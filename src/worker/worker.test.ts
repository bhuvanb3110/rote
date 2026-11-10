// Pure worker pieces (no Postgres, no browser): backoff, credentials + redactor, and the
// transient-vs-fatal database error classification.
import { describe, expect, it } from "vitest";
import { createBackoff, sleep } from "./backoff.js";
import {
  CredentialsConfigError,
  createRedactor,
  credentialEnvName,
  loadTenantCredentials,
  redactDeep,
  redactInputNames,
} from "./credentials.js";
import { isTransientDbError } from "./dbErrors.js";

describe("createBackoff (full jitter)", () => {
  it("draws in [0, min(cap, base * 2^n)] and the ceiling doubles up to the cap", () => {
    const max = createBackoff({ baseMs: 100, capMs: 2000, random: () => 0.999999 });
    const waits = Array.from({ length: 8 }, () => max.next());
    expect(waits).toEqual([99, 199, 399, 799, 1599, 1999, 1999, 1999]);
    const min = createBackoff({ baseMs: 100, capMs: 2000, random: () => 0 });
    expect(Array.from({ length: 4 }, () => min.next())).toEqual([0, 0, 0, 0]);
  });

  it("reset() goes back to the base ceiling", () => {
    const b = createBackoff({ baseMs: 100, capMs: 2000, random: () => 0.5 });
    b.next();
    b.next();
    expect(b.ceilingMs).toBe(400);
    b.reset();
    expect(b.ceilingMs).toBe(100);
    expect(b.next()).toBe(50);
  });

  it("jitter: two workers with different RNG draws do not wait the same", () => {
    let seed = 1;
    const lcg = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const b = createBackoff({ baseMs: 100, capMs: 2000, random: lcg });
    const waits = Array.from({ length: 20 }, () => b.next());
    expect(new Set(waits).size).toBeGreaterThan(15);
    expect(waits.every((w) => w >= 0 && w < 2000)).toBe(true);
  });

  it("rejects a nonsensical configuration", () => {
    expect(() => createBackoff({ baseMs: 0, capMs: 10 })).toThrow(RangeError);
    expect(() => createBackoff({ baseMs: 100, capMs: 10 })).toThrow(RangeError);
  });

  it("sleep resolves early on abort", async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleep(10_000, ac.signal);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("credentials", () => {
  const env = {
    ROTE_CRED_TENANT_A_USERNAME: "fleet-op-a",
    ROTE_CRED_TENANT_A_PASSWORD: "pw-a-secret-111",
    ROTE_CRED_TENANT_B_USERNAME: "fleet-op-b",
    ROTE_CRED_TENANT_B_PASSWORD: "pw-b-secret-222",
  };

  it("maps tenant + input to the env variable name", () => {
    expect(credentialEnvName("tenant-a", "username")).toBe("ROTE_CRED_TENANT_A_USERNAME");
    expect(credentialEnvName("tenant-c", "memberPin")).toBe("ROTE_CRED_TENANT_C_MEMBERPIN");
  });

  it("collects every redact input across capabilities", () => {
    const caps = [
      { inputs: [{ name: "username", type: "string", required: true, redact: true }, { name: "memo", type: "string", required: true, redact: false }] },
      { inputs: [{ name: "password", type: "string", required: true, redact: true }] },
    ] as never;
    expect(redactInputNames(caps)).toEqual(["password", "username"]);
  });

  it("loads per-tenant values", () => {
    const creds = loadTenantCredentials(env, ["tenant-a", "tenant-b"], ["password", "username"]);
    expect(creds.get("tenant-b")).toEqual({ username: "fleet-op-b", password: "pw-b-secret-222" });
  });

  it("refuses to start naming every missing or too-short variable, never a value", () => {
    let error: unknown;
    try {
      loadTenantCredentials({ ...env, ROTE_CRED_TENANT_B_PASSWORD: "abc" }, ["tenant-a", "tenant-b", "tenant-c"], ["password", "username"]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CredentialsConfigError);
    const message = (error as Error).message;
    expect(message).toContain("ROTE_CRED_TENANT_B_PASSWORD is shorter than 4");
    expect(message).toContain("ROTE_CRED_TENANT_C_USERNAME is not set");
    expect(message).toContain("ROTE_CRED_TENANT_C_PASSWORD is not set");
    expect(message).not.toContain("abc");
    for (const value of Object.values(env)) expect(message).not.toContain(value);
  });

  it("the redactor replaces every credential value, everywhere, longest first", () => {
    const creds = loadTenantCredentials(env, ["tenant-a", "tenant-b"], ["password", "username"]);
    const redact = createRedactor(creds);
    const text = "login fleet-op-a/pw-a-secret-111 failed; retry fleet-op-b pw-b-secret-222 fleet-op-a";
    const out = redact(text);
    for (const value of Object.values(env)) expect(out).not.toContain(value);
    expect(out).toBe("login [REDACTED]/[REDACTED] failed; retry [REDACTED] [REDACTED] [REDACTED]");
    expect(redactDeep({ a: ["x fleet-op-b y"], b: { c: "pw-a-secret-111" } }, redact)).toEqual({
      a: ["x [REDACTED] y"],
      b: { c: "[REDACTED]" },
    });
  });
});

describe("isTransientDbError", () => {
  const withCode = (code: string, message = "x") => Object.assign(new Error(message), { code });

  it("connection failures and Postgres shutdown/startup are transient", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "08006", "08001", "57P01", "57P02", "57P03"]) {
      expect(isTransientDbError(withCode(code)), code).toBe(true);
    }
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isTransientDbError(new AggregateError([withCode("ECONNREFUSED"), withCode("ECONNREFUSED")]))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("wrapped"), { cause: withCode("ECONNRESET") }))).toBe(true);
  });

  it("bugs are fatal: constraint, syntax, undefined table, unknown errors", () => {
    for (const code of ["23505", "23514", "42601", "42P01", "22P02"]) {
      expect(isTransientDbError(withCode(code)), code).toBe(false);
    }
    expect(isTransientDbError(new Error("something else"))).toBe(false);
    expect(isTransientDbError("string")).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
