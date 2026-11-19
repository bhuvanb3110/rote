// The oracle's collector and CLI over real inputs (D32): jobs in a Postgres test schema, ledger rows
// in an in-process mock bank (its real GET /control/ledger), judged by checkLedger. Also runs
// `rote oracle check` as a child process against the same schema and bank: exit 0 on PASS, 1 on FAIL,
// oracle.json + check.txt written.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { appendLedgerEntry, resetLedger } from "../../mock-app/data.js";
import { findCapability } from "../catalog/registry.js";
import { enqueue, type JobRow } from "../queue/index.js";
import { createTestSchema, resetQueueTables, testDatabaseUrl, type TestSchema } from "../queue/testDb.js";
import { collectAndCheck, fetchLedger, readJobIdsFile } from "./collect.js";
import { listenOnSafePort } from "../testing/listen.js";

const run = promisify(execFile);

let db: TestSchema;
let server: Server;
let bank: string;
let work: string;

async function newJob(i: number, tenantId = "tenant-a"): Promise<JobRow> {
  const capability = (await findCapability("transfer"))!;
  const { job } = await enqueue(db.pool, {
    capability,
    tenantId,
    idempotencyKey: `oracle-${i}`,
    params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
  });
  return job;
}

/** Puts a job in a state the schema accepts: an active state holds a lease (jobs_active_has_owner). */
async function setState(job: JobRow, state: string, result: unknown = null): Promise<void> {
  const active = ["running", "committing", "verifying"].includes(state);
  await db.pool.query(
    `UPDATE jobs SET state = $2, result = $3, attempt = 1, fencing_token = 1,
       lease_owner = CASE WHEN $4 THEN 'w-test' END,
       lease_expires_at = CASE WHEN $4 THEN now() + interval '5 minutes' END,
       commit_intent_at = CASE WHEN $2 = 'committing' THEN now() END
     WHERE id = $1`,
    [job.id, state, JSON.stringify(result), active],
  );
}

function row(job: JobRow) {
  return appendLedgerEntry({ tenantId: job.tenant_id, fromMemberId: "10001", toMemberId: "10002", amount: 1, memo: job.memo_key });
}

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${db.schema}`);
  try {
    const { stdout } = await run(process.execPath, ["--import", "tsx", "src/cli/index.ts", "oracle", "check", "--database-url", url.toString(), "--bank", bank, ...args]);
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "" };
  }
}

beforeAll(async () => {
  db = await createTestSchema("oracle_collect");
  server = createServer(app);
  bank = `http://127.0.0.1:${await listenOnSafePort(server)}`; // never a port fetch refuses (D31)
  work = await mkdtemp(path.join(tmpdir(), "oracle-collect-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.drop();
  await rm(work, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetQueueTables(db.pool);
  resetLedger();
});

describe("collectAndCheck: jobs from Postgres, rows from GET /control/ledger", () => {
  it("a clean run passes; the ledger is read through the bank's HTTP endpoint and validated", async () => {
    const a = await newJob(1);
    const b = await newJob(2, "tenant-b");
    const ra = row(a);
    const rb = row(b);
    await setState(a, "succeeded", { status: "success", outputs: { confirmationRef: ra.id } });
    await setState(b, "succeeded", { status: "success", outputs: { confirmationRef: rb.id } });
    expect((await fetchLedger(bank)).map((r) => r.id)).toEqual([ra.id, rb.id]);
    const { report, jobs } = await collectAndCheck({ pool: db.pool, bankUrl: bank, drainTimedOut: false });
    expect(jobs).toHaveLength(2);
    expect(report.pass).toBe(true);
    expect(report.counts.ok).toBe(2);
  });

  it("a duplicate, a lost-after-commit job and an orphan row are all found", async () => {
    const dup = await newJob(1);
    const lost = await newJob(2);
    row(dup);
    row(dup);
    row(lost);
    appendLedgerEntry({ tenantId: "tenant-a", fromMemberId: "10001", toMemberId: "10002", amount: 1, memo: "rote-from-another-run" });
    await setState(dup, "succeeded");
    await setState(lost, "running");
    const { report } = await collectAndCheck({ pool: db.pool, bankUrl: bank, drainTimedOut: true });
    expect(report.counts).toMatchObject({ DUPLICATE: 1, LOST: 1, ORPHAN: 1 });
    expect(report.findings.find((f) => f.jobId === lost.id)!.detail).toContain("lost after commit");
    expect(report.pass).toBe(false);
  });

  it("jobIds restricts the jobs judged; an unknown id is an error, not a silent skip", async () => {
    const a = await newJob(1);
    await newJob(2);
    await setState(a, "failed");
    const { jobs } = await collectAndCheck({ pool: db.pool, bankUrl: bank, jobIds: [a.id], drainTimedOut: false });
    expect(jobs.map((j) => j.id)).toEqual([a.id]);
    await expect(
      collectAndCheck({ pool: db.pool, bankUrl: bank, jobIds: [a.id, "00000000-0000-4000-8000-000000000000"], drainTimedOut: false }),
    ).rejects.toThrow(/1 job id\(s\) not in the jobs table/);
  });

  it("readJobIdsFile accepts one uuid per line or a JSON array, and rejects anything else", async () => {
    const a = await newJob(1);
    const lines = path.join(work, "ids.txt");
    await writeFile(lines, `${a.id}\r\n\r\n`);
    expect(await readJobIdsFile(lines)).toEqual([a.id]);
    await writeFile(lines, JSON.stringify([a.id]));
    expect(await readJobIdsFile(lines)).toEqual([a.id]);
    await writeFile(lines, "not-a-uuid\n");
    await expect(readJobIdsFile(lines)).rejects.toThrow();
  });
});

describe("rote oracle check (CLI)", () => {
  it("prints the report, writes oracle.json and check.txt, exits 0 on PASS and 1 on FAIL", async () => {
    const a = await newJob(1);
    const ra = row(a);
    await setState(a, "succeeded", { status: "success", outputs: { confirmationRef: ra.id } });
    const out = path.join(work, "pass");
    const pass = await cli(["--out", out]);
    expect(pass.code).toBe(0);
    expect(pass.stdout.trim().split("\n").at(-1)).toBe("RESULT: PASS");
    expect((await readFile(path.join(out, "check.txt"), "utf8")).trim().split("\n").at(-1)).toBe("RESULT: PASS");
    expect(JSON.parse(await readFile(path.join(out, "oracle.json"), "utf8"))).toMatchObject({ pass: true, jobs: 1 });

    row(a); // now a duplicate
    const fail = await cli([]);
    expect(fail.code).toBe(1);
    expect(fail.stdout).toContain("DUPLICATE=1");
    expect(fail.stdout.trim().split("\n").at(-1)).toBe("RESULT: FAIL");
  }, 60_000);
});
