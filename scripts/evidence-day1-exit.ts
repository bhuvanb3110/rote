// Day-1 exit (docs/FLEET_BRIEF.md; docs/plans/step-06.md section 9 and its reviewer decisions):
// 100 transfer jobs across 4 workers, all succeeded, checked by a script that reads the bank's
// /control/ledger: exactly 1 ledger row per job (matched by memo_key), 0 duplicates, 0 lost, every
// job in a terminal state. Writes --out (default evidence/fleet-day1-exit/) with check.txt ending in
// RESULT: PASS or RESULT: FAIL, and exits 1 on FAIL. No tuning: whatever happens is recorded. Since
// Step 7 the ledger verdicts come from the shared oracle (src/oracle, D32) and Docker helpers from
// scripts/lib/compose.ts.
//
//   npm run evidence:day1 [-- --out evidence/fleet-day1-exit-oracle]   (Docker Desktop running)
//
// Steps: stack up (postgres, bank, api) -> reset the dev queue tables and the bank ledger -> 4 workers
// up -> POST 100 async jobs (tenants a/b/c round-robin) -> POST the same 100 again (idempotency) ->
// poll GET /jobs/:id until terminal (10 min drain timeout) while sampling the per-tenant active count
// and `docker stats` -> checks -> graceful `docker compose stop worker` (exit codes recorded).
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkLedger, fetchLedger, readJobs, type LedgerRow } from "../src/oracle/index.js";
import { createPool, databaseUrlFromEnv, redactDatabaseUrl } from "../src/queue/index.js";
import { argValue, createDocker, dockerEnv, FAKE_CREDS, http, toMiB, type PsRow } from "./lib/compose.js";

// --out: where the evidence goes. Step 6's run is evidence/fleet-day1-exit/; the Step 7 re-run on the
// oracle (D32) writes evidence/fleet-day1-exit-oracle/.
const OUT = argValue("out") ?? path.join("evidence", "fleet-day1-exit");
const API = "http://127.0.0.1:8080";
const BANK = "http://127.0.0.1:4100";
const JOBS = 100;
const WORKERS = 4;
const TENANTS = ["tenant-a", "tenant-b", "tenant-c"];
const DRAIN_TIMEOUT_MS = 10 * 60_000;
const TERMINAL = new Set(["succeeded", "business_outcome", "failed", "needs_human"]);
const CREDS = FAKE_CREDS;
const { docker, dockerJson, waitHealthy } = createDocker(dockerEnv(WORKERS));

