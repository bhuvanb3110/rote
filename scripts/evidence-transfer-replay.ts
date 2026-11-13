// Evidence run for the two transfer capabilities (docs/plans/step-03.md): on each of the three
// tenants, replay `transfer` once and then `transfer-history-lookup` for the same memo, through
// invokeCapability -- the path fleet workers will use (param validation, tenant override from
// overrides/, approval read from the committed status/ files, NO approveUnattended). Then read the
// mock bank's ledger and CHECK it by script. Everything lands in evidence/transfer-replay-<version>/
// (the artifact version; one folder per version, so older versions' evidence stays as history --
// evidence/transfer-replay/ is the 1.0.0 run from Step 3). When the two versions differ (Step 9: the
// lookup is 1.2.0, the transfer stays 1.1.0) the folder is evidence/transfer-history-lookup-<lookup
// version>/, the lookup being what the run evidences.
//
//   npm run evidence:transfer                   (needs port 4100 free: the overrides point at it)
//   npm run evidence:transfer -- --pre-approval
//
// Approvals are bound to the artifact version (docs/DECISIONS.md D15). The script first records
// what the gate says for both capabilities from the committed status/ (approval.txt). A capability
// approved for its version runs under that approval. One that is not is refused -- unless
// --pre-approval is given: the evidence run that an approval will cite necessarily happens BEFORE
// the approval, so that mode passes approveUnattended (the per-run human opt-in) and a throwaway
// statusDir FOR THAT CAPABILITY ONLY, so the committed status/ files are never read for its gate nor
// written.
//
// A lookup that outputs firstMatchRef (1.2.0) is also run, per tenant, for a memo nothing matches
// (count 0, the grid's empty-state text) and with the bank's 503 on (the BANK_UNAVAILABLE outcome);
// on tenant-a for a memo used twice (count 2, the first row's id) and behind a history lag (count 0
// until the lag passes).
//
// Exits 1 if any check fails.
import { createServer } from "node:http";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import app from "../mock-app/app.js";
import { TENANTS } from "../mock-app/tenants.js";
import { findCapability, invokeCapability } from "../src/catalog/index.js";
import { checkApproval } from "../src/confidence/index.js";
import type { ReplayResult } from "../src/artifact/index.js";

const PORT = 4100;
const BANK = `http://localhost:${PORT}`;
const CREDS = { username: "operator", password: "operator" };
const PRE_APPROVAL = process.argv.includes("--pre-approval");
let OUT = "";
let RUNS = "";

interface LedgerRow {
  id: string;
  tenantId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  memo: string;
  at: string;
}

const transcript: string[] = [];
function log(line: string): void {
  transcript.push(line);
  console.log(line);
}

/** Moves the run's evidence folder from evidence/<runId>/ to evidence/transfer-replay/runs/<label>/. */
async function collect(result: ReplayResult, label: string): Promise<ReplayResult> {
  const ref = result.status === "needs_human" ? result.contextRef : result.evidenceRef;
  const runDir = path.dirname(ref.replace("evidence://", ""));
  const dest = path.join(RUNS, label);
  await rename(runDir, dest);
  const newRef = `evidence://${dest.replace(/\\/g, "/")}/run.jsonl`;
  return result.status === "needs_human" ? { ...result, contextRef: newRef } : { ...result, evidenceRef: newRef };
}

