# Evidence index

Each folder is a real, unedited run of `rote` against the mock back-office app — never hand
authored or fabricated. `run.jsonl` is the append-only, per-turn log; `step-NNN.png` are the
screenshots captured at each turn. Sensitive fields (passwords, etc.) are recorded as
`[REDACTED]` — see `src/safety/redact.ts`. All member/account data is fake seed data from
`mock-app/data.ts`, not real records.

Every entry below is one run, flat inside its own folder, with one exception:
`confidence-approval-gate/` is a *sequence* of 5 real, separately-invoked runs (numbered
subfolders, `01-`…`05-`), because the story it demonstrates — a capability earning approval over
several runs — can't be told from a single `run.jsonl`.

| Folder | Scenario | What to look for |
|---|---|---|
| [`discovery-member-lookup/`](discovery-member-lookup/) | An LLM discovery run (`npm run discover`) that explores the mock app live and compiles the result into `artifacts/member-lookup.json`. | `model_call` entries (the only kind that proves the LLM was actually driving, turn by turn) interleaved with `action`/`checkpoint` entries, ending in an `output` entry recording the discovered `savingsBalance`. |
| [`replay-success/`](replay-success/) | Deterministic replay (no LLM) of `member-lookup.json` for member `10001` — the happy path. | No `model_call` entries at all (replay never calls the LLM). A `checkpoint` entry confirming the post-login state, then a final `result: {status:"success"}` — cross-check the CLI's `savingsBalance` output against the corresponding screenshot. |
| [`replay-business-outcome/`](replay-business-outcome/) | Same replay, member `99999` (doesn't exist). | A `business_outcome` entry with `code: "NO_SUCH_MEMBER"` — a normal, recognized outcome the artifact was compiled to detect, not a crash or an `unexpected-state` failure. Ends `result: {status:"business_outcome"}`. |
| [`escalation-handoff/`](escalation-handoff/) | `operator` CLI run of `open-sub-account-confirmed.json`: replay pauses at a risky, irreversible "Confirm" step, a human takes over the *same* live browser session, resolves it, and hands back. | `blocked` (why replay paused) → `escalation_raised` (screenshot + reason at the pause point) → `escalation_resumed`, ~4 minutes later per the timestamps, with the human's own `note: "manually confirmed sub-account creation"` and distinct before/after screenshots → `result: {status:"success"}`, proving replay resumed and completed in the same session rather than restarting. |
| [`replay-tenant-b/`](replay-tenant-b/) | `replay --tenant tenant-b` of the SAME `member-lookup.json` used in `replay-success/`, against a second tenant with relabeled controls ("Find Member" instead of "Search," "Savings Balance" instead of "Current Savings Balance") — see [mock-app/README.md](../mock-app/README.md). | Two `drift` entries: `step-05 expectedStrategy: "roleName"` → `actualStrategy: "css"` (the Search button's role-based lookup failed, a css fallback caught it) and `step-06 expectedStrategy: "labelText"` → `actualStrategy: "tableCell"` (the old balance label no longer resolves). Ends `result: {status:"success"}` with the same `savingsBalance: "$4532.10"` as `replay-success/` — one base artifact, two tenants, no re-recording. |
| [`replay-hostile-tenant/`](replay-hostile-tenant/) | `replay --tenant tenant-c` of `member-lookup.json` against a deliberately hostile-DOM tenant (no ARIA roles, no `<label for>` association, no `<table>` for the balance — see [mock-app/README.md](../mock-app/README.md)). | Six `drift` entries, one per step — `step-01` through `step-05` show `expectedStrategy: "roleName"` → `actualStrategy: "textAnchor"` (every button/field lost its role/label but was still findable by its own visible text); `step-06` shows `expectedStrategy: "tableCell"` → `actualStrategy: "css"` (the balance has no table at all, so the chain bottoms out at the last-resort strategy). Ends `result: {status:"success"}` with the same `savingsBalance: "$4532.10"` as `replay-success/` — proof the ranked fallback chain, not the top strategy, is what makes replay work here. |
| [`catalog-agent-invoke/`](catalog-agent-invoke/) | `npx tsx examples/agent-demo.ts` (`npm run demo:agent`) — an agent-style caller does a real `GET /capabilities`, picks "Member Lookup" by name, then `POST /capabilities/member-lookup/invoke`s it with typed args, all over HTTP through `src/catalog/http.ts`, not a direct function call. | `demo-output.txt` is the actual terminal transcript: the capability listing, the chosen tool's `inputSchema`, then `POST .../invoke -> status 200` with the returned `ReplayResult` JSON. Cross-check it against this folder's own `run.jsonl`/screenshots — same run, same `savingsBalance: "$4532.10"`, proving the HTTP invoke drove the exact same `runReplay` path as every other entry here, not a special code path. |
| [`confidence-approval-gate/`](confidence-approval-gate/) | A real, 5-step CLI sequence against a fresh throwaway capability (`confidence-demo`, deleted after curation — see Provenance): refused unattended while in `draft`, three `--approve-unattended` runs that auto-promote it, then a final run with **no** flag at all. | `01-refused-draft/run.jsonl` has only a `blocked` entry + `result: {status:"needs_human"}` and **no screenshots** — proof the gate refuses before any browser launches. `sequence-output.txt` shows all 5 real commands and their output side by side, including `status/confidence-demo.json`'s content right after run 3, `approvalStatus: "approved"`. `05-approved-unattended/` then succeeds with no `--approve-unattended` flag — the contrast with step 1 is the whole point. |

## Provenance

- `discovery-member-lookup/` is one of the exact 3 folders in the project's history that contain a
  `model_call` log entry — the only artifact only a genuine LLM-driven discovery run produces —
  confirming it was never generated by an automated test.
- `escalation-handoff/` is a genuine manual `operator` run: `escalation_raised` and
  `escalation_resumed` are ~4 minutes apart, consistent with a person actually operating the
  browser, not the millisecond-scale automated escalation tests.
- `replay-success/`, `replay-business-outcome/`, and `replay-hostile-tenant/` were each generated
  fresh via direct CLI invocation (`npx tsx src/cli/index.ts replay ...`) specifically for their
  curation pass, so their provenance is unambiguous.
- `replay-tenant-b/` is a real `--tenant tenant-b` CLI run (found already sitting in the working
  tree, not freshly generated for this pass) — confirmed genuine by its `drift` entries matching
  tenant-b's own fingerprint exactly (`step-05 roleName→css`, `step-06 labelText→tableCell`; no
  other tenant produces that pair — tenant-c's hostile run produces six drift entries with
  different strategy pairs, not two), rather than fabricated to fill the gap.
- Every other historical `replay` evidence folder was indistinguishable from a `vitest` test run
  (both write through the same code path) or a redundant duplicate of an already-curated
  scenario, and was deleted rather than risk mislabeling test/duplicate output as a demo
  artifact. This includes a second pass: 5 more raw `member-lookup-<timestamp>-<hash>/` folders
  (one entirely empty, from a crashed run) accumulated as manual-verification byproducts while
  building the catalog and confidence-gate features and were removed the same way, for the same
  reason.
- As of this curation, `vitest` runs can no longer write into this directory at all —
  `defaultEvidenceBaseDir()` (`src/evidence/recorder.ts`) routes test runs to the OS temp
  directory instead, detected via Vitest's own `process.env.VITEST` flag. Only real
  `discover`/`replay`/`operator` CLI invocations write here going forward.
- `catalog-agent-invoke/` was generated by running the exact command in its own Scenario cell
  (`npx tsx examples/agent-demo.ts`) and capturing its real stdout verbatim as `demo-output.txt` —
  the transcript is what proves the run came from the HTTP catalog surface rather than a plain
  CLI replay, since `run.jsonl`'s content alone can't tell the two apart.
- `confidence-approval-gate/` was generated against a throwaway capability id (`confidence-demo`,
  a copy of `member-lookup.json` with the id changed) specifically so this curation pass would
  never touch the real, already-approved `status/member-lookup.json`. All 5 runs are real
  `npx tsx src/cli/index.ts replay ...` invocations, captured in invocation order into
  `sequence-output.txt`; `04-promotion-run-3/` is genuinely where auto-promotion fires (verified
  by reading `status/confidence-demo.json` back mid-sequence, also in the transcript). The
  throwaway artifact file and its `status/confidence-demo.json` were deleted after curation — the
  evidence folder is the permanent record, not a live capability in the catalog.
