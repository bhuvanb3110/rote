// The crash-point matrix (docs/plans/step-07.md section 3, FLEET_BRIEF amendment 3, D34): kill a worker
// at every step boundary of the transfer and judge each point with the ledger oracle (D32).
//
//   npm run crash-matrix -- [--points after-submit,before-complete] [--drain-timeout 90s]
//                           [--lease-seconds 30] [--heartbeat-seconds 10] [--expect step-08]
//                           [--tenant tenant-a] [--out <dir>]
//
// Per point, isolated: a fresh Postgres test schema (rote_test database), a fresh in-process mock bank
// on :4100 with an empty ledger, ONE transfer job, then
//   1. a worker child process (`node --import tsx src/worker/main.ts`) with ROTE_FAULT=<point> and
//      ROTE_FAULT_ENABLE=1: it logs the point and SIGKILLs itself there (no cleanup, no finally);
//   2. the harness checks it died at that point (its log line; a non-zero exit / SIGKILL);
//   3. a clean worker (no fault) runs until the job is terminal or --drain-timeout passes, then is
//      stopped with SIGTERM;
//   4. the oracle judges the one job against the bank's ledger, and the final job is compared with the
//      point's EXPECTED outcome (src/chaos/crashExpected.ts, --expect phase): a point passes only if the
//      fault fired, the oracle passes AND the job ended as expected.
// Writes <out>/matrix.md, <out>/check.txt (RESULT: PASS only if every point passes) and one folder per
// point (both workers' logs, job.json, attempts.json, ledger.json, oracle.json). Exit 1 if any fails.
//
// Needs Postgres (`docker compose up -d postgres`) and port 4100 free (stop the Compose bank first).
// The matrix runs with --lease-seconds 5 --heartbeat-seconds 2 so a point costs seconds, not a 30 s wait
// (D40); Step 10 adds one run at the production 30/10.
// Step 7: red (nothing recovered a dead worker's job). Step 8 (--expect step-08): before the intent ->
// requeued, attempt 2 succeeded, 1 row; after it -> needs_human (T6.3), 0 or 1 row, never 2. Step 9
// adds verify and its own expectations.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import app from "../mock-app/app.js";
import { resetLedger } from "../mock-app/data.js";
import { findCapability } from "../src/catalog/registry.js";
import { checkLedger, fetchLedger, readJobs } from "../src/oracle/index.js";
import { enqueue } from "../src/queue/index.js";
import { createTestSchema, testDatabaseUrl } from "../src/queue/testDb.js";
import { TRANSFER_FAULT_POINTS } from "../src/worker/fault.js";
import { EXPECTATION_PHASES, expectedFor, judgePoint, type ExpectationPhase } from "../src/chaos/crashExpected.js";
import { argValue, FAKE_CREDS, parseDuration } from "./lib/compose.js";

const BANK_PORT = 4100;
const BANK = `http://127.0.0.1:${BANK_PORT}`;
const points = argValue("points") ? argValue("points")!.split(",") : [...TRANSFER_FAULT_POINTS];
const DRAIN_TIMEOUT_MS = argValue("drain-timeout") ? parseDuration(argValue("drain-timeout")!) : 90_000;
const LEASE_SECONDS = Number(argValue("lease-seconds") ?? 30);
const HEARTBEAT_SECONDS = Number(argValue("heartbeat-seconds") ?? 10);
const TENANT = argValue("tenant") ?? "tenant-a";
const PHASE = (argValue("expect") ?? "step-08") as ExpectationPhase;
if (!(EXPECTATION_PHASES as readonly string[]).includes(PHASE)) throw new Error(`--expect must be one of ${EXPECTATION_PHASES.join(", ")}`);
const FAULT_WORKER_TIMEOUT_MS = 120_000;
const started = new Date();
const OUT = argValue("out") ?? path.join("evidence", "crash-matrix", started.toISOString().replace(/[:.]/g, "-"));
const TERMINAL = new Set(["succeeded", "business_outcome", "failed", "needs_human"]);

