// The crash-point matrix (docs/plans/step-07.md section 3, FLEET_BRIEF amendment 3, D34): kill a worker
// at every step boundary of the transfer and judge each point with the ledger oracle (D32). Step 9 adds
// the recovery-internal two-fault scenarios (docs/plans/step-08.md section 9's second table).
//
//   npm run crash-matrix -- [--points after-submit,before-submit>verify-after-count] [--drain-timeout 90s]
//                           [--lease-seconds 30] [--heartbeat-seconds 10] [--expect step-09]
//                           [--tenant tenant-a] [--out <dir>]
//
// Per scenario, isolated: a fresh Postgres test schema (rote_test database), a fresh in-process mock bank
// on :4100 with an empty ledger, ONE transfer job, then
//   1. a worker child process (`node --import tsx src/worker/main.ts`) with ROTE_FAULT=<first> and
//      ROTE_FAULT_ENABLE=1: it logs the point and SIGKILLs itself there (no cleanup, no finally);
//   2. the harness checks it died at that point (its log line; a non-zero exit / SIGKILL);
//   3. (a two-fault scenario "X>Y") a SECOND fault worker with ROTE_FAULT=<second>: it recovers the job
//      once the first one's lease expires and dies at the recovery-internal point Y (inside T6, or in
//      the verify phase); the harness checks that too;
//   4. a clean worker (no fault) runs until the job is terminal or --drain-timeout passes, then is
//      stopped with SIGTERM;
//   5. the oracle judges the one job against the bank's ledger, and the final job is compared with the
//      scenario's EXPECTED outcome (src/chaos/crashExpected.ts, --expect phase): it passes only if every
//      fault fired, the oracle says what it should AND the job ended as expected.
// Writes <out>/matrix.md, <out>/check.txt (RESULT: PASS only if every scenario passes) and one folder
// per scenario (every worker's log, job.json, attempts.json, verifications.json, ledger.json,
// oracle.json). Exit 1 if any fails.
//
// Needs Postgres (`docker compose up -d postgres`) and port 4100 free (stop the Compose bank first).
// The matrix runs with --lease-seconds 5 --heartbeat-seconds 2 so a point costs seconds, not a 30 s wait
// (D40); Step 10 adds one run at the production 30/10. The verify settle period is the worker default
// (5 s, ROTE_VERIFY_SETTLE_MS).
// Step 7: red. Step 8 (--expect step-08): before the intent -> requeued; after it -> needs_human (T6.3).
// Step 9 (--expect step-09, the default): after the intent -> VERIFIED ([0, 0] resubmitted, attempt 2;
// [1] already_done, attempt 1), always exactly 1 row; plus the 7 recovery-internal scenarios.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetLedger } from "../mock-app/data.js";
import { findCapability } from "../src/catalog/registry.js";
import { checkLedger, fetchLedger, readJobs } from "../src/oracle/index.js";
import { enqueue } from "../src/queue/index.js";
import { createTestSchema } from "../src/queue/testDb.js";
import { EXPECTATION_PHASES, scenariosFor, judgePoint, type CrashScenario, type ExpectationPhase } from "../src/chaos/crashExpected.js";
import { argValue, parseDuration } from "./lib/compose.js";
import { BANK, closeBank, describeExit, listenBank, startWorker, TERMINAL, within, workerEnv, type Child } from "./lib/harness.js";

const DRAIN_TIMEOUT_MS = argValue("drain-timeout") ? parseDuration(argValue("drain-timeout")!) : 90_000;
const LEASE_SECONDS = Number(argValue("lease-seconds") ?? 30);
const HEARTBEAT_SECONDS = Number(argValue("heartbeat-seconds") ?? 10);
const TENANT = argValue("tenant") ?? "tenant-a";
const PHASE = (argValue("expect") ?? "step-09") as ExpectationPhase;
if (!(EXPECTATION_PHASES as readonly string[]).includes(PHASE)) throw new Error(`--expect must be one of ${EXPECTATION_PHASES.join(", ")}`);
const ALL = scenariosFor(PHASE);
const scenarios: CrashScenario[] = argValue("points")
  ? argValue("points")!.split(",").map((name) => {
      const s = ALL.find((x) => x.name === name);
      if (!s) throw new Error(`no ${PHASE} scenario "${name}" (known: ${ALL.map((x) => x.name).join(", ")})`);
      return s;
    })
  : ALL;
