# Step 10 flakes (every one rerun and reported, never hidden)

## 1. `modelVsReal.db.test.ts`: lease remaining drifted past the 1 s slack under load (2026-11-14)

- **Where:** the slow-project commit's gate run 1, `evidence/step-10/npm-test-commit-slow-project-run1-FLAKE.txt`
  (exit 1, 200.8 s wall; 570 passed, 2 failed). Also round 3 of the slow-project A/B with the slow files in
  group 0 (`slow-project/ab/round3-after.txt`, 215 s).
- **What:** `dequeue(wC): job 0: lease remaining real 28.733502 vs model 30: expected 1.266... to be less
  than 1`. The second model-vs-real test then failed its coverage check ("never happened: recover:T6.4")
  only because the first test stopped after 43 sequences and its hits never accumulated (a cascade, not a
  second fault).
- **Not caused by the slow project:** the unit-db group (where this file runs) was unchanged by the
  committed configuration; the failure is in group 0, before any browser or slow file starts.
- **Cause:** the machine was swapping (0.65 GB of 7.8 GB free; VS Code, a browser, a VPN client and the
  Docker VM open; every run that day took 200-215 s against 165 s in the morning). The dequeue transaction
  plus the comparison's reads took 1.27 s of real time, and a lease set inside a command is not
  compensated by `sync()` (it only shifts times between commands). Step 9 met the same symptom once
  (28.995 vs 30) and added `sync()`.
- **Rerun:** `evidence/step-10/npm-test-commit-slow-project-run2.txt`: 58 files, 572/572 passed, 217.7 s
  (and runs 3 and 4 of the same commit passed too). A flake, confirmed.
- **Fixed** (its own commit, right after): the slack is now 1 s plus the real time since the stored times
  were last compensated, measured at the comparison. That bound is sound: real time can move a real
  remaining-time by at most the real time that passed. Every command's ANSWER (leased, extended, recorded,
  fenced, CHECK violation) is still compared exactly.

## 2. `recover.db.test.ts`: "8 concurrent recoverers over 50 expired jobs" timed out at vitest's default 5 s (2026-11-14)

- **Where:** the model-vs-real fix's first gate run, `evidence/step-10/npm-test-commit-mvr-slack-run1-FLAKE.txt`
  (exit 1, 206.6 s; 571 passed, 1 failed: `Test timed out in 5000ms`). Also round 3 of the slow-project A/B
  with the slow files in group 0, where the next test ("8 concurrent verifiers ...") then failed with "no
  job" because the timed-out test's work was still running.
- **Cause:** the same loaded machine as flake 1. The test enqueues and dequeues 50 jobs one by one, opens 8
  pools and recovers concurrently: a correctness test with vitest's default 5 s timeout, no explicit one.
- **Fixed** (with flake 1's fix): both concurrency tests get an explicit 60 s timeout. The timeout bounds a
  hang; it was never a claim about speed, and every assertion is unchanged.
- **Rerun:** `evidence/step-10/npm-test-commit-mvr-slack.txt` (with both fixes): 58 files, 572/572, 196.3 s.
