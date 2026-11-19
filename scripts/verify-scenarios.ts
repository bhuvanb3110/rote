// Step 9's verify scenarios, run end to end with saved evidence (docs/plans/step-09.md, reviewer
// additions 4 and 5), and Step 10's zombie window (docs/plans/step-10.md section 3, D52).
//
//   npm run verify-scenarios -- --family lag    [--runs crash-lag-3000,...] [--out evidence/settle-vs-history-lag]
//   npm run verify-scenarios -- --family outage [--outage 30s] [--jobs 4]  [--out evidence/verify-bank-outage-30s]
//   npm run verify-scenarios -- --family zombie [--out evidence/zombie-window-limit]
//
// Step 10 (D50): every family drains until its jobs are SETTLED (terminal, and the reconcile pass done if
// one was due), and the judges expect it: a [0, 0] duplicate in the lag family is flagged needs_human /
// duplicate_suspected (the reconcile pass is the backstop for a settle period shorter than the lag, D47);
// a resubmitted job in the outage family is reconciled with 1 match.
//
// --family lag (addition 4: the settle period vs the bank's history visibility delay). Each run uses a fresh
// test schema, the in-process bank with /control/history-lag/<lag>, and ONE transfer job, then one of two paths:
//   crash  a fault worker SIGKILLs itself right after Submit (ROTE_FAULT=after-submit: the bank has written
//          the row); a clean worker recovers the job once the lease expires (T6.4) and verifies it.
//   t5     the bank writes the row, THEN answers 503 (/control/errors/after-write); the worker's own run ends
//          commit-uncertain and it verifies at once (T5). This is the earliest a verify can start. The harness
//          turns the errors off once the job is verifying, so a resubmitted attempt 2 runs cleanly.
// The judge reads each lookup's own evidence (run.jsonl). A record is written after its action, so the bank
// rendered the filtered history (the count) between the records of step-07 and step-08. The row was visible to
// that lookup iff (render time - row.at) >= lag. Every run must satisfy three checks:
//   - its lookups agree with its own measured timing;
//   - its decision follows from its lookups: [1] / [0, 1] -> already_done, attempt 1, 1 row, oracle ok,
//     confirmationRef = the row; [0, 0] -> resubmitted -> attempt 2 -> 2 rows, oracle DUPLICATE;
//   - across the runs, both [0, 1] and a DUPLICATE actually occur.
// RESULT: PASS only then.
//
// --family outage (addition 5: bank unavailable != ambiguous). N jobs (tenant-a / tenant-b). N fault workers run
// in parallel and die right after Submit (even i) or between the intent and the click (odd i). The bank then goes
// down (/control/errors/on) for --outage (30 s), and two clean workers recover and verify during the outage. Every
// verify must DEFER (T8) and complete after the outage (T6.7). The checks: no job ends needs_human; no phase is
// escalated or exhausted; after-Submit jobs end already_done (attempt 1); before-Submit jobs end resubmitted
// (attempt 2); the oracle passes (0 DUPLICATE, 0 LOST). RESULT: PASS only then.
//
// --family zombie (D52: the window, measured and made loud). One job. A zombie worker (ROTE_FAULT=stall-after-intent)
// writes its intent and freezes with its heartbeat suspended for 30 s; a clean worker recovers the job (T6.4),
// verifies [0, 0], resubmits and succeeds; the zombie wakes and clicks: 2 ledger rows, DUPLICATE (the honest limit);
// the reconcile pass (margin 10 s: due 5 + 5 + 10 s after the success) reads 2 and flags the job needs_human /
// duplicate_suspected, duplicates_detected_total = 1. The judge checks each step and their order from the
// timestamps. RESULT: PASS means the duplicate happened AND it was detected.
//
// Every family: lease 5 s / heartbeat 2 s (as in the crash matrix, D40), the verify settle at its default (5 s),
// the deferral backoff and budget at their defaults (5 s doubling to a 60 s cap; 600 s budget), the reconcile
// margin at its default (25 s) except the zombie's 10 s. Needs Postgres (docker compose up -d postgres) and port 4100
// free. Writes summary.md and check.txt, plus one folder per run (lag) or the run's files (outage, zombie). Exits 1
// on FAIL.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetLedger } from "../mock-app/data.js";
import { findCapability } from "../src/catalog/registry.js";
import { checkLedger, fetchLedger, readJobs, type LedgerRow } from "../src/oracle/index.js";
import { enqueue } from "../src/queue/index.js";
import { createTestSchema, type TestSchema } from "../src/queue/testDb.js";
import { jobSettled } from "../src/fleet/stateMachine.js";
import { argValue, parseDuration } from "./lib/compose.js";
import { BANK, closeBank, control, FAKE_CREDS, listenBank, runFaultWorker, startWorker, within, workerEnv, type Child } from "../src/testing/workerProcess.js";

const FAMILY = argValue("family");
if (FAMILY !== "lag" && FAMILY !== "outage" && FAMILY !== "zombie") throw new Error("--family must be lag, outage or zombie");
const LEASE_SECONDS = 5;
const HEARTBEAT_SECONDS = 2;
const SETTLE_MS = 5000;
/** Slack around each lookup's render window: the bank and the worker share the OS clock (ms records). */
const TOLERANCE_MS = 250;
const FAULT_TIMEOUT_MS = 120_000;
const started = new Date();
const OUT = argValue("out") ?? path.join("evidence", FAMILY === "lag" ? "settle-vs-history-lag" : FAMILY === "outage" ? "verify-bank-outage-30s" : "zombie-window-limit");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The worker environment of a run: the matrix's timing, the settle default made explicit. */
function baseEnv(db: TestSchema, dir: string): Record<string, string> {
  return workerEnv(db, {
    ROTE_LEASE_SECONDS: String(LEASE_SECONDS),
    ROTE_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS),
    ROTE_VERIFY_SETTLE_MS: String(SETTLE_MS),
    ROTE_EVIDENCE_DIR: path.resolve(dir, "worker-evidence"),
  });
}

