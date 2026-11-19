// Unit tests for src/queue/db.ts and the loud-failure path of testDb.ts. No Postgres needed: this
// file runs under `npm run test:unit` too.
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { parseInt8, quoteIdent, redactDatabaseUrl, sqlState } from "./db.js";
import { PostgresUnreachableError, assertReachable } from "./testDb.js";

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("db helpers", () => {
  it("parseInt8 parses safe integers and refuses to round anything larger", () => {
    expect(parseInt8("0")).toBe(0);
    expect(parseInt8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseInt8("9007199254740992")).toThrow(RangeError);
    expect(() => parseInt8("not-a-number")).toThrow(RangeError);
  });

  it("redactDatabaseUrl never shows the password", () => {
    const red = redactDatabaseUrl("postgres://rote:s3cret@127.0.0.1:55432/rote");
    expect(red).toBe("postgres://rote:***@127.0.0.1:55432/rote");
    expect(red).not.toContain("s3cret");
    expect(redactDatabaseUrl("not a url :: s3cret")).not.toContain("s3cret");
  });

  it("quoteIdent doubles embedded quotes", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it("sqlState reads a driver error's code", () => {
    expect(sqlState({ code: "23505" })).toBe("23505");
    expect(sqlState(new Error("x"))).toBeUndefined();
  });
});

describe("no Postgres -> a loud, explanatory failure (never a skip)", () => {
  it("assertReachable on a closed port throws PostgresUnreachableError naming the fix, password redacted", async () => {
    const port = await closedPort();
    const url = `postgres://rote:s3cret@127.0.0.1:${port}/rote_test`;
    const err = await assertReachable(url, 2000).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PostgresUnreachableError);
    const message = (err as Error).message;
    expect(message).toContain(`Postgres not reachable at 127.0.0.1:${port}`);
    expect(message).toContain('run "docker compose up -d postgres"');
    expect(message).not.toContain("s3cret");
  });
});
