// Policy gate: URL/action-type allowlist, safe(reversible) vs risky(irreversible) classification.
// Redaction: the single redact()/redactObject() helper used at record time everywhere a value
// might reach evidence or the compiled artifact.
export * from "./policy.js";
export * from "./redact.js";
