// One verify PHASE (Step 9: docs/plans/step-08.md section 5; step-09 reviewer decisions 1, 4, 5; D43).
// Run by the worker that holds a `verifying` job: its own run ended commit-uncertain (T5), or its
// recovery sweep claimed the job (T6.4 a dead worker's commit, T6.5 a dead verifier's job, T6.7 a
// deferred or handed-off verify).
//
//   heartbeat (T2) on this phase's token; a lost lease aborts the lookup and the phase writes NOTHING to
//   jobs (its own job_verifications row says lease_lost)
//   lookup #1  = transfer-history-lookup 1.2.0 for (memberId, memo_key), read-only, no approveRisky;
//                one retry if it was transient (session timeout, interstitials exhausted, a network
//                throw); still transient -> "unavailable"
//   if it counted 0: wait the settle period (ROTE_VERIFY_SETTLE_MS, default 5 s; the heartbeat can
//                abort it), lookup #2 the same way
//   decide     = verifyDecision (pure) with the cycle's prior_status, attempt, and its deferrals so far
//                (VERIFY_CYCLE_SQL, database clock)
//   write      = T7 (the decision) or T8 (deferred: the bank was unavailable), fenced on this token; a
//                T7 `already_done` on a job that was resubmitted before marks it for the reconcile pass
//                (D50)
//
// The lookup itself (createLookup: one lookup and its one retry) is shared with the reconcile pass
// (src/worker/reconcile.ts, D50).
//
// Crash points (test-only, D34): verify-after-login (the lookup's step-03), verify-after-count (its
// step-09), verify-before-result (decided, before T7/T8), verify-before-requeue (decided "resubmitted",
// before T7), verify-after-requeue (T7 queued committed).
//
// RULE (step-09 reviewer decision 4): the settle period must exceed the bank's history visibility
// delay. A row the bank shows later than the second lookup is invisible to both, and [0, 0] would
// resubmit a transfer that happened. That is deployment configuration; the reconcile pass (D50) is the
// backstop that makes such a duplicate loud (evidence/settle-vs-history-lag/).
import type { Browser } from "playwright";
import type { Step } from "../artifact/index.js";
import { invokeCapability } from "../catalog/invoke.js";
import { DEFAULT_ARTIFACTS_DIR, findCapability } from "../catalog/registry.js";
import type { Pool } from "../queue/index.js";
import {
  afterRetry,
  alreadyDoneResult,
  classifyLookup,
  DEFAULT_DEFER_CONFIG,
  lookupsColumn,
  readingsComplete,
  reconcileDueSeconds,
  verifyDecision,
  type DeferConfig,
  type LookupEnd,
  type LookupReading,
  type VerifyDecision,
} from "../fleet/stateMachine.js";
import { sleep } from "./backoff.js";
import { retryTransient } from "./complete.js";
import type { TenantCredentials, Redactor } from "./credentials.js";
import { NO_FAULT, type FaultInjector } from "./fault.js";
import { Heartbeat } from "./heartbeat.js";
import { LeaseLostError } from "./leaseErrors.js";
import type { WorkerLogger } from "./loop.js";
import { NO_METRICS, type WorkerMetrics } from "./metrics.js";
import type { VerifyClaim } from "./recover.js";
import { buildJobParams } from "./runJob.js";
import { deferVerify, markPhaseFencedOut, readVerifyCycle, writeVerifyResult } from "./verifySql.js";
import type { FencedOutReason } from "./complete.js";

export const LOOKUP_CAPABILITY_ID = "transfer-history-lookup";
export const DEFAULT_VERIFY_SETTLE_MS = 5000;

/** The lookup's steps that are crash points (the 1.2.0 step ids). */
const LOOKUP_FAULT_POINTS: Record<string, string> = { "step-03": "verify-after-login", "step-09": "verify-after-count" };

export interface VerifyContext {
  pool: Pool;
  workerId: string;
  leaseSeconds: number;
  /** Omitted: no heartbeat (unit tests with long leases only; the entrypoint always sets it). */
  heartbeatSeconds?: number;
  settleMs: number;
  defer?: DeferConfig;
  getBrowser: () => Promise<Browser>;
  credentials: TenantCredentials;
  evidenceBaseDir: string;
  artifactsDir?: string;
  overridesDir?: string;
  statusDir?: string;
  fault?: FaultInjector;
  log?: WorkerLogger;
  metrics?: WorkerMetrics;
  redact?: Redactor;
  /**
   * Test seam: replaces the browser lookup (invokeCapability of transfer-history-lookup) with a function
   * returning what it would have. Never set by the entrypoint.
   */
  invokeLookup?: (input: { claim: LookupClaim; signal: AbortSignal; attempt: number }) => Promise<LookupEnd>;
  /**
   * The reconcile delay T7 marks a job with when it succeeds after a resubmit (D50): lease + settle +
   * margin (reconcileDueSeconds). Default: reconcileDueSeconds(leaseSeconds, settleMs).
   */
  reconcileDueSeconds?: number;
}

