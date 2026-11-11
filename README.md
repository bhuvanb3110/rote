# rote

[![ci](https://github.com/bhuvanb3110/rote/actions/workflows/ci.yml/badge.svg?branch=fleet/day-1)](https://github.com/bhuvanb3110/rote/actions/workflows/ci.yml?query=branch%3Afleet%2Fday-1)

Computer-use automation for legacy bank/credit-union back-office web apps that have no API. An
LLM discovers a UI task once and compiles it into a typed, versioned **Capability** artifact;
that artifact then **replays deterministically, with no LLM in the loop**, and escalates to a
human on the same live browser session if it gets stuck. Record once, replay many. Saved
capabilities are also exposed as a discoverable, typed, callable surface — CLI or a real HTTP
API — that an AI agent can list and invoke by name, gated by a confidence/approval check that
refuses to run an unproven capability unattended.

## Setup

Prerequisites: Node 22+ (CI uses 22 LTS; `engines` says `>=22`).

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

### Running the tests

From fleet Step 5 on, the full suite includes the Postgres job-queue tests, so start Postgres first
(Docker Desktop or any Docker engine with Compose):

```
docker compose up -d postgres     # postgres:17 on 127.0.0.1:55432, data in the pgdata volume
npm test                          # full suite; fails loudly (never skips) without Postgres
npm run test:unit                 # everything except the *.db.test.ts files, no Docker needed
npm run db:migrate                # apply db/migrations to the dev database (ROTE_DATABASE_URL)
```

The tests use a separate `rote_test` database (created on demand) with one schema per test file;
they never touch the dev `rote` database. `docker compose down -v` deletes the data volume.

`npm run typecheck` checks every file, tests and `scripts/` included (the build config excludes tests).
The 11 test files that launch Chromium run in their own vitest project, at most 3 at a time
(`vitest.browser-files.ts`, D31; a guard test keeps the list complete); everything else runs fully
parallel. Never run the suite while the 4-worker fleet is up on an 8 GB machine.

### CI

GitHub Actions (`.github/workflows/ci.yml`, D35) on every push and pull request to `main` and
`fleet/**`: **test** (Node 22, a `postgres:17` service, Playwright Chromium from the lockfile,
`npm run typecheck`, the full `npm test`, the full log uploaded as the `npm-test-log` artifact on every
run), **unit-node25** (the pure unit tests on Node 25) and **docker** (builds the fleet image, never
pushed, with the Actions cache). Not in CI: the Day-1 exit, chaos and the crash-point matrix; they need
the Compose stack or minutes of wall time and run as scripts with committed evidence (next section).

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

**Result contract.** Every replay returns one of four statuses: `success`, `business_outcome`,
`needs_human`, `failure`. A non-`success` result may also carry **`commitUncertain`**
(`{irreversibleStepId, detail}`), which means the run already *attempted* its irreversible step
(e.g. the transfer's Submit). The commit may have happened, so check the bank's history before any
retry. If a non-success result has no `commitUncertain`, nothing irreversible was attempted and a
retry is safe. The CLI also logs a separate warning line, `commit may have happened at <step> --
verify before retrying`. The catalog HTTP API returns the field unchanged in its 200 body. Once the
irreversible step has been attempted, replay never reloads, never retries that step, and turns
unexpected errors into `failure`/`unknown` with the marker. See
[docs/DECISIONS.md](docs/DECISIONS.md) D10.

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

**Approvals are bound to the artifact version** (docs/DECISIONS.md D15). Every approval records
`approvedVersion`, and an artifact whose `version` differs from it is refused (`needs_human`:
"approved for 1.0.0, artifact is 1.1.0; re-approve"), so editing and re-versioning an artifact never
silently inherits its old approval. `catalog approve <id>` takes the version from the artifact on
disk. A status file with no `approvedVersion` (written before this rule) is still allowed and the
gate says it is grandfathered; all committed status files now name their version.

**…and to the artifact's content** (D24). Every approval also records `approvedDigest`, the
SHA-256 of the artifact's canonical JSON (keys sorted, no whitespace, after schema validation). An
artifact edited without a version bump is refused too ("artifact content changed since approval;
re-approve"), while re-indenting the file or switching CRLF/LF changes nothing. A status file
with no digest falls back to the version check, and the gate's reason says so. All committed
status files carry a digest, and `src/catalog/committedApprovals.test.ts` fails if any committed
artifact no longer matches its approval.

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

## Fleet (Day 1): a job queue, workers and an async API

Single machine, Docker Compose (docs/FLEET_BRIEF.md; design in docs/plans/step-05.md and
step-06.md). Postgres holds the jobs; each worker container runs one Chromium and pulls jobs with
`SELECT … FOR UPDATE SKIP LOCKED`, at most 2 at a time per tenant; one mock-bank container is the
source of truth (its in-memory ledger).

```
cp .env.example .env              # once; fake per-tenant bank credentials (ROTE_CRED_*)
docker compose up -d --build      # postgres, bank, api (:8080), 4 workers (ROTE_WORKERS)
npm run evidence:day1             # the Day-1 exit: 100 jobs, ledger-checked (evidence/fleet-day1-exit/)
```

**Async invoke** (the synchronous `POST /capabilities/:id/invoke` is unchanged):

```
curl -X POST "http://127.0.0.1:8080/capabilities/transfer/invoke?mode=async" \
  -H "Idempotency-Key: order-42" -H "content-type: application/json" \
  -d '{"tenant":"tenant-a","params":{"memberId":"10001","toMemberId":"10002","amount":"1.00"}}'
# 201 {"jobId":…,"state":"queued","memoKey":"rote-<jobId>","links":{"self":"/jobs/<jobId>?tenant=tenant-a"}}
curl "http://127.0.0.1:8080/jobs/<jobId>?tenant=tenant-a"
```

- The same tenant + key + request returns the same job (200); the same key with a different
  request is 409. The body is `tenant` + `params` only: credentials are injected per tenant by the
  worker and never stored, the transfer's memo is the job's `memoKey`, and run-time approvals are
  never taken from a client (400). A capability not approved for its current version and content is
  422 at enqueue; the worker checks again at run time.
- **`?tenant=` is NOT authentication.** This project has no authentication, by scope. The tenant is
  whatever the caller says; scoping `GET /jobs/:id` by it only stops one tenant from reading
  another's job by id (another tenant's job is a 404, same as a missing one). Every port is bound to
  127.0.0.1.
- A job ends `succeeded`, `business_outcome` (the bank refused: final, never retried), `failed`, or
  `needs_human`. `outcome: "commit_uncertain"` means the Submit may have gone through: it is never
  retried, and someone must check the bank's history for the `memoKey` (Day 2 automates this).
- **Day-1 limits, on purpose:** leases are taken but not heartbeated, and nothing recovers a dead
  worker's job yet. A worker killed with SIGKILL (or OOM) leaves its job `running`. `docker compose
  stop` is graceful: the in-flight job gets 30 s, then is aborted and recorded. Day 2 adds heartbeats,
  recovery and the commit intent.

Measured (evidence/fleet-day1-exit/check.txt, `RESULT: PASS`): 100 transfer jobs on 4 workers in
102.6 s, all succeeded on the first attempt, exactly one ledger row per job, 0 duplicates, 0 lost.
Peak memory per worker was about 260 MiB. Re-run on the shared ledger oracle in Step 7
(evidence/fleet-day1-exit-oracle/): `RESULT: PASS` again, 84.0 s.

## The judges: the ledger oracle, chaos and the crash-point matrix (Day 1: expected to fail)

Correctness is judged only by the mock bank's own ledger, matched to jobs by `memoKey` (D32). One
module decides every verdict, for every harness:

```
npm run oracle -- --drain-timed-out --out <dir>   # any time: jobs in Postgres vs GET /control/ledger
npm run chaos -- --seed <n>                       # Compose fleet, seeded kills + a 45 s pause (D33)
npm run crash-matrix                              # kill a worker at each of 16 transfer boundaries (D34)
```

- **Oracle verdicts:** DUPLICATE (2+ rows for a job, whatever its state), MISSING_COMMIT
  (`succeeded`, no row), UNRECORDED_COMMIT (`failed`/`business_outcome`, but a row), MISMATCH (wrong
  `confirmationRef` or tenant), LOST (non-terminal after the drain, with its row count), ORPHAN (a row
  no job owns). `needs_human` may have 0 or 1 row and is listed. The report ends in `RESULT: PASS` or
  `RESULT: FAIL`.
- **Chaos** (`scripts/chaos.ts`): the seed fixes the schedule (kill times, victims, the pause), not
  the interleaving. The harness is the supervisor (`docker start` after each kill), never touches
  Postgres or the bank, and stops the fleet at the end.
- **Crash-point matrix** (`scripts/crash-matrix.ts`): per point a fresh test schema, an in-process bank
  on :4100 (stop the Compose bank first), one job, a worker child process with
  `ROTE_FAULT=<point> ROTE_FAULT_ENABLE=1` that SIGKILLs itself there, then a clean worker and the
  oracle. The fault flag is refused without the enable flag, so it can never fire by accident.

**Today these fail, on purpose, and the failures are the "before" evidence** (the brief: write them
now, even though they will fail):

| Judge | Result (Step 7) | Why |
| --- | --- | --- |
| `evidence/chaos/before-day2/` (seed 2024306878) | **RESULT: FAIL**: 61 ok, **39 LOST** (one after commit), 0 duplicates | a killed worker's job stays `running` forever and holds its tenant slot; tenant-a stalled after 16 s |
| `evidence/crash-matrix/before-day2/` | **1/16 green**: LOST at every point but `after-complete`; 1 ledger row from `after-submit` on | the lease expires (30 s, the drain was 40 s) but nothing recovers it |

**0 duplicates here proves nothing.** A duplicate needs a second runner of the same job, and before Day
2 nothing ever re-runs a dead worker's job. Day 2 (docs/plans/step-08.md: heartbeat, the fenced commit
intent, recovery, verify through the history page) is what these same scripts must then judge green.


## Saved demonstration runs

Real, unedited evidence from runs of all four scenarios above — logs, screenshots, and an index
of what to look for in each — is committed under [evidence/](evidence/README.md).
