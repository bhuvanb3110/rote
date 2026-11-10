// The repo's stable serialization (canonicalJson) and the approval digest built on it (D24).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJson, capabilityDigest, SHA256_HEX_REGEX } from "./canonical.js";
import { deserializeCapability } from "./serialize.js";

describe("canonicalJson", () => {
  it("sorts keys at every level, keeps array order, drops undefined, has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is the same for the same value whatever the insertion order", () => {
    expect(canonicalJson({ x: [1, "a"], y: { p: null, q: true } })).toBe(
      canonicalJson({ y: { q: true, p: null }, x: [1, "a"] }),
    );
  });
});

describe("capabilityDigest", () => {
  it("is SHA-256 hex of the canonical JSON of the validated artifact", async () => {
    const capability = deserializeCapability(await readFile("artifacts/transfer.json", "utf8"));
    const digest = capabilityDigest(capability);
    expect(digest).toMatch(SHA256_HEX_REGEX);
    expect(digest).toBe(createHash("sha256").update(canonicalJson(capability), "utf8").digest("hex"));
  });

  it("ignores file formatting (indentation, CRLF, key order) but not values", async () => {
    const text = await readFile("artifacts/transfer.json", "utf8");
    const base = capabilityDigest(deserializeCapability(text));
    const raw = JSON.parse(text);
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    expect(capabilityDigest(deserializeCapability(JSON.stringify(reordered)))).toBe(base);
    expect(capabilityDigest(deserializeCapability(JSON.stringify(raw, null, 8).replace(/\n/g, "\r\n")))).toBe(base);

    const changed = structuredClone(raw);
    changed.description = `${changed.description} `; // one trailing space in a value IS content
    expect(capabilityDigest(deserializeCapability(JSON.stringify(changed)))).not.toBe(base);
  });
});
