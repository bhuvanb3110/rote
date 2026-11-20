// Crash right BEFORE and right AFTER Submit, in `npm test` (the brief's deliverable: "integration tests for
// crash-before and crash-after Submit"; docs/plans/step-10.md section 6; D53). Real worker CHILD PROCESSES
// (src/testing/workerProcess.ts), the in-process mock bank on :4100, a Postgres test schema, then the
// ledger oracle (D32). A fault worker SIGKILLs itself at the point: a real signal on Linux (CI), Windows'
// TerminateProcess locally (exit code 1). A clean worker then recovers the job when its lease expires
// (T6.4), verifies it in the bank's history, and drains until the job is SETTLED (terminal, and the
// reconcile pass done if one was due). Expected, both cases: exactly 1 ledger row, succeeded, oracle PASS.
//   before-submit  the intent is written, the click never went out: verify [0, 0] -> resubmitted ->
//                  attempt 2 succeeds -> the reconcile pass reads 1 match (reconciled)
//   after-submit   the bank wrote the row: verify [1] -> succeeded / already_done on attempt 1, no reconcile
// The lease is 5 s / heartbeat 2 s (as in the crash matrix, D40), the settle 1 s and the reconcile margin
// 1 s, so each case takes seconds, not minutes.
//
// Step 13a: THE EQUIVALENCE TEST's worker-process half (step-13.md section 7 row 3; the in-process half is
// src/worker/telemetry.db.test.ts). Each point runs under four telemetry modes, one after another, one schema
// each, the workers configured only through the environment the entrypoint reads:
//   off        no OTEL_* / ROTE_METRICS_PORT (what this test ran before Step 13a)
//   memory     spans to a collector in this process that answers 200 (an in-memory exporter cannot cross a
//              process boundary), /metrics on a free port
//   closed     spans to a CLOSED port, and ROTE_METRICS_PORT set to a port this test holds: each worker logs
//              one warning and runs without /metrics
//   blackhole  spans to a server that accepts and never answers, /metrics on a free port
// Every mode must pass the original assertions, and all four must end identically (state, outcome, attempt,
// verify phases, attempts, ledger rows), the drain within 1.5 x off's + 5 s.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetLedger } from "../../mock-app/data.js";
import { findCapability } from "../catalog/registry.js";
import { jobSettled } from "../fleet/stateMachine.js";
import { checkLedger, fetchLedger, readJobs } from "../oracle/index.js";
import { enqueue } from "../queue/index.js";
import { createTestSchema } from "../queue/testDb.js";
import { blackHole, closedPort, receivingCollector, type BlackHole, type ReceivingCollector } from "../testing/collectors.js";
import { listenOnSafePort } from "../testing/listen.js";
import { BANK, closeBank, listenBank, runFaultWorker, startWorker, stopWorker, workerEnv } from "../testing/workerProcess.js";

type Mode = "off" | "memory" | "closed" | "blackhole";
const MODES: Mode[] = ["off", "memory", "closed", "blackhole"];

let bank: Server;
let dir: string;
let receiver: ReceivingCollector;
let hole: BlackHole;
let refused: number;
let squatter: Server;
let takenPort: number;

