# Fleet Step 8: test logs and the CI pin check

Every full `npm test` of Step 8, run through `scripts/npm-test-log.ps1` (raw stdout + stderr via
`cmd.exe` redirection, unfiltered, with `exit=<code> wall_seconds=<s>` appended), in commit order. No
run failed and no test flaked in any of them.

| Log | Before commit | Files | Tests | Wall |
| --- | --- | --- | --- | --- |
| `npm-test-baseline.txt` | (nothing changed yet) | 47 | 425/425 | 103 s |
| `npm-test-commit-a1-a2.txt` | 6dc6c59 CI pins, b2ab650 uncapped config deleted | 47 | 425/425 | 88.3 s |
| `npm-test-commit-a3-migration.txt` | aa2a48a CI crash-matrix job, 8eb5e55 migration 0002 | 47 | 431/431 | 88 s |
| `npm-test-commit-state-machine.txt` | ba4d959 state machine, model, property tests | 49 | 451/451 | 118.5 s |
| `npm-test-commit-heartbeat.txt` | ff828ce heartbeat T2 | 52 | 471/471 | 109.1 s |
| `npm-test-commit-intent.txt` | a26b97a commit intent T3, T4 widened | 53 | 485/485 | 116 s |
| `npm-test-commit-recovery.txt` | dc39eba recovery T6, db58bd3 model vs real | 55 | 498/498 | 149.3 s |
| `npm-test-commit-matrix.txt` | 4239173 crash matrix Expected column + evidence | 56 | 501/501 | 128.1 s |
| `npm-test-commit-chaos-docs.txt` | d487612 chaos evidence, 85ef8a8 docs, 8e3387b step-09 plan | 56 | 501/501 | 118.2 s |
| `npm-test-final-x3-run1.txt` | final run 1 of 3, back to back, on 8e3387b | 56 | 501/501 | 130 s |
| `npm-test-final-x3-run2.txt` | final run 2 of 3 | 56 | 501/501 | 118 s |
| `npm-test-final-x3-run3.txt` | final run 3 of 3 | 56 | 501/501 | 119.8 s |

Where one run covers two commits, the first commit's tree is the second's minus files that change no
code under test (CI YAML, docs, a test file added on top).

`ci-action-pins.md`: the CI run after the SHA pins (A1): all jobs green, 0 annotations (before: the
"Node.js 20 is deprecated" warning on every job).

Wall time grew from about 88 s to 110-150 s over the step: `src/worker/lease.db.test.ts` waits on a
deliberately slow bank (latency 1.5-3 s per request) to exercise the heartbeat, and the property tests
(about 7 s) and the model-vs-real test (about 3 s) add CPU in the parallel group.
