# Project context for Claude Code
Computer-use automation for legacy bank/credit-union back-office apps with no API.
Flow: LLM discovers a UI task once -> compile to a typed, versioned Capability artifact ->
replay deterministically with no LLM in the loop -> escalate to a human on the same live
session when stuck -> stay inside safety guardrails.

## Non-negotiable design decisions
- Language: TypeScript, strict mode, ESM. Schema-first with Zod (one definition = type +
  JSON serialization + runtime validator).
- Surface abstraction: all UI interaction goes through a `Surface` interface
  (perceive/act/locate). `WebSurface` (Playwright) is the only concrete impl now; the point
  is that a future `DesktopSurface` (OS accessibility tree) would swap in without changing
  the artifact schema.
- Locators are SEMANTIC-FIRST and RANKED. An element is an `ElementDescriptor` with an
  ordered list of strategies: role+accessible-name -> label/text anchor -> table-relative ->
  css -> visual/coordinate fallback (described in words). Never a single brittle CSS selector.
- Replay result is a discriminated union: success | business_outcome | needs_human | failure.
  "No such member" is a business_outcome, NOT a failure. This distinction is load-bearing.
- Error taxonomy: after each action, recognizers classify observed state into
  expected-next | known-business-outcome | recoverable-interstitial | transient(retry) |
  session-timeout | unknown. Map to the three required classes: business outcomes /
  recoverable / hard failure.
- Safety: a single policy gate enforces an allowlist (URL patterns + allowed action types) in
  BOTH discovery and replay. Actions are classified safe(reversible) vs risky(irreversible).
  Discovery STOPS at confirmation screens rather than committing irreversible actions.
- Redaction: credentials/tokens/full PII never land in artifacts, logs, or screenshots.
  The mock app uses fake data so evidence is safe to commit; redaction is still implemented.
- Escalation: an explicit control-transfer state machine with an owner token
  (automation|human). The human operates the SAME live browser session, then hands back.
- Do NOT build scaling infra (queues, clusters, multi-tenant plumbing). Single process.
  Multi-tenant and desktop are DESIGN-ONLY, addressed in REPORT.md.

## Repo layout
surface/ agent/ artifact/ replay/ safety/ escalation/ evidence/ catalog/ cli/ mock-app/
