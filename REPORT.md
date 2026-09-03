# REPORT

## 1. Architecture

Modules: `surface/` (perceive/act/locate abstraction + the Playwright implementation),
`agent/` (LLM discovery loop), `artifact/` (the Capability schema — the project's focal point),
`replay/` (deterministic, LLM-free execution), `safety/` (the one policy gate + redaction),
`escalation/` (control-transfer state machine + operator console), `evidence/` (append-only
JSONL + screenshot capture), `catalog/` (agent-facing capability discovery/invocation — see
below), `cli/`, `mock-app/`.

**Agent-facing surface.** `catalog/` is the literal payoff of treating a Capability as a callable
tool, not just a recorded flow: `listCapabilities()` scans `artifacts/` and returns each
capability's id/name/description plus a JSON-Schema-shaped `inputSchema`/`outputSchema`, and
`invokeCapability(id, params, tenant?)` validates `params` against that same schema, resolves an
optional tenant override, and calls the existing `runReplay` — the same `ReplayResult` contract
every other caller gets. Neither piece is a second, hand-authored schema: both are derived at call
time from each artifact's own declared `inputs`/`outputs` (via `z.toJSONSchema`, native to the
already-installed Zod v4), so the schema an agent is shown and the schema invoke actually enforces
can never drift apart — see [src/catalog/schema.ts](src/catalog/schema.ts). This is exposed three
ways over the identical underlying functions: `catalog list`/`catalog invoke`/`catalog serve`
(CLI, [src/cli/index.ts](src/cli/index.ts)), `GET /capabilities` / `POST /capabilities/:id/invoke`
(Express, [src/catalog/http.ts](src/catalog/http.ts)), and
[examples/agent-demo.ts](examples/agent-demo.ts) — a runnable, self-contained script that does the
real HTTP round trip an LLM tool-caller would: list, pick a capability by name, POST typed args,
get back a live `ReplayResult`.

The seam that makes this decomposition work is `Surface`
(`perceive(): Observation`, `act(action)`, `locate(descriptor): Handle | null`,
[src/surface/types.ts](src/surface/types.ts)). Everything above it — the Capability schema,
discovery, replay, the recognizer taxonomy — talks only to this interface, never to Playwright
directly. `WebSurface` is the only implementation today, but nothing in `ElementDescriptor` or
`Checkpoint` mentions a browser; a `DesktopSurface` driving an OS accessibility tree is a driver
swap, not a schema change (elaborated in §4). This is the direct payoff of treating "how we
perceive/act on a surface" and "the recorded flow" as two separate concerns from the start.

Everything runs as one Node process — no queues, no worker pool, no multi-tenant plumbing. For a
system whose whole job is to hold one live, stateful browser session open (including across a
human handoff), a single process is the simpler and more correct choice, not merely the cheaper
one: splitting perception/action across processes would mean shipping page state or reconnecting
a live Playwright session across a process boundary for no benefit at this scale.

**Why the mock credit-union app, and not something else.** Two alternatives considered: a public
website, and a real desktop application. A public site can't be given controllable failure
injection — you can't make it show a session timeout or a transient error on demand — so
demonstrating the error taxonomy in §3 would mean waiting for real flakiness, plus scraping a
site not built for this raises consent and stability concerns. A real desktop app would need an
OS accessibility-tree driver (`DesktopSurface`) that doesn't exist yet — building it would have
consumed this stage's time on driver plumbing instead of proving the artifact/replay/escalation
design. The mock app ([mock-app/README.md](mock-app/README.md)) is a deliberate middle point: it
exposes three real, HTTP-toggleable failure modes (`/control/transient/on`, a ~30% interstitial
per authenticated request; `/control/session-timeout`; `/control/unexpected-dialog/on`) so every
branch of the recognizer taxonomy is reproducible on demand rather than simulated in prose. It
also encodes two flow shapes genuinely common in this domain — search → detail → action (member
lookup) and form → confirmation (open a sub-account) — deliberately, not incidentally.