interface Child {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pid: number | undefined;
  stop(): void;
  kill(): void;
}

function startWorker(env: Record<string, string>, logFile: string): Child {
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => {
      // Let the pipes drain into the log before closing it.
      setTimeout(() => {
        out.end();
        resolve({ code, signal });
      }, 200);
    }),
  );
  return { exited, pid: child.pid, stop: () => child.kill("SIGTERM"), kill: () => child.kill("SIGKILL") };
}

function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

async function listenBank(): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`port ${BANK_PORT} is in use: stop the Compose bank (docker compose stop bank) first`) : err),
    );
    server.listen(BANK_PORT, () => resolve());
  });
  return server;
}

interface Row {
  point: string;
  fired: boolean;
  faultExit: string;
  state: string;
  outcome: string | null;
  attempt: number;
  rows: number;
  oracle: string;
  expected: string;
  /** "ok", or why the point failed. */
  verdict: string;
  detail: string;
}

async function runPoint(point: string): Promise<{ row: Row; text: string }> {
  const dir = path.join(OUT, point);
  await mkdir(dir, { recursive: true });
  const db = await createTestSchema(`crash_${point.replace(/-/g, "_")}`, { max: 4 });
  const bank = await listenBank();
  resetLedger();
  try {
    const capability = (await findCapability("transfer"))!;
    const { job } = await enqueue(db.pool, {
      capability,
      tenantId: TENANT,
      idempotencyKey: `crash-${point}`,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    });
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${db.schema}`);
    const base = {
      ...FAKE_CREDS,
      ROTE_DATABASE_URL: url.toString(),
      ROTE_LEASE_SECONDS: String(LEASE_SECONDS),
      ROTE_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS),
      ROTE_EVIDENCE_DIR: path.resolve(dir, "worker-evidence"),
      ROTE_SHUTDOWN_GRACE_MS: "10000",
    };

    // 1-2. The fault worker kills itself at the point.
    const faultLog = path.join(dir, "worker-fault.log");
    const fault = startWorker({ ...base, ROTE_FAULT: point, ROTE_FAULT_ENABLE: "1", ROTE_WORKER_ID: `fault-${point}` }, faultLog);
    const first = await within(fault.exited, FAULT_WORKER_TIMEOUT_MS);
    const timedOut = first === "timeout";
    if (timedOut) fault.kill();
    const faultEnd = timedOut ? await fault.exited : first;
    const faultText = await readFile(faultLog, "utf8");
    const fired = faultText.includes(`ROTE_FAULT firing at ${point}`);
    // Linux reports the signal; on Windows process.kill(SIGKILL) is TerminateProcess (exit code 1).
    const faultExit = timedOut
      ? `still alive after ${FAULT_WORKER_TIMEOUT_MS} ms (killed)`
      : faultEnd.signal ? `signal ${faultEnd.signal}` : `exit ${faultEnd.code}`;

    // 3. A clean worker drains.
    const cleanLog = path.join(dir, "worker-clean.log");
    const clean = startWorker({ ...base, ROTE_WORKER_ID: `clean-${point}` }, cleanLog);
    const drainStart = Date.now();
    let drainTimedOut = false;
    for (;;) {
      const [current] = await readJobs(db.pool, [job.id]);
      if (TERMINAL.has(current!.state)) break;
      if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
        drainTimedOut = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    clean.stop();
    if ((await within(clean.exited, 30_000)) === "timeout") clean.kill();

    // 4. The oracle.
    const jobs = await readJobs(db.pool, [job.id]);
    const attempts = (await db.pool.query("SELECT * FROM job_attempts ORDER BY id")).rows;
    const ledger = await fetchLedger(BANK);
    const report = checkLedger({ jobs, ledger, drainTimedOut });
    const f = report.findings[0]!;
    const { text: _t, ...reportJson } = report;
    await writeFile(path.join(dir, "job.json"), JSON.stringify(jobs, null, 2));
    await writeFile(path.join(dir, "attempts.json"), JSON.stringify(attempts, null, 2));
    await writeFile(path.join(dir, "ledger.json"), JSON.stringify({ entries: ledger }, null, 2));
    await writeFile(path.join(dir, "oracle.json"), JSON.stringify(reportJson, null, 2));
    await writeFile(path.join(dir, "check.txt"), report.text + "\n");
    // A point passes only if the fault fired there, the oracle passes AND the job ended as expected.
    const expected = expectedFor(point, PHASE);
    const final = jobs[0]!;
    const verdict = judgePoint(
      { fired, oracleVerdict: f.verdict, state: final.state, outcome: final.outcome ?? null, attempt: final.attempt, ledgerRows: f.rows },
      expected,
    ) ?? "ok";
    return {
      row: { point, fired, faultExit, state: final.state, outcome: final.outcome ?? null, attempt: final.attempt, rows: f.rows, oracle: f.verdict, expected: expected.says, verdict, detail: f.detail },
      text:
        `== ${point}: fault ${fired ? "fired" : "DID NOT FIRE"} (${faultExit}); drain ${drainTimedOut ? "timed out" : "ended"} after ${Date.now() - drainStart} ms\n` +
        `expected (${PHASE}): ${expected.says}; got ${final.state}/${final.outcome ?? "-"}, attempt ${final.attempt}, ${f.rows} row(s): ${verdict}\n${report.text}`,
    };
  } finally {
    await new Promise<void>((resolve) => bank.close(() => resolve()));
    bank.closeAllConnections?.();
    await db.drop();
  }
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const header = [
    `Crash-point matrix, started ${started.toISOString()}`,
    `points: ${points.join(", ")}`,
    `expectations: ${PHASE} (src/chaos/crashExpected.ts)`,
    `tenant: ${TENANT}; lease: ${LEASE_SECONDS} s; heartbeat: ${HEARTBEAT_SECONDS} s; drain timeout per point: ${DRAIN_TIMEOUT_MS} ms; workers: child processes (node --import tsx src/worker/main.ts)`,
    "",
  ];
  console.log(header.join("\n"));
  const rows: Row[] = [];
  const texts: string[] = [];
  for (const point of points) {
    const { row, text } = await runPoint(point);
    rows.push(row);
    texts.push(text);
    console.log(`${point}: ${row.verdict} (state ${row.state}/${row.outcome ?? "-"}, attempt ${row.attempt}, rows ${row.rows}, oracle ${row.oracle}; expected ${row.expected}; fault ${row.fired ? "fired" : "NOT fired"}, ${row.faultExit})`);
  }
  const allPass = rows.every((r) => r.verdict === "ok");
  const md = [
    `# Crash-point matrix: ${started.toISOString()}`,
    "",
    header.slice(1, 4).map((l) => `- ${l}`).join("\n"),
    "",
    "| Point | Fault fired | Fault worker | Expected | Final state | Attempt | Ledger rows | Oracle | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| \`${r.point}\` | ${r.fired ? "yes" : "**no**"} | ${r.faultExit} | ${r.expected} | ${r.state}${r.outcome ? ` / ${r.outcome}` : ""} | ${r.attempt} | ${r.rows} | ${r.oracle} | ${r.verdict === "ok" ? "ok" : `**${r.verdict}**`} |`,
    ),
    "",
    `Green points: ${rows.filter((r) => r.verdict === "ok").length}/${rows.length}.`,
    "",
    allPass ? "RESULT: PASS" : "RESULT: FAIL",
    "",
  ].join("\n");
  await writeFile(path.join(OUT, "matrix.md"), md);
  await writeFile(path.join(OUT, "check.txt"), [...header, ...texts, "", `points green: ${rows.filter((r) => r.verdict === "ok").length}/${rows.length}`, allPass ? "RESULT: PASS" : "RESULT: FAIL", ""].join("\n"));
  console.log(md);
  if (!allPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
