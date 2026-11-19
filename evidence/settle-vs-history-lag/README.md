# Settle period vs history lag (step-09 reviewer addition 4)

**The rule: the verify settle period (`ROTE_VERIFY_SETTLE_MS`) must exceed the bank's history visibility
delay.** That is a deployment configuration requirement, like the lease. If the bank shows a transfer in its
history later than verify's second look, both lookups count 0, and `[0, 0]` resubmits a transfer that
already happened. The ledger oracle reports that as a DUPLICATE. The reconcile pass (Step 10) is the
backstop that turns such a duplicate into an alert (docs/plans/step-08.md section 9a). D47 records the
rule.

```
npm run verify-scenarios -- --family lag --out evidence/settle-vs-history-lag
```

The run was on 2026-11-14 (UTC), 146 s wall, on the builder's Windows machine. Postgres came from Compose
and the bank ran in-process on :4100 with `/control/history-lag/<lag>`. Each worker was a child process
(`node --import tsx src/worker/main.ts`). Settle was 5000 ms (the default); lease 5 s / heartbeat 2 s, as
in the crash matrix.

**Result (`summary.md`, `check.txt`): RESULT: PASS.** All 6 runs were consistent, and both the `[0, 1]`
path and the `[0, 0]` duplicate occurred.

## How each run is judged (by the script, not by eye)

The mock bank applies the lag at read time: a row appears on the history pages (the count included) once
`now - row.at >= lag`, while `/control/ledger` sees it at once. Each lookup's own evidence (`run.jsonl`
under `worker-evidence/`) brackets the moment the bank rendered the filtered history. A record is written
after its action, so that moment falls between the records of step-07 (type the memo) and step-08 (apply the
filter). The judge requires three things:
1. each lookup's count matches what its measured render time implies for the row's visibility (± 250 ms
   slack; inside that band, either answer passes);
2. the decision follows from the lookups: `[1]` / `[0, 1]` → `already_done`, attempt 1, 1 row, oracle `ok`,
   and `confirmationRef` = the row's id; `[0, 0]` → `resubmitted`, attempt 2, 2 rows, oracle `DUPLICATE`;
3. across the six runs, `[0, 1]` and the duplicate each occur at least once.

## Two paths into verify, six runs

- **crash**: a worker SIGKILLs itself right after Submit (`ROTE_FAULT=after-submit`; the bank has written the
  row). A clean worker recovers the job only when the lease expires (T6.4) and then verifies it.
- **t5**: the bank writes the row, **then** answers 503 (`/control/errors/after-write`). The worker's own
  run ends commit-uncertain, and it verifies at once (T5). This is the earliest a verify can start.

| Run | Lag | Write → lookup #1 render | Write → lookup #2 render | Lookups | Result | Ledger rows | Oracle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `crash-lag-3000` | 3 s | 6.0–6.1 s | – | `[1]` | `succeeded` / `already_done`, attempt 1 | 1 | ok |
| `crash-lag-8000` | 8 s | 6.3–6.4 s | 12.3–12.4 s | `[0, 1]` | `succeeded` / `already_done`, attempt 1 | 1 | ok |
| `crash-lag-30000` | 30 s | 6.2–6.3 s | 12.2–12.3 s | `[0, 0]` | resubmitted → `succeeded`, attempt 2 | **2** | **DUPLICATE** |
| `t5-lag-3000` | 3 s | 0.9–1.0 s | 6.7–6.9 s | `[0, 1]` | `succeeded` / `already_done`, attempt 1 | 1 | ok |
| `t5-lag-8000` | 8 s | 1.1–1.2 s | 7.1–7.2 s | `[0, 0]` | resubmitted → `succeeded`, attempt 2 | **2** | **DUPLICATE** |
| `t5-lag-15000` | 15 s | 2.0–2.2 s | 8.3–8.4 s | `[0, 0]` | resubmitted → `succeeded`, attempt 2 | **2** | **DUPLICATE** |

## What the plan predicted, and what happened

The reviewer's two cases were "lag 3000 ms, settle 5000 ms, a crash right after Submit → `[0, 1]`" and
"lag 8000 ms, the same crash → `[0, 0]` → 2 rows → DUPLICATE". Run as stated, with a crash, they came out
differently: `[1]` and `[0, 1]`, one row each, no duplicate. The reason is the lease. A dead worker's job is
verified only after its lease expires. T3 sets that lease right before the click, so it ends about 5 s
after the write here, and about 30 s in production. Add the poll (up to 2 s), and lookup #1 rendered 6.0–6.4
s after the write in all three crash runs. By then a 3 s lag is over, and lookup #2 (about 12.3 s) also
outlasts an 8 s lag.

**With the verify starting at once (T5), the reviewer's predictions hold exactly:** lag 3 s → `[0, 1]`, 1
row; lag 8 s → `[0, 0]` → 2 rows → DUPLICATE. Lookup #2 rendered 7.1 s after the write, inside the 8 s
lag.

So the rule has to be stated against the fastest path. Lookup #2 renders at least `settle` after lookup #1
began, and lookup #1 begins after the write, so **settle ≥ lag is sufficient on every path**. A crash only
adds margin (here about 6 s; in production a 30 s lease), and that margin cannot be counted on, because the
T5 path verifies about 1 s after the write. `t5-lag-8000` shows the cost of breaking the rule: settle 5 s,
lag 8 s, one duplicate.

## Files

`summary.md` (the table above, generated), `check.txt` (every run's timing and judgement), and
`stdout.txt` (the console). Each run's folder holds the worker logs, `jobs.json`, `attempts.json`,
`verifications.json` (the phase with its `lookups`), `ledger.json` (with each row's `at`), `oracle.json` /
`oracle.txt`, `timing.json` (row time, visibility time, each lookup's render window, predicted vs counted)
and `worker-evidence/` (the transfer and lookup runs, screenshots included). The script also scans every
text file for the three fake passwords: none found.