## 2. Artifact schema

A `Capability` ([src/artifact/schema.ts](src/artifact/schema.ts)) is the sole output of discovery
and the sole input to replay: `schemaVersion`, `id`/`name`/`description`, `version`, a `target`
(app id, entry URL pattern, surface type), typed `inputs`/`outputs`, an ordered `steps` array, a
`successCondition`, `knownOutcomes`, `recoverables`, and `provenance`.

A `Step` is `{id, intent, action, target?, value?, checkpoint?, risk}`. Two shape choices are
load-bearing:

- **Action carries no data.** `Action` is only `{kind}` plus kind-intrinsic config (`navigate`'s
  `url`, `waitFor`'s `timeoutMs`) — never a literal value or a target. Those live on `Step`
  instead, as `target: ElementDescriptor` and `value: ValueRef`. This keeps raw data out of the
  action shape entirely, which is what makes redaction enforceable *in the schema*: `ValueRef` is
  `{kind:"literal", value, redact}` or `{kind:"paramRef", paramName, redact}`, and a Zod
  `superRefine` **rejects outright** any `literal` with `redact: true` — a secret can never be
  baked into an artifact as plaintext; if a value needs redacting it must be a `paramRef`,
  supplied fresh at replay time, never stored.
- **`target` is a ranked `ElementDescriptor`, never a single selector.** `strategies: []` is an
  ordered list — `roleName` → `labelText` → `textAnchor` → `tableCell` → `css` → `visual` —
  authored by discovery (or a human reviewer) in resilience order, tried in that array order at
  replay time (§3).

`Checkpoint` (`urlMatches | textPresent | textAbsent | elementPresent`) is one declarative
predicate vocabulary, reused in **four** places: a step's own `checkpoint`, the capability's
overall `successCondition`, a `BusinessOutcome.recognizer`, and a `RecoverableRule.recognizer`. A
reviewer learns one small vocabulary and can read every recognizer in the artifact.

`schemaVersion` (the Zod definition's own format revision, currently `1`) is kept separate from
`version` (a capability's own semver, bumped when its recorded flow changes) — conflating them
would make it impossible to evolve the schema without touching every capability's version
history. `provenance.transcriptRef` is a reference string (an evidence URI), never the inline
transcript — a `Step.intent` is sanitized reasoning (the *why*), not raw model output, so nothing
about how discovery reached a step needs to travel with the compiled artifact.

Referential integrity beyond shape is enforced by a `superRefine` on `CapabilitySchema`: step ids
must be unique, every `paramRef` must resolve to a declared input, every output's
`producedByStepId` must resolve to a declared step. A structurally valid but referentially broken
artifact fails to parse.

**Why a callable contract, not a step list.** A step list is instructions for one run. A
Capability is invocable — different `params` per call, typed `outputs` a caller can consume
programmatically, a `successCondition` a caller can check without reading logs. That's what lets
`runReplay(capability, params)` be a function with a real return type
(`ReplayResult`, [src/artifact/replayResult.ts](src/artifact/replayResult.ts)) instead of a
script.

## 3. Determinism & error handling

Replay never touches the LLM: `src/replay/replay.ts`'s import list has no Anthropic SDK
dependency, and nothing in the replay path calls out to a model. `runReplay` is a plain function
over a `Capability` and `params`.

Locators are resolved by trying `descriptor.strategies` in the array's own order
([src/surface/locate.ts](src/surface/locate.ts)), accepting the first strategy that resolves to
**exactly one** element (`count() === 1` — an ambiguous match is treated as no match). If nothing
resolves, the descriptor falls back to a `"visual"` handle with no live locator (a documented
stub, §7). After each action, replay compares the strategy that actually won against the
descriptor's own top-ranked strategy; a mismatch is logged as a `"drift"` evidence entry with
`expectedStrategy`/`actualStrategy` — the concrete signal that the page's structure has moved out
from under the top-choice locator, even though a lower-ranked one still worked.

This chain is proven load-bearing, not decorative, against a genuinely hostile surface: `tenant-c`
(§4) strips every semantic affordance the top strategies depend on — real `<a href>` links
instead of `<button>` (no "button" role), no `<label for>` association, no `<table>` at all for
the balance — while keeping every visible string identical to tenant-a, so the failure is
provably structural, not lexical. The same `member-lookup.json` still replays to `success` with
`savingsBalance: "$4532.10"` against it, purely by falling through to `textAnchor` (for every
button/field) and `css` (for the balance, which isn't clickable and so can never resolve via
`textAnchor`) — six `drift` entries, one per step, are the receipt (`evidence/replay-hostile-tenant/`).
Replaying the *unmodified* base artifact (no override, so only its own recorded roleName/labelText
strategies) against the same hostile surface fails outright at the very first step — the fallback
chain, not the top strategy, is what makes the hostile case work at all.

**Confidence & approval gating, built on that same signal.** Every resolved strategy used to be
accepted equally regardless of how far down its own ranked list it was — tenant-c's six `drift`
entries carried no extra scrutiny even though `textAnchor`/`css` are the least-confident strategies
in their chains. `src/confidence/score.ts` closes that gap by scoring the exact same comparison:
`stepConfidence` is 1.0 when the winning strategy is index 0, degrading linearly to 0.0 at the last
index (or 0.0 outright if nothing authored resolved at all — the guaranteed `"visual"` fallback).
Averaged per run, the numbers land exactly where the drift story predicts: tenant-a (zero drift)
computes **1.0**; the tenant-c hostile run above computes **0.0** — every one of its six steps
resolves at the last index of its strategies list. This is stored in the evidence run's own
`result` entry (`src/replay/replay.ts`'s `finish()`), never in the artifact — confidence is a
property of one run against one surface, not of the capability.

That score feeds a run-level approval gate, `src/confidence/approval.ts`, structurally mirroring
`policyGate`'s `{allowed, reason}` decision from §6: checked once, before any browser launches, it
refuses **unattended** replay of a capability still in `draft` status with a `needs_human` result,
the same shape an unapproved risky action already produces. A capability earns `approved` status
(a small JSON sidecar per capability under `status/`, never the artifact) automatically once its
confidence history has `N` consecutive runs at or above a threshold — a run below threshold breaks
the streak rather than counting toward it, so a single hostile-surface run can't accidentally
promote a capability it should instead be raising scrutiny on — or a human can force it with
`catalog approve <id> --reason "..."`. The three artifacts recorded before this gate existed
(`member-lookup`, `open-sub-account`, `open-sub-account-confirmed`) are grandfathered `approved`
this same way, keyed purely by capability id, which is why every existing test, the catalog demo,
and the README's replay commands keep working unattended with no changes at all.

`waitFor` polls, it doesn't sleep: `waitForDescriptor`
([src/surface/webSurface.ts](src/surface/webSurface.ts)) re-resolves the target descriptor every
150ms against a deadline, and the schema requires `waitFor` to carry a real `target` — there is
no bare "wait N ms and hope" action.

After every action, an observation is classified by the recognizer taxonomy
([src/replay/recognize.ts](src/replay/recognize.ts), [checkpoint.ts](src/replay/checkpoint.ts)):
a `BusinessOutcome` or `RecoverableRule`'s "recognizer" *is* a `Checkpoint` — the same evaluator
used for step checkpoints and `successCondition` runs against `knownOutcomes` and `recoverables`
too. This is where **`business_outcome` is deliberately separated from `failure`**: "no such
member" is data the caller branches on
(`ReplayResultSchema`: `{status:"business_outcome", code, detail}`), not a crash. Verified live
(see `evidence/replay-success/` and `evidence/replay-business-outcome/`): replaying member
lookup for `10001` returns `success` with `savingsBalance: "$4532.10"`; for `99999` it returns
`business_outcome`, `code: "NO_SUCH_MEMBER"` — same code path, same artifact, a normal recognized
branch rather than an exception.

`needs_human` triggers (a risky action blocked, a recoverable rule exhausted, a step checkpoint
failing, or an action erroring with no checkpoint declared) all funnel through one helper,
`pauseOrFail`. With no `EscalationController` supplied, it's a plain terminal exit — replay's
original, still-tested behavior. With one, it pauses and, on resume, decides where to continue by
re-evaluating: `successCondition` now passing means the human finished the job by hand
(**complete**); the step's own `checkpoint` now passing means just this step is done
(**skip** — its action, e.g. a click on a button the human already clicked, is never re-run);
neither passing means **retry** the step fresh (safe even if the human did nothing — it just
re-pauses). Elaborated with real evidence in §5.

## 4. Heterogeneity & multi-tenant

*Desktop heterogeneity below is design, not built code, flagged explicitly per the project's own
scoping. Multi-tenant is no longer a sketch — it's working code, described as built.*

The same seam from §1 is the mechanism: `Surface` is `perceive/act/locate` and nothing else;
`ElementDescriptor`/`Checkpoint`/`Capability` never mention Playwright, HTML, or the web. A
`DesktopSurface` implementing that interface over an OS accessibility tree (Windows UI Automation
or macOS Accessibility) would let the *same* artifact schema, the *same* recognizer taxonomy, and
the *same* replay loop drive a legacy Win32/WPF back-office client — only the driver underneath
`Surface` changes. `ElementDescriptor`'s `roleName`/`labelText` strategies map naturally onto
accessibility-tree role/name queries; `tableCell`/`textAnchor`/`css` would need
desktop-appropriate equivalents (e.g. a grid-cell-by-header strategy), but the *vocabulary* — an
ordered list of ways to find the same control — doesn't change. No `DesktopSurface` exists yet;
this stays a design claim.

**Multi-tenant, built**: `mock-app/` now serves two tenants of the same vendor product from one
Express app ([mock-app/tenants.ts](mock-app/tenants.ts)) — `tenant-a` (root-mounted, identical to
this app's original single-tenant behavior) and `tenant-b` (`/tenant-b`, different institution
branding, its Member Lookup button reads "Find Member" instead of "Search," and its balance row
reads "Savings Balance" instead of "Current Savings Balance"). `src/tenant/` is the override
layer: a `TenantOverride` ([src/tenant/types.ts](src/tenant/types.ts)) is data — `tenantId`,
`capabilityId`, an `entryUrl`, a `stepOverrides` map keyed by step id, and an optional
`successCondition` replacement — applied by `applyTenantOverride()` to produce an *effective*
Capability. The base artifact (`artifacts/member-lookup.json`) is never touched: steps not named
in `stepOverrides` keep the exact same descriptor object the base capability declared;
[overrides/member-lookup.tenant-b.json](overrides/member-lookup.tenant-b.json) patches only the
two steps that actually differ. `replay --tenant <id>` (and `operator --tenant <id>`) loads
`overrides/<capabilityId>.<tenant>.json` by convention and applies it before replaying — no new
`runReplay` option needed; the tenant layer sits entirely above it. Verified live: the SAME
compiled `member-lookup.json` replays to `success` with the identical `savingsBalance` against
both tenants (`src/tenant/multiTenant.test.ts`), and replaying that same base artifact against
tenant B *without* the override fails outright — proof the override is load-bearing, not
decorative.

Canonicalization is built too, additively: `canonicalizePath()`
([src/tenant/canonicalize.ts](src/tenant/canonicalize.ts)) maps `/member/12345` → `/member/:id`;
`matchesCanonically()` is wired into `evaluateCheckpoint`'s `urlMatches` case
([src/replay/checkpoint.ts](src/replay/checkpoint.ts)) as a fallback tried *only* when the direct
regex match fails, so it can never change behavior for a pattern that already matched — every
pre-existing artifact and test is unaffected. This is what lets a `urlMatches` checkpoint
authored against one tenant's concrete route recognize another tenant's differently-prefixed,
different-record-id URL of the same shape.

Drift across tenants is detected by the exact mechanism §3 already has, not a second system: the
override's replacement descriptors are still *ranked* (e.g. tenant-b's Search-button override
keeps `roleName: "Search"` as strategy 1, which legitimately fails there, falling back to a
`css` strategy that succeeds), so the same expected-vs-actual-strategy comparison fires and logs
a `drift` evidence entry — verified live for both overridden controls. A detected drift would
route through versioning and human approval before being applied to the shipped override, never
trigger a silent re-recording of the capability.

**A third tenant, `tenant-c`, is a hostile-DOM variant** — same flow, same seed data, every
visible string identical to tenant-a, but every top-ranked strategy structurally defeated (no
ARIA roles, no label association, no table for the balance — full writeup in
[mock-app/README.md](mock-app/README.md)). Its override
([overrides/member-lookup.tenant-c.json](overrides/member-lookup.tenant-c.json)) keeps the base
artifact's own recorded strategies as a literal prefix and appends exactly the fallback each
control needs — `textAnchor` for every button/field, `css` for the non-clickable balance value.
This is the concrete answer to "is the ranked fallback load-bearing, or decorative": §3 has the
result. Note the distinction from the *desktop* heterogeneity claim above — this proves the
ranked `ElementDescriptor` chain survives hostile HTML at the locator level; it says nothing new
about `Surface` portability, which is what would need a real `DesktopSurface` to prove.

## 5. Escalation & handoff

`EscalationController` ([src/escalation/controller.ts](src/escalation/controller.ts)) is an
explicit control-transfer state machine: a single `automation | human` owner token, checked
before replay can proceed past a pause point. `raise()` (called from `pauseOrFail`, §3) captures
a screenshot, the current URL, the step id, and a reason, flips ownership to `human`, and persists
an `escalation_raised` evidence entry. `waitForAutomation()` blocks replay (a promise-resolver
queue, not polling) until `handBack(note?)` flips ownership back — which also captures an
after-screenshot, persists an `escalation_resumed` entry with before/after URLs, before/after
screenshot filenames, the human's optional note, and both timestamps, then wakes replay.

The human operates the exact same live session: `WebSurface` launches headed by default
specifically for this ("human handoff needs a real window to take over in" —
[src/surface/webSurface.ts](src/surface/webSurface.ts)), and the controller is bound to that one
`WebSurface`/`EvidenceRecorder` pair once, right after replay creates them — nothing is torn down
or relaunched for the handoff, and every evidence entry (before, during, and after the pause)
lands in the same run folder. The operator console (`src/escalation/console.ts`) is a minimal
server-rendered Express page — "Take control" and "Hand back" are real `POST` calls that mutate
the controller directly, not a simulated UI.

On resume, replay never blindly re-runs the action it paused on (§3's complete/skip/retry
decision) — it re-perceives the page first and checks whether the human already finished the job.
`evidence/escalation-handoff/` is a real, verified run of exactly this: `blocked` (risky Confirm
refused) → `escalation_raised` → `escalation_resumed` roughly **4 minutes** later, with the
human's own note ("manually confirmed sub-account creation") and distinct before/after
screenshots → `result: {status:"success"}` — resumed in place, not restarted.

## 6. Safety

One function, `policyGate(action, context)`
([src/safety/policy.ts](src/safety/policy.ts)), is called by both discovery and replay before
every action — there is no second, parallel safety check anywhere in the codebase. It does two
things: checks the action's URL against an allowlist of origin patterns and permitted action
kinds (`navigate` is checked against its destination; everything else against the current page
URL), and classifies risk. Only `click` is risk-eligible — `navigate`/`type`/`selectOption`/
`waitFor`/`readText` are structurally always reversible in this system, since there's no separate
action kind for an irreversible submit; it's always expressed as a click on a button with a
matching accessible name (`DEFAULT_RISKY_CLICK_NAMES`: confirm/submit/delete/remove — explicitly
commented as "illustrative for the demo app, not exhaustive"). `risk: "risky"` doesn't mean
denied — discovery always stops rather than committing it; replay executes it only if the caller
passes `approveRisky: true`, otherwise it's a `needs_human` pause (§3, §5).

Redaction ([src/safety/redact.ts](src/safety/redact.ts)) is selective by design: an explicit
`redact: true` (on a `TypedParam` or a `ValueRef`) always wins; unflagged values are also checked
against a small pattern set (SSN-like, card-like, long opaque tokens) as a defensive fallback,
not the primary mechanism. Business data — a member id, an account type — passes through
untouched in both evidence and the compiled artifact; only fields actually marked sensitive (or
pattern-matched as secret-shaped) are ever masked.

**Honest limits**, stated directly in `policy.ts`'s own header comment rather than glossed over:
this gate does not sandbox the browser process or the target page — a compromised or adversarial
page could still attempt prompt injection against the LLM driving discovery, or exploit the
browser itself. It does not validate the *content* of what's being submitted — a "safe" action
can still submit wrong data. It does not authenticate or authorize *who* is allowed to invoke
replay or pass `approveRisky` — that's a deployment-level concern, not implemented here. And both
the risky-click name patterns and the redaction patterns are heuristics, not guarantees: an
irreversible action given an unexpected label, or a secret in a format the patterns don't
recognize, can still slip through.

## 7. Cuts

Stated plainly, not glossed over:

- **The operator console is intentionally minimal** — server-rendered HTML, inline CSS, no
  client-side JS, a `<meta refresh>` for polling instead of push updates. It proves the handoff
  mechanism is real (§5); it is not a production operator UI.
- **`DesktopSurface` is design-only** (§4) — no second `Surface` implementation exists. (The
  per-tenant override layer, canonicalization, and the hostile-DOM tenant, by contrast, ARE
  built — §3, §4, `src/tenant/`, `mock-app/tenants.ts`.) The override layer also has a real gap
  of its own: `TenantOverride` only patches step targets and `successCondition`;
  `knownOutcomes`/`recoverables` recognizers can't be overridden yet, so a tenant whose
  business-outcome or recoverable-interstitial text differs from the base artifact's would need
  a genuinely new artifact, not just an override.
- **The `"visual"` locator strategy never produces a live handle.** It's `locate()`'s guaranteed
  fallback (carries `describedAs` forward, `locator: null`), and any action that needs a real
  element throws an explicit "no coordinate clicking implemented yet" error if that's all that
  resolved. Documented stub, not silently broken.
- **`waitFor` requires a target by design** — there is no "just wait N ms" action, which is a
  deliberate constraint (wait for *something specific*), not an oversight, but it does mean a
  capability can't express an unconditional pause.
- The `"dismiss"` recoverable action has no target field to click in the schema — it degrades to
  a bounded wait-and-recheck of the same page rather than a real dismiss interaction; not
  exercised by any required test.

What I'd build next, in order: extending `TenantOverride` to cover `knownOutcomes`/`recoverables`
recognizers, not just step targets and `successCondition` (the real gap noted above); a real file
lock (or single-writer queue) under `src/confidence/store.ts`'s sidecar writes — today a concurrent
replay of the same capability across processes can't corrupt the file (writes are atomic via
temp-file + rename) but two writers racing on a read-modify-write can still drop one history entry,
a documented limit rather than the scaling infra CLAUDE.md says not to build here; and an actual
`DesktopSurface`, now that the locator vocabulary itself has been proven to survive hostile HTML
(§3) — the remaining open question is the driver, not the descriptor design.