async function main(): Promise<void> {
  const transferCap = await findCapability("transfer");
  const lookupCap = await findCapability("transfer-history-lookup");
  if (!transferCap || !lookupCap) throw new Error("transfer / transfer-history-lookup artifacts not found");
  const sameVersion = transferCap.version === lookupCap.version;
  OUT = path.join("evidence", sameVersion ? `transfer-replay-${transferCap.version}` : `transfer-history-lookup-${lookupCap.version}`);
  RUNS = path.join(OUT, "runs");
  const lookupHasRef = lookupCap.outputs.some((o) => o.name === "firstMatchRef");

  // What the gate says from the committed status/ files, before anything runs.
  const gate = [
    { id: transferCap.id, version: transferCap.version, decision: await checkApproval(transferCap, {}) },
    { id: lookupCap.id, version: lookupCap.version, decision: await checkApproval(lookupCap, {}) },
  ];
  const unapproved = gate.filter((g) => !g.decision.allowed);
  if (unapproved.length > 0 && !PRE_APPROVAL) {
    for (const g of unapproved) console.error(`${g.id} ${g.version}: ${g.decision.reason}`);
    throw new Error("not approved for these versions; rerun with --pre-approval to produce the evidence an approval will cite");
  }
  const statusDir = unapproved.length === 0 ? undefined : await mkdtemp(path.join(tmpdir(), "rote-evidence-preapproval-"));
  const modeOf = (id: string) =>
    gate.find((g) => g.id === id)!.decision.allowed
      ? "approval read from the committed status/ (no approveUnattended)"
      : "PRE-APPROVAL: approveUnattended on every run, throwaway statusDir (committed status/ neither read by the gate nor written)";
  const approvalMode = gate.map((g) => `${g.id} ${g.version}: ${modeOf(g.id)}`).join("; ");
  const optsFor = (id: string) => (gate.find((g) => g.id === id)!.decision.allowed ? {} : { approveUnattended: true, statusDir });

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(new Error(`port ${PORT} is busy (stop \`npm run mock\`): ${err.message}`)));
    server.listen(PORT, resolve);
  });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(RUNS, { recursive: true });
  await fetch(`${BANK}/control/ledger/reset`);
  log(`# transfer ${transferCap.version} + transfer-history-lookup ${lookupCap.version} on ${TENANTS.length} tenants, ${new Date().toISOString()}`);
  log(`# bank ${BANK}, ledger reset; approveRisky for transfer only`);
  log(`# approval: ${approvalMode}`);
  for (const g of gate) log(`# gate (committed status/) ${g.id} ${g.version}: allowed=${g.decision.allowed} -- ${g.decision.reason}`);
  const approvalText = [
    `artifact versions: transfer ${transferCap.version}, transfer-history-lookup ${lookupCap.version}`,
    `mode: ${approvalMode}`,
    "",
    "checkApproval from the committed status/ files, before the run:",
    ...gate.map((g) => `  ${g.id} ${g.version}: allowed=${g.decision.allowed} -- ${g.decision.reason}`),
  ].join("\n");
  await writeFile(path.join(OUT, "approval.txt"), approvalText + "\n");

  const runs: Array<{ tenant: string; capability: string; label: string; params: Record<string, unknown>; result: ReplayResult }> = [];
  let n = 0;
  const runLookup = async (tenant: string, label: string, lookupParams: { memberId: string; memo: string }) => {
    n += 1;
    const result = await collect(
      await invokeCapability({ id: "transfer-history-lookup", tenant, params: { ...CREDS, ...lookupParams }, ...optsFor(lookupCap.id) }),
      `${String(n).padStart(2, "0")}-lookup-${label}-${tenant}`,
    );
    runs.push({ tenant, capability: "transfer-history-lookup", label, params: lookupParams, result });
    log(`${tenant} lookup (${label}) ${JSON.stringify(lookupParams)} -> ${JSON.stringify(result)}`);
    return result;
  };
  const runTransfer = async (tenant: string, label: string, memo: string) => {
    const transferParams = { memberId: "10001", toMemberId: "10002", amount: "12.34", memo };
    n += 1;
    const result = await collect(
      await invokeCapability({ id: "transfer", tenant, params: { ...CREDS, ...transferParams }, approveRisky: true, ...optsFor(transferCap.id) }),
      `${String(n).padStart(2, "0")}-transfer-${label}-${tenant}`,
    );
    runs.push({ tenant, capability: "transfer", label, params: transferParams, result });
    log(`${tenant} transfer (${label}) ${JSON.stringify(transferParams)} -> ${JSON.stringify(result)}`);
    return result;
  };
  for (const tenant of TENANTS) {
    const memo = `rote-evidence-${tenant.id}`;
    await runTransfer(tenant.id, "main", memo);
    await runLookup(tenant.id, "main", { memberId: "10001", memo });
  }
  if (lookupHasRef) {
    for (const tenant of TENANTS) await runLookup(tenant.id, "no-match", { memberId: "10001", memo: `rote-evidence-none-${tenant.id}` });
    const twice = "rote-evidence-twice-tenant-a";
    await runTransfer("tenant-a", "twice-1", twice);
    await runTransfer("tenant-a", "twice-2", twice);
    await runLookup("tenant-a", "two-matches", { memberId: "10001", memo: twice });
    // History lag: the next row is invisible to the lookup until the lag has passed; the oracle sees it.
    await fetch(`${BANK}/control/history-lag/60000`);
    const lagged = "rote-evidence-lagged-tenant-a";
    await runTransfer("tenant-a", "lagged", lagged);
    await runLookup("tenant-a", "lag-60s", { memberId: "10001", memo: lagged });
    await fetch(`${BANK}/control/history-lag/0`);
    await runLookup("tenant-a", "lag-off", { memberId: "10001", memo: lagged });
    // The bank's 503 on every tenant route except /login.
    await fetch(`${BANK}/control/errors/on`);
    for (const tenant of TENANTS) await runLookup(tenant.id, "bank-503", { memberId: "10001", memo: `rote-evidence-${tenant.id}` });
    await fetch(`${BANK}/control/errors/off`);
  }

  const ledgerJson = (await (await fetch(`${BANK}/control/ledger`)).json()) as { memoMaxLength: number; entries: LedgerRow[] };
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- script checks: the ledger is the judge, not the pages ---
  const checks: Array<[string, boolean]> = [];
  const rows = ledgerJson.entries;
  const expectedRows = TENANTS.length + (lookupHasRef ? 3 : 0);
  checks.push([`ledger has exactly ${expectedRows} rows (got ${rows.length})`, rows.length === expectedRows]);
  const mainMemos = rows.map((r) => r.memo).filter((m) => !m.startsWith("rote-evidence-twice"));
  checks.push(["no duplicate memo in the ledger (except the deliberate twice-used one)", new Set(mainMemos).size === mainMemos.length]);
  const found = (tenant: string, label: string) => runs.find((r) => r.tenant === tenant && r.label === label && r.capability === "transfer-history-lookup")!.result;
  const outputsOf = (r: ReplayResult) => (r.status === "success" ? r.outputs : { status: r.status, code: r.status === "business_outcome" ? r.code : undefined });
  for (const tenant of TENANTS) {
    const memo = `rote-evidence-${tenant.id}`;
    const mine = rows.filter((r) => r.memo === memo);
    const transfer = runs.find((r) => r.tenant === tenant.id && r.label === "main" && r.capability === "transfer")!.result;
    const lookup = found(tenant.id, "main");
    checks.push([`${tenant.id}: transfer status is success (got ${transfer.status})`, transfer.status === "success"]);
    checks.push([
      `${tenant.id}: exactly one ledger row with memo "${memo}" (got ${mine.length})`,
      mine.length === 1 &&
        mine[0]!.tenantId === tenant.id &&
        mine[0]!.fromMemberId === "10001" &&
        mine[0]!.toMemberId === "10002" &&
        mine[0]!.amount === 12.34,
    ]);
    const ref = transfer.status === "success" ? String(transfer.outputs.confirmationRef) : "(none)";
    checks.push([`${tenant.id}: confirmationRef ${ref} == ledger row id ${mine[0]?.id ?? "(none)"}`, ref === mine[0]?.id]);
    const count = lookup.status === "success" ? String(lookup.outputs.matchingCount) : `(${lookup.status})`;
    checks.push([`${tenant.id}: lookup status success and matchingCount "1" (got ${count})`, count === "1"]);
    if (lookupHasRef) {
      const first = lookup.status === "success" ? String(lookup.outputs.firstMatchRef) : "(none)";
      checks.push([`${tenant.id}: lookup firstMatchRef ${first} == ledger row id ${mine[0]?.id ?? "(none)"}`, first === mine[0]?.id]);
      const none = outputsOf(found(tenant.id, "no-match"));
      checks.push([
        `${tenant.id}: no-match lookup -> matchingCount "0", firstMatchRef "No matching transfers." (got ${JSON.stringify(none)})`,
        none.matchingCount === "0" && none.firstMatchRef === "No matching transfers.",
      ]);
      const down = found(tenant.id, "bank-503");
      checks.push([
        `${tenant.id}: with the bank's 503 on -> business_outcome BANK_UNAVAILABLE (got ${JSON.stringify(outputsOf(down))})`,
        down.status === "business_outcome" && down.code === "BANK_UNAVAILABLE",
      ]);
    }
  }
  if (lookupHasRef) {
    const twiceRows = rows.filter((r) => r.memo === "rote-evidence-twice-tenant-a");
    const two = outputsOf(found("tenant-a", "two-matches"));
    checks.push([
      `tenant-a: a memo used twice -> matchingCount "2", firstMatchRef = the first row ${twiceRows[0]?.id} (got ${JSON.stringify(two)})`,
      twiceRows.length === 2 && two.matchingCount === "2" && two.firstMatchRef === twiceRows[0]!.id,
    ]);
    const laggedRow = rows.find((r) => r.memo === "rote-evidence-lagged-tenant-a");
    const lag = outputsOf(found("tenant-a", "lag-60s"));
    const off = outputsOf(found("tenant-a", "lag-off"));
    checks.push([
      `tenant-a: behind a 60 s history lag the new row (${laggedRow?.id}, in the oracle's ledger) is not shown: count "0" (got ${JSON.stringify(lag)})`,
      laggedRow !== undefined && lag.matchingCount === "0",
    ]);
    checks.push([
      `tenant-a: lag off -> count "1", firstMatchRef ${laggedRow?.id} (got ${JSON.stringify(off)})`,
      off.matchingCount === "1" && off.firstMatchRef === laggedRow?.id,
    ]);
  }
  const allPass = checks.every(([, ok]) => ok);
  const checkText = [
    ...checks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"}  ${label}`),
    "",
    allPass ? "RESULT: PASS" : "RESULT: FAIL",
  ].join("\n");
  log("");
  for (const line of checkText.split("\n")) log(line);

  await writeFile(path.join(OUT, "ledger.json"), JSON.stringify(ledgerJson, null, 2) + "\n");
  await writeFile(path.join(OUT, "results.json"), JSON.stringify(runs, null, 2) + "\n");
  await writeFile(path.join(OUT, "check.txt"), checkText + "\n");
  await writeFile(path.join(OUT, "output.txt"), transcript.join("\n") + "\n");
  if (statusDir) await rm(statusDir, { recursive: true, force: true });
  if (!allPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
