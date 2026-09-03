# rote

Computer-use automation for legacy bank/credit-union back-office web apps that have no API. An
LLM discovers a UI task once and compiles it into a typed, versioned **Capability** artifact;
that artifact then **replays deterministically, with no LLM in the loop**, and escalates to a
human on the same live browser session if it gets stuck. Record once, replay many. Saved
capabilities are also exposed as a discoverable, typed, callable surface — CLI or a real HTTP
API — that an AI agent can list and invoke by name, gated by a confidence/approval check that
refuses to run an unproven capability unattended.

## Setup

Prerequisites: Node 20+.

```
npm install
npx playwright install chromium
copy .env.example .env
```

Open `.env` and set `ANTHROPIC_API_KEY` — this is needed **only** for the `discover` command
(see below). Then, in a separate terminal, start the mock target app:

```
npm run mock
```

This listens on `http://localhost:4100` (fake seed data — see [mock-app/README.md](mock-app/README.md)).

## Replay needs no API key

This is a deliberate design point, not an omission: `src/replay/replay.ts` never imports the
Anthropic SDK, and `ANTHROPIC_API_KEY` is only ever read inside the `discover` command. Once a
Capability artifact exists (a few are already committed under [artifacts/](artifacts/)), **every
`replay` and `operator` run below works with zero LLM dependency** — the production path has no
API cost, no model latency, and no LLM in the decision loop at all.

## Demo path

Run these in order, with `npm run mock` already running in another terminal. `--params` takes a
JSON object; in PowerShell, escape the inner double quotes with `\"` inside a single-quoted
string exactly as below (plain `'{"a":"b"}'` gets mangled by cmd.exe on the way to `npx` — the
Bash equivalent doesn't need the backslashes).

**1. Discover the member-lookup capability** (needs `ANTHROPIC_API_KEY`; opens a real Chromium
window and drives it live):

```
npx tsx src/cli/index.ts discover
```

This uses the default goal ("look up member 10001 and read their current savings balance")
against `http://localhost:4100` and writes a new `artifacts/member-lookup.json` plus an evidence
run under `evidence/`.

**2. Replay it — success:**

```
npx tsx src/cli/index.ts replay --artifact artifacts/member-lookup.json --params '{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"10001\"}'
```

Logs `replay: success` with `outputs.savingsBalance`. No API key needed.

**3. Replay it — unknown member (business outcome, not a crash):**

```
npx tsx src/cli/index.ts replay --artifact artifacts/member-lookup.json --params '{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"99999\"}'
```

Logs `replay: did not succeed` with `status: "business_outcome"`, `code: "NO_SUCH_MEMBER"` — a
recognized, caller-branchable outcome the artifact was compiled to detect, distinct from a
`failure`. (The CLI still exits non-zero for any non-`success` status, including this one — check
`status`/`code` in the JSON log, not just the exit code.)

**4. Human-in-the-loop escalation demo:**

```
npx tsx src/cli/index.ts operator --artifact artifacts/open-sub-account-confirmed.json --params '{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"10001\",\"initialDeposit\":\"50.00\"}'
```

This artifact's last step is a real, irreversible "Confirm" click, which replay refuses to run
unattended. A headed Chromium window opens and runs up to that step, then pauses. Open
`http://localhost:4200` in a browser:

1. Click **Take control** — the console shows the pending step, the reason, and a screenshot.
2. Switch to the automation's own Chromium window and click **Confirm** yourself — same live
   browser session, not a new one.
3. Back in the console, optionally add a note, then click **Hand back**.
4. Watch the terminal: replay re-perceives the page, sees the capability's success condition now
   holds, and logs `operator: success` — resumed in place, not restarted.

## Agent-facing capability catalog

Every saved artifact under `artifacts/` is also exposed as a discoverable, typed, callable
surface an AI agent could use — not just something a human replays by file path. `catalog list`
returns each capability's id/name/description plus a JSON-Schema-shaped view of its typed
inputs/outputs, generated straight from the artifact so it can never drift out of sync; `catalog
invoke` validates params against that same schema and replays it through the exact same
`runReplay` path as `replay`/`operator` above.

```
npx tsx src/cli/index.ts catalog list
npx tsx src/cli/index.ts catalog invoke member-lookup --params '{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"10001\"}'
```

The same two operations are also a real HTTP API, not just a CLI trick:

```
npx tsx src/cli/index.ts catalog serve
```

```
curl http://localhost:4300/capabilities
curl -X POST http://localhost:4300/capabilities/member-lookup/invoke -H "content-type: application/json" -d "{\"params\":{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"10001\"},\"entryUrl\":\"http://localhost:4100\"}"
```

Fastest way to see it end to end — a small script that lists capabilities over HTTP, picks one by
name, and invokes it with typed args, the way a tool-calling LLM would:

```
npm run demo:agent
```

A saved run of exactly this is committed at
[evidence/catalog-agent-invoke/](evidence/catalog-agent-invoke/).

## Confidence & approval gating

A freshly discovered capability starts in `draft` and is refused for **unattended** replay —
`needs_human`, before any browser even launches — until it's proven reliable through repeated
high-confidence runs; every promotion decision is logged to a per-capability history file and is
auditable, never silent. (The 3 artifacts committed under `artifacts/` predate this gate and are
grandfathered `approved`, which is why every command above works with no extra flag.)

```
npx tsx src/cli/index.ts replay --artifact artifacts/member-lookup.json --params '{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"10001\"}' --approve-unattended
npx tsx src/cli/index.ts replay --artifact artifacts/member-lookup.json --params '{\"username\":\"operator\",\"password\":\"operator\",\"memberId\":\"10001\"}' --show-confidence
```

`--approve-unattended` opts a single run of a still-`draft` capability in (this is how a new
capability's history accumulates in the first place); `--show-confidence` prints the run's
confidence score, computed from how far down its own ranked locator strategies each step
resolved. Both flags exist on `catalog invoke` too. Once enough consecutive high-confidence runs
have landed, a capability auto-promotes to `approved` — or a human can promote it directly:

```
npx tsx src/cli/index.ts catalog approve member-lookup --reason "manually verified, safe to run unattended"
```

A saved run of the full sequence — refused while `draft`, promoted after qualifying runs, then
replaying unattended with no flag at all — is committed at
[evidence/confidence-approval-gate/](evidence/confidence-approval-gate/).

## Saved demonstration runs

Real, unedited evidence from runs of all four scenarios above — logs, screenshots, and an index
of what to look for in each — is committed under [evidence/](evidence/README.md).
