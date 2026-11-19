# Step 3 plan — transfer capability artifacts (approved)

Branch `fleet/day-1`. This is the builder's Step 2 plan for the artifacts with the reviewer's
changes applied; it was approved before any artifact was written. Parts A (screenshot flake) and B
(docs, control-route move) of Step 3 are listed for completeness; their rationale is D8 and D9 in
`docs/DECISIONS.md`.

## Commits, in order

1. Flake fix (`WebSurface.perceive` screenshot retry, `screenshotRetries`, unit test, 10 green
   full runs, REPO_NOTES "Known flake", D8).
2. Docs: CLAUDE.md working agreement, FLEET_BRIEF "Amendments (2026-11-09)", D9.
3. Move `/control/session-timeout`, `/control/transient/:state`, `/control/unexpected-dialog/:state`
   before the tenant routers (cookie-less use); session-timeout still clears tenant-a's cookie; test
   that a cookie-less `GET /control/transient/off` works.
4. This file.
5. Artifacts and overrides.
6. Replay tests.
7. Evidence and status approvals.

`npm test` before every commit; never commit or push on red. Push at the end.

## Shared rules for both artifacts

- Hand-authored (D3) in the shape of `artifacts/open-sub-account-confirmed.json`; validated through
  `deserializeCapability`.
- `target`: `entryUrlPattern` `^http://localhost:4100/`, `surfaceType` `web`, `appId`
  `great-plains-cu-backoffice`.
- Locator rule for every control: `roleName` first, then `labelText` (textboxes only), then
  `textAnchor` at 0.6.
- Recoverables: only the existing "System temporarily unavailable" retry, as in the other
  artifacts. **No** recoverable for the 503 "System unavailable" page (a reload after Submit can
  re-post the form; Step 4 makes replay stop retrying after an irreversible step).

## `transfer`

- Inputs: `username`, `password` (redacted); `memberId`, `toMemberId`, `amount`, `memo` (not
  redacted).
- Steps:
  1. type username
  2. type password
  3. click "Log In"
  4. type Member ID
  5. click "Search"
  6. click "Transfer"
  7. type To Member ID
  8. type Amount
  9. type Memo
  10. click "Continue"
  11. click "Submit" — `risk: "risky"`, `roleName` "Submit" first
  12. readText the TXN reference on the "Transfer Submitted" page
- Output: one, `confirmationRef` (the bank's TXN id), produced by step 12. *(Reviewer change: the
  ledger and history stay the proof; the ref is useful evidence and goes into job results later.)*
- Success condition: `textPresent` "Transfer Submitted".
- Known outcomes, matching the exact text in `mock-app/transfer.ts` / `views.ts`: `NO_SUCH_MEMBER`,
  `PERMISSION_DENIED`, `NO_SUCH_RECIPIENT`, `RECIPIENT_CLOSED` ("Recipient … is closed"),
  `SOURCE_CLOSED` ("Source member … is closed"), `SAME_MEMBER`, `INSUFFICIENT_FUNDS`,
  `INVALID_AMOUNT`.
- Overrides: `overrides/transfer.tenant-a.json` (entryUrl only), `transfer.tenant-b.json` (step-05
  "Find Member"), `transfer.tenant-c.json` (entryUrl only unless a test proves more is needed; if
  so, keep `roleName` "Submit" first on step-11).

## `transfer-history-lookup` (read-only; every step `risk: "safe"`)

- Steps 1–5: the same login and member-search steps as `transfer`; 6. click "History"; 7. type memo
  into "Memo"; 8. click "Filter"; 9. readText the "Matching transfers" count (`tableCell` rowLabel
  "Matching transfers" at 0.9, then `css` `.zk9bv` at 0.4).
- Output: `matchingCount`.
- Success condition: `elementPresent` on the count target.
- Known outcomes: `NO_SUCH_MEMBER`, `PERMISSION_DENIED`. Same transient recoverable.
- Overrides: same three files, tenant-b step-05.
- A test asserts `.zk9bv` matches exactly one element on tenant-c's history page.

## Approval

`status/transfer.json` and `status/transfer-history-lookup.json`, approved with a reason citing the
replay tests and the evidence folder. Committed with the evidence, after the tests pass. Tests do
**not** depend on the committed status files: they use `approveUnattended` or a temp `statusDir`
(D7 forbids `approveUnattended` in workers, not in tests).

## Replay tests (`src/replay/transfer.test.ts`)

- Schema round-trip.
- The gate is risky only on step 11, on all three tenants.
- Success per tenant with a ledger check, including `confirmationRef` matching the ledger row id.
- `needs_human` without `approveRisky`, and 0 ledger rows.
- Twice with the same memo, then the lookup returns "2"; tenant isolation.
- Each business outcome with an empty ledger.
- A 100-char memo is stored at 64 and the full-memo lookup returns 0.
- Write-then-error: non-success result, exactly 1 row, lookup returns "1"; report which
  `ReplayResult` status and category it produced.
- `errors/on` writes nothing.
- Transient recovery on login and navigation steps.
- Launch as few browsers as possible. Reset the ledger between tests via `/control/ledger/reset`.

## Evidence

A script replays `transfer` and the lookup on all three tenants and saves the run output plus the
ledger JSON under `evidence/transfer-replay/`, with an index line in `evidence/README.md`.

## Build notes (decided after approval, before writing the artifacts)

1. **The TXN reference needs its own element.** The Submitted page renders
   `<p>Reference TXN-000001</p>`; no locator strategy can isolate the id, so `readText` would
   return "Reference TXN-000001". The page will render the reference with the existing
   `balanceBlock` helper instead (a `<tr><th>Reference</th><td>TXN-…</td></tr>` row on tenants a/b,
   sibling `<div>`s with the value in `.zk9bv` on tenant-c), the same pattern as the history count.
   Step 12's target is then `tableCell` rowLabel "Reference" (0.9), then `css` `.zk9bv` (0.4), and
   the test asserts `.zk9bv` is unique on tenant-c's Submitted page too.
2. **Known-outcome order matters.** `textPresent` is a substring check and the first match wins.
   "Recipient 10003 is closed." has no unique fixed substring apart from "is closed.", which
   "Source member 10003 is closed." also contains. So `SOURCE_CLOSED` matches "Source member" and is
   listed first; `NO_SUCH_RECIPIENT` ("Recipient not found") precedes `RECIPIENT_CLOSED`
   ("is closed.").
3. **Tests approve into a temp `statusDir`.** `runReplay`'s `finish()` writes
   `status/<id>.json` for a *draft* capability on every success, so `approveUnattended` alone would
   make tests create the status files in the repo. Tests call `approveCapability(id, {reason,
   statusDir: <tmp>})` and pass that `statusDir`.

## After the build

Write `docs/plans/step-04.md` (commit it; don't build it): `runReplay` gains optional, additive
`browser`, `onIrreversible {before, after}`, `signal`; irreversibility hardening (policyGate risky
OR `step.risk === "risky"`); no retries/reload/pauseOrFail retry after an irreversible action has
been attempted, and a result that says "commit may have happened".
