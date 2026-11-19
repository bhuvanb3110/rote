# Mutation check on Linux CI (D54)

CI's **mutation-check** job on `9d38bb2` (the Step 10b code, as on `255f92f`; head of `fleet/day-1` when the
20-seed batch ran): run [44425004620](https://github.com/bhuvanb3110/rote/actions/runs/44425004620),
job 135227573674, 2026-11-18T23:57Z, ubuntu-24.04, Node 22, `postgres:17`. All five jobs of that run were
green.

**Caught: 12/12, RESULT: PASS**, with the same failing-test count per mutant as the Windows run one folder up
(`4cb302b`).

Every file here is copied byte for byte from that run's `mutation-check-report` artifact (artifact id
14483561979, downloaded with `gh run download 44425004620 -n mutation-check-report`):

- `report.md` and `check.txt`;
- the 12 `mutant-NN.json` files (each mutant's vitest JSON);
- `mutation-check-stdout.txt` (the job's full stdout).

GitHub deletes Actions artifacts after about 90 days (this one on 2027-02-16), so the repo keeps its own copy
(the reviewer decision 3 on 10b).

This copy replaces the Step 10a one: run [43616704578](https://github.com/bhuvanb3110/rote/actions/runs/43616704578)
on `3ff342a`, 8/8, `report.md` and `check.txt` only. That copy is in git history at `3f0776f`.
