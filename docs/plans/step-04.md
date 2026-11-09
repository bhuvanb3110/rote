# Step 4 plan — extend `runReplay` for the fleet (proposed, not built)

Branch `fleet/day-1`. Reads `docs/plans/step-03.md`. Status: **for review**; nothing here is built.

Rule (CLAUDE.md): extend replay, never fork it. Every change enters `runReplay` as an optional,
additive option, and every existing call site (CLI `replay`/`operator`/`catalog invoke`, catalog
HTTP, `invokeCapability`, all tests) keeps working unchanged. Each item below is one small commit
with passing tests; the full suite must stay green after each.

## What Step 3 measured that this step must fix

From `src/replay/transfer.test.ts`:

- **Write-then-error** (`errors/after-write`): the bank commits, the page shows the 503, and replay
  returns `{status: "failure", category: "unexpected-state", atStepId: "step-12"}`. Nothing in that
  result says the Submit already went through. A caller that retries on `failure` sends the money
  twice.
- **Transient interstitial right after Submit** (not yet tested; see 5.3): replay's recoverable
  rule would `page.reload()`. The interstitial is the response to the confirm **POST**, so a reload
  re-posts the form. Nothing was written the first time, so the reload commits now, and replay would
  report success. That's harmless only by luck. The same reload after an after-write error would
  duplicate.
- **Hardening gap** (REPO_NOTES Q3): `step.risk` is never read by replay. A tenant override that drops
  `roleName "Submit"` makes `policyGate` say safe.

## 1. `browser?: Browser` — reuse the worker's browser

- `ReplayOptions.browser?: import("playwright").Browser`.
- `WebSurface.launch({ headless, browser })`: when `browser` is given, open
  `browser.newContext()` + `newPage()` and remember `ownsBrowser = false`. `close()` then closes
  **only that context**, never the browser. Without `browser`, behavior is exactly today's (launch,
  own, close the browser). `headless` is ignored when a browser is passed (the browser already
  decided); documented on the option.
- Escalation (`controller.bind(surface)`) is unaffected: it uses the page/context, not the browser.

Tests (one shared `chromium.launch()` for the file):
- Two sequential runs on one browser both succeed; afterwards `browser.isConnected()` is true and
  `browser.contexts()` is empty.
- Two **concurrent** runs on one browser (different members) both succeed with their own balances.
  Contexts don't share cookies.
- A run that throws after the context opened (e.g. a stubbed `surface.act` that throws on
  navigate) still closes its context and leaves the browser open.
- Unchanged path: the existing 149 tests, which never pass `browser`.

## 2. Irreversibility hardening

In the step loop:

```ts
const irreversible = decision.risk === "risky" || step.risk === "risky";
```

`irreversible` replaces `decision.risk === "risky"` everywhere `runReplay` makes a risk decision:
the `approveRisky` gate, the `risk_approved` evidence entry, and the hooks and post-commit rules
below. It can only be **stricter** than today: a step is irreversible if either source says so.
Evidence records which source said so (`{ gate: "risky" | "safe", artifact: "risky" | "safe" }`).

Impact audit (done while writing this plan): every step with `risk: "risky"` today
(`open-sub-account-confirmed` step-09, `transfer` step-11, the two inline fixtures in
`replay.test.ts` (e)/(f)) is also risky at the gate, so no existing test changes behavior.

Tests:
- A capability whose risky step's override has **only** a `textAnchor` "Submit button" target (gate
  says safe) and `risk: "risky"`: without `approveRisky` → `needs_human` at that step, 0 ledger rows.
  With it, `onIrreversible.before` is called (see 3).