/** What a lookup needs from the job it reads for (a verify claim or a reconcile claim). */
export interface LookupClaim {
  job: Pick<VerifyClaim["job"], "id" | "tenant_id" | "params" | "memo_key">;
  fencingToken: number;
}

/**
 * One history lookup (transfer-history-lookup 1.2.0 for (memberId, memo_key), read-only, never
 * approveRisky) and the one retry if it was transient (afterRetry: still transient -> "unavailable").
 * Shared by the verify phase and the reconcile pass (D50). `faultPoints` maps lookup step ids to crash
 * points (verify's only). An abort of `controller` rejects with its reason.
 */
export function createLookup(
  ctx: VerifyContext,
  claim: LookupClaim,
  controller: AbortController,
  faultPoints: Record<string, string> = {},
): { once(): Promise<LookupReading>; withRetry(): Promise<LookupReading> } {
  const fault = ctx.fault ?? NO_FAULT;
  const redact = ctx.redact ?? ((s: string) => s);
  const { job } = claim;
  let lookupsRun = 0;
  const once = async (): Promise<LookupReading> => {
    lookupsRun += 1;
    if (ctx.invokeLookup) {
      let end: LookupEnd;
      try {
        end = await ctx.invokeLookup({ claim, signal: controller.signal, attempt: lookupsRun });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        end = { kind: "thrown", error };
      }
      controller.signal.throwIfAborted();
      return classifyLookup(end);
    }
    const capability = await findCapability(LOOKUP_CAPABILITY_ID, ctx.artifactsDir ?? DEFAULT_ARTIFACTS_DIR);
    if (!capability) return { kind: "unreadable", detail: `no capability "${LOOKUP_CAPABILITY_ID}"`, evidenceRef: null };
    let params: Record<string, unknown>;
    try {
      params = buildJobParams(capability, { tenant_id: job.tenant_id, params: { memberId: job.params.memberId, memo: job.memo_key }, memo_key: job.memo_key }, ctx.credentials);
    } catch (err) {
      return { kind: "unreadable", detail: redact(`cannot build the lookup's params: ${(err as Error).message}`), evidenceRef: null };
    }
    const onStep =
      fault.point && Object.keys(faultPoints).length > 0
        ? {
            after: async (step: Step) => {
              const point = faultPoints[step.id];
              if (point) fault.at(point);
            },
          }
        : undefined;
    let reading: LookupReading;
    try {
      const result = await invokeCapability({
        id: LOOKUP_CAPABILITY_ID,
        tenant: job.tenant_id,
        params,
        browser: await ctx.getBrowser(),
        signal: controller.signal,
        evidenceBaseDir: ctx.evidenceBaseDir,
        artifactsDir: ctx.artifactsDir,
        overridesDir: ctx.overridesDir,
        statusDir: ctx.statusDir,
        onStep,
        headless: true,
      });
      reading = classifyLookup({ kind: "result", result });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      reading = classifyLookup({ kind: "thrown", error });
    }
    controller.signal.throwIfAborted();
    return reading.kind === "count" ? reading : { ...reading, detail: redact(reading.detail) };
  };
  const withRetry = async (): Promise<LookupReading> => {
    const first = await once();
    if (first.kind !== "transient") return first;
    ctx.log?.warn({ workerId: ctx.workerId, jobId: job.id, fencingToken: claim.fencingToken, detail: first.detail }, "lookup transient; one retry");
    return afterRetry(await once());
  };
  return { once, withRetry };
}

export interface VerifyPhaseOutcome {
  claim: VerifyClaim;
  readings: LookupReading[];
  /** null: the phase ended without deciding (lease lost, or stopped). */
  decision: VerifyDecision | null;
  recorded: boolean;
  fencedOut?: FencedOutReason;
  /** T8: the token the job was left under (nobody holds it). */
  deferredToken?: number;
  durationMs: number;
}

/**
 * Runs one verify phase. `controller` is the phase's own: the heartbeat aborts it with a LeaseLostError
 * and the worker's stop() with a shutdown error; either ends the phase without writing to jobs.
 */
