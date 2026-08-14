// The single redaction helper. Two layers: (1) an EXPLICIT flag -- from a Step's ValueRef.redact
// or a Capability input's TypedParam.redact -- always wins and is set once, at record time, by
// whoever calls this (see discover.ts, replay.ts); (2) even when nothing was explicitly marked,
// a small set of pattern heuristics catches secret-shaped values an author forgot to flag. This
// is the one place that decides what a raw value looks like once it's safe to write to evidence,
// a log line, or (indirectly, since redacted values are never baked in as literals -- see
// src/artifact/schema.ts's ValueRef rule) the compiled artifact.
import type { TypedParam } from "../artifact/index.js";

export const REDACTED_PLACEHOLDER = "[REDACTED]";

const SSN_LIKE = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/;
const TOKEN_LIKE = /\b[A-Za-z0-9_-]{24,}\b/;

const AUTO_REDACT_PATTERNS = [SSN_LIKE, CARD_LIKE, TOKEN_LIKE];

/**
 * Redacts a single value. `explicit: true` always redacts; `explicit: false` still redacts if
 * the value itself looks like a secret (SSN, card number, long opaque token) -- a defensive
 * fallback, not a substitute for marking genuinely sensitive fields `redact: true` up front.
 */
export function redact(value: string, explicit: boolean): string {
  if (explicit) return REDACTED_PLACEHOLDER;
  if (AUTO_REDACT_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED_PLACEHOLDER;
  return value;
}

/** Redacts every string-valued key in `sensitiveKeys`; every other key passes through unchanged. */
export function redactObject<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: ReadonlySet<string>,
): T {
  const out = { ...obj };
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      (out as Record<string, unknown>)[key] = redact(value, sensitiveKeys.has(key));
    }
  }
  return out;
}

/** The set of input names a Capability itself declares sensitive -- straight from its schema. */
export function sensitiveKeysFromInputs(inputs: TypedParam[]): Set<string> {
  return new Set(inputs.filter((input) => input.redact).map((input) => input.name));
}
