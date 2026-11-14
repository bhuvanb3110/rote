# Fleet Step 10a: test logs, the slow-project measurement, the flakes

Every full `npm test` of Step 10a, in commit order. Each was run through `scripts/npm-test-log.ps1` (raw stdout +
stderr via `cmd.exe` redirection, unfiltered, with `exit=<code> wall_seconds=<s>` appended), except the
slow-project commit's four runs, which ran the same `vitest run` with a JSON report added (for the per-file
timeline). Two runs failed, each on a pre-existing load flake (`flakes.md`): both were rerun, and both flakes were
fixed at their cause in their own commit.

The machine: the builder's 8 GB Windows laptop with VS Code, a browser, a VPN client and the Docker VM open; about
0.65 GB of RAM free during the step. Wall times rose from 165 s in the morning to 200–285 s later in the day with
the same suite: the extra is spread across every test file (contention), and `slow-project/README.md` shows it
file by file.

| Log | Before commit | Files | Tests | Wall | Result |
| --- | --- | --- | --- | --- | --- |
| `npm-test-baseline.txt` | (Step 9 head) b6d8263 the reviewer decisions | 58 | 571/571 | 168 s | pass |
| `npm-test-commit-slow-project-run1-FLAKE.txt` | 8eb764b slow project (vitest's default order) | 58 | 570/572 | 200.8 s | **fail**: flake 1 (model vs real drift, unit-db) |
| `npm-test-commit-slow-project-run2.txt` | 8eb764b, rerun | 58 | 572/572 | 217.7 s | pass |
| `npm-test-commit-slow-project-run3.txt` | 8eb764b + the sequencer (cache key bug) | 58 | 572/572 | 208.8 s | pass |
| `npm-test-commit-slow-project-run4.txt` | 8eb764b as committed | 58 | 572/572 | 203.4 s | pass |
| `npm-test-commit-mvr-slack-run1-FLAKE.txt` | 1c2ae4a model vs real's slack only | 58 | 571/572 | 206.6 s | **fail**: flake 2 (recover's 5 s default timeout) |
| `npm-test-commit-mvr-slack.txt` | 1c2ae4a both flake fixes | 58 | 572/572 | 196.3 s | pass |
| `npm-test-commit-backoff.txt` | 063359e 0004 + requeue backoff | 58 | 590/590 | 205.9 s | pass |
| `npm-test-commit-reconcile.txt` | 8569dcf the reconcile pass, settled, `rote reconcile --since` | 60 | 620/620 | 255.7 s | pass |
| `npm-test-commit-stall.txt` | 2748eed `stall-after-intent`, `--family zombie` | 60 | 623/623 | 284.3 s | pass |
| `npm-test-commit-crash-submit.txt` | 05027a7 `crashSubmit.db.test.ts`, the spawner in `src/testing/` | 61 | 625/625 | 235.2 s | pass |
| `npm-test-commit-mutation-check.txt` | 3ff342a mutation check, CI, matrix `step-10` | 61 | 627/627 | 254.1 s | pass |
| `npm-test-commit-docker-build-fix.txt` | fa267a5 the image build excludes the timeline tool | 61 | 627/627 | 237.5 s | pass |
| `npm-test-final-x3-run1.txt` | final run 1 of 3, back to back, on the docs commit's tree | 61 | 627/627 | 223.9 s | pass |
| `npm-test-final-x3-run2.txt` | final run 2 of 3 | 61 | 627/627 | 214.5 s | pass |
| `npm-test-final-x3-run3.txt` | final run 3 of 3 | 61 | 627/627 | 229.0 s | pass |

The evidence-only commits (the zombie run 953cfd6, the matrix 59c00b4, the CI reports 3f0776f, the verify
scenarios) changed no code under test; each ran on the tree of the gated commit before it.

- `slow-project/`: the interleaved A/B and the committed configuration's timelines (D48).
- `flakes.md`: the two load flakes, each rerun and fixed.
- `verify-scenarios/`: `--family lag` and `--family outage` re-run on the 10a code.
