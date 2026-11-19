# Step 11 — close Day 2 and open the PR to `main`

Branch `fleet/day-1`. Reads `CLAUDE.md`, `docs/REPO_NOTES.md` and `docs/plans/step-10.md` (section 10's PR
checklist and every reviewer-decision section). No code changes: this step commits the overnight evidence,
checks the README from a fresh clone, brings the docs up to date and opens the PR.

## The plan (the reviewer's Step 11 instruction, 2026-11-19)

The reviewer gave the plan itself, step by step, so there was no separate plan review.

1. **The 20-seed batch.** The builder ran `npm run chaos-seeds -- --seeds 20 --jobs 500 --out
   evidence/chaos/day2-exit-final` on `9d38bb2` (exit code 3). Check it before committing it:
   - 20 seed folders, each stamped `9d38bb2`;
   - `tally.md` and `tally.json` agree with each seed's `summary.json`;
   - no stray `.interrupted` folders.

   Then inspect seed 20's escalated job `9e1d23f4-…` (its ledger count, its 5 attributed deaths) and write
   the folder's README: what the batch is, the totals, the recovery kinds, and what the escalation means and
   what a human would do with it. Commit the folder exactly as produced, plus the README, in one evidence
   commit. Nothing the runner wrote is modified, regenerated or deleted.
2. **Reviewer decision 3 on 10b:** copy the latest CI mutation-check report (12/12, run 44425004620 or newer)
   into `evidence/mutation-check/ci-linux/`, replacing the 10a copy, with the run id.
3. **Checklist item 4, the clean clone:** clone fresh into a new directory outside the repo, `npm ci`, and
   follow the README exactly (`docker compose up -d --build`, then `npm run chaos -- --seed <n>`, 100 jobs).
   Record the commands, versions and result in `evidence/clean-clone-check/`, then tear the stack down and
   delete the clone. Fix the README if a step is wrong or missing.
4. **Docs:** the README "Fleet (Day 2)" Results table, the evidence index and REPO_NOTES get the 20-seed
   numbers; step-10 section 10's checklist is filled in, every item with its evidence.
5. `npm test` once on the final code; push; CI checked with `gh`, all 5 jobs green.
6. **The PR** (`gh pr create`): "Fleet: a crash-safe multi-worker fleet (Days 1–2)". The body covers Days 1–2,
   the headline numbers with evidence links, the honest limits (copied from the README), the follow-ups and
   the branch-protection note. Not merged.

Memory: the 8 GB laptop. Stop the fleet when not in use; never run the test suite while a fleet is up.

## Built

| Commit | What |
| --- | --- |
| `735b7f9` | `evidence/step-11/check-day2-exit-final.mjs` and its output: the batch checked before it is committed, RESULT: PASS |
| `d8b27e9` | `evidence/chaos/day2-exit-final/`, exactly as the runner wrote it, plus its README |
| `7d840a3` | `evidence/mutation-check/ci-linux/`: CI run 44425004620, 12/12, the whole artifact |
| `f6dc7f4` | `evidence/clean-clone-check/`: RESULT: PASS |
| (docs) | the README Results table and an honest limit, the evidence index, REPO_NOTES, step-10's checklist, this file; `npm test` on the final code |

**1. The batch.** `evidence/step-11/day2-exit-final-check.txt` shows:
- 20 seed folders, each `summary.json` and `check.txt` stamped `9d38bb2`, with no `+dirty`;
- no stray, `.interrupted` or `.rerun` folder;
- `runner-log.jsonl` with one start and one end per seed and no set-aside run;
- every `tally.md` cell equal to its `summary.json`, and `tally.json` and the recovery-kind table equal to the
  sums;
- a recount from the raw `jobs.json` and `ledger.json` matching the oracle.

The totals: **10,000 jobs, 1,582 kills, 0 DUPLICATE, 0 LOST, 9,999 succeeded, 1 `needs_human` / `crash_limit`
(attributed)**.

Seed 20's job `9e1d23f4-…` has **0 ledger rows**. Its 5 deaths are:
- attempt 1, killed 0.6 s after its intent;
- then four verify phases, each killed 1.1–5.2 s in, before a lookup.

Each death is found in `events.jsonl` inside that holder's lease. They came during a burst of 16 kills in
135 s, 15 of them on workers 1–3 while worker 4 was paused. No money moved. The operator's move is `rote
jobs reverify`, which would read `[0, 0]` and resubmit once. It does not reset the crash count. The folder's
README says all of this.

**2. The CI mutation check.** All 16 files of run 44425004620's `mutation-check-report` artifact are copied
byte for byte: `report.md`, `check.txt`, 12 `mutant-NN.json` and the job's stdout. The 10a copy kept only the
first two. Since the point is a record that outlives GitHub's 90 days, the whole artifact is kept.

**3. The clean clone.** The clone came from GitHub (`9d38bb2`, the pushed head). It did not come from this
working tree, so it also proves everything needed was pushed. The commits since then are evidence and docs
only. Every README step worked as written; nothing in the README needed fixing.

**4. Docs.**
- The README Results table leads with the 20-seed batch. The 2-seed before / after row stays below it, and
  there are new rows for the CI mutation copy and the clean clone.
- **One honest limit is added:** bad luck alone can reach the crash cap. The batch showed it once in 10,000
  jobs, and the fleet cannot tell it from a poison job.
- The evidence index has rows for `day2-exit-final/`, `step-11/` and `clean-clone-check/`, and the 10b
  before / after closes its two open items.

**Decisions:** none added. This step made no design choice; the cap, the attribution rule and the batch rule are
D58 and D60.
