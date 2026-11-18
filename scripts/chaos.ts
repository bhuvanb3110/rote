// The chaos harness (docs/plans/step-07.md section 2, reviewer decision B1, docs/DECISIONS.md D33; the
// families, bank faults and settle-drain of Step 10b, D56).
//
//   npm run chaos -- [--seed <n>] [--jobs 100] [--workers 4] [--duration 150s] [--pause 45s]
//                    [--bank-fault [--no-kills]] [--drain-timeout 10m] [--out <dir>] [--gzip-logs] [--keep-up]
//
// Families (src/chaos/families.ts; step-10 reviewer decision 7), each with its expected outcomes stated and
// judged exactly:
//   standard                         kills every 5-15 s + one 45 s pause
//   --bank-fault                     bank-fault-kills: the same plus the bank down 30 s and slow 60 s (seeded)
//   --bank-fault --no-kills          bank-fault-only: the bank events alone (no kills, no pause)
//
// Drives the Compose fleet through the Docker CLI (the same from PowerShell or Linux):
//   1. seeded schedule (src/chaos/schedule.ts): kills at a seeded victim, the pause (the cgroup freezer: the
//      real SIGSTOP/SIGCONT effect), the bank events; printed and saved first;
//   2. stack up, queue tables and bank ledger reset (and the bank's fault knobs cleared), N jobs enqueued
//      through the API;
//   3. the schedule executed: around each kill / pause the harness records which jobs the victim holds
//      (jobs.lease_owner starts with the container's hostname) BEFORE the docker call and AGAIN right after
//      it returns (Step 10b's snapshot fix: `docker kill` takes a second or two on Docker Desktop, and a dead
//      or frozen container cannot move its rows, while recovery needs a full lease); the post-call read is
//      the one that says what was orphaned. A bank event is a GET of the bank's /control/<control>;
//   4. the SUPERVISOR is this harness: `docker start` of the same replica after a short delay (Compose keeps
//      restart: "no", so every restart is logged and attributable). Postgres and the bank container are never
//      restarted (REPO_NOTES "disagrees" 8);
//   5. drain until every job is SETTLED (terminal, and its reconcile done if one was due: D50, D55) or
//      --drain-timeout passes, then the ledger oracle (D32) and the family judge;
//   6. evidence in --out (default evidence/chaos/<UTC timestamp>[-<family>]-seed-<n>/), including
//      summary.json (what scripts/chaos-seeds.ts tallies); exit 1 on FAIL.
// Workers, API and bank are stopped at the end (8 GB laptop) unless --keep-up.
//
// Step 7 (before-day2): failed by design. Step 8: leases, heartbeat, recovery. Step 9: a job killed after its
// intent is verified in the bank's history. Step 10a: backoff (D49), the reconcile pass (D50). Step 10b:
// families, bank faults, drain until settled, the reconcile of failed / business_outcome jobs (D55).
import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  describeAttributed,
  judgeCrashLimitEscalation,
  type AttemptRowForDeaths,
  type ChaosEventForDeaths,
  type PhaseRowForDeaths,
} from "../src/chaos/attribution.js";
import { acceptedEscalations, FAMILY_SPECS, familyFromFlags, judgeFamily } from "../src/chaos/families.js";
import { buildSchedule, DEFAULT_CHAOS, drawSeed, type ChaosAction, type ChaosConfig } from "../src/chaos/schedule.js";
import { recoveryKinds, type SeedSummary } from "../src/chaos/tally.js";
import { jobSettled } from "../src/fleet/stateMachine.js";
import { checkLedger, fetchLedger, readJobs } from "../src/oracle/index.js";
import { createPool, databaseUrlFromEnv, redactDatabaseUrl } from "../src/queue/index.js";
import { argFlag, argValue, createDocker, dockerEnv, FAKE_CREDS, http, parseDuration, toMiB } from "./lib/compose.js";

const API = "http://127.0.0.1:8080";
const BANK = "http://127.0.0.1:4100";
const TENANTS = ["tenant-a", "tenant-b", "tenant-c"];
const ACTIVE = ["running", "committing", "verifying"];

