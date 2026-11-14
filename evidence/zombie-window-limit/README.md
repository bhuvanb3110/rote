# The zombie window: measured, and made loud (Step 10, D52)

`npm run verify-scenarios -- --family zombie` (needs Postgres and port 4100 free). `summary.md` is the
judge's verdict; `check.txt` adds the run's log and the oracle report; `jobs.json`, `attempts.json`,
`verifications.json` and `ledger.json` are the record; `worker-zombie.log` and `worker-clean.log` are the two
workers' full logs; `worker-evidence/` holds each lookup's own evidence (screenshots and `run.jsonl`).

**The window is not closed. It is made loud.**

What happens (docs/plans/step-08.md section 6):
1. The zombie worker writes its commit intent and freezes before it clicks Submit (the
   `stall-after-intent` fault: its heartbeat stops, as every timer does in a frozen process).
2. Its lease expires. The clean worker's recovery claims the job (T6.4), reads the bank's history twice
   with the settle period between, sees `[0, 0]` (nothing happened yet), and resubmits.
3. The clean worker runs attempt 2: one transfer.
4. The zombie wakes and clicks at once. The bank has no lease to check, so it takes the click: a second
   transfer. The oracle says **DUPLICATE**. No design that clicks a legacy UI can prevent this; the zombie's
   own late result is fenced (it records nothing on the job), but its click has already gone out.
5. The job succeeded after a resubmit, so it was marked for the reconcile pass. After lease + settle + margin
   a worker re-reads the history, finds **2** transfers with the job's memo key, and moves the job to
   **`needs_human` / `duplicate_suspected`**, with the count, the first match's reference and the job's own
   `confirmationRef` in `result.reconcile`, `duplicates_detected_total` + 1 and an error-level log line.

The judge checks every step and their order from the timestamps (the verify decided `[0, 0]` before attempt
2's row, the zombie's row after it, the reconcile after both), so a run whose timing differs fails loudly
instead of passing by luck. RESULT: PASS means the duplicate happened AND it was detected.

The limits, stated plainly (docs/DECISIONS.md D50, D51):
- A zombie that stays frozen longer than the reconcile delay (60 s in production) and also beats its own
  overdue heartbeat on waking clicks after the reconcile read: that duplicate is silent until the end-of-day
  batch, `npm run reconcile -- --since 24h`, re-reads the job.
- Lookup 1.2.0 reads only the first match's Reference; the second row's id is visible in the reconcile
  lookup's screenshot, and here in `ledger.json` (the oracle), not in a job field.
- The run is deliberately the worst case (the zombie acts before its heartbeat). In chaos, the 45 s pause
  of every seed exercises the realistic case, where the heartbeat usually notices the lost lease first.
