# Fleet Step 9: test logs and the mutation check

Every full `npm test` of Step 9, in commit order. Each was run through `scripts/npm-test-log.ps1` (raw
stdout + stderr via `cmd.exe` redirection, unfiltered, with `exit=<code> wall_seconds=<s>` appended). No
run failed and no test flaked in any of them.

| Log | Before commit | Files | Tests | Wall |
| --- | --- | --- | --- | --- |
| `npm-test-baseline.txt` | (nothing changed yet; Step 8 head) | 56 | 501/501 | 122.2 s |
| `npm-test-commit-a1-illegal-transition.txt` | 9f1f873 A1, `illegal_transition` | 56 | 504/504 | 124.2 s |
| `npm-test-commit-lookup-1.2.0.txt` | 2935370 lookup 1.2.0, approvals, history lag | 56 | 510/510 | 124.5 s |
| `npm-test-commit-verify.txt` | 7337661 verify (T5/T7/T8, T6.4–T6.7, reverify, 0003) | 58 | 568/568 | **242.8 s** |
| `npm-test-commit-matrix.txt` | efcd7c5 matrix `step-09` + two-fault scenarios (run after resuming the interrupted session, on the working tree as found) | 58 | 571/571 | 161.8 s |
| `npm-test-commit-verify-scenarios.txt` | 5416f60 `verify-scenarios.ts`, lag + outage evidence | 58 | 571/571 | 172.5 s |
| `npm-test-commit-chaos.txt` | 5aeec8a chaos harness Step 9 lines + seed 14449393 | 58 | 571/571 | 175.6 s |
| `npm-test-final-x3-run1.txt` | final run 1 of 3, back to back, on the docs commit's tree | 58 | 571/571 | **245.6 s** |
| `npm-test-final-x3-run2.txt` | final run 2 of 3 | 58 | 571/571 | 167 s |
| `npm-test-final-x3-run3.txt` | final run 3 of 3 | 58 | 571/571 | 168.7 s |

Where a run is listed before a commit, the tree differed from that commit only by files that change no code
under test (evidence, docs, CI YAML, harness scripts outside the suite).

**Wall time.** Two runs went over step-09 section 2's 3-minute line: the verify commit's (242.8 s) and final
run 1 (245.6 s). Their cumulative test time was 591 s and 682 s, against 485–514 s in the other runs, and the
extra is spread across all tests (machine contention, not one slow test). The `slow`-project move that
section describes is a reviewed change, proposed in `docs/plans/step-10.md` (open question 6).

**`mutation-check-property-tests.txt`** (with the script that produced it,
`mutation-check-property-tests.ps1`): four planted bugs in `src/fleet/stateMachine.ts`, each applied, the
property tests run, and the file restored:
- M1: a single 0 decides;
- M2: T6.4 requeues an expired `committing` job;
- M3: `[0, 1]` read as not committed;
- M4: a refusal after Submit is retried.

Each mutant made the property tests fail (exit 1), and the failing tests are listed under it. Step 10 turns
this into `scripts/mutation-check` with a CI job (step-09 reviewer addition 6).
