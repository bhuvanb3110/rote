// The repo's one stable serialization, used wherever bytes must not depend on formatting: the
// queue's request_hash (src/queue/enqueue.ts) and the approval digest of an artifact
// (docs/DECISIONS.md D24). serializeCapability's pretty JSON is for humans and diffs; this is for
// hashing.
import { createHash } from "node:crypto";
import { CapabilitySchema, type Capability } from "./schema.js";

/**
 * JSON with object keys sorted at every level (by UTF-16 code unit, so locale never matters),
 * `undefined` properties dropped, no whitespace. Array order is preserved: it is meaningful
 * (steps run in order).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 digests are stored as 64 lowercase hex characters. */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * SHA-256 (hex) of the artifact's canonical JSON, after validation through CapabilitySchema. So the
 * digest covers exactly what replay executes: file whitespace, line endings and key order don't
 * change it; any change to a value (a locator, a recognizer, a step, the version) does.
 */
export function capabilityDigest(capability: Capability): string {
  const validated = CapabilitySchema.parse(capability);
  return createHash("sha256").update(canonicalJson(validated), "utf8").digest("hex");
}
