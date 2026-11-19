# Step 7 evidence

Every full `npm test` log of this step, unfiltered (stdout and stderr), with the exit code and wall
time appended by the runner. Runs are from PowerShell (see the note on Git Bash below).

| File | What |
| --- | --- |
| `npm-test-baseline.txt` | before any Step 7 code: 37 files, 350/350, 90.6 s |
| `npm-test-baseline-gitbash-runner-error.txt` | the first baseline attempt, from Git Bash: every file failed with "Vitest failed to find the runner" before running a test. Cause: Git Bash hands vitest a lower-case `c:/` cwd, so on Windows vitest's runner module is loaded under two paths. Not a test failure; kept because nothing is deleted. All later runs are from PowerShell. |
| `approval-override-backfill.txt` | D30 backfill output, `RESULT: PASS` |
| `npm-test-commit-*.txt` | the run before each commit |
