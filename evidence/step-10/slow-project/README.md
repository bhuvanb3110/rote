# The `slow` vitest project: before / after (Step 10, reviewer decision 6; D48)

Every run here is the full suite, with its raw log (`*.txt`) and vitest's JSON report (`*.json`: each
file's start and end). `npx tsx scripts/test-timeline.ts <file>.json` prints a run as a per-file timeline.
Nothing else ran during the A/B (the builder's machine: 8 GB RAM; VS Code, a browser and the Docker VM
open, about 0.65 GB free at the time, so the runs swap and vary).

## The A/B: slow files in the browser pool (before) vs in group 0 beside unit-db (the first "after")

`ab.ps1` alternated the two arrangements, 3 rounds. "Before" is the pre-D48 configuration
(`vitest.ab-before.config.ts.txt`: the slow files inside the capped browser project). The first "after"
put a `slow` project in group 0, next to `unit-db`, to overlap its waiting with the unit/DB CPU work.

| Round | Before: wall (s) | After (slow in group 0): wall (s) | unit-db span before / after (s) | slow files' span before / after (s) |
| --- | --- | --- | --- | --- |
| 1 | 168.5 | 160.3 | 41.9 / 74.5 | 103.3 / 75.6 |
| 2 | 171.6 | 180.0 | 41.5 / 74.5 | 107.4 / 74.0 |
| 3 | 215.4 | 215.3, **6 tests failed** | 52.1 / 82.3 | 145.1 / 93.7 |
| mean | 185.2 | 185.2 | | |

- **No gain.** Overlapping made both sides slower: `modelVsReal.db.test.ts` went from about 40 s to about
  75 s, and the slow files slowed too (`verify` 59 s → 75 s).
- **Flaky under load.** In round 3 (a loaded machine: both runs 215 s) the overlap failed six tests: model
  vs real drifted past its 1 s slack, two recovery tests timed out at 5 s, `faults`' setup hook timed out,
  plus the guard test below. The "before" run of the same round passed everything but the guard.
- Every A/B run failed ONE test, the new guard in `browserProject.test.ts`: it flagged `fault.test.ts`,
  whose local `startWorker` checks that the worker refuses a bad fault flag before it launches anything.
  The guard now matches only an import of the shared spawner (fixed before the commit). A 0.1 s unit
  test: it does not affect the timing.

So the slow project stays in the browser files' pool (group 1, the same cap of 3).

## The committed configuration (slow and browser share group 1, one longest-first queue)

Each run below is also that commit's `npm test` gate (`../npm-test-commit-slow-project-run*.txt`).

| Run | Configuration | Wall (s) | Group 1 (s from start) | Group 1 span / summed file time | Result |
| --- | --- | --- | --- | --- | --- |
| `final-run1-flake.json` | group 1, vitest's default order | 200.8 | 44.1 .. 198.4 | 154.3 / 387.7 = 0.40 | **2 failed**: model vs real drift in unit-db (`../flakes.md` 1), not in group 1 |
| `final-2.json` | group 1, vitest's default order | 217.7 | 45.3 .. 213.2 | 167.9 / 419.7 = 0.40 | passed; **the slow files ran last** (browser 45-160 s, slow 159-213 s) |
| `final-3.json` | + `vitest.sequencer.ts`, but its cache key missed (backslashes) | 208.8 | 56.9 .. 205.5 | 148.6 / 375.5 = 0.40 | passed; slow first, then the browser files in file order |
| `final-4.json` | + `vitest.sequencer.ts`, fixed (committed) | 203.4 | 51.1 .. 199.0 | 147.9 / 409.4 = 0.36 | passed; **longest first across both projects** |

vitest's own sequencer orders a group's files by project name before duration ("projects run sequential"),
so with "browser" and "slow" in one group every slow file queued behind every browser file (`final-2`).
`vitest.sequencer.ts` is vitest's comparator without that step. With it, group 1 packs as tightly as in the
"before" runs of the A/B (span / summed file time 0.36, 0.355 and 0.36 there; 0.36 here): the same
scheduling as before the slow project existed. The absolute times above are higher than the A/B's first
rounds because the machine was more loaded by then (every test file was slower: `transfer.test.ts` 75 s in
the morning, 90 s in `final-4`), not because of the arrangement.