const FAULT_WORKER_TIMEOUT_MS = 120_000 + LEASE_SECONDS * 1000;
const started = new Date();
const OUT = argValue("out") ?? path.join("evidence", "crash-matrix", started.toISOString().replace(/[:.]/g, "-"));

interface Row {
  point: string;
  fired: boolean;
  secondFired?: boolean;
  faultExit: string;
  state: string;
  outcome: string | null;
  attempt: number;
  rows: number;
  oracle: string;
  expected: string;
  /** "ok", or why the scenario failed. */
  verdict: string;
  detail: string;
  /** The verify phases' decisions, in order (job_verifications), e.g. "crashed, already_done". */
  verify: string;
}

/** Runs a fault worker to its death at `point`; returns whether it fired there and how it exited. */
async function faultWorker(base: Record<string, string>, point: string, logFile: string): Promise<{ fired: boolean; exit: string }> {
  const child: Child = startWorker({ ...base, ROTE_FAULT: point, ROTE_FAULT_ENABLE: "1", ROTE_WORKER_ID: `fault-${point}` }, logFile);
  const first = await within(child.exited, FAULT_WORKER_TIMEOUT_MS);
  if (first === "timeout") child.kill();
  const end = first === "timeout" ? await child.exited : first;
  const text = await readFile(logFile, "utf8");
  return { fired: text.includes(`ROTE_FAULT firing at ${point}`), exit: first === "timeout" ? describeExit("timeout", FAULT_WORKER_TIMEOUT_MS) : describeExit(end, 0) };
}

