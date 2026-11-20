// THE EQUIVALENCE TEST, in process (step-13.md section 7 row 3; docs/plans/step-13a.md section 4): telemetry
// never changes behaviour. The same scripted scenarios run under four telemetry modes:
//   off        NO_TELEMETRY (what `npm test` and every worker without OTEL_*/ROTE_METRICS_PORT runs)
//   memory     OpenTelemetry, spans to an in-memory exporter, metrics on, /metrics served
//   closed     OpenTelemetry, spans to a CLOSED port (every export refused), metrics on, /metrics served
//   blackhole  OpenTelemetry, spans to a server that accepts and NEVER answers (every export hangs to its
//              2 s timeout), metrics on, /metrics served
// Scenarios: success, business outcome, a lost lease (the heartbeat aborts the run), a deferred verify (the bank
// down right after Submit; the verify defers, resumes, resubmits; attempt 2 succeeds). Each must give the same
// job end state, outcome/error, attempt and verification rows (timestamps, ids and tokens aside) and the same
// ledger count in every mode, within 1.5 x the off run's wall time + 3 s. The memory mode's spans are also the
// full-transfer redaction check (section 7 row 2).
//
// Crash before / after Submit (worker CHILD processes, which need the bank on :4100) run the four modes in
// src/worker/crashSubmit.db.test.ts, the file that owns :4100.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRow } from "../queue/index.js";
import { blackHole, closedPort, type BlackHole } from "../testing/collectors.js";
import {
  NO_TELEMETRY,
  OtelTelemetry,
  SPAN_ATTRIBUTES,
  startMetricsServer,
  type MetricsServer,
  type Telemetry,
} from "../telemetry/index.js";
import type { JobDone } from "./loop.js";
import { runJob, type RunJobOptions } from "./runJob.js";
import { CREDENTIAL_VALUES, createWorkerTestEnv, type WorkerTestEnv } from "./testEnv.js";

type Mode = "off" | "memory" | "closed" | "blackhole";
const MODES: Mode[] = ["off", "memory", "closed", "blackhole"];
const FAST_DEFER = { budgetSeconds: 600, backoffBaseSeconds: 1, backoffCapSeconds: 2 };

let env: WorkerTestEnv;
let hole: BlackHole;
let refused: number;

beforeAll(async () => {
  env = await createWorkerTestEnv("worker_telemetry_equiv");
  hole = await blackHole();
  refused = await closedPort();
}, 60_000);
afterAll(async () => {
  await hole?.close();
  await env?.close();
});

interface ModeRun {
  telemetry: Telemetry;
  server: MetricsServer | null;
}

async function startMode(mode: Mode): Promise<ModeRun> {
  if (mode === "off") return { telemetry: NO_TELEMETRY, server: null };
  const traces =
    mode === "memory"
      ? ({ kind: "memory" } as const)
      : ({ kind: "otlp", url: `http://127.0.0.1:${mode === "closed" ? refused : hole.port}/v1/traces` } as const);
  const telemetry = new OtelTelemetry({ serviceName: "rote-worker", instanceId: `equiv-${mode}`, traces, metrics: true });
  const server = await startMetricsServer(telemetry.metricsHandler()!, { port: 0, host: "127.0.0.1" });
  return { telemetry, server };
}

/** Everything a scenario's end is compared on; timestamps, ids, tokens and worker names normalized away. */
interface Snapshot {
  jobs: unknown[];
  attempts: unknown[];
  verifications: unknown[];
  ledgerRows: number;
}

function norm(text: unknown): unknown {
  if (typeof text !== "string") return text;
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/test-worker-\d+/g, "<worker>")
    .replace(/TXN-\d+/g, "<txn>")
    .replace(/\btoken \d+/g, "token <n>")
    .replace(/\d+(\.\d+)? ?ms\b/g, "<n> ms")
    .replace(/\d+(\.\d+)? s\b/g, "<n> s");
}

