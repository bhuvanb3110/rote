// The chaos harness (docs/plans/step-07.md section 2, reviewer decision B1, docs/DECISIONS.md D33).
//
//   npm run chaos -- [--seed <n>] [--jobs 100] [--workers 4] [--duration 150s] [--pause 45s]
//                    [--drain-timeout 10m] [--out <dir>] [--keep-up]
//
// Drives the Compose fleet through the Docker CLI (the same from PowerShell or Linux):
//   1. seeded schedule (src/chaos/schedule.ts): kills every 5-15 s at a seeded victim, one 45 s
//      `docker pause` (the cgroup freezer: the real SIGSTOP/SIGCONT effect), printed and saved first;
//   2. stack up, queue tables and bank ledger reset, N jobs enqueued through the API;
//   3. the schedule executed: before each kill / pause the harness records which jobs the victim holds
//      (jobs.lease_owner starts with the container's hostname), then `docker kill --signal=KILL`;
//   4. the SUPERVISOR is this harness: `docker start` of the same replica after a short delay (Compose
//      keeps restart: "no", so every restart is logged and attributable). Postgres and the bank are
//      never touched (REPO_NOTES "disagrees" 8);
//   5. drain until every job is terminal or --drain-timeout passes, then the ledger oracle (D32);
//   6. evidence in --out (default evidence/chaos/<UTC timestamp>-seed-<n>/), exit 1 on FAIL.
// Workers, API and bank are stopped at the end (8 GB laptop) unless --keep-up.
//
// Day 1 (Step 7): EXPECTED TO FAIL. Nothing expires a lease or recovers a job yet, so every killed
// worker's job stays `running` forever and holds its tenant slot; the oracle reports LOST.
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSchedule, DEFAULT_CHAOS, drawSeed, type ChaosAction, type ChaosConfig } from "../src/chaos/schedule.js";
import { checkLedger, fetchLedger, readJobs } from "../src/oracle/index.js";
import { createPool, databaseUrlFromEnv, redactDatabaseUrl } from "../src/queue/index.js";
import { argFlag, argValue, createDocker, dockerEnv, FAKE_CREDS, http, parseDuration, toMiB } from "./lib/compose.js";

const API = "http://127.0.0.1:8080";
const BANK = "http://127.0.0.1:4100";
const TENANTS = ["tenant-a", "tenant-b", "tenant-c"];
const ACTIVE = ["running", "committing", "verifying"];

