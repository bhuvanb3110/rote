# Step 12 — dependency upgrades: the evidence

Plan: `docs/plans/step-12.md`. Decision: D61 (and D54's 2026-11-19 amendment). Branch `chore/deps-2026-11`, from
`main` at `0fa700f`. Every file here was written by the command named next to it. Nothing is hand-edited.

## Before and after

| | Before (`0fa700f`) | After |
| --- | --- | --- |
| `npm audit` | **8**: 1 critical, 4 high, 3 moderate (`audit-before.json`, `audit-before.txt`) | **0** (`audit-after.json`, `audit-after.txt`) |
| `npm outdated` | 11 packages (`outdated-before.txt`) | 5, all held on purpose (`outdated-after.txt`): playwright, express, @anthropic-ai/sdk, dotenv, fast-check |
| `npm ls --all` | `npm-ls-before.txt` | `npm-ls-after.txt` |

## The groups (one commit each, each after a full `npm test`)

Every command ran with `--before=2026-11-12` (D61's 7-day cooling-off).

| Group | Commit | What | Lockfile diff | Typecheck | `npm test` |
| --- | --- | --- | --- | --- | --- |
| 1 test runner (dev) | `20129a1` | vitest 4.1.12, vite 8.3.8, source-map-js 1.2.2 | `group-1-lockdiff.txt` (42, all dev) | `group-1-typecheck.txt` exit 0 | `group-1-npm-test.txt`: 723/723, 191.8 s |
| 2 Express transitives (runtime) | `836d798` | proxy-addr 2.0.8, body-parser 2.4.0, qs 6.17.1 (express stays 5.2.1) | `group-2-lockdiff.txt` (4) | exit 0 | `group-2-npm-test.txt`: 723/723, 189.7 s |
| 3 zod (runtime) | `b1f2825` | zod 4.6.7 → audit 0 | `group-3-lockdiff.txt` (1) | exit 0 | `group-3-npm-test.txt`: 723/723, 191.4 s |
| 4 in-range refresh (dev) | `28d21b7` | tsx 4.23.15, @types/node 26.6.6 | `group-4-lockdiff.txt` (3) | exit 0 | `group-4-npm-test.txt`: 723/723, 191.6 s |
| 5 in-range refresh (runtime) | `4401c7d` | commander 15.1.0, pino 10.4.0 | `group-5-lockdiff.txt` (4) | exit 0 | `group-5-npm-test.txt`: 723/723, 198.2 s |
| (fix) | `25ca3d0` | `.gitattributes`: `scripts/mutations/*.patch text eol=lf` (see "The mutation check") | — | — | `eol-fix-npm-test.txt`: 723/723, 190.6 s |

## The proof

Code is identical on `4401c7d` and `25ca3d0`. The fix commit changes only `.gitattributes` and
adds evidence.

| Check | Commit | File | Result |
| --- | --- | --- | --- |
| `npm ci` from an empty `node_modules` | `4401c7d` | `npm-ci-clean.txt` | exit 0, 168 packages, 0 vulnerabilities, Playwright 1.62.1, lockfile not rewritten |
| `npm test` ×3, back to back, unfiltered | `4401c7d` | `npm-test-1.txt`, `-2.txt`, `-3.txt` | 66 files, **723/723** each; 221.1 s, 209.5 s, 212.3 s |
| `npm run typecheck` | `4401c7d` | `typecheck.txt` | exit 0 |
| crash matrix at 5 s / 2 s (CI's flags) | `4401c7d` | `crash-matrix/` (`check.txt`, `matrix.md`, per-scenario folders), `crash-matrix-stdout.txt` | **23/23, RESULT: PASS**, 455 s |
| mutation check, first run | `4401c7d` | `mutation-check-run1-stale-03/` | **RESULT: FAIL, 11/12**: mutant 03 `STALE PATCH` (not a surviving mutant; see below) |
| mutation check, after the fix | `25ca3d0` | `mutation-check/`, `mutation-check-stdout.txt` | **12/12, RESULT: PASS**, 174 s |
| the rebuilt image | `25ca3d0` | `image-versions.txt` | `npm ls` inside the api and worker containers: zod 4.6.7, body-parser 2.4.0, proxy-addr 2.0.8, qs 6.17.1, pino 10.4.0, commander 15.1.0, Playwright 1.62.1 (`PLAYWRIGHT_VERSION=1.62.1`) |
| chaos, standard family, seed 412432443, 100 jobs | `25ca3d0` | `chaos-seed-412432443/`, `chaos-stdout.txt` | **RESULT: PASS**: 100/100 succeeded (99 `success`, 1 `already_done`), 15 kills + the 45 s pause, 0 DUPLICATE, 0 LOST, 0 needs_human, peak worker 303 MiB, no credential values anywhere |

## The mutation check's first run

Mutant 03 failed `git apply --check` with "corrupt patch at line 12", before any test ran. On this machine
`core.autocrlf=true` puts every patch on disk as CRLF. Line 12 of patch 03 is a bare empty context line,
which `git apply` accepts only as `\n`, so the CRLF copy is "corrupt". It is the only patch with such a line,
and the LF copy applies cleanly. On CI (Linux, LF) it was never a problem.

The dependency upgrades did not cause it. The likely trigger is this step's `git checkout`/`git pull`, which
rewrote a working-tree copy that had been LF until then. The fix (`25ca3d0`) is the same rule `*.sql` already
has. The failed run is kept here unchanged.

## The chaos run's credentials

This machine's `.env` dates from before the worker credentials existed, so the first `docker compose up`
started workers that correctly refused to run ("Worker credentials are incomplete", naming each variable).
The workers were then recreated, and chaos run, with the **committed fake** `ROTE_CRED_*` values from
`.env.example` set in that process's environment only. `.env` was not changed.
