// The verify phase end to end (docs/plans/step-09.md section 3, integration; reviewer decisions 4-5): a
// real worker, the in-process mock bank, Chromium and Postgres. Each test ends by checking the bank's
// own ledger (the oracle), not just the job rows.
//
// The first group drives runVerifyPhase with a scripted lookup (the invokeLookup seam) to pin the
// procedure's branches exactly: the one retry on a transient, unreadable at once, a persisting transient
// is "unavailable" (deferred), the settle period between two 0-match lookups, and a lease lost during
// the settle. The second group runs the real lookup against the real bank.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deserializeCapability, type ReplayResult } from "../artifact/index.js";
import { approvalKeyWithOverrides, approveCapability } from "../confidence/index.js";
import { checkLedger, readJobs } from "../oracle/index.js";
import { dequeue, type JobRow } from "../queue/index.js";
import { jobOutcomeFor, type LookupEnd } from "../fleet/stateMachine.js";
import { writeCommitIntent } from "./intent.js";
import type { VerifyClaim } from "./recover.js";
import { runJob, type RunJobOptions } from "./runJob.js";
import { createWorkerTestEnv, type WorkerTestEnv } from "./testEnv.js";
import { runVerifyPhase, type VerifyContext, type VerifyPhaseOutcome } from "./verify.js";
import { completeIntoVerify } from "./verifySql.js";
import { testDatabaseUrl } from "../queue/testDb.js";

const runCli = promisify(execFile);
let env: WorkerTestEnv;

beforeAll(async () => {
  env = await createWorkerTestEnv("worker_verify");
}, 60_000);
afterAll(async () => {
  await env?.close();
});
beforeEach(async () => {
  await env.reset();
  await env.pool.query("UPDATE tenants SET max_concurrent = 10");
});

const FAST_DEFER = { budgetSeconds: 600, backoffBaseSeconds: 1, backoffCapSeconds: 2 };
const phases = async (jobId: string) =>
  (await env.pool.query("SELECT fencing_token, reason, prior_status, decision, lookups, worker_id FROM job_verifications WHERE job_id = $1 ORDER BY id", [jobId])).rows;
const jobRow = async (id: string) => (await env.pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];

/** A job this test holds in `verifying` via T5 (its run ended commit-uncertain after a real intent). */
async function heldInVerify(workerId = "verifier"): Promise<VerifyClaim> {
  const [queued] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
  const job = (await dequeue(env.pool, { workerId, leaseSeconds: 30 }))!;
  expect(job.id).toBe(queued!.id);
  await writeCommitIntent(env.pool, { jobId: job.id, fencingToken: job.fencing_token, workerId, leaseSeconds: 30 });
  const result: ReplayResult = {
    status: "failure",
    atStepId: "step-12",
    expected: "x",
    observed: "503",
    category: "unexpected-state",
    evidenceRef: "e",
    commitUncertain: { irreversibleStepId: "step-11", detail: "test" },
  };
  const outcome = jobOutcomeFor({ kind: "result", result }, { attempt: job.attempt, maxAttempts: job.max_attempts, irreversibleStarted: true });
  const moved = await completeIntoVerify(env.pool, { jobId: job.id, fencingToken: job.fencing_token, workerId, leaseSeconds: 30, outcome });
  if (!moved.recorded) throw new Error(moved.detail);
  return { job, fencingToken: moved.fencingToken, label: "T5", priorStatus: "failure" };
}

const count = (n: number, ref = n > 0 ? "TXN-000001" : "No matching transfers."): LookupEnd => ({
  kind: "result",
  result: { status: "success", outputs: { matchingCount: String(n), firstMatchRef: ref }, evidenceRef: `evidence://fake-${n}` },
});
const interstitials: LookupEnd = {
  kind: "result",
  result: { status: "needs_human", reason: 'Recoverable rule ("retry") exhausted after 3 attempts at step "step-04".', atStepId: "step-04", contextRef: "c" },
};
const garbled: LookupEnd = { kind: "result", result: { status: "success", outputs: { matchingCount: "lots" }, evidenceRef: "evidence://garbled" } };

/** runVerifyPhase with a scripted lookup; records when each lookup ran. */
async function scripted(claim: VerifyClaim, script: LookupEnd[], over: Partial<VerifyContext> = {}): Promise<{ done: VerifyPhaseOutcome; at: number[] }> {
  const at: number[] = [];
  const done = await runVerifyPhase(
    {
      pool: env.pool,
      workerId: "verifier",
      leaseSeconds: 30,
      settleMs: 400,
      defer: FAST_DEFER,
      getBrowser: async () => env.browser,
      credentials: env.credentials,
      evidenceBaseDir: env.workDir,
      invokeLookup: async ({ attempt }) => {
        at.push(Date.now());
        const next = script[attempt - 1];
        if (!next) throw new Error(`lookup ${attempt} was not scripted`);
        return next;
      },
      ...over,
    },
    claim,
  );
  return { done, at };
}