export async function runVerifyPhase(
  ctx: VerifyContext,
  claim: VerifyClaim,
  controller: AbortController = new AbortController(),
  hardSignal?: AbortSignal,
): Promise<VerifyPhaseOutcome> {
  const started = Date.now();
  const { job, fencingToken } = claim;
  const fault = ctx.fault ?? NO_FAULT;
  const metrics = ctx.metrics ?? NO_METRICS;
  const redact = ctx.redact ?? ((s: string) => s);
  const log = { workerId: ctx.workerId, jobId: job.id, tenant: job.tenant_id, label: claim.label, fencingToken, attempt: job.attempt };
  ctx.log?.info(log, "verify: phase started");
  const heartbeat =
    ctx.heartbeatSeconds === undefined
      ? null
      : new Heartbeat({
          pool: ctx.pool,
          jobId: job.id,
          fencingToken,
          workerId: ctx.workerId,
          leaseSeconds: ctx.leaseSeconds,
          intervalMs: ctx.heartbeatSeconds * 1000,
          controller,
          log: ctx.log,
        });
  heartbeat?.start();
  const readings: LookupReading[] = [];
  const done = (rest: Omit<VerifyPhaseOutcome, "claim" | "readings" | "durationMs">): VerifyPhaseOutcome => ({
    claim,
    readings,
    durationMs: Date.now() - started,
    ...rest,
  });

  const lookupWithRetry = createLookup(ctx, claim, controller, LOOKUP_FAULT_POINTS).withRetry;

  try {
    readings.push(await lookupWithRetry());
    if (!readingsComplete(readings)) {
      // Counted 0: the transfer may not be visible YET. Wait, then look again (reviewer decision 1).
      await sleep(ctx.settleMs, controller.signal);
      controller.signal.throwIfAborted();
      readings.push(await lookupWithRetry());
    }
    const cycle = await retryTransient(() => readVerifyCycle(ctx.pool, job.id), { signal: hardSignal });
    if (cycle === null) {
      ctx.log?.error(log, "verify: stopped while Postgres was unavailable; the phase dies and recovery re-verifies");
      return done({ decision: null, recorded: false });
    }
    const decision = verifyDecision({
      readings,
      priorStatus: cycle.priorStatus,
      attempt: job.attempt,
      maxAttempts: job.max_attempts,
      deferrals: cycle.deferrals,
      deferredForSeconds: cycle.deferredForSeconds,
      defer: ctx.defer ?? DEFAULT_DEFER_CONFIG,
    });
    fault.at("verify-before-result"); // decided; nothing written
    if (decision.decision === "resubmitted") fault.at("verify-before-requeue");
    // The heartbeat stops before the write (as before T4): the write is fenced on the token anyway.
    heartbeat?.stop();
    controller.signal.throwIfAborted();
    const write = {
      jobId: job.id,
      fencingToken,
      workerId: ctx.workerId,
      lookups: lookupsColumn(readings),
      evidenceRefs: readings.map((r) => r.evidenceRef),
    };
    const written = await retryTransient(
      () =>
        decision.decision === "deferred"
          ? deferVerify(ctx.pool, { ...write, decision })
          : writeVerifyResult(ctx.pool, {
              ...write,
              decision,
              result: decision.decision === "already_done" ? alreadyDoneResult(decision) : null,
              reconcileDueSeconds: ctx.reconcileDueSeconds ?? reconcileDueSeconds(ctx.leaseSeconds, ctx.settleMs),
            }),
      { signal: hardSignal },
    );
    if (written === null) {
      ctx.log?.error({ ...log, decision: decision.decision }, "verify: stopped before the decision could be recorded; the phase dies and recovery re-verifies");
      return done({ decision, recorded: false });
    }
    if (!written.recorded) {
      if (written.reason === "illegal_transition") {
        metrics.inc("illegal_transitions_total");
        ctx.log?.error({ ...log, illegal_transition: true, detail: written.detail }, "verify: illegal_transition: the state guard refused this decision (a bug)");
      } else {
        ctx.log?.warn({ ...log, decision: decision.decision, detail: written.detail }, "verify: lease lost; decision NOT recorded on the job");
      }
      return done({ decision, recorded: false, fencedOut: written.reason });
    }
    if (decision.decision === "resubmitted") fault.at("verify-after-requeue"); // T7 (queued) committed
    metrics.inc("verify_decisions_total", { decision: decision.decision });
    const fields = { ...log, decision: decision.decision, to: decision.to, lookups: write.lookups, ms: Date.now() - started };
    if (decision.decision === "escalated") ctx.log?.warn({ ...fields, outcome: decision.outcome, error: decision.error }, "verify: escalated to a human");
    else ctx.log?.info(fields, decision.decision === "deferred" ? `verify: deferred ${decision.backoffSeconds} s (bank unavailable)` : "verify: decided");
    return done({
      decision,
      recorded: true,
      deferredToken: "fencingToken" in written ? (written as { fencingToken: number }).fencingToken : undefined,
    });
  } catch (err) {
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : null;
    if (reason instanceof LeaseLostError) {
      // This verifier no longer holds the job: nothing on jobs; its phase row says lease_lost.
      await retryTransient(
        () => markPhaseFencedOut(ctx.pool, { jobId: job.id, fencingToken, how: "lease_lost", detail: redact(`lease lost during the verify phase (heartbeat). ${reason.message}`) }),
        { signal: hardSignal },
      );
      ctx.log?.warn({ ...log, err: reason.message, readings: lookupsColumn(readings) }, "verify: lease lost; phase aborted, nothing recorded on the job");
      return done({ decision: null, recorded: false, fencedOut: "lease_lost" });
    }
    if (controller.signal.aborted) {
      // Shutdown: the phase stays open; its lease expires and recovery re-verifies (T6.5).
      ctx.log?.warn({ ...log, err: String((reason as Error)?.message ?? reason) }, "verify: stopped (shutdown); recovery will re-verify after the lease expires");
      return done({ decision: null, recorded: false });
    }
    throw err;
  } finally {
    heartbeat?.stop();
  }
}