async function snapshot(jobIds: string[]): Promise<Snapshot> {
  const jobs = (await env.pool.query<JobRow>("SELECT * FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY created_at", [jobIds])).rows;
  const attempts = (await env.pool.query("SELECT * FROM job_attempts WHERE job_id = ANY($1::uuid[]) ORDER BY job_id, attempt", [jobIds])).rows;
  const verifications = (await env.pool.query("SELECT * FROM job_verifications WHERE job_id = ANY($1::uuid[]) ORDER BY id", [jobIds])).rows;
  const memos = new Set(jobs.map((j) => j.memo_key));
  const ledger = (await env.ledger()).filter((r) => memos.has(r.memo));
  return {
    jobs: jobs.map((j) => ({
      state: j.state,
      outcome: j.outcome,
      error: norm(j.error),
      attempt: j.attempt,
      crashes: j.crashes,
      lease_crashes: j.lease_crashes,
      reconcile_due: j.reconcile_after !== null,
      reconciled: j.reconciled_at !== null,
      result: j.result ? Object.keys(j.result as object).sort() : null,
      lease_owner: j.lease_owner === null ? null : "<set>",
    })),
    attempts: attempts.map((a) => ({ attempt: a.attempt, outcome: a.outcome, commit_uncertain: a.commit_uncertain, error: norm(a.error), intent: a.commit_intent_at !== null })),
    verifications: verifications.map((v) => ({ reason: v.reason, decision: v.decision, lookups: v.lookups, prior_status: v.prior_status, error: norm(v.error) })),
    ledgerRows: ledger.length,
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Scenario = (run: ModeRun) => Promise<string[]>;

const SCENARIOS: Record<string, Scenario> = {
  async success({ telemetry }) {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const worker = env.newWorker({ telemetry });
    expect(await worker.tick()).toBe("ran");
    return [job!.id];
  },
  async business_outcome({ telemetry }) {
    const [job] = await env.enqueueTransfers(1, { toMemberId: "99999" }, ["tenant-a"]);
    const worker = env.newWorker({ telemetry });
    expect(await worker.tick()).toBe("ran");
    return [job!.id];
  },
  async lost_lease({ telemetry }) {
    // As lease.db.test.ts: the job is taken away (token bumped) while the worker waits on a slow bank.
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    await env.control("latency/3000");
    const done: JobDone[] = [];
    const worker = env.newWorker({ telemetry, leaseSeconds: 5, heartbeatSeconds: 1, onJobDone: (d) => done.push(d) });
    const tick = worker.tick();
    await waitFor(async () => (await env.jobs()).find((j) => j.id === job!.id)!.state === "running", 20_000, "the job to be leased");
    await env.pool.query(
      "UPDATE jobs SET fencing_token = fencing_token + 1, state = 'needs_human', outcome = 'taken-by-test', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [job!.id],
    );
    expect(await tick).toBe("ran");
    await env.control("latency/0");
    expect(done.map((d) => d.recorded)).toEqual([false]);
    return [job!.id];
  },
  async deferred_verify({ telemetry }) {
    // As verify.db.test.ts: 503 armed right after the intent; the verify defers, resumes (T6.7), resubmits.
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    let armed = false;
    const worker = env.newWorker({
      telemetry,
      verifyCtx: { defer: FAST_DEFER },
      runJob: (j: JobRow, options: RunJobOptions) =>
        runJob({ ...env.ctx, telemetry }, j, {
          ...options,
          commitIntent: async () => {
            await options.commitIntent!();
            if (!armed) {
              armed = true;
              await env.control("errors/on");
            }
          },
        }),
    });
    expect(await worker.tick()).toBe("ran"); // the run, T5, the verify: deferred
    await env.control("errors/off");
    await new Promise((resolve) => setTimeout(resolve, 1200)); // the 1 s backoff
    expect(await worker.tick()).toBe("ran"); // T6.7 resumed, [0, 0], resubmitted
    expect(await worker.tick()).toBe("ran"); // attempt 2
    return [job!.id];
  },
};

describe("telemetry never changes behaviour: four modes, the same end state", () => {
  const results: Record<string, Partial<Record<Mode, { snap: Snapshot; ms: number }>>> = {};
  const runs: Partial<Record<Mode, ModeRun>> = {};

  for (const mode of MODES) {
    it(`mode ${mode}: every scenario runs to its end`, async () => {
      const run = await startMode(mode);
      runs[mode] = run;
      try {
        for (const [name, scenario] of Object.entries(SCENARIOS)) {
          await env.reset();
          const started = Date.now();
          const ids = await scenario(run);
          const ms = Date.now() - started;
          (results[name] ??= {})[mode] = { snap: await snapshot(ids), ms };
        }
        if (run.server) {
          // /metrics answers while the collector is down or hanging, and counted what the worker did.
          const res = await fetch(`http://127.0.0.1:${run.server.port}/metrics`);
          expect(res.status).toBe(200);
          const text = await res.text();
          expect(text).toMatch(/^rote_jobs_completed_total\{outcome="success"\} 2$/m); // success + deferred_verify's attempt 2
          expect(text).toMatch(/^rote_jobs_completed_total\{outcome="business_outcome"\} 1$/m);
          expect(text).toMatch(/^rote_recoveries_total\{result="resubmitted"\} 1$/m);
          expect(text).toMatch(/^rote_verify_decisions_total\{decision="deferred"\} 1$/m);
          expect(text).toMatch(/^rote_browser_contexts_in_use 0$/m);
        }
      } finally {
        if (run.server) await run.server.close();
      }
    }, 240_000);
  }

  it("every scenario's end state is identical across the four modes", () => {
    for (const [name, byMode] of Object.entries(results)) {
      const off = byMode.off!;
      expect(off, `${name}: off ran`).toBeDefined();
      for (const mode of MODES.filter((m) => m !== "off")) {
        expect(byMode[mode]?.snap, `${name} under ${mode}`).toEqual(off.snap);
      }
    }
    // The scenarios ended where they should (so "identical" is not "identically broken").
    expect(results.success!.off!.snap.jobs).toEqual([expect.objectContaining({ state: "succeeded", outcome: "success", attempt: 1 })]);
    expect(results.success!.off!.snap.ledgerRows).toBe(1);
    expect(results.business_outcome!.off!.snap.jobs).toEqual([expect.objectContaining({ state: "business_outcome", attempt: 1 })]);
    expect(results.business_outcome!.off!.snap.ledgerRows).toBe(0);
    expect(results.lost_lease!.off!.snap.attempts).toEqual([expect.objectContaining({ outcome: "lease_lost" })]);
    expect(results.lost_lease!.off!.snap.ledgerRows).toBe(0);
    expect(results.deferred_verify!.off!.snap.jobs).toEqual([expect.objectContaining({ state: "succeeded", attempt: 2 })]);
    expect(results.deferred_verify!.off!.snap.verifications).toEqual([
      expect.objectContaining({ reason: "commit_uncertain", decision: "deferred" }),
      expect.objectContaining({ reason: "resumed", decision: "resubmitted", lookups: [0, 0] }),
    ]);
    expect(results.deferred_verify!.off!.snap.ledgerRows).toBe(1);
  });

  it("no mode is slower than 1.5 x off + 3 s on any scenario", () => {
    for (const [name, byMode] of Object.entries(results)) {
      const bound = byMode.off!.ms * 1.5 + 3000;
      for (const mode of MODES) expect(byMode[mode]!.ms, `${name} under ${mode} (off took ${byMode.off!.ms} ms)`).toBeLessThan(bound);
    }
  });

  it("memory mode exported every step of the runs as capability.step spans, allowlisted and with no credential or param value", async () => {
    const t = runs.memory!.telemetry as OtelTelemetry;
    await t.flush(2000);
    const spans = t.finishedSpans();
    // success (12 steps) + deferred_verify's two runs (12 + 12) at least; business outcome and lost lease add partial runs.
    expect(spans.filter((s) => s.attributes.ended === "completed").length).toBeGreaterThanOrEqual(36);
    const allowed: readonly string[] = SPAN_ATTRIBUTES["capability.step"];
    // Attributes and event names only: random hex span/trace ids could contain "10001" by chance.
    const text = JSON.stringify(spans.map((s) => ({ attributes: s.attributes, events: s.events })));
    for (const s of spans) {
      expect(s.name).toBe("capability.step");
      for (const key of Object.keys(s.attributes)) expect(allowed).toContain(key);
    }
    for (const v of [...CREDENTIAL_VALUES, "10001", "10002", "99999", "1.00"]) expect(text, v).not.toContain(v);
    expect(spans.filter((s) => s.attributes.irreversible === true).every((s) => s.attributes.step_id === "step-11")).toBe(true);
    await t.shutdown(2000);
  });

  it("the closed-port and black-hole modes did try to export, and failed without anyone noticing but the counter", async () => {
    for (const mode of ["closed", "blackhole"] as const) {
      const t = runs[mode]!.telemetry as OtelTelemetry;
      await t.shutdown(2500);
      const errors = t.errors();
      expect((errors.span_export ?? 0) + (errors.flush ?? 0), `${mode}: ${JSON.stringify(errors)}`).toBeGreaterThan(0);
    }
    expect(hole.connections).toBeGreaterThan(0);
  });
});
