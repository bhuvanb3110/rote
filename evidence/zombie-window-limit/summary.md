# The zombie window, measured and made loud: 2026-11-14T16:21:59.599Z

- one job; lease 5 s / heartbeat 2 s; settle 5000 ms; reconcile delay 5 + 5 + 10 = 20 s
- the zombie: ROTE_FAULT=stall-after-intent, a 30 s stall right after its commit intent with its heartbeat suspended (a process freeze's worst case: it clicks the moment it wakes)

| Event | Time (from the zombie's intent) |
| --- | --- |
| the zombie writes its commit intent and freezes | +0.0 s |
| verify decided resubmitted | +14.3 s |
| attempt 2's row written | +16.0 s |
| the zombie's row written | +30.1 s |
| the reconcile started (its lookup reads after this) | +36.5 s |
| the reconcile decided duplicate_suspected [2] | +37.6 s |

Final job: needs_human / duplicate_suspected; result.reconcile {"lookups":[2],"matches":2,"decision":"duplicate_suspected","phaseToken":4,"evidenceRef":"evidence://C:/Users/hp/Downloads/rote/evidence/zombie-window-limit/worker-evidence/transfer-history-lookup-2026-11-14T16-22-39-894Z-a2145536/run.jsonl","evidenceRefs":["evidence://C:/Users/hp/Downloads/rote/evidence/zombie-window-limit/worker-evidence/transfer-history-lookup-2026-11-14T16-22-39-894Z-a2145536/run.jsonl"],"firstMatchRef":"TXN-000001","jobConfirmationRef":"TXN-000001"}; ledger rows TXN-000001, TXN-000002; oracle DUPLICATE; duplicates_detected_total 1.

RESULT: PASS (the duplicate happened, and it was detected)