describe("the verify procedure (scripted lookups)", () => {
  it("[1] -> already_done at once: one lookup, no settle", async () => {
    const claim = await heldInVerify();
    const { done, at } = await scripted(claim, [count(1, "TXN-000042")]);
    expect(at).toHaveLength(1);
    expect(done).toMatchObject({ recorded: true, decision: { decision: "already_done", confirmationRef: "TXN-000042" } });
    expect(await jobRow(claim.job.id)).toMatchObject({ state: "succeeded", outcome: "already_done" });
  });

  it("[0, 1]: the second lookup waits the settle period, then already_done", async () => {
    const claim = await heldInVerify();
    const { done, at } = await scripted(claim, [count(0), count(1)]);
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(390);
    expect(done.decision).toMatchObject({ decision: "already_done" });
    expect((await phases(claim.job.id))[0]).toMatchObject({ decision: "already_done", lookups: [0, 1] });
  });

  it("a transient lookup (interstitials exhausted) is retried ONCE and then counted (reviewer decision 4 of step 8)", async () => {
    const claim = await heldInVerify();
    const { done, at } = await scripted(claim, [interstitials, count(1)]);
    expect(at).toHaveLength(2);
    expect(done.decision).toMatchObject({ decision: "already_done" });
    expect((await phases(claim.job.id))[0]).toMatchObject({ lookups: [1] });
  });

  it("a transient that persists after the one retry is 'unavailable' -> deferred (T8): verifying, token + 1, the phase deferred", async () => {
    const claim = await heldInVerify();
    const { done } = await scripted(claim, [interstitials, interstitials]);
    expect(done).toMatchObject({ recorded: true, decision: { decision: "deferred", backoffSeconds: 1 }, deferredToken: claim.fencingToken + 1 });
    expect(await jobRow(claim.job.id)).toMatchObject({ state: "verifying", fencing_token: claim.fencingToken + 1, lease_owner: "verifier" });
    expect((await phases(claim.job.id))[0]).toMatchObject({ decision: "deferred", lookups: [null] });
  });

  it("a page that loads but cannot be understood -> needs_human / unreadable at once, NOT retried and NOT deferred", async () => {
    const claim = await heldInVerify();
    const { done, at } = await scripted(claim, [garbled]);
    expect(at).toHaveLength(1);
    expect(done.decision).toMatchObject({ decision: "escalated", outcome: "unreadable" });
    expect(await jobRow(claim.job.id)).toMatchObject({ state: "needs_human", outcome: "unreadable" });
    expect((await jobRow(claim.job.id)).result.verify).toMatchObject({ evidenceRefs: ["evidence://garbled"] });
  });

  it("the lease lost during the settle period (token bumped): the heartbeat aborts the phase; nothing on jobs; the phase says lease_lost", async () => {
    const claim = await heldInVerify();
    const bumped = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await env.pool.query("UPDATE jobs SET fencing_token = fencing_token + 1 WHERE id = $1", [claim.job.id]);
    })();
    const { done, at } = await scripted(claim, [count(0), count(1)], { leaseSeconds: 3, heartbeatSeconds: 1, settleMs: 5000 });
    await bumped;
    expect(at).toHaveLength(1); // the second lookup never ran
    expect(done).toMatchObject({ decision: null, recorded: false, fencedOut: "lease_lost" });
    expect(await jobRow(claim.job.id)).toMatchObject({ state: "verifying", fencing_token: claim.fencingToken + 1 });
    expect((await phases(claim.job.id))[0]).toMatchObject({ decision: "lease_lost", lookups: null });
  }, 20_000);
});