const lines: string[] = [];
function log(line: string): void {
  console.log(line);
  lines.push(line);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const started = new Date();
  const failures: string[] = [];
  const timings: Record<string, number> = {};
  log(`Day-1 exit run, started ${started.toISOString()}`);
  log(`jobs: ${JOBS}, workers: ${WORKERS}, tenants: ${TENANTS.join(", ")}, capability: transfer`);

  // 1. Stack up without workers, reset state, then the workers.
  let t = Date.now();
  await docker(["compose", "up", "-d", "--build", "postgres", "bank", "api"]);
  await waitHealthy({ postgres: 1, bank: 1, api: 1 }, 180_000);
  timings.stackUpMs = Date.now() - t;

  const dbUrl = databaseUrlFromEnv();
  const pool = createPool({ connectionString: dbUrl, max: 4 });
  log(`database: ${redactDatabaseUrl(dbUrl)}`);
  // The dev database's queue tables are emptied so this run's jobs are the only jobs (tenants kept).
  await pool.query("TRUNCATE jobs, job_attempts, breakers RESTART IDENTITY CASCADE");
  const reset = await fetch(`${BANK}/control/ledger/reset`);
  if (!reset.ok) throw new Error(`ledger reset -> HTTP ${reset.status}`);
  const ledgerBefore = await fetchLedger(BANK);
  log(`reset: queue tables truncated; bank ledger rows before the run: ${ledgerBefore.length}`);

  t = Date.now();
  // --no-deps: never recreate the bank (its ledger was just reset). Workers ARE recreated if the image
  // changed (Step 6 used --no-recreate, which would start old containers on an old image).
  await docker(["compose", "up", "-d", "--no-deps", "--scale", `worker=${WORKERS}`, "worker"]);
  const psUp = await waitHealthy({ postgres: 1, bank: 1, api: 1, worker: WORKERS }, 180_000);
  timings.workersUpMs = Date.now() - t;
  await writeFile(path.join(OUT, "compose-ps-up.txt"), await docker(["compose", "ps", "--all"]));
  log(`stack healthy: ${psUp.map((r) => `${r.Name}=${r.Health}`).join(", ")}`);

  // Samplers: per-tenant active count (the cap) and docker stats (memory per container).
  let sampling = true;
  let maxActivePerTenant = 0;
  let activeSamples = 0;
  const activeSampler = (async () => {
    while (sampling) {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT coalesce(max(n), 0)::int AS n FROM (SELECT count(*) AS n FROM jobs WHERE state IN ('running','committing','verifying') GROUP BY tenant_id) t",
      );
      maxActivePerTenant = Math.max(maxActivePerTenant, rows[0]!.n);
      activeSamples += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  const statsLines: string[] = [];
  const peakMiB = new Map<string, { peak: number; limit: string }>();
  const statsSampler = (async () => {
    while (sampling) {
      try {
        const rows = await dockerJson<{ Name: string; MemUsage: string; CPUPerc: string; MemPerc: string }>([
          "stats",
          "--no-stream",
          "--format",
          "json",
        ]);
        const at = new Date().toISOString();
        for (const r of rows) {
          if (!r.Name.startsWith("rote-")) continue;
          statsLines.push(JSON.stringify({ at, ...r }));
          const [used, limit] = r.MemUsage.split("/").map((s) => s.trim());
          const mib = toMiB(used!);
          const prev = peakMiB.get(r.Name);
          if (!prev || mib > prev.peak) peakMiB.set(r.Name, { peak: mib, limit: limit ?? "" });
        }
      } catch (err) {
        statsLines.push(JSON.stringify({ error: (err as Error).message }));
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  })();

  // 2. 100 async jobs through the API.
  const apiResponses: string[] = [];
  const submitted: Array<{ key: string; tenant: string; jobId: string; memoKey: string; status: number }> = [];
  t = Date.now();
  for (let i = 0; i < JOBS; i += 1) {
    const tenant = TENANTS[i % TENANTS.length]!;
    const key = `day1-exit-${started.getTime()}-${String(i).padStart(3, "0")}`;
    const res = await http("POST", `${API}/capabilities/transfer/invoke?mode=async`, {
      tenant,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    }, key);
    apiResponses.push(res.text);
    submitted.push({ key, tenant, jobId: res.json?.jobId, memoKey: res.json?.memoKey, status: res.status });
  }
  timings.enqueueMs = Date.now() - t;
  const createdStatuses = submitted.map((s) => s.status);
  const n201 = createdStatuses.filter((s) => s === 201).length;
  log(`POST x${JOBS}: ${n201} x 201${n201 === JOBS ? "" : ` (others: ${JSON.stringify(createdStatuses.filter((s) => s !== 201))})`} in ${timings.enqueueMs} ms`);
  if (n201 !== JOBS) failures.push(`expected ${JOBS} x 201 on first POST, got ${n201}`);

  // 3. The same 100 again: same job ids, 200, nothing new.
  t = Date.now();
  let replayOk = 0;
  for (const s of submitted) {
    const res = await http("POST", `${API}/capabilities/transfer/invoke?mode=async`, {
      tenant: s.tenant,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    }, s.key);
    apiResponses.push(res.text);
    if (res.status === 200 && res.json?.jobId === s.jobId) replayOk += 1;
  }
  timings.replayPostsMs = Date.now() - t;
  const jobCountAfterReplay = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n;
  log(`replayed POST x${JOBS}: ${replayOk} x 200 with the same job id; jobs in table: ${jobCountAfterReplay}`);
  if (replayOk !== JOBS) failures.push(`expected ${JOBS} idempotent replays (200, same id), got ${replayOk}`);
  if (jobCountAfterReplay !== JOBS) failures.push(`expected ${JOBS} jobs after the replayed POSTs, found ${jobCountAfterReplay}`);

  // 4. Drain: poll GET /jobs/:id until every job is terminal (or the timeout).
  t = Date.now();
  const lastSeen = new Map<string, string>();
  for (;;) {
    let pending = 0;
    for (const s of submitted) {
      if (TERMINAL.has(lastSeen.get(s.jobId) ?? "")) continue;
      const res = await http("GET", `${API}/jobs/${s.jobId}?tenant=${s.tenant}`);
      apiResponses.push(res.text);
      lastSeen.set(s.jobId, res.json?.state ?? `http-${res.status}`);
      if (!TERMINAL.has(lastSeen.get(s.jobId)!)) pending += 1;
    }
    if (pending === 0 || Date.now() - t > DRAIN_TIMEOUT_MS) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  timings.drainMs = Date.now() - t;
  sampling = false;
  await Promise.all([activeSampler, statsSampler]);
  log(`drain: ${timings.drainMs} ms (timeout ${DRAIN_TIMEOUT_MS} ms)`);

  // 5. Checks, from the database and the bank's ledger.
  // The ledger verdicts come from the oracle (D32), the one definition every harness shares.
  const jobs = await readJobs(pool);
  const attempts = (await pool.query("SELECT * FROM job_attempts ORDER BY id")).rows;
  const ledger: LedgerRow[] = await fetchLedger(BANK);
  const report = checkLedger({ jobs, ledger, drainTimedOut: timings.drainMs > DRAIN_TIMEOUT_MS });

  const byState = new Map<string, number>();
  for (const j of jobs) byState.set(j.state, (byState.get(j.state) ?? 0) + 1);
  log(`job states: ${[...byState].map(([s, n]) => `${s}=${n}`).join(", ")}`);

  const notTerminal = jobs.filter((j) => !TERMINAL.has(j.state));
  const notSucceeded = jobs.filter((j) => j.state !== "succeeded");
  const retried = jobs.filter((j) => j.attempt !== 1);
  const perWorker = new Map<string, number>();
  for (const a of attempts) perWorker.set(a.worker_id, (perWorker.get(a.worker_id) ?? 0) + 1);

  const check = (ok: boolean, label: string) => {
    log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };
  check(jobs.length === JOBS, `${JOBS} jobs in the table (found ${jobs.length})`);
  check(notTerminal.length === 0, `every job terminal (not terminal: ${notTerminal.length})`);
  check(notSucceeded.length === 0, `every job succeeded (not succeeded: ${notSucceeded.length}${notSucceeded.length ? ` -- ${notSucceeded.map((j) => `${j.id}:${j.state}/${j.outcome}`).join(", ")}` : ""})`);
  check(retried.length === 0, `every job on attempt 1 (retried: ${retried.length}${retried.length ? ` -- ${retried.map((j) => `${j.id}:attempt ${j.attempt}`).join(", ")}` : ""})`);
  check(ledger.length === JOBS, `bank ledger has exactly ${JOBS} rows (found ${ledger.length})`);
  // Ledger checks, by the oracle: 0 DUPLICATE, 0 LOST, 0 MISSING_COMMIT, 0 UNRECORDED_COMMIT,
  // 0 MISMATCH (confirmationRef and tenant), 0 ORPHAN.
  const c = report.counts;
  check(c.DUPLICATE === 0, `0 duplicates: no job's memo_key on 2+ ledger rows (oracle DUPLICATE=${c.DUPLICATE})`);
  check(c.MISSING_COMMIT === 0, `every succeeded job has its ledger row (oracle MISSING_COMMIT=${c.MISSING_COMMIT})`);
  check(c.LOST === 0 && c.PENDING === 0, `0 lost: no job left non-terminal after the drain (oracle LOST=${c.LOST}, PENDING=${c.PENDING})`);
  check(c.ORPHAN === 0, `0 ledger rows whose memo matches no job (oracle ORPHAN=${c.ORPHAN})`);
  check(c.MISMATCH === 0, `each succeeded job's confirmationRef is its ledger row id, of its own tenant (oracle MISMATCH=${c.MISMATCH})`);
  check(c.UNRECORDED_COMMIT === 0, `no failed/business_outcome job has a ledger row (oracle UNRECORDED_COMMIT=${c.UNRECORDED_COMMIT})`);
  check(report.pass, "the ledger oracle passes (its report follows below)");
  check(perWorker.size === WORKERS, `${WORKERS} distinct workers ran attempts (found ${perWorker.size}: ${[...perWorker].map(([w, n]) => `${w}=${n}`).join(", ")})`);
  check(attempts.length === JOBS, `${JOBS} attempt rows, one per job (found ${attempts.length})`);
  check(maxActivePerTenant <= 2, `per-tenant cap held: max active per tenant ${maxActivePerTenant} <= 2 over ${activeSamples} samples`);

  // Containers: none died, none OOM-killed (a dead worker's job would show up as lost above).
  const workerIds = (await docker(["compose", "ps", "-q", "worker"])).split(/\s+/).filter(Boolean);
  const inspect = await dockerJson<{ Name: string; State: { Status: string; OOMKilled: boolean; ExitCode: number } }>([
    "inspect",
    ...workerIds,
  ]);
  const deadOrOom = inspect.filter((c) => c.State.Status !== "running" || c.State.OOMKilled);
  check(deadOrOom.length === 0, `all ${workerIds.length} workers still running, none OOM-killed (${inspect.map((c) => `${c.Name}:${c.State.Status}${c.State.OOMKilled ? ":OOM" : ""}`).join(", ")})`);

  // No credential value in any job row, attempt row, API response or container log line.
  const composeLogs = await docker(["compose", "logs", "--no-color", "--timestamps"]);
  const haystacks: Array<[string, string]> = [
    ["jobs table", JSON.stringify(jobs)],
    ["job_attempts table", JSON.stringify(attempts)],
    ["API responses", apiResponses.join("\n")],
    ["docker compose logs", composeLogs],
  ];
  const leaks: string[] = [];
  for (const [where, text] of haystacks) {
    for (const [name, value] of Object.entries(CREDS)) if (text.includes(value)) leaks.push(`${name} in ${where}`);
  }
  check(leaks.length === 0, `no credential value in jobs, job_attempts, API responses or container logs${leaks.length ? ` -- LEAKS: ${leaks.join(", ")}` : ""}`);

  // Memory per container (peak over the run, docker stats every ~2 s).
  log("docker stats, peak memory per container during the run:");
  for (const [name, { peak, limit }] of [...peakMiB].sort()) log(`  ${name}: ${peak.toFixed(1)} MiB (limit ${limit})`);
  const durations = jobs
    .filter((j) => j.state === "succeeded")
    .map((j) => new Date(j.updated_at).getTime() - new Date(j.created_at).getTime());
  const firstCreated = Math.min(...jobs.map((j) => new Date(j.created_at).getTime()));
  const lastUpdated = Math.max(...jobs.map((j) => new Date(j.updated_at).getTime()));
  timings.firstEnqueueToLastCompletionMs = lastUpdated - firstCreated;
  log(`throughput: ${JOBS} jobs from first enqueue to last completion in ${(timings.firstEnqueueToLastCompletionMs / 1000).toFixed(1)} s`);
  log(`per-worker split: ${[...perWorker].map(([w, n]) => `${w}=${n}`).join(", ")}`);

  // Evidence files.
  await writeFile(path.join(OUT, "ledger.json"), JSON.stringify({ entries: ledger }, null, 2));
  const { text: oracleText, ...oracleJson } = report;
  await writeFile(path.join(OUT, "oracle.json"), JSON.stringify(oracleJson, null, 2));
  await writeFile(path.join(OUT, "jobs.json"), JSON.stringify(jobs, null, 2));
  await writeFile(path.join(OUT, "attempts.json"), JSON.stringify(attempts, null, 2));
  await writeFile(path.join(OUT, "submitted.json"), JSON.stringify(submitted, null, 2));
  await writeFile(path.join(OUT, "docker-stats.jsonl"), statsLines.join("\n") + "\n");
  await writeFile(path.join(OUT, "compose-logs.txt"), composeLogs);
  await writeFile(path.join(OUT, "worker-inspect.json"), JSON.stringify(inspect, null, 2));
  // The Playwright base is not tagged in the local store (BuildKit); its resolved digest is in
  // evidence/step-06/docker/first-build.txt. Each inspect is non-fatal.
  const inspectOr = (args: string[], label: string) =>
    docker(args).catch((e) => `${label}: ${(e as Error).message.split("\n")[0]}`);
  const images = [
    await inspectOr(["image", "inspect", "rote-fleet:local", "--format", "rote-fleet:local id={{.Id}} size={{.Size}} created={{.Created}}"], "rote-fleet:local"),
    await inspectOr(["image", "inspect", "mcr.microsoft.com/playwright:v1.62.1-noble", "--format", "base {{index .RepoDigests 0}}"], "base (digest in evidence/step-06/docker/first-build.txt)"),
    await inspectOr(["image", "inspect", "postgres:17", "--format", "postgres {{index .RepoDigests 0}}"], "postgres"),
  ];
  await writeFile(path.join(OUT, "images.txt"), images.map((s) => s.trim()).join("\n") + "\n");
  // Enqueue -> completion per succeeded job (database clock: created_at -> updated_at).
  const latency = durations.length
    ? { min: Math.min(...durations), median: [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)], max: Math.max(...durations) }
    : null;
  await writeFile(path.join(OUT, "timings.json"), JSON.stringify({ ...timings, succeededJobLatencyMs: latency }, null, 2));

  // 6. Graceful stop of the workers; exit codes recorded (SIGTERM -> drain -> exit 0 expected).
  t = Date.now();
  await docker(["compose", "stop", "worker"]);
  timings.workerStopMs = Date.now() - t;
  const psAfter = await docker(["compose", "ps", "--all"]);
  await writeFile(path.join(OUT, "compose-ps-after-stop.txt"), psAfter);
  const stopped = await dockerJson<PsRow>(["compose", "ps", "--all", "--format", "json"]);
  const workerExits = stopped.filter((r) => r.Service === "worker").map((r) => `${r.Name}:${r.State}(${r.ExitCode})`);
  log(`docker compose stop worker: ${timings.workerStopMs} ms; ${workerExits.join(", ")}`);
  check(
    stopped.filter((r) => r.Service === "worker").every((r) => r.State === "exited" && r.ExitCode === 0),
    "workers exit 0 on SIGTERM (graceful shutdown)",
  );
  await writeFile(path.join(OUT, "timings.json"), JSON.stringify({ ...timings, succeededJobLatencyMs: latency }, null, 2));

  await pool.end();
  log("");
  log("ledger oracle report (D32):");
  for (const line of oracleText.split("\n")) log(`  ${line}`);
  log("");
  log(failures.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures.length} failed check(s))`);
  await writeFile(path.join(OUT, "check.txt"), lines.join("\n") + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  log(`ERROR: ${(err as Error).stack ?? String(err)}`);
  log("RESULT: FAIL (the run did not complete)");
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "check.txt"), lines.join("\n") + "\n");
  process.exitCode = 1;
});
