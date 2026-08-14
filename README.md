# rote

Computer-use automation for legacy bank/credit-union back-office web apps that have no API. An
LLM discovers a UI task once and compiles it into a typed, versioned **Capability** artifact;
that artifact then **replays deterministically, with no LLM in the loop**, and escalates to a
human on the same live browser session if it gets stuck. Record once, replay many.

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

## Saved demonstration runs

Real, unedited evidence from runs of all four scenarios above — logs, screenshots, and an index
of what to look for in each — is committed under [evidence/](evidence/README.md).
