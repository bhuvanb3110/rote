// Step 11: an independent check of the 20-seed batch in evidence/chaos/day2-exit-final/, run before it was
// committed. Read-only: it opens the batch's files and writes nothing there.
//
//   node evidence/step-11/check-day2-exit-final.mjs evidence/chaos/day2-exit-final 9d38bb2
//
// It checks:
//   1. seeds.json lists 20 seeds; there is exactly one folder seed-NN-<seed> per seed, and no stray folder
//      (no *.interrupted-* / *.rerun-*); each seed.txt names its seed.
//   2. Every summary.json is completed, family standard, 500 jobs, 4 workers, and stamped with the commit;
//      check.txt's first line names the same commit.
//   3. Every cell of tally.md's per-seed table equals the value derived from that seed's summary.json, and
//      the recovery-kind table and tally.json's recoveryTotals equal the sums over the 20 summaries.
//   4. Recomputed from the raw jobs.json and ledger.json (not oracle.json): per job its ledger rows by
//      memo_key, so DUPLICATE (2+ rows), MISSING_COMMIT (succeeded, 0), UNRECORDED_COMMIT (failed /
//      business_outcome, 1+), LOST (not terminal), ORPHAN (a row no job owns), tenant mismatches; and the
//      final states. These must equal summary.json's oracle counts and finals.
//   5. runner-log.jsonl has one start and one end per seed, in order, with no set-aside entry.
//   6. Each accepted escalation: the job's row, its ledger rows, and each attributed death's kill event,
//      found again in events.jsonl.
// Prints the totals; the last line is RESULT: PASS or RESULT: FAIL.
import fs from "node:fs";
import path from "node:path";

const [dirArg, commit] = process.argv.slice(2);
if (!dirArg || !commit) {
  console.error("usage: node check-day2-exit-final.mjs <batch dir> <commit>");
  process.exit(2);
}
const dir = path.resolve(dirArg);
const problems = [];
const fail = (m) => problems.push(m);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const out = [];
const say = (s = "") => out.push(s);

// 1. seeds and folders
const seedsFile = readJson(path.join(dir, "seeds.json"));
const seeds = seedsFile.seeds;
if (seeds.length !== 20) fail(`seeds.json lists ${seeds.length} seeds, not 20`);
const pad = (i) => String(i).padStart(2, "0");
const expectedDirs = seeds.map((s, i) => `seed-${pad(i + 1)}-${s}`);
const entries = fs.readdirSync(dir, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
const stray = dirs.filter((d) => !expectedDirs.includes(d));
const missing = expectedDirs.filter((d) => !dirs.includes(d));
if (stray.length) fail(`stray folders: ${stray.join(", ")}`);
if (missing.length) fail(`missing seed folders: ${missing.join(", ")}`);
const interrupted = dirs.filter((d) => /\.(interrupted|rerun)-/.test(d));
say(`batch: ${path.relative(process.cwd(), dir) || dir}`);
say(`seeds.json: ${seeds.length} seeds; command: ${seedsFile.command}`);
say(`seed folders: ${dirs.length - stray.length} of ${expectedDirs.length} expected; stray: ${stray.length ? stray.join(", ") : "none"}; .interrupted / .rerun folders: ${interrupted.length ? interrupted.join(", ") : "none"}`);
say(`top-level files: ${entries.filter((e) => e.isFile()).map((e) => e.name).sort().join(", ")}`);

// 3a. tally.md per-seed rows
const tallyMd = fs.readFileSync(path.join(dir, "tally.md"), "utf8");
const tallyRows = new Map();
for (const line of tallyMd.split(/\r?\n/)) {
  const m = /^\| (\d+) \| \[(\d+)\]\(([^)]+)\) \| (.*) \|$/.exec(line);
  if (!m) continue;
  tallyRows.set(Number(m[1]), { seed: Number(m[2]), link: m[3], cells: m[4].split(" | ") });
}
if (tallyRows.size !== 20) fail(`tally.md has ${tallyRows.size} seed rows, not 20`);
const sec = (ms) => (ms === null ? "-" : `${Math.round(ms / 1000)} s`);