const seed = argValue("seed") !== undefined ? Number(argValue("seed")) : drawSeed();
if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed must be a non-negative integer`);
const family = familyFromFlags({ bankFault: argFlag("bank-fault"), noKills: argFlag("no-kills") });
const spec = FAMILY_SPECS[family];
const JOBS = Number(argValue("jobs") ?? 100);
const config: ChaosConfig = {
  ...DEFAULT_CHAOS,
  seed,
  workers: Number(argValue("workers") ?? DEFAULT_CHAOS.workers),
  durationMs: argValue("duration") ? parseDuration(argValue("duration")!) : DEFAULT_CHAOS.durationMs,
  pauseMs: spec.pause ? (argValue("pause") ? parseDuration(argValue("pause")!) : DEFAULT_CHAOS.pauseMs) : 0,
  kills: spec.kills,
  bankFaults: spec.bankFaults,
};
const DRAIN_TIMEOUT_MS = argValue("drain-timeout") ? parseDuration(argValue("drain-timeout")!) : 10 * 60_000;
const started = new Date();
const OUT =
  argValue("out") ?? path.join("evidence", "chaos", `${started.toISOString().replace(/[:.]/g, "-")}${family === "standard" ? "" : `-${family}`}-seed-${seed}`);
const KEEP_UP = argFlag("keep-up");
const GZIP_LOGS = argFlag("gzip-logs");

const { docker, dockerJson, waitHealthy } = createDocker(dockerEnv(config.workers));
const lines: string[] = [];
function log(line: string): void {
  console.log(line);
  lines.push(line);
}
const events: string[] = [];
let t0 = 0;
function event(e: Record<string, unknown>): void {
  const line = JSON.stringify({ tMs: t0 ? Date.now() - t0 : null, at: new Date().toISOString(), ...e });
  events.push(line);
  console.log(`  event ${line}`);
}

const replicaName = (i: number) => `rote-worker-${i}`;

async function gitCommit(): Promise<string> {
  const run = promisify(execFile);
  try {
    const head = (await run("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== "";
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

async function bankControl(control: string): Promise<string> {
  const res = await fetch(`${BANK}/control/${control}`);
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`GET /control/${control} -> HTTP ${res.status}: ${text}`);
  return text;
}

/** The summary of a run that did not finish (scripts/chaos-seeds.ts counts it as a failed seed). */
function incompleteSummary(error: string, commit: string): SeedSummary {
  return {
    version: 1,
    completed: false,
    error,
    seed,
    family,
    jobs: JOBS,
    workers: config.workers,
    durationMs: config.durationMs,
    pauseMs: config.pauseMs,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    commit,
    startedAt: started.toISOString(),
    wallMs: Date.now() - started.getTime(),
    workMs: null,
    drainMs: null,
    drainTimedOut: false,
    kills: 0,
    restarts: 0,
    actionErrors: 0,
    pause: null,
    bank: null,
    bankControlsApplied: 0,
    oracle: { pass: false, counts: {}, ledgerRows: 0 },
    finals: {},
    needsHuman: [],
    failed: [],
    notSettled: 0,
    recoveries: recoveryKinds([], []),
    workerProtections: {},
    leaks: [],
    oom: [],
    problems: [`the run did not complete: ${error}`],
    pass: false,
  };
}

let commit = "unknown";

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  commit = await gitCommit();
  const schedule = buildSchedule(config);
  const kills = schedule.actions.filter((a) => a.kind === "kill").length;
  log(`Chaos run, started ${started.toISOString()} (code ${commit})`);
  log(`family: ${family} -- ${spec.description}; expected final states: ${spec.allowedFinal.join(", ")} (src/chaos/families.ts)`);
  log(`seed: ${seed}  (reproduce: npm run chaos -- --seed ${seed}${family === "bank-fault-kills" ? " --bank-fault" : family === "bank-fault-only" ? " --bank-fault --no-kills" : ""} --jobs ${JOBS} --duration ${config.durationMs / 1000}s)`);
  log(
    `jobs: ${JOBS}, workers: ${config.workers}, schedule ${config.durationMs} ms: ${kills} kills (gap ${config.minGapMs}-${config.maxGapMs} ms), ` +
      `pause ${schedule.pause ? `replica ${schedule.pause.replica} ${schedule.pause.fromMs}-${schedule.pause.toMs} ms` : "none"}, ` +
      `bank ${schedule.bank ? `down ${schedule.bank.outage.fromMs}-${schedule.bank.outage.toMs} ms, slow (${schedule.bank.slow.latencyMs} ms) ${schedule.bank.slow.fromMs}-${schedule.bank.slow.toMs} ms` : "no faults"}, ` +
      `restart after ${config.restartDelayMs} ms; drain (until settled) timeout ${DRAIN_TIMEOUT_MS} ms`,
  );
  await writeFile(path.join(OUT, "seed.txt"), `${seed}\n`);
  await writeFile(path.join(OUT, "schedule.json"), JSON.stringify(schedule, null, 2));

  // 1. Stack up, reset, workers up (recreated if the image changed; never the bank).
  await docker(["compose", "up", "-d", "--build", "postgres", "bank", "api"]);
  await waitHealthy({ postgres: 1, bank: 1, api: 1 }, 180_000);
  const dbUrl = databaseUrlFromEnv();
  const pool = createPool({ connectionString: dbUrl, max: 4 });
  log(`database: ${redactDatabaseUrl(dbUrl)}`);
  await pool.query("TRUNCATE jobs, job_attempts, job_verifications, breakers RESTART IDENTITY CASCADE");
  const reset = await fetch(`${BANK}/control/ledger/reset`);
  if (!reset.ok) throw new Error(`ledger reset -> HTTP ${reset.status}`);
  // A run killed mid-way with --keep-up could have left a fault on.
  const knobs = [await bankControl("errors/off"), await bankControl("latency/0"), await bankControl("history-lag/0")];
  log(`reset: queue tables truncated; bank ledger rows: ${(await fetchLedger(BANK)).length}; bank knobs: ${knobs.join(", ")}`);
  await docker(["compose", "up", "-d", "--no-deps", "--scale", `worker=${config.workers}`, "worker"]);
  await waitHealthy({ postgres: 1, bank: 1, api: 1, worker: config.workers }, 180_000);
  await writeFile(path.join(OUT, "compose-ps-up.txt"), await docker(["compose", "ps", "--all"]));

  // Replica -> container hostname (the prefix of its workers' lease_owner; it survives docker start).
  const hostnames = new Map<number, string>();
  for (let i = 1; i <= config.workers; i += 1) {
    hostnames.set(i, (await docker(["inspect", "--format", "{{.Config.Hostname}}", replicaName(i)])).trim());
  }
  log(`replicas: ${[...hostnames].map(([i, h]) => `${replicaName(i)}=${h}`).join(", ")}`);

  const heldBy = async (replica: number) =>
    (
      await pool.query<{ id: string; state: string; attempt: number }>(
        "SELECT id, state, attempt FROM jobs WHERE lease_owner LIKE $1 AND state = ANY($2) ORDER BY id",
        [`${hostnames.get(replica)}-%`, ACTIVE],
      )
    ).rows;

  // docker stats sampler.
  let sampling = true;
  const statsLines: string[] = [];
  const peak = new Map<string, number>();
  const statsSampler = (async () => {
    while (sampling) {
      try {
        const rows = await dockerJson<{ Name: string; MemUsage: string; CPUPerc: string }>(["stats", "--no-stream", "--format", "json"]);
        const at = new Date().toISOString();
        for (const r of rows) {
          if (!r.Name.startsWith("rote-")) continue;
          statsLines.push(JSON.stringify({ at, ...r }));
          const mib = toMiB(r.MemUsage.split("/")[0]!.trim());
          if (!(mib <= (peak.get(r.Name) ?? -1))) peak.set(r.Name, mib);
        }
      } catch (err) {
        statsLines.push(JSON.stringify({ error: (err as Error).message }));
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  })();

  // 2 + 3. Clock starts at the first enqueue; the schedule runs alongside the enqueue and the work.
  t0 = Date.now();
  event({ kind: "clock-start" });
  let pausedReplica: number | null = null;
  let bankControlsApplied = 0;
  const execute = async (a: ChaosAction) => {
    if (a.kind === "bank") {
      try {
        const answer = await bankControl(a.control);
        bankControlsApplied += 1;
        event({ kind: "bank", control: a.control, scheduledMs: a.atMs, answer });
      } catch (err) {
        event({ kind: "bank-error", control: a.control, scheduledMs: a.atMs, error: (err as Error).message.split("\n")[0] });
      }
      return;
    }
    const name = replicaName(a.replica);
    try {
      if (a.kind === "kill") {
        const before = await heldBy(a.replica);
        await docker(["kill", "--signal=KILL", name], 30_000);
        // The snapshot fix (plan section 5): read again once the kill has returned; a dead container cannot
        // move its rows, and recovery needs a full lease, so this read is what the kill orphaned.
        const held = await heldBy(a.replica);
        event({ kind: "kill", replica: a.replica, container: name, scheduledMs: a.atMs, redirectedFrom: a.redirectedFrom, heldJobs: held, heldJobsBeforeKill: before });
      } else if (a.kind === "start") {
        await docker(["start", name], 60_000);
        event({ kind: "start", replica: a.replica, container: name, scheduledMs: a.atMs });
      } else if (a.kind === "pause") {
        const before = await heldBy(a.replica);
        await docker(["pause", name], 30_000);
        pausedReplica = a.replica;
        event({ kind: "pause", replica: a.replica, container: name, scheduledMs: a.atMs, heldJobs: await heldBy(a.replica), heldJobsBeforePause: before });
      } else {
        await docker(["unpause", name], 30_000);
        pausedReplica = null;
        event({ kind: "unpause", replica: a.replica, container: name, scheduledMs: a.atMs, heldJobs: await heldBy(a.replica) });
      }
    } catch (err) {
      event({ kind: `${a.kind}-error`, replica: a.replica, container: name, scheduledMs: a.atMs, error: (err as Error).message.split("\n")[0] });
    }
  };
  const scheduleRun = (async () => {
    for (const a of schedule.actions) {
      const wait = t0 + a.atMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await execute(a);
    }
    event({ kind: "schedule-done" });
  })();

  const submitted: Array<{ key: string; tenant: string; jobId?: string; status: number }> = [];
  const apiResponses: string[] = [];
  for (let i = 0; i < JOBS; i += 1) {
    const tenant = TENANTS[i % TENANTS.length]!;
    const key = `chaos-${seed}-${started.getTime()}-${String(i).padStart(3, "0")}`;
    const res = await http("POST", `${API}/capabilities/transfer/invoke?mode=async`, {
      tenant,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    }, key);
    apiResponses.push(res.text);
    submitted.push({ key, tenant, jobId: res.json?.jobId, status: res.status });
  }
  const n201 = submitted.filter((s) => s.status === 201).length;
  event({ kind: "enqueue-done", created: n201, of: JOBS });
  log(`enqueued: ${n201}/${JOBS} x 201`);
  await scheduleRun;

  // 5. Drain until every job is SETTLED: terminal, and no reconcile due (jobSettled, D50 / D55). A job that
  // turned terminal after a [0, 0] verify is re-read lease + settle + margin later (60 s in Compose).
  const drainStart = Date.now();
  let drainTimedOut = false;
  let lastSettledAt = Date.now();
  for (;;) {
    const { rows } = await pool.query<{ state: string; reconcile_after: Date | null; reconciled_at: Date | null; reconcile_abandoned_at: Date | null }>(
      "SELECT state, reconcile_after, reconciled_at, reconcile_abandoned_at FROM jobs",
    );
    const unsettled = rows.filter((r) => !jobSettled(r)).length;
    if (unsettled === 0) {
      lastSettledAt = Date.now();
      break;
    }
    if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
      drainTimedOut = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  event({ kind: "drain-done", timedOut: drainTimedOut, ms: Date.now() - drainStart });
  sampling = false;
  await statsSampler;

  // 6. Oracle + evidence.
  const jobs = await readJobs(pool);
  const attempts = (await pool.query("SELECT * FROM job_attempts ORDER BY id")).rows;
  const verifications = (await pool.query("SELECT * FROM job_verifications ORDER BY id")).rows;
  const ledger = await fetchLedger(BANK);
  const report = checkLedger({ jobs, ledger, drainTimedOut });
  // Clear the bank's knobs (the schedule turns them off itself; this covers an action that failed).
  await bankControl("errors/off").catch(() => undefined);
  await bankControl("latency/0").catch(() => undefined);
  const parsed = events.map((e) => JSON.parse(e) as Record<string, unknown>);
  const killEvents = parsed.filter((e) => e.kind === "kill" || e.kind === "pause");
  // The FIRST kill/pause whose POST-call read found the job leased is the one that orphaned it. A restarted
  // replica keeps its hostname, so later kills of it still see an unrecovered orphan "held" (lease_owner
  // prefix); they are counted, not blamed.
  const orphanedBy = (jobId: string) => {
    const hits = killEvents.filter((e) => (e.heldJobs as Array<{ id: string }>).some((h) => h.id === jobId));
    if (hits.length === 0) return [];
    const first = hits[0]!;
    return [`${first.kind} of ${first.container} at ${first.tMs} ms${hits.length > 1 ? ` (still leased at ${hits.length - 1} later event(s) of that replica)` : ""}`];
  };
  const snapshotDiffs = killEvents.filter((e) => {
    const before = (e.heldJobsBeforeKill ?? e.heldJobsBeforePause) as Array<{ id: string; state: string }> | undefined;
    const after = e.heldJobs as Array<{ id: string; state: string }>;
    return before !== undefined && JSON.stringify(before) !== JSON.stringify(after);
  }).length;

  const executedKills = parsed.filter((e) => e.kind === "kill").length;
  const restarts = parsed.filter((e) => e.kind === "start").length;
  const actionErrors = parsed.filter((e) => typeof e.kind === "string" && e.kind.endsWith("-error")).length;
  log("");
  log(`kills executed: ${executedKills}; restarts: ${restarts}; errors: ${actionErrors}; kills/pauses whose post-call snapshot differed from the pre-call one: ${snapshotDiffs}`);
  if (spec.bankFaults) {
    log(`bank controls applied: ${bankControlsApplied} of 4 (${parsed.filter((e) => e.kind === "bank").map((e) => `${e.control} at ${e.tMs} ms`).join(", ")})`);
  }
  const recoveries = recoveryKinds(
    attempts as Array<{ outcome: string | null; error: string | null }>,
    verifications as Array<{ reason: string; decision: string | null; error: string | null }>,
  );
  log(
    `recovery kinds (decision 8): ${Object.entries(recoveries)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} x${n}`)
      .join(", ") || "none"}`,
  );
  const decisions = new Map<string, number>();
  for (const v of verifications as Array<{ reason: string; decision: string | null; lookups: Array<number | null> | null }>) {
    const k = `${v.decision ?? "(open)"}${v.lookups ? JSON.stringify(v.lookups) : ""} (${v.reason})`;
    decisions.set(k, (decisions.get(k) ?? 0) + 1);
  }
  log(`verify and reconcile phases (job_verifications: decision[lookups] (reason)): ${[...decisions].sort().map(([k, n]) => `${k} x${n}`).join(", ") || "none"}`);
  const needsHuman = jobs.filter((j) => j.state === "needs_human");
  const failed = jobs.filter((j) => j.state === "failed");
  const attemptsOf = (id: string) =>
    (attempts as Array<{ job_id: string; attempt: number; outcome: string | null }>).filter((a) => a.job_id === id).map((a) => `${a.attempt}:${a.outcome ?? "open"}`);
  const attemptOutcomes = new Map<string, number>();
  for (const a of attempts as Array<{ outcome: string | null }>) attemptOutcomes.set(a.outcome ?? "(open)", (attemptOutcomes.get(a.outcome ?? "(open)") ?? 0) + 1);
  const finals: Record<string, number> = {};
  for (const j of jobs) finals[`${j.state}${j.outcome ? `/${j.outcome}` : ""}`] = (finals[`${j.state}${j.outcome ? `/${j.outcome}` : ""}`] ?? 0) + 1;
  const notSettled = jobs.filter((j) => !jobSettled(j)).length;
  log(`needs_human jobs: ${needsHuman.length}${needsHuman.length ? ` (${needsHuman.map((j) => `${j.id} ${j.outcome}`).join(", ")})` : ""} (the ${family} family allows none)`);
  log(`failed jobs: ${failed.length}${failed.length ? ` (${failed.map((j) => `${j.id} ${j.outcome} attempts ${attemptsOf(j.id).join(" ")}`).join("; ")})` : ""}`);
  // The two budgets (D57), read from jobs: how many jobs a worker died under before the intent, and how many
  // were leased past max_attempts -- possible only because those deaths did not use attempts.
  const budgetRows = (await pool.query<{ attempt: number; max_attempts: number; crashes: number; max_crashes: number }>("SELECT attempt, max_attempts, crashes, max_crashes FROM jobs")).rows;
  const crashBudget = {
    jobsWithCrashes: budgetRows.filter((r) => r.crashes > 0).length,
    totalCrashes: budgetRows.reduce((n, r) => n + r.crashes, 0),
    maxCrashesOnOneJob: budgetRows.reduce((n, r) => Math.max(n, r.crashes), 0),
    jobsLeasedPastMaxAttempts: budgetRows.filter((r) => r.attempt > r.max_attempts).length,
    crashLimit: budgetRows.filter((r) => r.crashes >= r.max_crashes).length,
  };
  log(
    `crash budget (D57): ${crashBudget.totalCrashes} crash(es) on ${crashBudget.jobsWithCrashes} job(s), at most ${crashBudget.maxCrashesOnOneJob} on one job; ` +
      `${crashBudget.jobsLeasedPastMaxAttempts} job(s) leased past max_attempts (crashes used no attempt); ${crashBudget.crashLimit} at the crash cap`,
  );
  // D59: reconciler deaths, counted apart from the job's crashes; a job the pass abandoned fails every family.
  const reconcileRows = (await pool.query<{ id: string; reconcile_crashes: number; abandoned: boolean }>(
    "SELECT id, reconcile_crashes, reconcile_abandoned_at IS NOT NULL AS abandoned FROM jobs WHERE reconcile_crashes > 0 OR reconcile_abandoned_at IS NOT NULL ORDER BY id",
  )).rows;
  const reconcileAbandoned = reconcileRows.filter((r) => r.abandoned).map((r) => r.id);
  log(
    `reconciler deaths (D59): ${reconcileRows.reduce((n, r) => n + r.reconcile_crashes, 0)} on ${reconcileRows.filter((r) => r.reconcile_crashes > 0).length} job(s); ` +
      `${reconcileAbandoned.length} reconcile(s) abandoned by the pass${reconcileAbandoned.length ? ` (${reconcileAbandoned.join(", ")})` : ""}`,
  );
  log(`attempt outcomes: ${[...attemptOutcomes].sort().map(([k, n]) => `${k} x${n}`).join(", ")}`);
  log(`final job states: ${Object.entries(finals).sort().map(([k, n]) => `${k} x${n}`).join(", ")}`);
  log(`settled: ${jobs.length - notSettled}/${jobs.length}; drain ${Math.round((Date.now() - drainStart) / 1000)} s${drainTimedOut ? " (TIMED OUT)" : ""}`);
  const notTerminal = report.findings.filter((f) => f.verdict === "LOST" || f.verdict === "PENDING");
  if (notTerminal.length > 0) {
    log(`non-terminal jobs tied to the kill or pause that orphaned them:`);
    for (const f of notTerminal) {
      const by = orphanedBy(f.jobId);
      log(`  ${f.jobId} ${f.state} rows=${f.rows}: ${by.length ? by.join("; ") : f.state === "queued" ? "never dequeued (no free tenant slot)" : "not held by a victim after the kill"}`);
    }
  }
  const inspect = await dockerJson<{ Name: string; State: { Status: string; OOMKilled: boolean; ExitCode: number }; RestartCount: number }>([
    "inspect",
    ...[...hostnames.keys()].map(replicaName),
  ]);
  const oom = inspect.filter((c) => c.State.OOMKilled).map((c) => c.Name.replace(/^\//, ""));
  log(`worker containers at the end: ${inspect.map((c) => `${c.Name.replace(/^\//, "")}:${c.State.Status}${c.State.OOMKilled ? ":OOM" : ""}`).join(", ")}`);
  if (oom.length) log(`OOM-killed (not a chaos kill, D9): ${oom.join(", ")}`);
  // This run's logs only: Compose reuses the containers between runs (same image), and `compose logs` would
  // otherwise return every earlier run's lines too (their protections and flags counted as this run's).
  const composeLogs = await docker(["compose", "logs", "--no-color", "--timestamps", "--since", started.toISOString()]);
  const logLines = composeLogs.split("\n");
  const count = (re: RegExp) => logLines.filter((l) => re.test(l)).length;
  const workerProtections = {
    heartbeatLeaseLost: count(/heartbeat: lease lost; aborting the job/),
    fencedCommitIntent: count(/FencingError: commit intent refused/),
    completionFencedOut: count(/lease lost; outcome NOT recorded on the job/),
    runAbortedOnLostLease: count(/lease lost; run aborted, outcome NOT recorded/),
    verifyPhaseAborted: count(/verify: lease lost; phase aborted/),
    verifyDecisionFencedOut: count(/verify: lease lost; decision NOT recorded/),
    reconcileDecisionFencedOut: count(/reconcile: lease lost; decision NOT recorded/),
    duplicatesDetected: count(/reconcile: DUPLICATE SUSPECTED/),
    unrecordedCommitsDetected: count(/reconcile: UNRECORDED COMMIT SUSPECTED/),
    reconcileAbandoned: count(/reconcile: ABANDONED/), // D59
  };
  log(`worker protections fired (container logs): ${Object.entries(workerProtections).map(([k, n]) => `${k} x${n}`).join(", ")}`);
  const leaks = Object.entries(FAKE_CREDS)
    .filter(([, v]) => [JSON.stringify(jobs), JSON.stringify(attempts), apiResponses.join("\n"), composeLogs].some((t) => t.includes(v)))
    .map(([k]) => k);
  log(`credential values in jobs/attempts/API responses/container logs: ${leaks.length === 0 ? "none" : leaks.join(", ")}`);
  log("docker stats, peak memory per container:");
  for (const [name, mib] of [...peak].sort()) log(`  ${name}: ${mib.toFixed(1)} MiB`);
  log("");
  // The oracle's report, then the family judge, then ONE final RESULT line.
  for (const line of report.text.split("\n").slice(0, -1)) log(line);
  const oracleBad = Object.fromEntries(Object.entries(report.counts).filter(([v, n]) => v !== "ok" && n > 0));
  // D58: every needs_human / crash_limit job, judged on its own history (src/chaos/attribution.ts): every death
  // matched to a scheduled kill or pause of its worker, and at most 1 ledger row for its memo_key.
  const capped = (await pool.query<{ id: string; memo_key: string; crashes: number }>("SELECT id, memo_key, crashes FROM jobs WHERE state = 'needs_human' AND outcome = 'crash_limit' ORDER BY id")).rows;
  const crashLimitEscalations = capped.map((j) =>
    judgeCrashLimitEscalation({
      jobId: j.id,
      crashes: j.crashes,
      ledgerRows: ledger.filter((r) => r.memo === j.memo_key).length,
      attempts: attempts as AttemptRowForDeaths[],
      phases: verifications as PhaseRowForDeaths[],
      events: parsed as unknown as ChaosEventForDeaths[],
      hostnameOfReplica: hostnames,
    }),
  );
  for (const v of crashLimitEscalations) {
    log(`crash-cap escalation ${v.jobId}: ${v.attributed ? "ATTRIBUTED" : "NOT attributed"}; ${v.crashes} crashes, ${v.ledgerRows} ledger row(s)${v.reasons.length ? `; ${v.reasons.join("; ")}` : ""}`);
    for (const d of v.deaths) {
      log(`  ${d.row} ${d.n} of ${d.holder} (${d.recovery}), held ${d.startedAt} .. ${d.endedAt ?? "open"}: ${d.event ? `${d.event.kind} of ${d.event.container} at ${d.event.tMs === null ? d.event.at : `${(d.event.tMs / 1000).toFixed(1)} s`}` : "NO scheduled kill or pause"}`);
    }
  }
  const problems = judgeFamily(spec, {
    oraclePass: report.pass,
    oracleBad,
    finals,
    notSettled,
    drainTimedOut,
    leaks,
    oom,
    bankControlErrors: parsed.filter((e) => e.kind === "bank-error").length,
    bankControlsApplied,
    requeuedAfterFailure: recoveries.requeuedAfterFailure,
    deferrals: recoveries.deferred + recoveries.reconcile_deferred,
    crashLimitEscalations,
    reconcileAbandoned,
  });
  const accepted = acceptedEscalations(spec, { crashLimitEscalations });
  log("");
  log(`family judge (${family}; src/chaos/families.ts): ${problems.length === 0 ? "every expectation met" : problems.join("; ")}`);
  const pass = problems.length === 0;
  // Never a plain pass with an accepted escalation (the reviewer decision during 10b, decision 3).
  log(
    !pass
      ? `RESULT: FAIL (${problems.join("; ")})`
      : accepted.length > 0
        ? `RESULT: PASS WITH ${accepted.length} ESCALATION(S) BY CRASH CAP (ATTRIBUTED): ${accepted.map(describeAttributed).join("; ")}`
        : "RESULT: PASS",
  );

  const firstEnqueue = jobs.length ? Math.min(...jobs.map((j) => j.created_at.getTime())) : t0;
  const summary: SeedSummary = {
    version: 1,
    completed: true,
    seed,
    family,
    jobs: JOBS,
    workers: config.workers,
    durationMs: config.durationMs,
    pauseMs: config.pauseMs,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    commit,
    startedAt: started.toISOString(),
    wallMs: Date.now() - started.getTime(),
    workMs: drainTimedOut ? null : lastSettledAt - firstEnqueue,
    drainMs: Date.now() - drainStart,
    drainTimedOut,
    kills: executedKills,
    restarts,
    actionErrors,
    pause: schedule.pause,
    bank: schedule.bank,
    bankControlsApplied,
    oracle: { pass: report.pass, counts: report.counts, ledgerRows: report.ledgerRows },
    finals,
    needsHuman: needsHuman.map((j) => ({ id: j.id, outcome: j.outcome })),
    failed: failed.map((j) => ({ id: j.id, outcome: j.outcome, attempts: attemptsOf(j.id) })),
    notSettled,
    recoveries,
    crashBudget,
    escalatedByCrashCapAttributed: accepted.map((v) => ({
      jobId: v.jobId,
      crashes: v.crashes,
      ledgerRows: v.ledgerRows,
      deaths: v.deaths.map((d) => ({ row: d.row, n: d.n, holder: d.holder, recovery: d.recovery, event: d.event })),
    })),
    reconcileAbandoned,
    workerProtections,
    leaks,
    oom,
    problems,
    pass,
  };

  await writeFile(path.join(OUT, "events.jsonl"), events.join("\n") + "\n");
  const { text: _text, ...reportJson } = report;
  await writeFile(path.join(OUT, "oracle.json"), JSON.stringify(reportJson, null, 2));
  await writeFile(path.join(OUT, "jobs.json"), JSON.stringify(jobs, null, 2));
  await writeFile(path.join(OUT, "attempts.json"), JSON.stringify(attempts, null, 2));
  await writeFile(path.join(OUT, "verifications.json"), JSON.stringify(verifications, null, 2));
  await writeFile(path.join(OUT, "ledger.json"), JSON.stringify({ entries: ledger }, null, 2));
  await writeFile(path.join(OUT, "submitted.json"), JSON.stringify(submitted, null, 2));
  await writeFile(path.join(OUT, "docker-stats.jsonl"), statsLines.join("\n") + "\n");
  if (GZIP_LOGS) await writeFile(path.join(OUT, "compose-logs.txt.gz"), gzipSync(composeLogs));
  else await writeFile(path.join(OUT, "compose-logs.txt"), composeLogs);
  await writeFile(path.join(OUT, "worker-inspect.json"), JSON.stringify(inspect, null, 2));
  await writeFile(path.join(OUT, "compose-ps-end.txt"), await docker(["compose", "ps", "--all"]));
  await writeFile(path.join(OUT, "check.txt"), lines.join("\n") + "\n");
  await pool.end();
  if (pausedReplica !== null) await docker(["unpause", replicaName(pausedReplica)]).catch(() => undefined);
  if (!KEEP_UP) await docker(["compose", "stop", "worker", "api", "bank"]);
  // Last: chaos-seeds.ts treats a folder with summary.json as finished.
  await writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  // 3: passed its family judge with an attributed escalation by the crash cap (D58), not a plain pass.
  if (!pass) process.exitCode = 1;
  else if (accepted.length > 0) process.exitCode = 3;
}

main().catch(async (err) => {
  log(`ERROR: ${(err as Error).stack ?? String(err)}`);
  log("RESULT: FAIL (the run did not complete)");
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "check.txt"), lines.join("\n") + "\n");
  await writeFile(path.join(OUT, "events.jsonl"), events.join("\n") + "\n").catch(() => undefined);
  await bankControl("errors/off").catch(() => undefined);
  await bankControl("latency/0").catch(() => undefined);
  for (let i = 1; i <= config.workers; i += 1) await docker(["unpause", replicaName(i)]).catch(() => undefined);
  if (!KEEP_UP) await docker(["compose", "stop", "worker", "api", "bank"]).catch(() => undefined);
  await writeFile(path.join(OUT, "summary.json"), JSON.stringify(incompleteSummary((err as Error).message.split("\n")[0] ?? String(err), commit), null, 2));
  process.exitCode = 1;
});
