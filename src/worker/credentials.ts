// Per-tenant bank credentials for fleet workers (docs/plans/step-06.md section 1; D23: credentials
// are NEVER in jobs.params). They come from the environment, one variable per tenant per input the
// capability marks redact: true:
//
//   ROTE_CRED_<TENANT>_<INPUT>      e.g. ROTE_CRED_TENANT_A_USERNAME, ROTE_CRED_TENANT_A_PASSWORD
//
// with the tenant id and input name upper-cased and every non-alphanumeric character -> "_".
// Compose passes them from .env (fake values; .env.example lists the names). A production secret
// store is out of scope (the brief).
//
// Every value is also registered with a redactor: any error text the worker stores (jobs.error,
// job_attempts.error) or logs passes through a replace-all of every credential value -> [REDACTED],
// on top of replay's own redaction.
import type { Capability } from "../artifact/index.js";
import { REDACTED_PLACEHOLDER } from "../safety/index.js";

/** Shorter values would redact innocent substrings everywhere ("a" would eat every "a"). */
export const MIN_CREDENTIAL_LENGTH = 4;

export function credentialEnvName(tenantId: string, inputName: string): string {
  const part = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `ROTE_CRED_${part(tenantId)}_${part(inputName)}`;
}

/** Every input name any capability marks redact: true (the worker must supply each one per tenant). */
export function redactInputNames(capabilities: Pick<Capability, "inputs">[]): string[] {
  const names = new Set<string>();
  for (const capability of capabilities) {
    for (const input of capability.inputs) if (input.redact) names.add(input.name);
  }
  return [...names].sort();
}

/** Thrown at startup. Names the missing/invalid variables, never a value. */
export class CredentialsConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Worker credentials are incomplete; refusing to start:\n  ${problems.join("\n  ")}`);
    this.name = "CredentialsConfigError";
  }
}

export type TenantCredentials = ReadonlyMap<string, Readonly<Record<string, string>>>;

/**
 * Reads credentials for every tenant x every redact input. Fails fast (CredentialsConfigError) if any
 * variable is missing, empty, or shorter than MIN_CREDENTIAL_LENGTH.
 */
export function loadTenantCredentials(
  env: Record<string, string | undefined>,
  tenantIds: string[],
  inputNames: string[],
): TenantCredentials {
  const problems: string[] = [];
  const out = new Map<string, Record<string, string>>();
  for (const tenantId of tenantIds) {
    const values: Record<string, string> = {};
    for (const input of inputNames) {
      const name = credentialEnvName(tenantId, input);
      const value = env[name];
      if (value === undefined || value === "") problems.push(`${name} is not set`);
      else if (value.length < MIN_CREDENTIAL_LENGTH) {
        problems.push(`${name} is shorter than ${MIN_CREDENTIAL_LENGTH} characters (too short to redact safely)`);
      } else values[input] = value;
    }
    out.set(tenantId, values);
  }
  if (problems.length > 0) throw new CredentialsConfigError(problems);
  return out;
}

export type Redactor = (text: string) => string;

/** Replace-all of every credential value (longest first, so a value containing another is caught whole). */
export function createRedactor(credentials: TenantCredentials): Redactor {
  const values = [...new Set([...credentials.values()].flatMap((v) => Object.values(v)))]
    .filter((v) => v.length >= MIN_CREDENTIAL_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const value of values) out = out.split(value).join(REDACTED_PLACEHOLDER);
    return out;
  };
}

/** Redacts every string inside a JSON-compatible value (for result jsonb). */
export function redactDeep<T>(value: T, redactor: Redactor): T {
  return JSON.parse(redactor(JSON.stringify(value))) as T;
}
