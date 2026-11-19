# Clean-clone check (step-10 section 10, item 4)

**RESULT: PASS.** A fresh clone of `fleet/day-1`, set up and run by following the README exactly, built the
Compose stack and passed the one-command chaos run. Seed 757102590: 100/100 jobs succeeded, 16 kills and a
45 s pause, 0 DUPLICATE, 0 LOST, `RESULT: PASS`. **No README step was wrong or missing**, so the README is
unchanged by this check.

Run on 2026-11-19 (Step 11) on the builder's Windows laptop.

## Environment

| | |
| --- | --- |
| OS | Windows 11 Home Single Language 10.0.26300, PowerShell 5.1 |
| Node / npm | v25.9.0 / 11.0.0 (`engines.node` is `>=22`) |
| git | 2.54.0.windows.1 |
| Docker | Docker Desktop, client and server 29.9.3; Compose 5.7.0; the VM had 8 CPUs and 3.83 GiB |
| Playwright | 1.62.1 (the lockfile's) |

## What was cloned

`git clone --branch fleet/day-1 https://github.com/bhuvanb3110/rote.git C:\Users\hp\rote-clean-check` gave a
new directory outside this repo, at `9d38bb2`, the pushed head of `fleet/day-1` at the time. The commits made
on this branch since then (`735b7f9`, `d8b27e9`, `7d840a3` and this step's docs) change only `evidence/` and
Markdown docs (`README.md`, `docs/`), with no code, config, migration or lockfile change. So the clone ran
the code this PR ships.

## The commands, in the README's order

The README's Setup section and its "Fleet (Day 1)" section, then the one-command chaos run from "Fleet
(Day 2)". Each command ran in the clone; its full output is in this folder.

| # | Command | Log | Result |
| --- | --- | --- | --- |
| 1 | `npm ci` (in place of the README's `npm install`, as the reviewer asked: it installs the lockfile exactly) | [`01-npm-ci.txt`](01-npm-ci.txt) | exit 0, 4.8 s; 169 packages. It prints the 8 known `npm audit` findings (a follow-up of its own; `npm audit fix` was not run) |
| 2 | `npx playwright install chromium` | [`02-playwright-install.txt`](02-playwright-install.txt) | exit 0, 1.2 s (already in the user's Playwright cache). Chaos itself does not need it: its Chromium runs inside the worker image |
| 3 | `cp .env.example .env` | — | the fake per-tenant credentials (`ROTE_CRED_*`); `.env` is gitignored, so the run's commit stamp stayed clean |
| 4 | `docker compose up -d --build` | [`03-compose-up.txt`](03-compose-up.txt) | exit 0, 45.9 s: `rote-fleet:local` rebuilt from the clone's 1.81 MB context, and postgres, bank, api and 4 workers recreated and started |
| 5 | `npm run chaos -- --seed 757102590` | [`04-chaos.txt`](04-chaos.txt) | exit 0, 173.4 s, **RESULT: PASS** |
| 6 | `docker compose down` | [`05-compose-down.txt`](05-compose-down.txt) | exit 0; every container and the network removed |
| 7 | `Remove-Item -Recurse -Force C:\Users\hp\rote-clean-check` | — | the clone deleted |

- **The seed** was drawn fresh for this check (`crypto.randomInt`). It was not picked from an earlier run.
- **The build used this machine's Docker cache** for the base layer. That cannot hide a missing file: BuildKit
  keys every `COPY` layer on the content of the clone's context, which holds only tracked files
  (`.dockerignore` keeps out `node_modules`, `evidence`, `.env` and `.git`).
- **The compose project** is `name: rote` in `docker-compose.yml`, so the clone's stack used the same
  container names (`rote-worker-N`, which chaos addresses) and the same named volumes. This repo's own stack
  was stopped first, and chaos resets the queue tables and the bank's ledger before it starts.

## The chaos run

[`chaos-run/`](chaos-run/) is copied unchanged from the clone's `evidence/chaos/2026-11-19T14-39-20-106Z-seed-757102590/`.
[`chaos-run/check.txt`](chaos-run/check.txt) holds the report.

- **Stamp:** code `9d38bb2`, no `+dirty`. Standard family, 100 jobs, 4 workers, a 150 s schedule.
- **Faults:** 16 kills with restarts; worker 1 paused from 40.9 s to 85.9 s.
- **Recovery:** 11 crash requeues (T6.1), none of which used an attempt. No death landed after an intent,
  so there was no verify.
- **The zombie check:** worker 1 was paused holding job `0abdfc3a-…`, which was recovered (T6.1) while it
  was frozen. It woke into a lost lease. Its heartbeat noticed and aborted the run
  (`heartbeatLeaseLost x1`, `runAbortedOnLostLease x1`; attempt outcome `lease_lost x1`).
- **Ledger oracle:** 100 jobs, 100 ledger rows, ok = 100. DUPLICATE, MISSING_COMMIT, UNRECORDED_COMMIT,
  MISMATCH, LOST, PENDING and ORPHAN are all 0. 100/100 settled; 0 `needs_human`, 0 failed.
- **Other checks:** no credential values in the jobs, attempts, API responses or container logs. Peak worker
  memory was 223–406 MiB.