- The converse: `risk: "safe"` in the artifact but gate says risky → still treated as irreversible
  (today's behavior, pinned).

## 3. `onIrreversible?: { before(step), after(step) }`

```ts
onIrreversible?: {
  /** Runs right before the irreversible click. Throw to prevent it (the fleet's fencing check). */
  before(step: Step): Promise<void>;
  /** Runs right after the click (whether the click resolved or threw). Fault injection fires here. */
  after(step: Step): Promise<void>;
};
```

Order for an irreversible step: policy gate → `approveRisky` check (unchanged) → `before(step)` →
**mark `irreversibleAttempted = { stepId }`** → `surface.act(click)` → `after(step)` (in a
`finally`, so it runs even if the click threw: a click that threw may still have been dispatched)
→ perceive/recognize as today.

- **`before()` throws** → the click never happens; `irreversibleAttempted` stays unset; the
  context is closed and `runReplay` **rejects with that same error** (not wrapped). The fleet threw
  it (lost lease / fencing token mismatch), so the fleet owns it, and a `ReplayResult` would only
  invite a stale worker to record it.
- **`after()` throws** → the context is closed and `runReplay` rejects with that error. In the
  crash-after-submit test, `after()` calls `process.exit()` (or the test's simulated crash), so
  nothing is returned at all, which is the point.
- `irreversibleAttempted` is set **before** `act()` on purpose: if the process dies inside the
  click, the fleet's own commit intent (written in `before()`) already says "committing", and
  in-process the flag already says "may have committed".
- Neither hook runs for safe steps, or when `approveRisky` is false (replay stops before the click).

Tests: `before` and `after` each called exactly once, in order, with step-11; `before` throwing →
rejection with that error, 0 ledger rows, `after` never called; `after` throwing → rejection,
exactly 1 ledger row (the click happened); no hooks on the lookup capability.

## 4. `signal?: AbortSignal`

- If `signal.aborted` at entry: reject immediately with `signal.reason`; no browser/context opened.
- Otherwise `signal.addEventListener("abort", …, { once: true })` closes the context (or the
  browser if replay owns it) **immediately**, mid-action. Every await in the loop then fails with
  a Playwright "Target closed" error. The top-level `catch` sees `signal.aborted` and **rejects with
  `signal.reason`** (an `AbortError` `DOMException` by default), instead of the Playwright error.
- **Defined result: abort always rejects, never returns a `ReplayResult`**, even after an
  irreversible attempt. The fleet aborts only when its heartbeat lost the lease. A worker that lost
  the lease must not record anything, and the next lease holder recovers by reading history.
  Evidence gets one `aborted` entry (`{ reason, irreversibleAttempted }`); no `result` entry and no
  confidence write.
- The listener is removed in `finally` (no leak across runs on a long-lived worker).

Tests: pre-aborted signal → rejects, `browser.contexts()` unchanged; abort during a slow step
(`/control/latency/3000`, abort after 300 ms) → rejects with `AbortError` in well under 3 s, the
shared browser is still connected with 0 contexts, 0 ledger rows; abort inside `after()` (after the
click) → rejects with `AbortError`, exactly 1 ledger row (the verifier's job, not replay's).

## 5. After an irreversible action has been attempted

Once `irreversibleAttempted` is set, for the rest of the run:

1. **No recoverable retries and no reload.** If a recoverable rule matches (e.g. the transient
   interstitial), replay does **not** back off, reload or re-recognize. It returns immediately (5.4).
   A reload of a POST response re-posts the form; after Submit that is a second transfer.
2. **No `pauseOrFail` retry of the irreversible step.** If the irreversible step itself fails its
   checkpoint or its action threw:
   - no controller → terminal result (5.4);
   - with a controller (operator mode) → still raise to the human (they may finish or verify by
     hand), but a `"retry"` outcome on resume is converted to a terminal `needs_human` result (5.4).
     `"complete"` and `"skip"` behave as today. Replay never clicks the irreversible control twice
     in one run.
   - Later **safe** steps (e.g. step-12 `readText`) may still be retried by `pauseOrFail`, because
     re-reading a page is idempotent. They still never reload (rule 1).
3. **Thrown errors become results.** A throw after the attempt (Playwright error, a third screenshot
   failure, a locator crash) is caught and returned as `failure` with category `"unknown"` and the
   marker (5.4). Exceptions: `before`/`after` hook errors and aborts still reject (3, 4). Before the
   attempt, throws behave exactly as today.
4. **Every non-success result carries the marker** (shape below). It is added in **one place**,
   `finish()`, from the run-level `irreversibleAttempted` variable, so no exit path can forget it.
   `success` never carries it (a recognized success condition after Submit is the confirmation).

### Proposed result shape: an optional field, not a new status

```ts
// src/artifact/replayResult.ts
export const CommitUncertainSchema = z.object({
  /** The irreversible step whose action was attempted in this run. */
  irreversibleStepId: z.string().min(1),
  /** Human-readable: what was observed after the attempt. */
  detail: z.string().min(1),
});

// added as `commitUncertain: CommitUncertainSchema.optional()` to the
// business_outcome, needs_human and failure members (never to success).
```

Meaning: **present → "the commit may have happened; verify via history before any retry."
Absent on a non-success → no irreversible action was attempted in this run, so a blind retry is
safe.** The fleet's recovery reads exactly this.

Why a field and not a fifth status (`commit_unknown`):
- CLAUDE.md fixes the replay result as the four-way union `success | business_outcome |
  needs_human | failure` and calls the business_outcome/failure distinction load-bearing. A fifth
  status changes a non-negotiable. A field adds information without touching that.
- A field keeps the underlying classification. "503 after Submit" stays a `failure` with its real
  category, and "Insufficient funds re-validated on the confirm POST" stays a `business_outcome`
  with its code. The fleet still decides via history.
- Additive in Zod: every result that parses today still parses. Existing code that branches on
  `status` compiles unchanged.
- Risk: a consumer can ignore an optional field. Mitigations: set centrally in `finish()`; the CLI
  prints a distinct warning; the fleet worker treats `commitUncertain` as mandatory input to
  recovery; a test asserts that every non-success exit after the attempt carries it.

Alternative kept on the table for the reviewer: `failure.category: "commit-unknown"` (enum
widening). It's rejected because it only covers `failure`, overwrites the real category, and
`business_outcome`/`needs_human` after Submit would have nowhere to say it.

### Schema impact on `ReplayResultSchema` and every consumer

| Consumer | Change |
| --- | --- |
| `src/artifact/replayResult.ts` | Add `CommitUncertainSchema`; optional on three members. Export the type. |
| `src/artifact/capability.test.ts` | Parse each non-success with and without the field; on `success` the field is not in the schema (Zod's default `z.object` strips it, so it can never reach a caller). |
| `src/replay/replay.ts` | Track `irreversibleAttempted`; `finish()` attaches the field to non-success; rules 5.1–5.3. |
| `src/cli/index.ts` (`replay`, `operator`, `catalog invoke`) | Already logs the whole result (`...result`); add a distinct `logger.warn` line "commit may have happened at <step> — verify before retrying" and keep exit code 1. |
| `src/catalog/http.ts` | None (returns the result as-is, 200). Documented in the README's HTTP section. |
| `src/catalog/schema.ts` | None (it describes capability inputs/outputs, not results). |
| `examples/agent-demo.ts` | None (prints JSON). |
| `scripts/evidence-transfer-replay.ts` | None for success; it already fails its check on any non-success. |
| `src/confidence/*` | None (confidence is only recorded on `success`). |
| Escalation (`controller.ts`, console) | None for the controller. The pause request's `reason` mentions that the irreversible step was already attempted. |
| Fleet worker (Day 1/2 code) | Consumer by design: `commitUncertain` present → job goes to `committing`-recovery (history lookup), never a blind retry. |
| Docs | README result-contract section, REPORT.md §result taxonomy, D10 (this decision). |

## 6. Deterministic ways to show a transient interstitial or a 503 right after Submit

No randomness, and they work across processes (Docker chaos as well as in-process tests):

- **New mock control `GET /control/transient/next`**: arms a one-shot flag; the *next*
  authenticated tenant request returns the interstitial (before any handler runs, so no write),
  then the flag clears. Registered with the other controls (cookie-less). Unit-tested at HTTP
  level.
- **503 right after Submit, no write:** `onIrreversible.before()` calls `/control/errors/on`. The
  confirm POST hits the 503 middleware before the handler. Expect a `failure` with
  `commitUncertain`, **0 ledger rows** (the fleet's history check then says "not committed → safe
  to retry").
- **503 right after Submit, with write:** `/control/errors/after-write` (exists). Expect a `failure`
  with `commitUncertain`, **exactly 1 row**, history lookup "1".
- **Transient right after Submit:** `before()` calls `/control/transient/next`. Expect a non-success
  with `commitUncertain`, **0 ledger rows**, and **no `recover` evidence entry at or after step-11**
  (proves no reload/re-POST). This test is written first and fails on the unpatched code (the reload
  re-posts and the run "succeeds" with 1 row). That failure is recorded in the commit message as the
  before/after.
- **Transient before Submit still recovers:** `/control/transient/next` armed before the run → the
  first authenticated request (post-login) shows the interstitial and replay recovers to success
  (rules 5.x apply only after the attempt).

## 7. Commits

1. `WebSurface` + `ReplayOptions.browser` (context-only close) + tests.
2. Irreversibility hardening + tests.
3. `ReplayResultSchema.commitUncertain` + schema tests + CLI warning (no behavior change yet:
   nothing sets it).
4. `/control/transient/next` + HTTP test.
5. Post-irreversible rules (5.1–5.4) + the failing-first "transient after Submit" test and the
   503 tests.
6. `onIrreversible` hooks + tests.
7. `signal` + tests.
8. Docs: D10 (result marker), D11 (abort rejects, hooks reject), README/REPORT result contract,
   REPO_NOTES Q3 hazard marked fixed; `docs/plans/step-05.md`.

`npm test` before every commit; never commit or push on red.

## Open questions for the reviewer

1. Field (`commitUncertain`) vs. fifth status — this plan recommends the field (reasons above).
2. Abort and hook errors **reject** rather than return a result. OK, or should abort return a
   `failure` carrying `commitUncertain` when the click was attempted?
3. Should `business_outcome` after the attempt carry the marker? The plan says yes, to be
   conservative: the bank's re-validation on the confirm POST means no write in the mock, but a real
   bank might commit and then show an error.
4. `headless` is ignored when `browser` is passed. Alternatively, throw if both are given.