async function runScenario(scenario: CrashScenario): Promise<{ row: Row; text: string }> {
  const dir = path.join(OUT, scenario.name.replace(">", "__"));
  await mkdir(dir, { recursive: true });
  const db = await createTestSchema(`crash_${scenario.name.replace(/[^a-z0-9]+/gi, "_")}`.slice(0, 40), { max: 4 });
  const bank = await listenBank();
  resetLedger();
  try {
    const capability = (await findCapability("transfer"))!;
    const { job } = await enqueue(db.pool, {
      capability,
      tenantId: TENANT,
      idempotencyKey: `crash-${scenario.name}`,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    });
    const base = workerEnv(db, {
      ROTE_LEASE_SECONDS: String(LEASE_SECONDS),
      ROTE_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS),
      ROTE_EVIDENCE_DIR: path.resolve(dir, "worker-evidence"),
    });

    // 1-2. The first fault worker kills itself at its point.
    const first = await faultWorker(base, scenario.first, path.join(dir, "worker-fault.log"));
    // 3. A two-fault scenario: the RECOVERING worker dies at the recovery-internal point.
    const second = scenario.second ? await faultWorker(base, scenario.second, path.join(dir, "worker-fault-2.log")) : null;

    // 4. A clean worker drains.
    const clean = startWorker({ ...base, ROTE_WORKER_ID: `clean-${scenario.name}` }, path.join(dir, "worker-clean.log"));
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

    // 5. The oracle.
    const jobs = await readJobs(db.pool, [job.id]);
    const attempts = (await db.pool.query("SELECT * FROM job_attempts ORDER BY id")).rows;
    const verifications = (await db.pool.query("SELECT * FROM job_verifications ORDER BY id")).rows;
    const ledger = await fetchLedger(BANK);
    const report = checkLedger({ jobs, ledger, drainTimedOut });
    const f = report.findings[0]!;
    const { text: _t, ...reportJson } = report;
    await writeFile(path.join(dir, "job.json"), JSON.stringify(jobs, null, 2));
    await writeFile(path.join(dir, "attempts.json"), JSON.stringify(attempts, null, 2));
    await writeFile(path.join(dir, "verifications.json"), JSON.stringify(verifications, null, 2));
    await writeFile(path.join(dir, "ledger.json"), JSON.stringify({ entries: ledger }, null, 2));
    await writeFile(path.join(dir, "oracle.json"), JSON.stringify(reportJson, null, 2));
    await writeFile(path.join(dir, "check.txt"), report.text + "\n");
    const final = jobs[0]!;
    const verdict =
      judgePoint(
        { fired: first.fired, secondFired: second?.fired, oracleVerdict: f.verdict, state: final.state, outcome: final.outcome ?? null, attempt: final.attempt, ledgerRows: f.rows },
        scenario.expected,
      ) ?? "ok";
    const verify = verifications.map((v: { decision: string | null; lookups: Array<number | null> | null }) => `${v.decision ?? "open"}${v.lookups ? JSON.stringify(v.lookups) : ""}`).join(", ") || "-";
    const faultExit = second ? `${first.exit}; then ${second.exit}` : first.exit;
    const firedText = `${scenario.first}: ${first.fired ? "fired" : "DID NOT FIRE"}${second ? `; ${scenario.second}: ${second.fired ? "fired" : "DID NOT FIRE"}` : ""}`;
    return {
      row: {
        point: scenario.name,
        fired: first.fired,
        secondFired: second?.fired,
        faultExit,
        state: final.state,
        outcome: final.outcome ?? null,
        attempt: final.attempt,
        rows: f.rows,
        oracle: f.verdict,
        expected: scenario.expected.says,
        verdict,
        detail: f.detail,
        verify,
      },
      text:
        `== ${scenario.name}: ${firedText} (${faultExit}); drain ${drainTimedOut ? "timed out" : "ended"} after ${Date.now() - drainStart} ms\n` +
        `verify phases: ${verify}\n` +
        `expected (${PHASE}): ${scenario.expected.says}; got ${final.state}/${final.outcome ?? "-"}, attempt ${final.attempt}, ${f.rows} row(s): ${verdict}\n${report.text}`,
    };
  } finally {
    await closeBank(bank);
    await db.drop();
  }
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const header = [
    `Crash-point matrix, started ${started.toISOString()}`,
    `scenarios: ${scenarios.map((s) => s.name).join(", ")}`,
    `expectations: ${PHASE} (src/chaos/crashExpected.ts)`,
    `tenant: ${TENANT}; lease: ${LEASE_SECONDS} s; heartbeat: ${HEARTBEAT_SECONDS} s; verify settle: the worker default (5 s); drain timeout per scenario: ${DRAIN_TIMEOUT_MS} ms; workers: child processes (node --import tsx src/worker/main.ts)`,
    "",
  ];
  console.log(header.join("\n"));
  const rows: Row[] = [];
  const texts: string[] = [];
  for (const scenario of scenarios) {
    const { row, text } = await runScenario(scenario);
    rows.push(row);
    texts.push(text);
    console.log(
      `${scenario.name}: ${row.verdict} (state ${row.state}/${row.outcome ?? "-"}, attempt ${row.attempt}, rows ${row.rows}, oracle ${row.oracle}; ` +
        `verify ${row.verify}; expected ${row.expected}; fault ${row.fired ? "fired" : "NOT fired"}${row.secondFired === undefined ? "" : row.secondFired ? ", 2nd fired" : ", 2nd NOT fired"}, ${row.faultExit})`,
    );
  }
  const allPass = rows.every((r) => r.verdict === "ok");
  const fired = (r: Row) => (r.fired ? "yes" : "**no**") + (r.secondFired === undefined ? "" : r.secondFired ? " / yes" : " / **no**");
  const md = [
    `# Crash-point matrix: ${started.toISOString()}`,
    "",
    header.slice(1, 4).map((l) => `- ${l}`).join("\n"),
    "",
    "| Scenario | Fault(s) fired | Fault worker(s) | Expected | Final state | Attempt | Ledger rows | Verify phases | Oracle | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| \`${r.point}\` | ${fired(r)} | ${r.faultExit} | ${r.expected} | ${r.state}${r.outcome ? ` / ${r.outcome}` : ""} | ${r.attempt} | ${r.rows} | ${r.verify} | ${r.oracle} | ${r.verdict === "ok" ? "ok" : `**${r.verdict}**`} |`,
    ),
    "",
    `Green: ${rows.filter((r) => r.verdict === "ok").length}/${rows.length}.`,
    "",
    allPass ? "RESULT: PASS" : "RESULT: FAIL",
    "",
  ].join("\n");
  await writeFile(path.join(OUT, "matrix.md"), md);
  await writeFile(path.join(OUT, "check.txt"), [...header, ...texts, "", `green: ${rows.filter((r) => r.verdict === "ok").length}/${rows.length}`, allPass ? "RESULT: PASS" : "RESULT: FAIL", ""].join("\n"));
  console.log(md);
  if (!allPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
