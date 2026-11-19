// Pure parts of enqueue (no Postgres): canonical hashing and which params the queue never stores.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { deserializeCapability } from "../artifact/index.js";
import {
  CredentialsInParamsError,
  canonicalJson,
  computeRequestHash,
  newTraceId,
  validateJobParams,
  workerSuppliedInputs,
} from "./enqueue.js";

const load = async (id: string) => deserializeCapability(await readFile(`artifacts/${id}.json`, "utf8"));

describe("enqueue helpers", () => {
  it("canonicalJson sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("computeRequestHash depends on tenant, capability and params, not on key order", () => {
    const h = computeRequestHash("tenant-a", "transfer", { a: "1", b: "2" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestHash("tenant-a", "transfer", { b: "2", a: "1" })).toBe(h);
    expect(computeRequestHash("tenant-b", "transfer", { a: "1", b: "2" })).not.toBe(h);
    expect(computeRequestHash("tenant-a", "member-lookup", { a: "1", b: "2" })).not.toBe(h);
  });

  it("newTraceId is a W3C trace id", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("worker-supplied inputs: credentials always; memo only for a capability with an irreversible step", async () => {
    expect(workerSuppliedInputs(await load("transfer"))).toEqual(["username", "password", "memo"]);
    expect(workerSuppliedInputs(await load("transfer-history-lookup"))).toEqual(["username", "password"]);
    expect(workerSuppliedInputs(await load("member-lookup"))).toEqual(["username", "password"]);
  });

  it("validateJobParams rejects credentials before anything else, even with other errors present", async () => {
    expect(() => validateJobParams({ id: "x", steps: [], inputs: [
      { name: "password", type: "string", required: true, description: "d", redact: true },
    ] }, { password: "p", junk: 1 })).toThrow(CredentialsInParamsError);
    expect(validateJobParams(await load("member-lookup"), { memberId: "10001" })).toEqual({ memberId: "10001" });
  });
});