/** Drains until every job is SETTLED (terminal, and its reconcile done if one was due, D50); true = timed out. */
async function waitSettled(db: TestSchema, ids: string[], timeoutMs: number, onPoll?: (states: string[]) => Promise<void>): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const jobs = await readJobs(db.pool, ids);
    await onPoll?.(jobs.map((j) => j.state));
    if (jobs.every((j) => jobSettled(j))) return false;
    if (Date.now() - t0 > timeoutMs) return true;
    await sleep(100);
  }
}

async function stopWorker(child: Child): Promise<void> {
  child.stop();
  if ((await within(child.exited, 30_000)) === "timeout") child.kill();
}

async function dump(dir: string, db: TestSchema, ids: string[], ledger: LedgerRow[], drainTimedOut: boolean) {
  const jobs = await readJobs(db.pool, ids);
  const attempts = (await db.pool.query("SELECT * FROM job_attempts ORDER BY id")).rows;
  const verifications = (await db.pool.query("SELECT * FROM job_verifications ORDER BY id")).rows;
  const report = checkLedger({ jobs, ledger, drainTimedOut });
  const { text, ...reportJson } = report;
  await writeFile(path.join(dir, "jobs.json"), JSON.stringify(jobs, null, 2));
  await writeFile(path.join(dir, "attempts.json"), JSON.stringify(attempts, null, 2));
  await writeFile(path.join(dir, "verifications.json"), JSON.stringify(verifications, null, 2));
  await writeFile(path.join(dir, "ledger.json"), JSON.stringify({ entries: ledger }, null, 2));
  await writeFile(path.join(dir, "oracle.json"), JSON.stringify(reportJson, null, 2));
  await writeFile(path.join(dir, "oracle.txt"), text + "\n");
  return { jobs, attempts, verifications, report };
}

