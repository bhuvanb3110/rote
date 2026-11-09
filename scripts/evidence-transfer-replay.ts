// Evidence run for the two transfer capabilities (docs/plans/step-03.md): on each of the three
// tenants, replay `transfer` once and then `transfer-history-lookup` for the same memo, through
// invokeCapability -- the path fleet workers will use (param validation, tenant override from
// overrides/, approval read from the committed status/ files, NO approveUnattended). Then read the
// mock bank's ledger and CHECK it by script. Everything lands in evidence/transfer-replay/.
//
//   npm run evidence:transfer        (needs port 4100 free: the overrides point at it)
//
// Exits 1 if any check fails.
import { createServer } from "node:http";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import app from "../mock-app/app.js";
import { TENANTS } from "../mock-app/tenants.js";
import { invokeCapability } from "../src/catalog/index.js";
import type { ReplayResult } from "../src/artifact/index.js";

const PORT = 4100;
const BANK = `http://localhost:${PORT}`;
const OUT = path.join("evidence", "transfer-replay");
const RUNS = path.join(OUT, "runs");
const CREDS = { username: "operator", password: "operator" };

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
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(new Error(`port ${PORT} is busy (stop \`npm run mock\`): ${err.message}`)));
    server.listen(PORT, resolve);
  });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(RUNS, { recursive: true });
  await fetch(`${BANK}/control/ledger/reset`);
  log(`# transfer + transfer-history-lookup on ${TENANTS.length} tenants, ${new Date().toISOString()}`);
  log(`# bank ${BANK}, ledger reset; approval from status/ (no approveUnattended); approveRisky for transfer only`);

  const runs: Array<{ tenant: string; capability: string; params: Record<string, unknown>; result: ReplayResult }> = [];
  let n = 0;
  for (const tenant of TENANTS) {
    const memo = `rote-evidence-${tenant.id}`;
    const transferParams = { memberId: "10001", toMemberId: "10002", amount: "12.34", memo };
    n += 1;
    const transfer = await collect(
      await invokeCapability({
        id: "transfer",
        tenant: tenant.id,
        params: { ...CREDS, ...transferParams },
        approveRisky: true,
      }),
      `${String(n).padStart(2, "0")}-transfer-${tenant.id}`,
    );
    runs.push({ tenant: tenant.id, capability: "transfer", params: transferParams, result: transfer });
    log(`${tenant.id} transfer ${JSON.stringify(transferParams)} -> ${JSON.stringify(transfer)}`);

    const lookupParams = { memberId: "10001", memo };
    n += 1;
    const lookup = await collect(
      await invokeCapability({ id: "transfer-history-lookup", tenant: tenant.id, params: { ...CREDS, ...lookupParams } }),
      `${String(n).padStart(2, "0")}-lookup-${tenant.id}`,
    );
    runs.push({ tenant: tenant.id, capability: "transfer-history-lookup", params: lookupParams, result: lookup });
    log(`${tenant.id} lookup ${JSON.stringify(lookupParams)} -> ${JSON.stringify(lookup)}`);
  }

  const ledgerJson = (await (await fetch(`${BANK}/control/ledger`)).json()) as { memoMaxLength: number; entries: LedgerRow[] };
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- script checks: the ledger is the judge, not the pages ---
  const checks: Array<[string, boolean]> = [];
  const rows = ledgerJson.entries;
  checks.push([`ledger has exactly ${TENANTS.length} rows (got ${rows.length})`, rows.length === TENANTS.length]);
  const memos = rows.map((r) => r.memo);
  checks.push(["no duplicate memo in the ledger", new Set(memos).size === memos.length]);
  for (const tenant of TENANTS) {
    const memo = `rote-evidence-${tenant.id}`;
    const mine = rows.filter((r) => r.memo === memo);
    const transfer = runs.find((r) => r.tenant === tenant.id && r.capability === "transfer")!.result;
    const lookup = runs.find((r) => r.tenant === tenant.id && r.capability === "transfer-history-lookup")!.result;
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
  if (!allPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