beforeAll(async () => {
  bank = await listenBank();
  dir = await mkdtemp(path.join(tmpdir(), "rote-crash-submit-"));
  receiver = await receivingCollector();
  hole = await blackHole();
  refused = await closedPort();
  squatter = createServer((_req, res) => void res.end("taken"));
  takenPort = await listenOnSafePort(squatter, "127.0.0.1");
});
afterAll(async () => {
  if (bank) await closeBank(bank);
  await receiver?.close();
  await hole?.close();
  if (squatter) await new Promise<void>((resolve) => squatter.close(() => resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

function telemetryEnv(mode: Mode): Record<string, string> {
  switch (mode) {
    case "off":
      return { OTEL_EXPORTER_OTLP_ENDPOINT: "", ROTE_METRICS_PORT: "" };
    case "memory":
      return { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`, ROTE_METRICS_PORT: "0", ROTE_METRICS_HOST: "127.0.0.1" };
    case "closed":
      return { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${refused}`, ROTE_METRICS_PORT: String(takenPort), ROTE_METRICS_HOST: "127.0.0.1" };
    case "blackhole":
      return { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${hole.port}`, ROTE_METRICS_PORT: "0", ROTE_METRICS_HOST: "127.0.0.1" };
  }
}

async function crashThenRecover(point: "before-submit" | "after-submit", mode: Mode) {
  const tag = `${point.replace("-", "_")}_${mode}`;
  const db = await createTestSchema(`crash_submit_${tag}`, { max: 4 });
  try {
    const capability = (await findCapability("transfer"))!;
    const { job } = await enqueue(db.pool, {
      capability,
      tenantId: "tenant-a",
      idempotencyKey: `crash-submit-${point}-${mode}`,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    });
    const base = workerEnv(db, {
      ROTE_LEASE_SECONDS: "5",
      ROTE_HEARTBEAT_SECONDS: "2",
      ROTE_VERIFY_SETTLE_MS: "1000",
      ROTE_RECONCILE_MARGIN_SECONDS: "1",
      ROTE_EVIDENCE_DIR: path.join(dir, tag, "worker-evidence"),
      ...telemetryEnv(mode),
    });
    const faultLog = path.join(dir, `${tag}-fault.log`);
    const cleanLog = path.join(dir, `${tag}-clean.log`);
    const fault = await runFaultWorker(base, point, faultLog, 120_000, `fault-${point}-${mode}`);
    const clean = startWorker({ ...base, ROTE_WORKER_ID: `clean-${point}-${mode}` }, cleanLog);
    let drainTimedOut = false;
    const drainStarted = Date.now();
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const [current] = await readJobs(db.pool, [job.id]);
        if (jobSettled(current!)) break;
        if (Date.now() > deadline) {
          drainTimedOut = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await stopWorker(clean);
    }
    const drainMs = Date.now() - drainStarted;
    const [final] = await readJobs(db.pool, [job.id]);
    // The four modes share the bank: each judges only the rows carrying its own job's memo_key.
    const ledger = (await fetchLedger(BANK)).filter((row) => row.memo === final!.memo_key);
    const report = checkLedger({ jobs: [final!], ledger, drainTimedOut });
    const phases = (
      await db.pool.query<{ reason: string; decision: string | null; lookups: number[] | null }>("SELECT reason, decision, lookups FROM job_verifications WHERE job_id = $1 ORDER BY id", [job.id])
    ).rows;
    const attempts = (await db.pool.query<{ attempt: number; worker_id: string; outcome: string | null }>("SELECT attempt, worker_id, outcome FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [job.id])).rows;
    const logs = { fault: await readFile(faultLog, "utf8"), clean: await readFile(cleanLog, "utf8") };
    return { mode, fault, final: final!, ledger, report, phases, attempts, drainTimedOut, drainMs, logs };
  } finally {
    await db.drop();
  }
}

type Run = Awaited<ReturnType<typeof crashThenRecover>>;

/**
 * The four modes of one point, ONE AFTER ANOTHER (one bank, four schemas; the ledger reset once, before them).
 * Not at once: four worker processes each launching Chromium, on top of the suite's three browser files, overloaded
 * the 8 GB laptop (two other files' teardowns timed out in the first full run, evidence/step-13a/flakes.md). One
 * worker process at a time is what this file ran before Step 13a.
 */
async function allModes(point: "before-submit" | "after-submit"): Promise<Record<Mode, Run>> {
  resetLedger();
  const runs: Run[] = [];
  for (const mode of MODES) runs.push(await crashThenRecover(point, mode));
  return Object.fromEntries(runs.map((r) => [r.mode, r])) as Record<Mode, Run>;
}

/** What the modes must agree on. */
function endState(r: Run) {
  return {
    state: r.final.state,
    outcome: r.final.outcome,
    attempt: r.final.attempt,
    crashes: r.final.crashes,
    reconciled: r.final.reconciled_at !== null,
    reconcileDue: r.final.reconcile_after !== null,
    phases: r.phases,
    attempts: r.attempts.map((a) => [a.attempt, a.outcome]),
    ledgerRows: r.ledger.length,
    oracle: r.report.pass,
  };
}

function expectEquivalent(runs: Record<Mode, Run>): void {
  for (const mode of MODES) expect(endState(runs[mode]), `${mode} vs off`).toEqual(endState(runs.off));
  for (const mode of MODES) expect(runs[mode].drainMs, `${mode}'s drain (off: ${runs.off.drainMs} ms)`).toBeLessThan(runs.off.drainMs * 1.5 + 5000);
  // The closed mode's port was taken: each of its workers said so once, and ran on without /metrics.
  for (const log of [runs.closed.logs.fault, runs.closed.logs.clean]) {
    expect(log.match(/telemetry: metrics port unavailable/g) ?? []).toHaveLength(1);
  }
  // Nobody else warned about the port; the off mode's workers say nothing about telemetry at all.
  for (const mode of ["memory", "blackhole"] as const) expect(runs[mode].logs.clean).not.toMatch(/metrics port unavailable/);
  expect(runs.off.logs.fault + runs.off.logs.clean).not.toMatch(/telemetry:/);
}

describe("crash before / after Submit (real worker processes, a real SIGKILL on Linux), under four telemetry modes", () => {
  it("crash right BEFORE Submit (after the intent): verified [0, 0] -> resubmitted -> attempt 2 succeeds -> reconciled; exactly 1 row; the same in every mode", async () => {
    const runs = await allModes("before-submit");
    for (const r of Object.values(runs)) {
      expect(r.fault.fired, `${r.mode}: the fault worker: ${r.fault.exit}`).toBe(true);
      expect(r.fault.exit).toMatch(/^(signal SIGKILL|exit 1)$/);
      expect(r.drainTimedOut, r.mode).toBe(false);
      expect(r.final, r.mode).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2 });
      expect(r.final.reconciled_at, r.mode).not.toBeNull();
      expect(r.phases, r.mode).toEqual([
        { reason: "lease_expired_in_committing", decision: "resubmitted", lookups: [0, 0] },
        { reason: "reconcile", decision: "reconciled", lookups: [1] },
      ]);
      expect(r.attempts.map((a) => [a.attempt, a.outcome]), r.mode).toEqual([
        [1, "crashed"],
        [2, "success"],
      ]);
      expect(r.ledger, r.mode).toHaveLength(1);
      expect(r.report.pass, `${r.mode}: ${r.report.text}`).toBe(true);
    }
    expectEquivalent(runs);
    // The memory mode's clean worker ran attempt 2 in full: its steps reached the collector as OTLP spans.
    expect(receiver.requests).toBeGreaterThan(0);
    expect(receiver.bodies).toContain("capability.step");
    expect(hole.connections).toBeGreaterThan(0);
  }, 480_000);

  it("crash right AFTER Submit (the bank wrote the row): verified [1] -> succeeded / already_done on attempt 1, no reconcile due; exactly 1 row; the same in every mode", async () => {
    const runs = await allModes("after-submit");
    for (const r of Object.values(runs)) {
      expect(r.fault.fired, `${r.mode}: the fault worker: ${r.fault.exit}`).toBe(true);
      expect(r.fault.exit).toMatch(/^(signal SIGKILL|exit 1)$/);
      expect(r.drainTimedOut, r.mode).toBe(false);
      expect(r.final, r.mode).toMatchObject({ state: "succeeded", outcome: "already_done", attempt: 1, reconcile_after: null });
      expect(r.phases, r.mode).toEqual([{ reason: "lease_expired_in_committing", decision: "already_done", lookups: [1] }]);
      expect(r.ledger, r.mode).toHaveLength(1);
      expect((r.final.result as { outputs: { confirmationRef: string } }).outputs.confirmationRef, r.mode).toBe(r.ledger[0]!.id);
      expect(r.report.pass, `${r.mode}: ${r.report.text}`).toBe(true);
    }
    expectEquivalent(runs);
  }, 480_000);
});