/** Every text file under `dir` that contains one of the fake passwords (must be none). */
async function credentialHits(dir: string): Promise<string[]> {
  const secrets = Object.entries(FAKE_CREDS).filter(([k]) => k.endsWith("_PASSWORD")).map(([, v]) => v);
  const hits: string[] = [];
  for (const rel of (await readdir(dir, { recursive: true })) as string[]) {
    if (!/\.(log|json|jsonl|txt|md)$/.test(rel)) continue;
    const text = await readFile(path.join(dir, rel), "utf8").catch(() => "");
    if (secrets.some((s) => text.includes(s))) hits.push(rel);
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------------
// --family lag

interface LagRun {
  name: string;
  path: "crash" | "t5";
  lagMs: number;
  why: string;
  /** What docs/plans/step-09.md (reviewer addition 4) predicted, where it named this case. */
  planSaid?: string;
}

const LAG_RUNS: LagRun[] = [
  { name: "crash-lag-3000", path: "crash", lagMs: 3000, why: "the reviewer's case 1", planSaid: "[0, 1] -> already_done, 1 row" },
  { name: "crash-lag-8000", path: "crash", lagMs: 8000, why: "the reviewer's case 2", planSaid: "[0, 0] -> resubmitted -> 2 rows, DUPLICATE" },
  { name: "crash-lag-30000", path: "crash", lagMs: 30_000, why: "longer than a crash's write -> lookup #2 time" },
  { name: "t5-lag-3000", path: "t5", lagMs: 3000, why: "case 1's lag, the verify starting at once" },
  { name: "t5-lag-8000", path: "t5", lagMs: 8000, why: "case 2's lag, the verify starting at once" },
  { name: "t5-lag-15000", path: "t5", lagMs: 15_000, why: "longer than an immediate verify's write -> lookup #2 time" },
];

interface LookupTiming {
  run: string;
  startedAt: number;
  /** The bank rendered the filtered history (the count) inside [renderFrom, renderTo]. */
  renderFrom: number | null;
  renderTo: number | null;
  status: string | null;
}

/** The lookups a worker ran, from their own evidence, in start order. */
async function lookupTimings(evidenceDir: string): Promise<LookupTiming[]> {
  let entries: string[];
  try {
    entries = (await readdir(evidenceDir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const out: LookupTiming[] = [];
  for (const rel of entries.filter((e) => path.basename(e) === "run.jsonl" && path.basename(path.dirname(e)).startsWith("transfer-history-lookup-"))) {
    const lines = (await readFile(path.join(evidenceDir, rel), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { timestamp: string; kind: string; detail?: { stepId?: string; status?: string } });
    const at = (stepId: string) => {
      const e = lines.find((l) => l.kind === "action" && l.detail?.stepId === stepId);
      return e ? Date.parse(e.timestamp) : null;
    };
    out.push({
      run: path.basename(path.dirname(rel)),
      startedAt: Date.parse(lines[0]!.timestamp),
      renderFrom: at("step-07"),
      renderTo: at("step-08"),
      status: lines.find((l) => l.kind === "result")?.detail?.status ?? null,
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

type Visibility = 0 | 1 | "boundary";

function predictedCount(t: LookupTiming, visibleAt: number): Visibility {
  if (t.renderFrom === null || t.renderTo === null) return "boundary";
  if (t.renderFrom >= visibleAt + TOLERANCE_MS) return 1;
  if (t.renderTo <= visibleAt - TOLERANCE_MS) return 0;
  return "boundary";
}

const secs = (ms: number) => (ms / 1000).toFixed(1);

interface LagRow {
  run: LagRun;
  fired: boolean | null;
  reads: string[];
  lookups: Array<number | null> | null;
  decision: string;
  state: string;
  outcome: string | null;
  attempt: number;
  rows: number;
  oracle: string;
  problems: string[];
}

async function runLag(run: LagRun): Promise<{ row: LagRow; text: string }> {
  const dir = path.join(OUT, run.name);
  await mkdir(dir, { recursive: true });
  const db = await createTestSchema(`vs_${run.name.replace(/[^a-z0-9]+/gi, "_")}`, { max: 4 });
  const bank = await listenBank();
  resetLedger();
  const problems: string[] = [];
  try {
    await control("errors/off");
    await control(`history-lag/${run.lagMs}`);
    const capability = (await findCapability("transfer"))!;
    const { job } = await enqueue(db.pool, {
      capability,
      tenantId: "tenant-a",
      idempotencyKey: `verify-${run.name}`,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    });
    const base = baseEnv(db, dir);
    let fired: boolean | null = null;
    let worker: Child;
    let errorsOff = true;
    if (run.path === "crash") {
      const fault = await runFaultWorker(base, "after-submit", path.join(dir, "worker-fault.log"), FAULT_TIMEOUT_MS);
      fired = fault.fired;
      if (!fault.fired) problems.push(`the fault did not fire at after-submit (${fault.exit})`);
      worker = startWorker({ ...base, ROTE_WORKER_ID: `clean-${run.name}` }, path.join(dir, "worker-clean.log"));
    } else {
      await control("errors/after-write");
      errorsOff = false;
      worker = startWorker({ ...base, ROTE_WORKER_ID: `worker-${run.name}` }, path.join(dir, "worker.log"));
    }
    const drainTimedOut = await waitSettled(db, [job.id], 180_000, async (states) => {
      if (!errorsOff && states[0] !== "queued" && states[0] !== "running" && states[0] !== "committing") {
        await control("errors/off"); // the job is verifying (or done): attempt 2, if any, runs cleanly
        errorsOff = true;
      }
    });
    await stopWorker(worker);
    if (drainTimedOut) problems.push("the job did not settle within 180 s");

    const ledger = await fetchLedger(BANK);
    const { jobs, verifications, report } = await dump(dir, db, [job.id], ledger, drainTimedOut);
    const final = jobs[0]!;
    const finding = report.findings[0]!;
    const rows = ledger.filter((r) => r.memo === final.memo_key).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    type VRow = { reason: string; decision: string | null; lookups: Array<number | null> | null; started_at: Date; ended_at: Date | null };
    const verifyPhases = (verifications as VRow[]).filter((v) => v.reason !== "reconcile");
    const reconciles = (verifications as VRow[]).filter((v) => v.reason === "reconcile");
    const deciding = verifyPhases.at(-1);
    const lookups = deciding?.lookups ?? null;

    // 1. The lookups agree with the measured timing.
    // The verify's lookups only: the reconcile's own lookup starts after the verify decided.
    const timings = (await lookupTimings(path.join(dir, "worker-evidence"))).filter((t) => !deciding?.ended_at || t.startedAt <= new Date(deciding.ended_at).getTime());
    const rowAt = rows[0]?.at ? Date.parse(rows[0].at) : NaN;
    const visibleAt = rowAt + run.lagMs;
    const reads = timings.map((t) => (t.renderFrom === null || t.renderTo === null ? "?" : `${secs(t.renderFrom - rowAt)}-${secs(t.renderTo - rowAt)} s`));
    const predicted = timings.map((t) => predictedCount(t, visibleAt));
    if (Number.isNaN(rowAt)) problems.push("no ledger row with a timestamp for the job's memo");
    if (!lookups) problems.push("no lookups recorded on the deciding verify phase");
    else if (timings.length !== lookups.length) problems.push(`${timings.length} lookup run(s) in the evidence, ${lookups.length} on the phase`);
    else {
      lookups.forEach((seen, i) => {
        const p = predicted[i]!;
        if (seen === null) problems.push(`lookup #${i + 1} was unreadable`);
        else if (p !== "boundary" && seen !== p) problems.push(`lookup #${i + 1} counted ${seen}; its timing says ${p} (render ${reads[i]} after the write, lag ${secs(run.lagMs)} s)`);
      });
    }

    // 2. The decision follows from the lookups; the oracle agrees.
    const shape = JSON.stringify(lookups);
    if (shape === "[1]" || shape === "[0,1]") {
      if (deciding?.decision !== "already_done") problems.push(`decision ${deciding?.decision} (expected already_done)`);
      if (final.state !== "succeeded" || final.outcome !== "already_done" || final.attempt !== 1) problems.push(`job ${final.state}/${final.outcome}, attempt ${final.attempt} (expected succeeded/already_done, attempt 1)`);
      if (reconciles.length !== 0 || final.reconcile_after !== null) problems.push("a reconcile was due, but nothing was resubmitted");
      if (rows.length !== 1) problems.push(`${rows.length} ledger rows (expected 1)`);
      if (finding.verdict !== "ok") problems.push(`oracle ${finding.verdict} (expected ok)`);
      const ref = (final.result as { outputs?: { confirmationRef?: string } } | null)?.outputs?.confirmationRef;
      if (rows[0] && ref !== rows[0].id) problems.push(`confirmationRef ${ref} (expected the row's id ${rows[0].id})`);
    } else if (shape === "[0,0]") {
      if (deciding?.decision !== "resubmitted") problems.push(`decision ${deciding?.decision} (expected resubmitted)`);
      if (final.attempt !== 2) problems.push(`attempt ${final.attempt} (expected 2: the resubmit)`);
      if (rows.length !== 2) problems.push(`${rows.length} ledger rows (expected 2: the lagging one and the resubmit's)`);
      if (finding.verdict !== "DUPLICATE") problems.push(`oracle ${finding.verdict} (expected DUPLICATE)`);
      // Step 10 (D50, D47's backstop): attempt 2 succeeded after a resubmit, so the reconcile pass re-read the
      // history after lease + settle + margin, saw both rows, and flagged the job.
      const r = reconciles.at(-1);
      if (r?.decision !== "duplicate_suspected" || JSON.stringify(r.lookups) !== "[2]") problems.push(`reconcile ${r?.decision ?? "none"} ${JSON.stringify(r?.lookups ?? null)} (expected duplicate_suspected [2])`);
      if (final.state !== "needs_human" || final.outcome !== "duplicate_suspected") problems.push(`job ${final.state}/${final.outcome} (expected needs_human/duplicate_suspected: flagged by the reconcile pass)`);
    } else problems.push(`lookups ${shape}: not a shape this scenario can produce`);

    await writeFile(
      path.join(dir, "timing.json"),
      JSON.stringify(
        {
          path: run.path,
          lagMs: run.lagMs,
          settleMs: SETTLE_MS,
          leaseSeconds: LEASE_SECONDS,
          rowAt: rows[0]?.at ?? null,
          rowVisibleInHistoryAt: Number.isNaN(visibleAt) ? null : new Date(visibleAt).toISOString(),
          lookups: timings.map((t, i) => ({
            run: t.run,
            status: t.status,
            renderAfterWriteMs: t.renderFrom === null || t.renderTo === null ? null : [t.renderFrom - rowAt, t.renderTo - rowAt],
            predicted: predicted[i],
            counted: lookups?.[i] ?? null,
          })),
          toleranceMs: TOLERANCE_MS,
        },
        null,
        2,
      ),
    );
    const row: LagRow = {
      run,
      fired,
      reads,
      lookups,
      decision: `${deciding?.decision ?? "-"}${reconciles.length ? `; reconcile ${reconciles.map((x) => `${x.decision}${JSON.stringify(x.lookups)}`).join(", ")}` : ""}`,
      state: final.state,
      outcome: final.outcome ?? null,
      attempt: final.attempt,
      rows: rows.length,
      oracle: finding.verdict,
      problems,
    };
    const text = [
      `== ${run.name} (${run.path}, lag ${run.lagMs} ms, settle ${SETTLE_MS} ms): ${run.why}`,
      run.path === "crash" ? `fault after-submit: ${fired ? "fired" : "DID NOT FIRE"}` : "the bank wrote the row, then answered 503 (errors/after-write); T5",
      `row written ${rows[0]?.at ?? "?"}; visible in history from ${Number.isNaN(visibleAt) ? "?" : new Date(visibleAt).toISOString()}`,
      ...timings.map((t, i) => `lookup #${i + 1}: rendered ${reads[i]} after the write -> timing says ${predicted[i]}; counted ${lookups?.[i] ?? "?"}`),
      `decision ${row.decision} (verify ${shape}); job ${final.state}/${final.outcome ?? "-"}, attempt ${final.attempt}; ${rows.length} ledger row(s); oracle ${finding.verdict}`,
      problems.length === 0 ? "CONSISTENT" : `INCONSISTENT: ${problems.join("; ")}`,
      "",
    ].join("\n");
    return { row, text };
  } finally {
    await control("history-lag/0").catch(() => undefined);
    await control("errors/off").catch(() => undefined);
    await closeBank(bank);
    await db.drop();
  }
}

async function lagFamily(): Promise<boolean> {
  const names = argValue("runs")?.split(",");
  const runs = names ? names.map((n) => LAG_RUNS.find((r) => r.name === n) ?? (() => { throw new Error(`no run "${n}"`); })()) : LAG_RUNS;
  const header = [
    `Settle period vs history lag (step-09 reviewer addition 4), started ${started.toISOString()}`,
    `runs: ${runs.map((r) => r.name).join(", ")}`,
    `settle ${SETTLE_MS} ms; lease ${LEASE_SECONDS} s / heartbeat ${HEARTBEAT_SECONDS} s; reconcile margin 25 s (the default: due 5 + 5 + 25 s after a success that followed a resubmit); tenant-a; one transfer per run; drained until settled; workers: child processes (node --import tsx src/worker/main.ts)`,
    `judge: a lookup counts the row iff the bank rendered its count >= lag after the write (render window = the step-07 .. step-08 records, +/- ${TOLERANCE_MS} ms)`,
    "",
  ];
  console.log(header.join("\n"));
  const results: LagRow[] = [];
  const texts: string[] = [];
  for (const run of runs) {
    const { row, text } = await runLag(run);
    results.push(row);
    texts.push(text);
    console.log(text);
  }
  const saw01 = results.some((r) => JSON.stringify(r.lookups) === "[0,1]" && r.problems.length === 0);
  const sawDup = results.some((r) => JSON.stringify(r.lookups) === "[0,0]" && r.oracle === "DUPLICATE" && r.state === "needs_human" && r.problems.length === 0);
  const coverage: string[] = [];
  if (!names) {
    if (!saw01) coverage.push("no run took the [0, 1] path");
    if (!sawDup) coverage.push("no run produced the [0, 0] duplicate, flagged");
  }
  const hits = await credentialHits(OUT);
  const pass = results.every((r) => r.problems.length === 0) && coverage.length === 0 && hits.length === 0;
  const md = [
    `# Settle period vs history lag: ${started.toISOString()}`,
    "",
    header.slice(1, 4).map((l) => `- ${l}`).join("\n"),
    "",
    "| Run | Path | Lag | Write -> lookup #1 render | Write -> lookup #2 render | Lookups | Decision | Job | Attempt | Ledger rows | Oracle | Plan predicted | Consistent |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| \`${r.run.name}\` | ${r.run.path} | ${secs(r.run.lagMs)} s | ${r.reads[0] ?? "-"} | ${r.reads[1] ?? "-"} | ${JSON.stringify(r.lookups)} | ${r.decision} | ${r.state} / ${r.outcome ?? "-"} | ${r.attempt} | ${r.rows} | ${r.oracle} | ${r.run.planSaid ?? "-"} | ${r.problems.length === 0 ? "yes" : `**no**: ${r.problems.join("; ")}`} |`,
    ),
    "",
    `[0, 1] path seen: ${saw01 ? "yes" : "NO"}; [0, 0] duplicate seen: ${sawDup ? "yes" : "NO"}; credential values in the evidence: ${hits.length === 0 ? "none" : hits.join(", ")}`,
    "",
    pass ? "RESULT: PASS" : `RESULT: FAIL${coverage.length ? ` (${coverage.join("; ")})` : ""}`,
    "",
  ].join("\n");
  await writeFile(path.join(OUT, "summary.md"), md);
  await writeFile(path.join(OUT, "check.txt"), [...header, ...texts, md].join("\n"));
  console.log(md);
  return pass;
}

// ---------------------------------------------------------------------------------------------------------
// --family outage

async function outageFamily(): Promise<boolean> {
  const outageMs = parseDuration(argValue("outage") ?? "30s");
  const n = Number(argValue("jobs") ?? 4);
  await mkdir(OUT, { recursive: true });
  const db = await createTestSchema("vs_outage", { max: 8 });
  const bank = await listenBank();
  resetLedger();
  const problems: string[] = [];
  const log: string[] = [];
  const note = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    log.push(stamped);
    console.log(stamped);
  };
  try {
    await control("errors/off");
    await control("history-lag/0");
    await db.pool.query("UPDATE tenants SET max_concurrent = 10");
    const capability = (await findCapability("transfer"))!;
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const { job } = await enqueue(db.pool, {
        capability,
        tenantId: i % 2 === 0 ? "tenant-a" : "tenant-b",
        idempotencyKey: `outage-${i}`,
        params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
      });
      ids.push(job.id);
    }
    const base = baseEnv(db, OUT);
    const points = ids.map((_, i) => (i % 2 === 0 ? "after-submit" : "before-submit"));
    note(`${n} jobs queued; ${n} fault workers start in parallel (${points.join(", ")})`);
    const faults = await Promise.all(points.map((point, i) => runFaultWorker(base, point, path.join(OUT, `worker-fault-${i}.log`), FAULT_TIMEOUT_MS, `fault-${i}-${point}`)));
    faults.forEach((f, i) => {
      if (!f.fired) problems.push(`fault worker ${i} did not fire at ${points[i]} (${f.exit})`);
    });
    note(`fault workers dead: ${faults.map((f, i) => `${i}:${f.fired ? "fired" : "NOT fired"}`).join(", ")}; ledger rows: ${(await fetchLedger(BANK)).length}`);

    await control("errors/on");
    const outageStart = (await db.pool.query<{ now: Date }>("SELECT now()")).rows[0]!.now;
    note(`BANK DOWN (/control/errors/on) for ${outageMs} ms; two clean workers start`);
    const workers = [0, 1].map((i) => startWorker({ ...base, ROTE_WORKER_ID: `clean-${i}` }, path.join(OUT, `worker-clean-${i}.log`)));
    await sleep(outageMs);
    await control("errors/off");
    const outageEnd = (await db.pool.query<{ now: Date }>("SELECT now()")).rows[0]!.now;
    note("BANK UP (/control/errors/off)");
    const drainTimedOut = await waitSettled(db, ids, 300_000);
    note(drainTimedOut ? "drain TIMED OUT (300 s)" : "every job settled");
    await Promise.all(workers.map(stopWorker));
    if (drainTimedOut) problems.push("not every job settled within 300 s of the outage's end");

    const ledger = await fetchLedger(BANK);
    const { jobs, attempts, verifications, report } = await dump(OUT, db, ids, ledger, drainTimedOut);
    if (!report.pass) problems.push(`the oracle fails: ${JSON.stringify(report.counts)}`);
    if (ledger.length !== n) problems.push(`${ledger.length} ledger rows (expected ${n}: one per job)`);
    type Phase = { job_id: string; fencing_token: number; worker_id: string; reason: string; decision: string | null; lookups: Array<number | null> | null; started_at: Date; ended_at: Date | null };
    type Attempt = { job_id: string; attempt: number; worker_id: string; outcome: string | null };
    const rowsOut: string[] = [];
    const firstWorkers = new Set<string>();
    for (const job of jobs) {
      const first = (attempts as Attempt[]).find((a) => a.job_id === job.id && a.attempt === 1);
      const point = first?.worker_id.replace(/^fault-\d+-/, "");
      if (first) firstWorkers.add(first.worker_id);
      const all = (verifications as Phase[]).filter((v) => v.job_id === job.id);
      const phases = all.filter((p) => p.reason !== "reconcile");
      const reconciles = all.filter((p) => p.reason === "reconcile");
      const deferrals = phases.filter((p) => p.decision === "deferred").length;
      const deciding = phases.at(-1);
      const bad = phases.filter((p) => p.decision === "escalated" || p.decision === "exhausted");
      const why: string[] = [];
      if (!first?.worker_id.startsWith("fault-")) why.push(`attempt 1 was not a fault worker's (${first?.worker_id})`);
      if (point === "after-submit" && !(job.state === "succeeded" && job.outcome === "already_done" && job.attempt === 1)) why.push(`${job.state}/${job.outcome}, attempt ${job.attempt} (expected succeeded/already_done, attempt 1)`);
      if (point === "before-submit" && !(job.state === "succeeded" && job.outcome === "success" && job.attempt === 2)) why.push(`${job.state}/${job.outcome}, attempt ${job.attempt} (expected succeeded/success, attempt 2)`);
      if (job.state === "needs_human") why.push("needs_human");
      if (bad.length > 0) why.push(`phase(s) ${bad.map((p) => p.decision).join(", ")}`);
      if (deferrals === 0) why.push("never deferred: its verify did not meet the outage");
      if (phases[0] && (phases[0].started_at < outageStart || phases[0].started_at > outageEnd)) why.push(`its first verify started ${phases[0].started_at.toISOString()}, outside the outage`);
      if (!deciding?.ended_at || deciding.ended_at < outageEnd) why.push("decided before the outage ended");
      const expectDecision = point === "after-submit" ? "already_done" : "resubmitted";
      if (deciding?.decision !== expectDecision) why.push(`decided ${deciding?.decision} (expected ${expectDecision})`);
      // Step 10 (D50): a job resubmitted (before-submit) succeeded after a resubmit: reconciled, 1 match. The others: none due.
      const expectReconcile = point === "before-submit" ? "reconciled[1]" : "";
      const gotReconcile = reconciles.map((r) => `${r.decision}${JSON.stringify(r.lookups)}`).join(", ");
      if (gotReconcile !== expectReconcile) why.push(`reconcile "${gotReconcile}" (expected "${expectReconcile}")`);
      if (why.length) problems.push(`job ${job.id.slice(0, 8)} (${point}): ${why.join("; ")}`);
      const afterEnd = deciding?.ended_at ? ((deciding.ended_at.getTime() - outageEnd.getTime()) / 1000).toFixed(1) : "-";
      rowsOut.push(
        `| \`${job.id.slice(0, 8)}\` | ${job.tenant_id} | ${point} | ${phases.length} | ${deferrals} | ${phases.map((p) => `${p.reason}->${p.decision ?? "open"}${p.lookups ? JSON.stringify(p.lookups) : ""}`).join(", ")} | ${afterEnd} s | ${reconciles.map((r) => `${r.decision}${JSON.stringify(r.lookups)}`).join(", ") || "-"} | ${job.state} / ${job.outcome ?? "-"} | ${job.attempt} | ${why.length ? `**no**: ${why.join("; ")}` : "yes"} |`,
      );
    }
    if (firstWorkers.size !== n) problems.push(`${firstWorkers.size} distinct fault workers took the ${n} jobs (expected ${n})`);
    const maxPhases = Math.max(...jobs.map((j) => (verifications as Phase[]).filter((v) => v.job_id === j.id && v.reason !== "reconcile").length));
    const hits = await credentialHits(OUT);
    if (hits.length) problems.push(`credential values in: ${hits.join(", ")}`);
    const pass = problems.length === 0;
    const md = [
      `# Verify during a ${outageMs / 1000} s bank outage: ${started.toISOString()}`,
      "",
      `- ${n} jobs (tenant-a / tenant-b); fault workers died right after Submit (even) or between the intent and the click (odd)`,
      `- bank down (/control/errors/on) ${outageStart.toISOString()} .. ${outageEnd.toISOString()} (database clock); two clean workers`,
      `- lease ${LEASE_SECONDS} s / heartbeat ${HEARTBEAT_SECONDS} s; settle ${SETTLE_MS} ms; deferral backoff 5 s doubling (cap 60 s), budget 600 s (the defaults)`,
      "",
      "| Job | Tenant | Died at | Verify phases | Deferrals | Phases (reason -> decision [lookups]) | Decided after the outage | Reconcile | Final | Attempt | As expected |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rowsOut,
      "",
      `Ledger rows: ${ledger.length}; oracle: ${report.pass ? "PASS" : "FAIL"} (${Object.entries(report.counts).filter(([, c]) => c > 0).map(([v, c]) => `${v}=${c}`).join(", ")}); most phases on one job: ${maxPhases} (the crash cap is 3 dead phases; deferrals do not count); credential values in the evidence: ${hits.length === 0 ? "none" : hits.join(", ")}`,
      "",
      ...(problems.length ? ["Problems:", ...problems.map((p) => `- ${p}`), ""] : []),
      pass ? "RESULT: PASS" : "RESULT: FAIL",
      "",
    ].join("\n");
    await writeFile(path.join(OUT, "summary.md"), md);
    await writeFile(path.join(OUT, "check.txt"), [...log, "", report.text, "", md].join("\n"));
    console.log(md);
    return pass;
  } finally {
    await control("errors/off").catch(() => undefined);
    await closeBank(bank);
    await db.drop();
  }
}

// ---------------------------------------------------------------------------------------------------------
// --family zombie (docs/plans/step-10.md section 3; reviewer decisions 4 and 5; D52)

const ZOMBIE_STALL_MS = 30_000;
const ZOMBIE_MARGIN_SECONDS = 10;

async function zombieFamily(): Promise<boolean> {
  await mkdir(OUT, { recursive: true });
  const db = await createTestSchema("vs_zombie", { max: 6 });
  const bank = await listenBank();
  resetLedger();
  const problems: string[] = [];
  const log: string[] = [];
  const note = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    log.push(stamped);
    console.log(stamped);
  };
  const workers: Child[] = [];
  try {
    await control("errors/off");
    await control("history-lag/0");
    const capability = (await findCapability("transfer"))!;
    const { job } = await enqueue(db.pool, {
      capability,
      tenantId: "tenant-a",
      idempotencyKey: "zombie-window",
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    });
    const base = { ...baseEnv(db, OUT), ROTE_RECONCILE_MARGIN_SECONDS: String(ZOMBIE_MARGIN_SECONDS) };
    const dueSeconds = LEASE_SECONDS + Math.ceil(SETTLE_MS / 1000) + ZOMBIE_MARGIN_SECONDS;
    note(`one job ${job.id}; the zombie worker starts with ROTE_FAULT=stall-after-intent, ROTE_FAULT_STALL_MS=${ZOMBIE_STALL_MS}`);
    workers.push(startWorker({ ...base, ROTE_FAULT: "stall-after-intent", ROTE_FAULT_ENABLE: "1", ROTE_FAULT_STALL_MS: String(ZOMBIE_STALL_MS), ROTE_WORKER_ID: "zombie" }, path.join(OUT, "worker-zombie.log")));
    // The clean worker starts only once the zombie holds the job past its intent (one job: it must be the zombie's).
    const t0 = Date.now();
    for (;;) {
      const [j] = await readJobs(db.pool, [job.id]);
      if (j!.state === "committing") break;
      if (Date.now() - t0 > 120_000) throw new Error(`the zombie never wrote its intent (job ${j!.state})`);
      await sleep(100);
    }
    note("the zombie wrote its intent and froze (heartbeat suspended); the clean worker starts");
    workers.push(startWorker({ ...base, ROTE_WORKER_ID: "clean" }, path.join(OUT, "worker-clean.log")));
    const drainTimedOut = await waitSettled(db, [job.id], 240_000);
    note(drainTimedOut ? "drain TIMED OUT (240 s)" : "the job is settled");
    await Promise.all(workers.map((w) => stopWorker(w)));
    if (drainTimedOut) problems.push("the job did not settle within 240 s");

    const ledger = await fetchLedger(BANK);
    const { jobs, attempts, verifications, report } = await dump(OUT, db, [job.id], ledger, drainTimedOut);
    const final = jobs[0]!;
    type Phase = { worker_id: string; reason: string; decision: string | null; lookups: Array<number | null> | null; started_at: Date; ended_at: Date | null };
    type Attempt = { attempt: number; worker_id: string; outcome: string | null; commit_intent_at: Date | null; ended_at: Date | null };
    const phases = verifications as Phase[];
    const atts = attempts as Attempt[];
    const rows = [...ledger].sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    const verify = phases.find((p) => p.reason === "lease_expired_in_committing");
    const reconcile = phases.filter((p) => p.reason === "reconcile").at(-1);
    const a1 = atts.find((a) => a.attempt === 1);
    const a2 = atts.find((a) => a.attempt === 2);
    const ref = (final.result as { outputs?: { confirmationRef?: string } } | null)?.outputs?.confirmationRef;
    const reconcileResult = (final.result as { reconcile?: { matches?: number; firstMatchRef?: string; jobConfirmationRef?: string } } | null)?.reconcile;
    const logs = await Promise.all(["worker-zombie.log", "worker-clean.log"].map((f) => readFile(path.join(OUT, f), "utf8").catch(() => "")));
    const zombieLog = logs[0]!;
    // duplicates_detected_total: the error-level line each detection writes (summed over both workers).
    const detections = logs.flatMap((text) => text.split(/\r?\n/).filter((l) => l.includes("DUPLICATE SUSPECTED")).map((l) => JSON.parse(l) as { duplicates_detected_total: number; workerId: string }));
    const detectedTotal = detections.reduce((n, d) => n + (d.duplicates_detected_total > 0 ? 1 : 0), 0);

    // 1. T6.4 -> verify [0, 0] -> resubmitted
    if (a1?.worker_id !== "zombie" || !a1.commit_intent_at) problems.push(`attempt 1 was not the zombie's, with an intent (${a1?.worker_id})`);
    if (!verify || verify.worker_id !== "clean" || verify.decision !== "resubmitted" || JSON.stringify(verify.lookups) !== "[0,0]") problems.push(`the verify was not clean's T6.4 [0, 0] -> resubmitted (${JSON.stringify(verify ?? null)})`);
    // 2. attempt 2 succeeded (its row is the first)
    if (a2?.worker_id !== "clean" || a2.outcome !== "success") problems.push(`attempt 2 was not clean's success (${JSON.stringify(a2 ?? null)})`);
    if (rows[0] && ref !== rows[0].id) problems.push(`the job's confirmationRef ${ref} is not the first row ${rows[0]?.id}`);
    // 3. the zombie woke and clicked: 2 rows, DUPLICATE (the honest limit)
    if (rows.length !== 2) problems.push(`${rows.length} ledger rows (expected 2: attempt 2's and the zombie's late click)`);
    if (report.findings[0]?.verdict !== "DUPLICATE") problems.push(`oracle ${report.findings[0]?.verdict} (expected DUPLICATE)`);
    if (!zombieLog.includes("ROTE_FAULT stall over")) problems.push("the zombie's log has no 'stall over' line");
    if (!/lease lost; outcome NOT recorded/.test(zombieLog)) problems.push("the zombie's late result was not fenced out (no 'lease lost; outcome NOT recorded' line)");
    // 4. the reconcile pass flags it
    if (!reconcile || reconcile.decision !== "duplicate_suspected" || JSON.stringify(reconcile.lookups) !== "[2]") problems.push(`the reconcile did not find 2 matches (${JSON.stringify(reconcile ?? null)})`);
    if (final.state !== "needs_human" || final.outcome !== "duplicate_suspected") problems.push(`job ${final.state}/${final.outcome} (expected needs_human/duplicate_suspected)`);
    if (reconcileResult?.matches !== 2) problems.push(`result.reconcile.matches ${reconcileResult?.matches} (expected 2)`);
    if (detectedTotal !== 1) problems.push(`duplicates_detected_total over the workers' logs: ${detectedTotal} (expected 1)`);
    // The order of events, from the timestamps: decided [0, 0] < attempt 2's row < the zombie's row < the reconcile's read.
    const at = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);
    const order: Array<[string, number]> = [
      ["verify decided resubmitted", at(verify?.ended_at)],
      ["attempt 2's row written", at(rows[0]?.at)],
      ["the zombie's row written", at(rows[1]?.at)],
      ["the reconcile started (its lookup reads after this)", at(reconcile?.started_at)],
    ];
    for (let i = 1; i < order.length; i += 1) {
      const [prevName, prev] = order[i - 1]!;
      const [name, t] = order[i]!;
      if (!(prev < t)) problems.push(`order: "${prevName}" (${new Date(prev).toISOString()}) is not before "${name}" (${Number.isNaN(t) ? "?" : new Date(t).toISOString()})`);
    }
    const hits = await credentialHits(OUT);
    if (hits.length) problems.push(`credential values in: ${hits.join(", ")}`);
    const pass = problems.length === 0;
    const rel = (t: number) => (Number.isNaN(t) ? "?" : `+${((t - at(a1?.commit_intent_at)) / 1000).toFixed(1)} s`);
    const md = [
      `# The zombie window, measured and made loud: ${started.toISOString()}`,
      "",
      `- one job; lease ${LEASE_SECONDS} s / heartbeat ${HEARTBEAT_SECONDS} s; settle ${SETTLE_MS} ms; reconcile delay ${LEASE_SECONDS} + ${Math.ceil(SETTLE_MS / 1000)} + ${ZOMBIE_MARGIN_SECONDS} = ${dueSeconds} s`,
      `- the zombie: ROTE_FAULT=stall-after-intent, a ${ZOMBIE_STALL_MS / 1000} s stall right after its commit intent with its heartbeat suspended (a process freeze's worst case: it clicks the moment it wakes)`,
      "",
      "| Event | Time (from the zombie's intent) |",
      "| --- | --- |",
      `| the zombie writes its commit intent and freezes | +0.0 s |`,
      ...order.map(([name, t]) => `| ${name} | ${rel(t)} |`),
      `| the reconcile decided ${reconcile?.decision ?? "-"} ${JSON.stringify(reconcile?.lookups ?? null)} | ${rel(at(reconcile?.ended_at))} |`,
      "",
      `Final job: ${final.state} / ${final.outcome}; result.reconcile ${JSON.stringify(reconcileResult ?? null)}; ledger rows ${rows.map((r) => r.id).join(", ")}; oracle ${report.findings[0]?.verdict}; duplicates_detected_total ${detectedTotal}.`,
      "",
      ...(problems.length ? ["Problems:", ...problems.map((p) => `- ${p}`), ""] : []),
      pass ? "RESULT: PASS (the duplicate happened, and it was detected)" : "RESULT: FAIL",
      "",
    ].join("\n");
    await writeFile(path.join(OUT, "summary.md"), md);
    await writeFile(path.join(OUT, "check.txt"), [...log, "", report.text, "", md].join("\n"));
    console.log(md);
    return pass;
  } finally {
    for (const w of workers) w.kill();
    await control("errors/off").catch(() => undefined);
    await closeBank(bank);
    await db.drop();
  }
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const pass = FAMILY === "lag" ? await lagFamily() : FAMILY === "outage" ? await outageFamily() : await zombieFamily();
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
