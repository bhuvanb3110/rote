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
- Scope: a SINGLE-MACHINE fleet, specified in docs/FLEET_BRIEF.md: Postgres job queue
  (`SELECT … FOR UPDATE SKIP LOCKED`), worker processes, leases and fencing tokens, Docker
  Compose. Multi-machine (Kubernetes, autoscaling, distributed anything) stays OUT of scope, as
  do desktop surfaces; those remain DESIGN-ONLY, addressed in REPORT.md. (Reverses the earlier
  "single process, no queues" rule for the fleet only -- see docs/DECISIONS.md D1.)

## Repo layout
surface/ agent/ artifact/ replay/ safety/ escalation/ evidence/ catalog/ cli/ mock-app/
queue/ (src/queue: Postgres job queue) db/migrations/ (forward-only SQL, never edited once applied)
worker/ (src/worker: fleet worker process) Dockerfile + docker-compose.yml (bank, api, workers)

## Fleet build — working agreement
Applies to all work under docs/FLEET_BRIEF.md. Repo facts live in docs/REPO_NOTES.md.
- Plan before coding. Present the plan for review; build only after it is approved.
- Small commits, each with passing tests.
- All existing tests must pass after every step. Run `npm test` before committing. From Step 5 on it
  needs Postgres (`docker compose up -d postgres`) and fails loudly without it; `npm run test:unit`
  runs everything except `*.db.test.ts`, for checking pure code changes without Docker. The old
  screenshot flake is fixed (D8); if any test flakes, rerun to confirm and report it, never hide it.
- Never push on a red test run.
- Each step's plan is saved to docs/plans/step-NN.md and committed; the next step reads it.
- Every design choice goes in docs/DECISIONS.md (Decision, Alternatives considered, Why, Date).
- Never claim a result without a script-checked run saved under evidence/. "Zero duplicates"
  means a script read the mock bank's ledger and the output is committed.
- Extend replay; never fork it. New behavior enters `runReplay` as optional, additive options so
  every existing call site keeps working unchanged.
- No cuts. Quality over schedule; every deliverable gets built. (See the 2026-11-09 amendments at
  the end of docs/FLEET_BRIEF.md.)
- Don't run `npm audit fix`. Dependency upgrades get their own reviewed step.
- End every step with the handoff report: Summary / Commits (hash + message) / Tests (command,
  passed/failed/skipped) / REPO_NOTES verification / Docker check / Decisions added / Open
  questions for the reviewer / Plan for next step.