const TERMINAL = new Set(["succeeded", "failed", "business_outcome", "needs_human"]);
const totals = { jobs: 0, kills: 0, ok: 0, DUPLICATE: 0, LOST: 0, MISSING_COMMIT: 0, UNRECORDED_COMMIT: 0, ORPHAN: 0, MISMATCH: 0, ledgerRows: 0, succeeded: 0, needs_human: 0, failed: 0, business_outcome: 0, notSettled: 0 };
const recoverySums = {};
const seedsWith = {};
const finalsAll = {};
const escalations = [];

say("");
say("| # | seed | commit | jobs | kills | ledger rows | raw: dup / missing / unrecorded / lost / orphan / tenant mismatch | final states | tally.md row | result |");
say("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
seeds.forEach((seed, i) => {
  const idx = i + 1;
  const sd = path.join(dir, expectedDirs[i]);
  if (!fs.existsSync(sd)) return;
  const seedTxt = fs.readFileSync(path.join(sd, "seed.txt"), "utf8").trim();
  if (seedTxt !== String(seed)) fail(`seed ${idx}: seed.txt says ${seedTxt}, not ${seed}`);
  const s = readJson(path.join(sd, "summary.json"));
  // 2. stamps
  if (s.commit !== commit) fail(`seed ${idx}: summary.json commit ${s.commit}, not ${commit}`);
  if (s.completed !== true) fail(`seed ${idx}: not completed`);
  if (s.seed !== seed) fail(`seed ${idx}: summary seed ${s.seed}`);
  if (s.family !== "standard" || s.jobs !== 500 || s.workers !== 4) fail(`seed ${idx}: config ${s.family}/${s.jobs}/${s.workers}`);
  const firstLine = fs.readFileSync(path.join(sd, "check.txt"), "utf8").split(/\r?\n/)[0];
  if (!firstLine.includes(`(code ${commit})`)) fail(`seed ${idx}: check.txt line 1 does not name ${commit}: ${firstLine}`);

  // 3a. the tally row against the summary
  const r = s.recoveries;
  const esc = s.escalatedByCrashCapAttributed ?? [];
  const flagged = r.duplicate_suspected + r.unrecorded_commit_suspected + r.reconcile_unreadable;
  const verdict = !s.pass ? `**FAIL**: ${s.problems.join("; ")}` : esc.length > 0 ? `PASS with ${esc.length} escalated by crash cap (attributed): not a plain pass` : "PASS";
  const want = [s.commit, s.kills, s.oracle.counts.ok ?? 0, s.oracle.counts.DUPLICATE ?? 0, s.oracle.counts.LOST ?? 0, s.needsHuman.length, esc.length, s.failed.length, s.notSettled, r.requeuedAfterCrash, r.claimedToVerify, r.already_done, r.resubmitted, r.reconciled, flagged, sec(s.workMs), sec(s.wallMs), verdict].map(String);
  const row = tallyRows.get(idx);
  let rowOk = false;
  if (!row) fail(`seed ${idx}: no tally.md row`);
  else {
    if (row.seed !== seed) fail(`seed ${idx}: tally.md row names seed ${row.seed}`);
    if (row.link !== `${expectedDirs[i]}/check.txt`) fail(`seed ${idx}: tally.md links ${row.link}`);
    const diffs = want.map((w, k) => (row.cells[k] === w ? null : `col ${k + 3}: tally "${row.cells[k]}" vs summary "${w}"`)).filter(Boolean);
    if (row.cells.length !== want.length) diffs.push(`${row.cells.length} cells, expected ${want.length}`);
    diffs.forEach((d) => fail(`seed ${idx}: ${d}`));
    rowOk = diffs.length === 0;
  }
  for (const [k, v] of Object.entries(r)) {
    recoverySums[k] = (recoverySums[k] ?? 0) + v;
    if (v > 0) seedsWith[k] = (seedsWith[k] ?? 0) + 1;
  }

  // 4. raw recount from jobs.json and ledger.json
  const jobs = readJson(path.join(sd, "jobs.json"));
  const ledger = readJson(path.join(sd, "ledger.json")).entries;
  const byMemo = new Map();
  for (const e of ledger) byMemo.set(e.memo, [...(byMemo.get(e.memo) ?? []), e]);
  const memos = new Set(jobs.map((j) => j.memo_key));
  const raw = { dup: 0, missing: 0, unrecorded: 0, lost: 0, orphan: 0, tenant: 0, nhRowsOver1: 0 };
  const states = {};
  for (const j of jobs) {
    const rows = byMemo.get(j.memo_key) ?? [];
    const key = `${j.state}/${j.outcome}`;
    states[key] = (states[key] ?? 0) + 1;
    if (rows.length > 1) raw.dup++;
    if (j.state === "succeeded" && rows.length === 0) raw.missing++;
    if ((j.state === "failed" || j.state === "business_outcome") && rows.length > 0) raw.unrecorded++;
    if (!TERMINAL.has(j.state)) raw.lost++;
    if (rows.some((e) => e.tenantId !== j.tenant_id)) raw.tenant++;
  }
  for (const m of byMemo.keys()) if (!memos.has(m)) raw.orphan += byMemo.get(m).length;
  const oc = s.oracle.counts;
  if (jobs.length !== 500) fail(`seed ${idx}: jobs.json has ${jobs.length} jobs`);
  if (ledger.length !== s.oracle.ledgerRows) fail(`seed ${idx}: ledger.json ${ledger.length} rows vs summary ${s.oracle.ledgerRows}`);
  if (raw.dup !== oc.DUPLICATE) fail(`seed ${idx}: raw duplicates ${raw.dup} vs oracle ${oc.DUPLICATE}`);
  if (raw.missing !== oc.MISSING_COMMIT) fail(`seed ${idx}: raw missing ${raw.missing} vs oracle ${oc.MISSING_COMMIT}`);
  if (raw.unrecorded !== oc.UNRECORDED_COMMIT) fail(`seed ${idx}: raw unrecorded ${raw.unrecorded} vs oracle ${oc.UNRECORDED_COMMIT}`);
  if (raw.lost !== oc.LOST) fail(`seed ${idx}: raw lost ${raw.lost} vs oracle ${oc.LOST}`);
  if (raw.orphan !== oc.ORPHAN) fail(`seed ${idx}: raw orphan rows ${raw.orphan} vs oracle ${oc.ORPHAN}`);
  if (raw.tenant) fail(`seed ${idx}: ${raw.tenant} job(s) with a row under another tenant`);
  const finalsJson = JSON.stringify(Object.entries(s.finals).sort());
  const statesJson = JSON.stringify(Object.entries(states).sort());
  if (finalsJson !== statesJson) fail(`seed ${idx}: jobs.json states ${statesJson} vs summary finals ${finalsJson}`);
  for (const [k, v] of Object.entries(states)) finalsAll[k] = (finalsAll[k] ?? 0) + v;

  totals.jobs += jobs.length;
  totals.kills += s.kills;
  totals.ledgerRows += ledger.length;
  for (const k of ["ok", "DUPLICATE", "LOST", "MISSING_COMMIT", "UNRECORDED_COMMIT", "ORPHAN", "MISMATCH"]) totals[k] += oc[k] ?? 0;
  for (const j of jobs) if (totals[j.state] !== undefined) totals[j.state]++;
  totals.notSettled += s.notSettled;

  // 6. escalations
  for (const e of esc) escalations.push({ idx, seed, sd, e, jobs, byMemo });

  say(`| ${idx} | ${seed} | ${s.commit} | ${jobs.length} | ${s.kills} | ${ledger.length} | ${raw.dup} / ${raw.missing} / ${raw.unrecorded} / ${raw.lost} / ${raw.orphan} / ${raw.tenant} | ${Object.entries(states).sort().map(([k, v]) => `${k} ${v}`).join(", ")} | ${rowOk ? "matches summary.json" : "DIFFERS"} | ${verdict} |`);
});

// 3b. tally.json and the recovery-kind table
const tallyJson = readJson(path.join(dir, "tally.json"));
for (const [k, v] of Object.entries(recoverySums)) {
  if (tallyJson.recoveryTotals[k] !== v) fail(`tally.json recoveryTotals.${k} = ${tallyJson.recoveryTotals[k]}, the summaries sum to ${v}`);
}
for (const k of Object.keys(tallyJson.recoveryTotals)) if (!(k in recoverySums)) fail(`tally.json has ${k}, absent from the summaries`);
if (tallyJson.finished !== 20 || tallyJson.passed !== 20 || tallyJson.seeds !== 20) fail(`tally.json finished/passed/seeds = ${tallyJson.finished}/${tallyJson.passed}/${tallyJson.seeds}`);
const expectResult = escalations.length > 0 ? "PASS_WITH_ATTRIBUTED_ESCALATIONS" : "PASS";
if (tallyJson.result !== expectResult) fail(`tally.json result ${tallyJson.result}, expected ${expectResult}`);
const kindRows = [...tallyMd.matchAll(/^\| (.+?) \| (\d+) \| (\d+) of (\d+) \|$/gm)].map((m) => ({ label: m[1], total: Number(m[2]), seedsWith: Number(m[3]), of: Number(m[4]) }));
const kindTotalsMd = kindRows.map((k) => `${k.total}/${k.seedsWith}`).sort().join(",");
const kindTotalsSum = Object.keys(tallyJson.recoveryTotals).map((k) => `${recoverySums[k]}/${seedsWith[k] ?? 0}`).sort().join(",");
if (kindRows.length !== Object.keys(tallyJson.recoveryTotals).length) fail(`tally.md has ${kindRows.length} recovery-kind rows, tally.json ${Object.keys(tallyJson.recoveryTotals).length}`);
if (kindTotalsMd !== kindTotalsSum) fail(`tally.md recovery-kind (total / seeds-with) multiset differs from the summaries' sums`);
if (kindRows.some((k) => k.of !== 20)) fail("a tally.md recovery-kind row is not 'of 20'");

// 5. runner log
const log = fs.readFileSync(path.join(dir, "runner-log.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
const setAside = log.filter((l) => l.kind === "set-aside");
if (setAside.length) fail(`runner-log has ${setAside.length} set-aside entr(ies)`);
const expectedLog = seeds.flatMap((s, i) => [`start ${i + 1} ${s}`, `end ${i + 1} ${s}`]).join("\n");
const gotLog = log.filter((l) => l.kind === "start" || l.kind === "end").map((l) => `${l.kind} ${l.index} ${l.seed}`).join("\n");
if (gotLog !== expectedLog) fail("runner-log start/end entries are not one pair per seed, in order");
const exitCodes = log.filter((l) => l.kind === "end").map((l) => l.exitCode);
const otherKinds = [...new Set(log.map((l) => l.kind))].filter((k) => k !== "start" && k !== "end");

say("");
say(`runner-log.jsonl: ${log.length} entries (${log.filter((l) => l.kind === "start").length} start, ${log.filter((l) => l.kind === "end").length} end${otherKinds.length ? `, other: ${otherKinds.join(", ")}` : ""}); set-aside: ${setAside.length}; seed exit codes: ${exitCodes.join(" ")}`);
say(`  first start ${log[0].at}, last end ${log[log.length - 1].at}`);
say(`tally.json: result ${tallyJson.result}, finished ${tallyJson.finished}, passed ${tallyJson.passed}; recoveryTotals equal the sums of the 20 summaries: ${problems.some((p) => p.startsWith("tally.json")) ? "NO" : "yes"}`);
say(`tally.md: 20 seed rows checked cell by cell against summary.json; recovery-kind table checked against the sums: ${problems.some((p) => p.startsWith("tally.md")) ? "NO" : "yes"}`);

// 6. each escalation, from the raw files
for (const { idx, seed, sd, e, jobs, byMemo } of escalations) {
  const j = jobs.find((x) => x.id === e.jobId);
  const rows = byMemo.get(j.memo_key) ?? [];
  const events = fs.readFileSync(path.join(sd, "events.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const attempts = readJson(path.join(sd, "attempts.json")).filter((a) => a.job_id === e.jobId);
  const verifs = readJson(path.join(sd, "verifications.json")).filter((v) => v.job_id === e.jobId);
  say("");
  say(`escalation, seed ${idx} (${seed}): job ${e.jobId}`);
  say(`  job row: tenant ${j.tenant_id}, ${j.params.memberId} -> ${j.params.toMemberId} $${j.params.amount}, state ${j.state}/${j.outcome}, attempt ${j.attempt}, crashes ${j.crashes}/${j.max_crashes}, lease_crashes ${j.lease_crashes}, token ${j.fencing_token}, commit_intent_at ${j.commit_intent_at}`);
  say(`  ledger rows for memo_key ${j.memo_key}: ${rows.length}${rows.length ? ` (${rows.map((r) => r.id).join(", ")})` : ""}`);
  if (rows.length > 1) fail(`escalated job ${e.jobId} has ${rows.length} ledger rows`);
  if (rows.length !== e.ledgerRows) fail(`escalated job ${e.jobId}: raw ${rows.length} rows vs summary ${e.ledgerRows}`);
  say(`  attempts: ${attempts.map((a) => `#${a.attempt} ${a.worker_id} ${a.started_at} .. ${a.ended_at} ${a.outcome} (intent ${a.commit_intent_at})`).join("; ")}`);
  say(`  verify phases: ${verifs.map((v) => `${v.worker_id} ${v.started_at} .. ${v.ended_at} ${v.decision} lookups=${JSON.stringify(v.lookups)}`).join("; ")}`);
  if (j.crashes !== e.deaths.length) fail(`escalated job ${e.jobId}: ${j.crashes} crashes vs ${e.deaths.length} attributed deaths`);
  for (const d of e.deaths) {
    const ev = events.find((x) => x.kind === d.event.kind && x.container === d.event.container && x.tMs === d.event.tMs && x.at === d.event.at);
    const held = d.row === "attempt" ? attempts.find((a) => a.attempt === d.n) : verifs[d.n - 2];
    const inWindow = ev && held && new Date(held.started_at) <= new Date(ev.at) && new Date(ev.at) <= new Date(held.ended_at);
    const holderOk = held && held.worker_id === d.holder;
    if (!ev) fail(`escalated job ${e.jobId}: death ${d.n} has no matching ${d.event.kind} of ${d.event.container} at ${d.event.at} in events.jsonl`);
    if (!holderOk) fail(`escalated job ${e.jobId}: death ${d.n} holder ${d.holder} does not hold that row`);
    if (!inWindow) fail(`escalated job ${e.jobId}: death ${d.n}'s kill is not inside the held window`);
    const into = held ? ((new Date(d.event.at) - new Date(held.started_at)) / 1000).toFixed(1) : "?";
    say(`  death ${d.n} (${d.row}, ${d.recovery}): holder ${d.holder}; events.jsonl ${ev ? "has" : "LACKS"} the ${d.event.kind} of ${d.event.container} at ${d.event.at} (t=${(d.event.tMs / 1000).toFixed(1)} s), ${into} s into the hold; inside the hold window: ${inWindow ? "yes" : "NO"}`);
  }
}

say("");
say("totals over the 20 seeds:");
say(`  jobs ${totals.jobs}; kills ${totals.kills}; ledger rows ${totals.ledgerRows}`);
say(`  oracle verdicts: ok ${totals.ok}, DUPLICATE ${totals.DUPLICATE}, LOST ${totals.LOST}, MISSING_COMMIT ${totals.MISSING_COMMIT}, UNRECORDED_COMMIT ${totals.UNRECORDED_COMMIT}, MISMATCH ${totals.MISMATCH}, ORPHAN ${totals.ORPHAN}`);
say(`  final states: succeeded ${totals.succeeded}, needs_human ${totals.needs_human}, failed ${totals.failed}, business_outcome ${totals.business_outcome}; not settled ${totals.notSettled}`);
say(`  by state/outcome: ${Object.entries(finalsAll).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
say(`  escalated by crash cap (attributed): ${escalations.length}${escalations.map((x) => ` (seed ${x.idx}: ${x.e.jobId})`).join("")}`);
say(`  recovery kinds (sum of the summaries): ${Object.entries(recoverySums).map(([k, v]) => `${k} ${v} (${seedsWith[k] ?? 0} seeds)`).join(", ")}`);
say("");
if (problems.length) {
  say(`problems (${problems.length}):`);
  problems.forEach((p) => say(`  - ${p}`));
  say("RESULT: FAIL");
} else {
  say("RESULT: PASS (the batch is complete, on one commit, and tally.md / tally.json agree with every seed's summary.json and with a recount from the raw jobs.json and ledger.json)");
}
process.stdout.write(out.join("\n") + "\n");
process.exit(problems.length ? 1 : 0);