const seed = argValue("seed") !== undefined ? Number(argValue("seed")) : drawSeed();
if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed must be a non-negative integer`);
const JOBS = Number(argValue("jobs") ?? 100);
const config: ChaosConfig = {
  ...DEFAULT_CHAOS,
  seed,
  workers: Number(argValue("workers") ?? DEFAULT_CHAOS.workers),
  durationMs: argValue("duration") ? parseDuration(argValue("duration")!) : DEFAULT_CHAOS.durationMs,
  pauseMs: argValue("pause") ? parseDuration(argValue("pause")!) : DEFAULT_CHAOS.pauseMs,
};
const DRAIN_TIMEOUT_MS = argValue("drain-timeout") ? parseDuration(argValue("drain-timeout")!) : 10 * 60_000;
const started = new Date();
const OUT = argValue("out") ?? path.join("evidence", "chaos", `${started.toISOString().replace(/[:.]/g, "-")}-seed-${seed}`);
const KEEP_UP = argFlag("keep-up");

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

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const schedule = buildSchedule(config);
  const kills = schedule.actions.filter((a) => a.kind === "kill").length;
  log(`Chaos run, started ${started.toISOString()}`);
  log(`seed: ${seed}  (reproduce: npm run chaos -- --seed ${seed})`);
  log(`jobs: ${JOBS}, workers: ${config.workers}, schedule ${config.durationMs} ms: ${kills} kills (gap ${config.minGapMs}-${config.maxGapMs} ms), ` +
    `pause ${schedule.pause ? `replica ${schedule.pause.replica} ${schedule.pause.fromMs}-${schedule.pause.toMs} ms` : "none"}, ` +
    `restart after ${config.restartDelayMs} ms; drain timeout ${DRAIN_TIMEOUT_MS} ms`);
  await writeFile(path.join(OUT, "seed.txt"), `${seed}\n`);
  await writeFile(path.join(OUT, "schedule.json"), JSON.stringify(schedule, null, 2));

  // 1. Stack up, reset, workers up (recreated if the image changed; never the bank).
  await docker(["compose", "up", "-d", "--build", "postgres", "bank", "api"]);
  await waitHealthy({ postgres: 1, bank: 1, api: 1 }, 180_000);
  const dbUrl = databaseUrlFromEnv();
  const pool = createPool({ connectionString: dbUrl, max: 4 });
  log(`database: ${redactDatabaseUrl(dbUrl)}`);
  await pool.query("TRUNCATE jobs, job_attempts, breakers RESTART IDENTITY CASCADE");
  const reset = await fetch(`${BANK}/control/ledger/reset`);
  if (!reset.ok) throw new Error(`ledger reset -> HTTP ${reset.status}`);
  log(`reset: queue tables truncated; bank ledger rows: ${(await fetchLedger(BANK)).length}`);
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
  const execute = async (a: ChaosAction) => {
    const name = replicaName(a.replica);
    try {
      if (a.kind === "kill") {
        const held = await heldBy(a.replica);
        await docker(["kill", "--signal=KILL", name], 30_000);
        event({ kind: "kill", replica: a.replica, container: name, scheduledMs: a.atMs, redirectedFrom: a.redirectedFrom, heldJobs: held });
      } else if (a.kind === "start") {
        await docker(["start", name], 60_000);
        event({ kind: "start", replica: a.replica, container: name, scheduledMs: a.atMs });
      } else if (a.kind === "pause") {
        const held = await heldBy(a.replica);
        await docker(["pause", name], 30_000);
        pausedReplica = a.replica;
        event({ kind: "pause", replica: a.replica, container: name, scheduledMs: a.atMs, heldJobs: held });
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

  // 5. Drain.
  const drainStart = Date.now();
  let drainTimedOut = false;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE state NOT IN ('succeeded','business_outcome','failed','needs_human')");
    if (rows[0]!.n === 0) break;
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
  const ledger = await fetchLedger(BANK);
  const report = checkLedger({ jobs, ledger, drainTimedOut });
  const killEvents = events.map((e) => JSON.parse(e)).filter((e) => e.kind === "kill" || e.kind === "pause");
  // The FIRST kill/pause that found the job leased is the one that orphaned it. A restarted replica
  // keeps its hostname, so later kills of it still see the orphan "held" (lease_owner prefix); they are
  // counted, not blamed. (The before-day2 run's check.txt predates this and lists every such kill.)
  const orphanedBy = (jobId: string) => {
    const hits = killEvents.filter((e) => (e.heldJobs as Array<{ id: string }>).some((h) => h.id === jobId));
    if (hits.length === 0) return [];
    const first = hits[0]!;
    return [`${first.kind} of ${first.container} at ${first.tMs} ms${hits.length > 1 ? ` (still leased at ${hits.length - 1} later event(s) of that replica)` : ""}`];
  };

  log("");
  log(`kills executed: ${killEvents.filter((e) => e.kind === "kill").length}; restarts: ${events.filter((e) => JSON.parse(e).kind === "start").length}; ` +
    `errors: ${events.filter((e) => /-error"/.test(e)).length}`);
  const notTerminal = report.findings.filter((f) => f.verdict === "LOST" || f.verdict === "PENDING");
  if (notTerminal.length > 0) {
    log(`non-terminal jobs tied to the kill or pause that orphaned them:`);
    for (const f of notTerminal) {
      const by = orphanedBy(f.jobId);
      log(`  ${f.jobId} ${f.state} rows=${f.rows}: ${by.length ? by.join("; ") : f.state === "queued" ? "never dequeued (no free tenant slot)" : "not held by a victim at kill time"}`);
    }
  }
  const inspect = await dockerJson<{ Name: string; State: { Status: string; OOMKilled: boolean; ExitCode: number }; RestartCount: number }>([
    "inspect",
    ...[...hostnames.keys()].map(replicaName),
  ]);
  const oom = inspect.filter((c) => c.State.OOMKilled);
  log(`worker containers at the end: ${inspect.map((c) => `${c.Name.replace(/^\//, "")}:${c.State.Status}${c.State.OOMKilled ? ":OOM" : ""}`).join(", ")}`);
  if (oom.length) log(`OOM-killed (not a chaos kill, D9): ${oom.map((c) => c.Name).join(", ")}`);
  const composeLogs = await docker(["compose", "logs", "--no-color", "--timestamps"]);
  const leaks = Object.entries(FAKE_CREDS).filter(([, v]) =>
    [JSON.stringify(jobs), JSON.stringify(attempts), apiResponses.join("\n"), composeLogs].some((t) => t.includes(v)),
  );
  log(`credential values in jobs/attempts/API responses/container logs: ${leaks.length === 0 ? "none" : leaks.map(([k]) => k).join(", ")}`);
  log("docker stats, peak memory per container:");
  for (const [name, mib] of [...peak].sort()) log(`  ${name}: ${mib.toFixed(1)} MiB`);
  log("");
  // The oracle's report, then ONE final RESULT line (the oracle's own, unless a leak or OOM overrides it).
  for (const line of report.text.split("\n").slice(0, -1)) log(line);
  const pass = report.pass && leaks.length === 0 && oom.length === 0;
  log(pass ? "RESULT: PASS" : report.pass ? "RESULT: FAIL (the oracle passed, but a credential leaked or a worker was OOM-killed)" : "RESULT: FAIL");

  await writeFile(path.join(OUT, "events.jsonl"), events.join("\n") + "\n");
  const { text: _text, ...reportJson } = report;
  await writeFile(path.join(OUT, "oracle.json"), JSON.stringify(reportJson, null, 2));
  await writeFile(path.join(OUT, "jobs.json"), JSON.stringify(jobs, null, 2));
  await writeFile(path.join(OUT, "attempts.json"), JSON.stringify(attempts, null, 2));
  await writeFile(path.join(OUT, "ledger.json"), JSON.stringify({ entries: ledger }, null, 2));
  await writeFile(path.join(OUT, "submitted.json"), JSON.stringify(submitted, null, 2));
  await writeFile(path.join(OUT, "docker-stats.jsonl"), statsLines.join("\n") + "\n");
  await writeFile(path.join(OUT, "compose-logs.txt"), composeLogs);
  await writeFile(path.join(OUT, "worker-inspect.json"), JSON.stringify(inspect, null, 2));
  await writeFile(path.join(OUT, "compose-ps-end.txt"), await docker(["compose", "ps", "--all"]));
  await writeFile(path.join(OUT, "check.txt"), lines.join("\n") + "\n");
  await pool.end();
  if (pausedReplica !== null) await docker(["unpause", replicaName(pausedReplica)]).catch(() => undefined);
  if (!KEEP_UP) await docker(["compose", "stop", "worker", "api", "bank"]);
  if (!pass) process.exitCode = 1;
}

main().catch(async (err) => {
  log(`ERROR: ${(err as Error).stack ?? String(err)}`);
  log("RESULT: FAIL (the run did not complete)");
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "check.txt"), lines.join("\n") + "\n");
  await writeFile(path.join(OUT, "events.jsonl"), events.join("\n") + "\n").catch(() => undefined);
  for (let i = 1; i <= config.workers; i += 1) await docker(["unpause", replicaName(i)]).catch(() => undefined);
  if (!KEEP_UP) await docker(["compose", "stop", "worker", "api", "bank"]).catch(() => undefined);
  process.exitCode = 1;
});
