# Repo notes — read before Day 1 of the fleet build

Written after reading the whole codebase and running it, before any fleet code. Answers the seven
"Starting point" questions in the 4-day build brief, then lists where the repo disagrees with the
brief and how the plan adjusts. Where the two disagree, the repo wins.

Baseline at the time of writing: `npx vitest run` → **13 files, 83 tests, 83 passing** (commit
`HEAD` of `main`, 2026-10-29).

Re-verified 2026-11-09 on the builder's Windows machine, `npm test` run twice back to back:

| Run | Result |
| --- | --- |
| 1 | 13 files, **82 passed, 1 failed** (83) — `replay.test.ts` test (e), see "Known flake" |
| 2 | 13 files, **83 passed** (83) |

## Known flake: `page.screenshot` under parallel browsers

`src/replay/replay.test.ts` test (e) ("risky action without approveRisky returns needs_human…")
intermittently fails with `page.screenshot: Protocol error (Page.captureScreenshot): Unable to
capture screenshot`. Seen twice on Windows: once in an earlier full run, and again in run 1 on
2026-11-09 (stack: `WebSurface.perceive` at `src/surface/webSurface.ts:107` ← `runReplay` at
`src/replay/replay.ts:248` ← test line 149). It passes alone and in the next full run. Cause is
not proven; the working theory is that vitest runs test files in parallel, each launching its own
headless Chromium, and a busy machine drops a `Page.captureScreenshot` call.

**Why it matters for the fleet:** `perceive()` takes a full screenshot *after every step*
(`replay.ts:248`, inside the act loop), and a screenshot failure is not handled anywhere — it
throws out of `runReplay`. A fleet runs many browsers at once, so this will not be rare. For a job
that throws mid-run it is harmless before the commit intent, but a throw *after* the irreversible
click would look like a crash at the worst moment.

**Measured and fixed (Step 3, 2026-11-09).** By then the suite was 125 tests and the flake had
spread beyond test (e):

