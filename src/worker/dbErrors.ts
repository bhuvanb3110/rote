// Transient vs fatal database errors (docs/plans/step-06.md section 6). A transient error means
// "Postgres is briefly unreachable or restarting": the worker logs it, backs off and tries again,
// and never exits on it. Anything else (a constraint violation, a syntax error, a schema mismatch)
// is a bug: the worker exits loudly instead of looping on it.
import { sqlState } from "../queue/index.js";

/** Node socket error codes that mean the connection itself failed. */
const TRANSIENT_ERRNO = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);

/** SQLSTATEs: class 08 (connection exception), 57P01-57P03 (admin/crash shutdown, cannot connect now). */
function isTransientSqlState(code: string): boolean {
  return code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03";
}

/** Messages `pg` uses for a dropped connection or a pool connect timeout (no code attached). */
const TRANSIENT_MESSAGES = [
  /Connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /Client has encountered a connection error and is not queryable/i,
  /Connection terminated unexpectedly/i,
];

export function isTransientDbError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = sqlState(err);
  if (code !== undefined) {
    if (TRANSIENT_ERRNO.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code)) return isTransientSqlState(code);
  }
  const message = err instanceof Error ? err.message : "";
  if (TRANSIENT_MESSAGES.some((re) => re.test(message))) return true;
  // AggregateError (Node's happy-eyeballs connect) wraps the per-address errors.
  if (err instanceof AggregateError) return err.errors.length > 0 && err.errors.every(isTransientDbError);
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err ? isTransientDbError(cause) : false;
}
