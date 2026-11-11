// The oracle's two inputs, read from where they live: jobs from Postgres, ledger rows from the bank's
// test-only GET /control/ledger (workers never call it; a real bank would not let them). Both are
// validated on the way in (CLAUDE.md: schema-first; rows are parsed, never cast).
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Pool } from "../queue/index.js";
import { JobRowSchema, type JobRow } from "../queue/types.js";
import { checkLedger, LedgerRowSchema, type LedgerRow, type OracleReport } from "./ledger.js";

export const DEFAULT_BANK_URL = "http://127.0.0.1:4100";

const LedgerResponseSchema = z.object({ entries: z.array(LedgerRowSchema) });

export async function fetchLedger(bankUrl: string = DEFAULT_BANK_URL): Promise<LedgerRow[]> {
  const res = await fetch(new URL("/control/ledger", bankUrl));
  if (!res.ok) throw new Error(`GET ${bankUrl}/control/ledger -> HTTP ${res.status}`);
  return LedgerResponseSchema.parse(await res.json()).entries;
}

/** Every job, or only `jobIds` (a run's own jobs). Ordered by creation, then id. */
export async function readJobs(pool: Pool, jobIds?: string[]): Promise<JobRow[]> {
  const { rows } = jobIds
    ? await pool.query("SELECT * FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY created_at, id", [jobIds])
    : await pool.query("SELECT * FROM jobs ORDER BY created_at, id");
  return rows.map((r) => JobRowSchema.parse(r));
}

/** A job-ids file: one uuid per line, or a JSON array of uuids. */
export async function readJobIdsFile(file: string): Promise<string[]> {
  const text = (await readFile(file, "utf8")).trim();
  const ids: unknown = text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return z.array(z.uuid()).parse(ids);
}

export interface CollectedRun {
  jobs: JobRow[];
  ledger: LedgerRow[];
  report: OracleReport;
}

/** Reads both sides and judges them. A missing job id (asked for, not in the table) is an error. */
export async function collectAndCheck(options: {
  pool: Pool;
  bankUrl?: string;
  jobIds?: string[];
  drainTimedOut: boolean;
}): Promise<CollectedRun> {
  const jobs = await readJobs(options.pool, options.jobIds);
  if (options.jobIds && jobs.length !== new Set(options.jobIds).size) {
    const found = new Set(jobs.map((j) => j.id));
    const missing = options.jobIds.filter((id) => !found.has(id));
    throw new Error(`${missing.length} job id(s) not in the jobs table: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`);
  }
  const ledger = await fetchLedger(options.bankUrl);
  return { jobs, ledger, report: checkLedger({ jobs, ledger, drainTimedOut: options.drainTimedOut }) };
}

/** oracle.json: the report without its rendered text (that is check.txt). */
export function oracleJson(run: CollectedRun): string {
  const { text: _text, ...report } = run.report;
  return JSON.stringify(report, null, 2);
}