| | Full runs | Result |
| --- | --- | --- |
| Before, unpatched (reviewer's runs) | 4 | **4 of 4 failed**, 2–5 tests each, every one `page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot` |
| Reviewer's trial patch with a retry | 6 | 6 of 6 passed 125/125; 1–3 retries per run, every one succeeded on its first retry |
| After, this fix (`npm test` ×10 back to back) | 10 | **10 of 10 passed**, 16 files, 128/128 each (125 + 3 new unit tests); `evidence/screenshot-flake-fix/npm-test-x10.txt` |

The retry counter is not yet logged anywhere, so these 10 runs show the suite is green but not how
many retries fired in them; the fleet's metrics will expose `screenshotRetries`.

**Cause:** a transient Chromium hiccup under CPU load. vitest runs test files in parallel, each
with its own headless Chromium, and a loaded machine occasionally drops a `Page.captureScreenshot`
call. Pre-existing; not caused by Step 2. **Fix:** `WebSurface.perceive()` retries
`page.screenshot()` up to 3 attempts in total, only when the message matches
`/Unable to capture screenshot/`, with 100 ms × attempt backoff; any other error, or a third
failure, throws as before. Retries are counted on the surface (`screenshotRetries`) so the fleet can
report them as a metric. Unit tests: `src/surface/webSurface.test.ts`. Rationale: D8.

## Known limitations

Recorded as found; each names its planned fix or the step that owns it.

1. **Screenshots show "Signed in as <username>".** The member-lookup page (`renderHome`) prints the
   operator's username, and replay screenshots every step into evidence. The mock uses fake
   credentials, so committed evidence is safe, but against a real bank this puts a credential value
   in a screenshot. **Planned fix (Day 4):** Playwright's screenshot `mask` option for elements that
   display credential values, driven from the capability's redacted inputs.
2. **The artifact input schema has no non-empty / min-length constraint.** `TypedParamSchema` is
   `{name, type, required, description, redact}`, and `inputsToZodSchema` maps `string` to a plain
   `z.string()`. So `""` passes validation and reaches the browser. Measured (Step 4): an empty
   `toMemberId` or `amount` is now the `REQUIRED_FIELD_MISSING` business outcome (the bank's
   "… is required."). An empty `memberId` searches for nothing; the bank redirects to `/member/`,
   which has no route (Express's default 404, "Cannot GET /member/"), and replay fails at step-06
   (no Transfer button), before Submit. Fixing this needs a schema change (e.g. `minLength` on
   `TypedParam`), not made here; it belongs in a reviewed schema step.
3. **Business-outcome recognizers are scoped by CSS, not semantics** (D14). The transfer and lookup
   outcomes are `elementPresent` on `.msg1.err:has-text("…")`. The existing schema could do this
   with no change, and it fixes the memo false positive (a memo containing "Insufficient funds" was
   reported as that outcome; tested). But the descriptor has only a `css` strategy (a message box
   has no role or label to match), and `:has-text` is Playwright-specific, so a future
   `DesktopSurface` would need an equivalent. The other three artifacts (`member-lookup`,
   `open-sub-account*`) still use whole-page `textPresent`; they have no free-text field that
   echoes back.
4. **A Submit that is never found still gets `commitUncertain`.** `irreversibleAttempted` is set
   before `act()` (approved, so a crash inside the click already counts). If the locator doesn't
   resolve at all, the click was never dispatched, but the result still carries the marker. Also,
   the bounded settle wait runs its full 10 s, because no navigation comes. Safe, but it costs the
   fleet one history lookup (0 matches → retry). Possible fix: `WebSurface` throws a typed
   "locator not resolved" error that `runReplay` treats as "not dispatched". Open question for the
   reviewer.
5. **`signal` is not observed while paused for a human.** With an `EscalationController`,
   `waitForAutomation()` does not race the abort. Fleet workers never pass a controller.
6. ~~**An approval is bound to the version string, not the content**~~ **Fixed in Step 6 (D24).**
   Approvals now also record `approvedDigest`, SHA-256 of the artifact's canonical JSON (keys sorted,
   no whitespace, after schema validation), so formatting-only edits keep the approval and any content
   edit, with or without a version bump, is refused ("artifact content changed since approval;
   re-approve"). All five status files were backfilled; the guard test checks digests. A status
   without a digest falls back to the version check (grandfathered). **Still open:** tenant override
   files (`overrides/*.json`) are not covered by any approval; an override edit changes what that
   tenant's replay executes without a re-approval (open question for the reviewer).
7. **With one hot tenant, a dequeuer can return `null` while a slot is free** (D18, Step 5). It skips
   a tenant whose row another dequeuer holds (`SKIP LOCKED`), so in a burst some dequeuers come back
   empty and poll again. Correctness is unaffected (the cap is never exceeded); the cost is one poll
   interval. The Day-3 load test measures whether it matters.

## Fleet Step 5: Postgres is required (2026-11-09)

- `docker compose up -d postgres` starts `postgres:17` (resolved digest
  `postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`, PostgreSQL 17.11)
  on `127.0.0.1:55432`, data in the named volume `pgdata`. Health: `pg_isready`.
- `npm test` needs it and fails loudly without it (`PostgresUnreachableError`); `npm run test:unit`
  runs everything except `*.db.test.ts`. Tests use the `rote_test` database (created on demand), one
  schema per test file (D20); the dev database is `rote`.
- `npm run db:migrate` applies `db/migrations/*.sql` to `ROTE_DATABASE_URL` (default
  `postgres://rote:rote_dev_only@127.0.0.1:55432/rote`; `.env.example` lists the variables).
- The queue lives in `src/queue/` (enqueue, dequeue, migrations, row schemas); design in
  `docs/plans/step-05.md`, decisions D16–D23.
- **Approvals are version-bound** (D15). All five committed status files name their version; the
  transfer pair was re-approved for 1.1.0 on new evidence (`evidence/transfer-replay-1.1.0/`).

## The seven questions

### 1. Language, framework, and how replay is invoked

TypeScript (strict, ESM, `tsx` to run, `tsc` to build), Node 20+. Zod for every schema, Playwright
for the browser, Express 5 for HTTP, pino for logs, vitest for tests, commander for the CLI.

Replay is one async function: `runReplay(options: ReplayOptions): Promise<ReplayResult>` in
`src/replay/replay.ts`. Three entry points call it:

| Entry point | Where | Notes |
| --- | --- | --- |
| Function | `runReplay` / `invokeCapability` (`src/catalog/invoke.ts`) | `invokeCapability` adds param validation + tenant override resolution, then calls `runReplay` |
| CLI | `src/cli/index.ts` — `replay`, `operator`, `catalog invoke` | `operator` passes an `EscalationController` so `needs_human` pauses instead of exiting |
| HTTP | `src/catalog/http.ts` — `POST /capabilities/:id/invoke` | Calls `invokeCapability` |

The fleet worker should call **`invokeCapability`** (it already does param validation and tenant
resolution), extended with the new options below.

### 2. Can replay run in a separate process? Shared state?

**Yes — verified by a spike.** Four `replay` CLI processes run at once against one mock bank
(members 10001/10002 alternating, different usernames) all returned `success` with the correct
balance for their own member, in 9 s wall-clock total. No crosstalk.

What each run touches, and whether two workers would fight over it:

| Resource | Shared? | Verdict for the fleet |
| --- | --- | --- |
| Browser | `WebSurface.launch()` starts a **whole new Chromium per run** and `close()` closes the browser | Works, but wasteful. The brief wants one browser per worker, one context per job → add a way to pass an existing `Browser` in (see "Changes to replay") |
| Evidence dir `evidence/<runId>/` | `runId` = capability id + timestamp + 8 random hex chars | No collisions |
| `status/<capabilityId>.json` (confidence/approval) | Written by `recordConfidenceRun` **only for draft capabilities**; approved ones are never written | Approved capabilities: safe. Draft capabilities: a known lost-update race (documented in `src/confidence/store.ts`). Fleet rule: only run **approved** capabilities unattended — which `checkApproval` already enforces |
| Module-level state in `src/` | None found (no top-level `let`, no singletons). `EscalationController` is per-run | Safe |
| Mock bank state | In-memory `Map`s in `mock-app/data.ts`, one process | Fine — workers are clients of it, not owners |
| Escalation console | Fixed port 4200, only in the `operator` CLI | Not used by fleet workers |

Conclusion: no shared-state fix is needed before Day 1. The "budget half of Day 1" risk in the
brief does not apply.

Re-verified 2026-11-09: four concurrent `replay` CLI processes against one mock bank (members
10001/10002 alternating, distinct usernames) all returned `success` with the right balance for their
own member ($4532.10 / $812.55). Two further details from re-reading the code:

- `defaultEvidenceBaseDir()` (`src/evidence/recorder.ts:13`) is `os.tmpdir()/rote-evidence-test`
  when `VITEST` is set and the cwd-relative `evidence/` otherwise. Fleet workers must pass
  `evidenceBaseDir` explicitly (a per-container volume), or every job writes screenshots into the
  repo's tracked `evidence/` folder.
- The replay path does one `readFile` of `status/<id>.json` per run (`checkApproval`); an approved
  capability is never written. All three committed capabilities are grandfathered `approved`, and
  the new transfer artifacts must be approved with a recorded reason before the fleet can run them.
  *Updated in Step 5: approvals are now bound to the artifact version (D15); all five status files
  record `approvedVersion`, and a run of a capability approved for a different version is refused.
  A capability approved for another version is recorded like a draft (it is written), so the fleet
  rule stays: run only capabilities approved for their current version, never `approveUnattended`.*

### 3. Where are irreversible steps marked?

Two places, and replay uses the **live** one:

- **Live classification (authoritative at replay time):** `policyGate()` in `src/safety/policy.ts`
  returns `risk: "risky"` for any `click` whose accessible name matches `DEFAULT_RISKY_CLICK_NAMES`
  (`/^confirm$/i`, `/^submit$/i`, `/^delete$/i`, `/^remove$/i`). Only `click` can ever be risky.
- **Recorded in the artifact:** each `Step` has `risk: "safe" | "risky"` (schema in
  `src/artifact/schema.ts`), set by what discovery observed. `open-sub-account-confirmed.json`'s
  final Confirm step is `"risky"`.

`runReplay` refuses a risky step unless `approveRisky: true` (otherwise it returns or pauses with
`needs_human`). The fleet reuses exactly this: the commit-intent write wraps **the step where
`decision.risk === "risky"`**, so there is one definition of "irreversible" in the codebase, not two.

**Correction / hazard found on verification.** `Step.risk` in the artifact is *not read by replay*
at all (`replay.ts` only uses `decision.risk` from `policyGate`; the field is informational). And
the live classification is fragile in one specific way: `clickTargetName()` (`policy.ts:91-96`)
uses the **`roleName` strategy's name if one exists, otherwise `describedAs`**. So a tenant
override that drops the `roleName` strategy and describes the button as, say, "Submit button"
would fail `/^submit$/i` and the click would be classified **safe** — silently skipping the
commit-intent hook. Tenant-c's hostile `<a>` buttons make a textAnchor-only override tempting.
Rule for the transfer artifacts and any override: keep a `roleName` strategy named exactly
"Submit" on the irreversible step, and add a test per tenant asserting the live gate says risky.

**Fixed in Step 4 (2026-11-09).** `runReplay` now treats a step as irreversible if the live gate
says risky **or** the artifact step has `risk: "risky"` (`replay.ts`, "Hardening"). `step.risk` is
read, and the override hazard above no longer skips the gate, the hooks or the post-attempt rules:
`src/replay/fleet.test.ts` replays a step-11 that has only a textAnchor and is described as
"Submit control" (the gate says safe). It is refused without `approveRisky` (0 rows), and with it,
`onIrreversible.before` runs. Evidence records `riskSources: {gate, artifact}`. The roleName rule
above still stands as good practice.

### 4. Transaction history page and memo field in the mock bank?

**Neither exists — and there is no transfer flow at all.** The mock bank has: login, member
lookup, member detail, and open-sub-account (form → confirm → "Created"). That is the only
irreversible action, and the "Confirm" POST **persists nothing**: it clears the session draft and
renders a flash page.

This is the biggest gap between the brief and the repo. See "Plan adjustments" below.

### 5. A ledger a test script can read directly?

**No.** Nothing in the mock bank records completed actions. Members and balances are a hard-coded
array; there is no database, file, or debug endpoint for writes.

The repo already has a pattern for test-only hooks: unprefixed `/control/*` routes (session
timeout, transient errors, unexpected dialog). A ledger read fits there: `GET /control/ledger`.

### 6. How does `POST /capabilities/:id/invoke` run today?

**Synchronously, in the request.** The handler `await`s `invokeCapability(...)`, which launches a
browser and replays to completion, then responds `200` with the `ReplayResult` — whatever its
status (`business_outcome`, `needs_human` and `failure` are normal outcomes, not HTTP errors).
`404` for an unknown id, `400` for invalid params. Artifacts are re-read from disk on every call.
No idempotency, no job id, no timeout.

The async mode in the brief is additive: keep this synchronous path as-is (existing tests and the
agent demo use it) and add `?mode=async` (or a `Prefer: respond-async` header) that enqueues.

### 7. Is Docker available on the builder's machine?

**Yes (confirmed 2026-11-09).** Windows AMD64, Docker Desktop running: `docker version` → client
and server 29.9.3 (linux/amd64, API 1.56); `docker compose version` → v5.7.0. The Docker VM has
**8 CPUs and ~4.0 GB RAM** (`docker info`), which is tight for 8 Chromium workers plus Postgres,
Jaeger, Prometheus and Grafana — see the open question in the Day-1 handoff. Installed
`playwright` is **1.62.1**, which is what the worker image tag must match.

## Where the repo disagrees with the brief

1. **No transfers, no ledger, no history, no memo** (Q4/Q5). The brief's whole correctness story
   is "transfers, checked against the bank's ledger". The mock bank has to grow a transfer flow
   first.
2. **`CLAUDE.md` forbids this project.** Its non-negotiables say: "Do NOT build scaling infra
   (queues, clusters, multi-tenant plumbing). Single process." That was right for the original
   scope; the fleet deliberately reverses it. It must be updated in the first commit, or every
   future Claude Code session in this repo will push back against the fleet code.
3. **Per-run confidence is not in `ReplayResult`.** It is only written to the run's evidence log
   and read back by `readRunConfidence()` (the CLI's `--show-confidence`). The circuit breaker can
   reuse that function — no schema change needed.
4. **`runReplay` has no hook around the risky step.** The brief's commit-intent write must happen
   "right before the irreversible click" and only if the lease is still held. Today the only
   control is the boolean `approveRisky`.
5. **Test count matches** (83). Tests need Playwright's Chromium (`npx playwright install
   chromium`, as in the README). One test is flaky under load — see "Known flake".
6. **There are three tenants, not two, and the transfer flow must work on all of them.**
   `mock-app/tenants.ts` defines tenant-a (root `/`), tenant-b (`/tenant-b`, relabelled "Find
   Member" / "Savings Balance") and tenant-c (`/tenant-c`, **hostile markup**: `<a href>` instead
   of `<button>`, no `<label for>`, no `<table>`; same visible text as tenant-a). Every form field
   and button goes through `field()` / `actionControl()` in `mock-app/views.ts`, so new transfer
   views must use those helpers or tenant-c breaks. Sessions are per-tenant cookies. The first
   draft of these notes did not mention this.
7. **Docs elsewhere say the opposite of the fleet.** After the CLAUDE.md change, these comments
   are stale: `REPORT.md` (~line 39 "a single process is the simpler… choice", ~line 336
   "scaling infra CLAUDE.md says not to build") and the comment above `writeCapabilityStatus`
   in `src/confidence/store.ts:43-47`. Not edited in this step; fix when the fleet README lands.
   *(The `store.ts` comment was fixed in Step 5 Part A; `REPORT.md` still waits for the fleet README.)*
8. **Mock-bank state is per-process and in memory** (`mock-app/data.ts`, `app.ts` module-level
   flags like `transientEnabled`). Under Compose the bank is one container; a restart wipes
   sessions *and* the ledger, so chaos scripts must never restart it mid-run.

## Plan adjustments (Day 1)

1. **First commit: update `CLAUDE.md`** — replace the "do not build scaling infra" rule with the
   fleet's scope and its single-machine limit. Logged in `docs/DECISIONS.md`.
2. **Mock bank: add a transfer flow** that mirrors the existing sub-account flow's shape, so
   locators and recognizers work the same way:
   - `GET/POST /member/:id/transfer` — from account, to member/account, amount, **memo** (free text)
   - `GET/POST /member/:id/transfer/confirm` — summary + a **"Submit"** button (matches the
     existing risky pattern, so `policyGate` classifies it with no change)
   - On submit, append to an in-memory **ledger** `{id, memberId, toAccount, amount, memo, at}`
   - `GET /member/:id/history` — server-rendered table of that member's transfers, memo column
     included (read-only; this is what recovery reads)
   - `GET /control/ledger` — JSON dump for the test oracle only; workers never call it
   - Fault knobs for the "bank slow or down" scenario: `/control/latency/:ms`, `/control/errors/on|off`
3. **Two new capability artifacts:** `transfer` (the irreversible job) and `transfer-history-lookup`
   (read-only, finds a memo — used by `commit.verify`). Discovery needs an API key and stops at
   confirmation screens by design, so the default is to **hand-author them in the same shape as
   `open-sub-account-confirmed.json`** (which is itself a hand-made fixture), validate them through
   `deserializeCapability`, approve them with a recorded reason, and add replay tests. Open
   question for the builder: re-run discovery for the read-only lookup later, as evidence?
4. **Replay gains three optional, additive options** (extend, don't fork; every existing call
   site keeps working unchanged). *Built in Step 4 (docs/plans/step-04.md, D10–D13); `after()`
   now runs once the bank has answered (D12), and `invokeCapability` passes all three through.*
   - `browser?: Browser` — reuse a worker's browser; `WebSurface` opens a fresh context per run and
     closes only that context
   - `onIrreversible?: { before(step): Promise<void>; after(step): Promise<void> }` — `before`
     writes the commit intent and throws if the fencing check fails (the click never happens);
     `after` is where the crash-after-submit fault flag fires
   - `signal?: AbortSignal` — aborted when the heartbeat loses the lease; replay closes the
     context immediately
5. **Chaos runs through Docker.** Windows has no `SIGSTOP`, and `SIGKILL` is just
   `TerminateProcess`; running workers as Compose services gives real `KILL` and real pause
   (`docker pause`) on any host OS. The CI integration tests (crash-before/after submit) use
   in-process fault flags, so they are OS-independent.

## Answers from the builder (2026-10-29)

- **Windows machine; Docker Desktop is installed and running** (WSL2 backend; verified 2026-11-09). So the brief's original design stands, with no workarounds:
  - `docker compose up` runs Postgres, the mock bank, the API, N workers, Jaeger, Prometheus and
    Grafana. Worker images build from the official Playwright image pinned to the repo's
    `playwright` version, so the browser inside matches the package.
  - Random kills use `docker kill --signal=KILL <worker>`; the zombie scenario uses
    `docker pause` / `docker unpause` (cgroup freezer — the real SIGSTOP/SIGCONT effect). The
    chaos script drives these through the Docker CLI, so it runs the same from PowerShell.
  - Unit and integration tests still run on the Windows host with `npm test`, against Postgres
    in a container. The crash-before/after-submit tests use in-process fault flags, so CI needs
    no Docker-in-Docker tricks beyond a Postgres service.
- **Transfer artifacts: hand-authored** (no API key, no cost), validated through
  `deserializeCapability` and tested like the existing fixtures.
- **Workflow:** the builder runs Claude Code in VS Code with GitHub access. Each step is handed
  to Claude Code as a prompt; Claude Code plans, the plan is reviewed, then it builds and ends
  with a handoff report that is reviewed before the next step.