describe("verify against the real bank (Chromium, the real lookup 1.2.0)", () => {
  /** A worker whose commit intent first runs `meddle` (the test's stand-in for a concurrent event). */
  const workerMeddlingBeforeIntent = (meddle: () => Promise<void>, extra: Parameters<WorkerTestEnv["newWorker"]>[0] = {}) =>
    env.newWorker({
      verifyCtx: { defer: FAST_DEFER },
      ...extra,
      runJob: (job: JobRow, options: RunJobOptions) =>
        runJob({ ...env.ctx, ...extra.ctx }, job, {
          ...options,
          commitIntent: async () => {
            await options.commitIntent!();
            await meddle();
          },
        }),
    });

  it("errors/on armed right after the intent (503 BEFORE the write): verify finds the bank down -> deferred; the outage ends -> resumed (T6.7) [0, 0] -> resubmitted; attempt 2 succeeds; exactly 1 row", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    let armed = false;
    const worker = workerMeddlingBeforeIntent(async () => {
      if (armed) return;
      armed = true;
      await env.control("errors/on");
    });
    expect(await worker.tick()).toBe("ran"); // the run (503 after Submit: commit uncertain), T5, the verify: deferred
    expect(await jobRow(job!.id)).toMatchObject({ state: "verifying", outcome: "commit_uncertain" });
    expect((await phases(job!.id)).map((p) => p.decision)).toEqual(["deferred"]);
    await env.control("errors/off");
    await new Promise((resolve) => setTimeout(resolve, 1200)); // the 1 s backoff
    expect(await worker.tick()).toBe("ran"); // T6.7: resumed, [0, 0], resubmitted
    expect(await jobRow(job!.id)).toMatchObject({ state: "queued", attempt: 1 });
    expect(await worker.tick()).toBe("ran"); // attempt 2
    expect(await jobRow(job!.id)).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2 });
    expect((await phases(job!.id)).map((p) => [p.reason, p.decision, p.lookups])).toEqual([
      ["commit_uncertain", "deferred", [null]],
      ["resumed", "resubmitted", [0, 0]],
    ]);
    const ledger = await env.ledger();
    expect(ledger.map((r) => r.memo)).toEqual([job!.memo_key]);
  }, 90_000);

  it("a business outcome shown after Submit with nothing written -> [0, 0] -> business_outcome (the refusal stands), never retried; 0 rows", async () => {
    // A test-only variant of the transfer whose 503 page is a business outcome after Submit (as in
    // src/replay/fleet.test.ts), approved in its own statusDir with the env's overrides.
    const dir = path.join(env.workDir, "variant-bank-down");
    const artifactsDir = path.join(dir, "artifacts");
    const statusDir = path.join(dir, "status");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(statusDir, { recursive: true });
    const raw = JSON.parse(await readFile(path.join(env.workDir, "artifacts", "transfer.json"), "utf8"));
    raw.knownOutcomes.push({ code: "BANK_DOWN", recognizer: { kind: "textPresent", text: "System unavailable" }, detail: "503 (test-only outcome)" });
    await writeFile(path.join(artifactsDir, "transfer.json"), JSON.stringify(raw));
    const variant = deserializeCapability(JSON.stringify(raw));
    await approveCapability("transfer", { ...(await approvalKeyWithOverrides(variant, env.ctx.overridesDir!)), statusDir, reason: "test-only variant" });
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    let armed = false;
    const worker = workerMeddlingBeforeIntent(
      async () => {
        if (armed) return;
        armed = true;
        await env.control("errors/on");
      },
      { ctx: { artifactsDir, statusDir }, verifyCtx: { defer: FAST_DEFER, statusDir: env.ctx.statusDir } },
    );
    expect(await worker.tick()).toBe("ran");
    expect((await phases(job!.id))[0]).toMatchObject({ prior_status: "business_outcome", decision: "deferred" });
    await env.control("errors/off");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await worker.tick()).toBe("ran");
    const row = await jobRow(job!.id);
    expect(row).toMatchObject({ state: "business_outcome", outcome: "business_outcome", attempt: 1 });
    expect(row.result).toMatchObject({ code: "BANK_DOWN", verify: { decision: "not_committed_final", lookups: [0, 0] } });
    expect(await worker.tick()).toBe("idle"); // never retried
    expect(await env.ledger()).toEqual([]);
  }, 90_000);

  it("rote jobs reverify <id> end to end: a job Step 8 parked (needs_human / commit_uncertain, its transfer committed) -> the CLI hands it to verify -> the next worker's recovery (T6.7) -> [1] -> succeeded / already_done; refusals exit 1 / 2", async () => {
    // A Step 8-style parked job: its transfer really committed (1 row), then T6.3 escalated it.
    const [queued] = await env.enqueueTransfers(1, {}, ["tenant-b"]);
    const leased = (await dequeue(env.pool, { workerId: "dead", leaseSeconds: 30 }))!;
    expect(leased.id).toBe(queued!.id);
    await runJob(env.ctx, leased, {
      browser: env.browser,
      signal: new AbortController().signal,
      commitIntent: () => writeCommitIntent(env.pool, { jobId: leased.id, fencingToken: leased.fencing_token, workerId: "dead", leaseSeconds: 30 }).then(() => undefined),
    });
    await env.pool.query(
      `UPDATE jobs SET state = 'needs_human', outcome = 'commit_uncertain', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL,
              error = 'lease expired after the commit intent: the Submit may have committed; check the bank''s history for memo_key' WHERE id = $1`,
      [leased.id],
    );
    const [row] = await env.ledger();
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${env.db.schema}`);
    const cli = (...args: string[]) =>
      runCli(process.execPath, ["--import", "tsx", "src/cli/index.ts", "jobs", "reverify", ...args, "--database-url", url.toString(), "--by", "ops-test"]).then(
        (r) => ({ code: 0, out: r.stdout + r.stderr }),
        (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
      );
    expect(await cli(leased.id, "--tenant", "tenant-a")).toMatchObject({ code: 1, out: expect.stringContaining("no such job") });
    expect(await cli("not-a-uuid")).toMatchObject({ code: 2 });
    const ok = await cli(leased.id, "--tenant", "tenant-b");
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("handed to verify");
    expect(await jobRow(leased.id)).toMatchObject({ state: "verifying", lease_owner: "ops-test" });
    expect(await cli(leased.id)).toMatchObject({ code: 1, out: expect.stringContaining("refused") }); // fenced on its state
    const worker = env.newWorker();
    expect(await worker.tick()).toBe("ran"); // recovery T6.7 claims it and verifies
    const after = await jobRow(leased.id);
    expect(after).toMatchObject({ state: "succeeded", outcome: "already_done", attempt: 1 });
    expect(after.result.outputs.confirmationRef).toBe(row!.id);
    expect((await phases(leased.id)).map((p) => [p.reason, p.decision, p.worker_id])).toEqual([
      ["commit_uncertain", "handed_off", "ops-test"],
      ["resumed", "already_done", expect.stringMatching(/^test-worker-/)],
    ]);
    expect(await env.ledger()).toHaveLength(1);
  }, 90_000);

  it("a bank outage DURING verifies (dead workers after Submit and after the intent; errors/on for 8 s): every verify defers and completes after the outage; no needs_human, no duplicate (the ledger oracle)", async () => {
    const jobs = await env.enqueueTransfers(4, {}, ["tenant-a", "tenant-b"]);
    // Two "dead workers" that submitted and died before recording (1 row each), two that died between
    // the intent and the click (0 rows): every job is left `committing` with its lease running.
    class DiedAfterIntent extends Error {}
    for (const [i] of jobs.entries()) {
      const leased = (await dequeue(env.pool, { workerId: `dead-${i}`, leaseSeconds: 30 }))!;
      await runJob(env.ctx, leased, {
        browser: env.browser,
        signal: new AbortController().signal,
        commitIntent: async () => {
          await writeCommitIntent(env.pool, { jobId: leased.id, fencingToken: leased.fencing_token, workerId: `dead-${i}`, leaseSeconds: 30 });
          if (i % 2 === 1) throw new DiedAfterIntent("died between the intent and the click");
        },
      });
    }
    expect((await env.ledger()).length).toBe(2);
    await env.control("errors/on");
    await env.pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second'");
    const workers = [env.newWorker({ verifyCtx: { defer: FAST_DEFER } }), env.newWorker({ verifyCtx: { defer: FAST_DEFER } })];
    const loops = workers.map((w) => w.run());
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await env.control("errors/off");
    const finished = await env.waitForTerminal(jobs.map((j) => j.id), 60_000);
    for (const w of workers) w.stop();
    await Promise.all(loops);

    const byId = new Map(finished.map((j) => [j.id, j]));
    for (const [i, j] of jobs.entries()) {
      const row = byId.get(j.id)!;
      if (i % 2 === 0) expect(row, `job ${i}`).toMatchObject({ state: "succeeded", outcome: "already_done", attempt: 1 });
      else expect(row, `job ${i}`).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2 });
      const p = await phases(j.id);
      expect(p.some((x) => x.decision === "deferred"), `job ${i} was deferred during the outage: ${JSON.stringify(p)}`).toBe(true);
      expect(p.some((x) => x.decision === "escalated")).toBe(false);
    }
    const ledger = await env.ledger();
    const report = checkLedger({ jobs: await readJobs(env.pool, jobs.map((j) => j.id)), ledger, drainTimedOut: true });
    expect(report.pass, report.text).toBe(true);
    expect(ledger).toHaveLength(4);
  }, 120_000);
});
