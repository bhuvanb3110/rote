# Step 12 — dependency upgrades (npm audit), as their own reviewed step

Branch `chore/deps-2026-11`, from `main` at `0fa700f` (PR #1 merged). Reads `CLAUDE.md`, `docs/REPO_NOTES.md`
and `docs/DECISIONS.md`. CLAUDE.md's rule "Don't run `npm audit fix`. Dependency upgrades get their own
reviewed step" is why this step exists. Nothing here runs `npm audit fix`, with or without `--force`.

## 1. Inventory (before any change, 2026-11-19)

Raw outputs, committed with this plan: `evidence/step-12/audit-before.json` (`npm audit --json`),
`audit-before.txt`, `outdated-before.txt` (`npm outdated`) and `npm-ls-before.txt` (`npm ls --all`).

`npm audit`: **8 findings: 1 critical, 4 high, 3 moderate.** npm marks every one `fixAvailable: true`, and none
needs a major bump. Each fixed version is inside the range already declared by its parent.

| # | Package (installed) | Dependency path | Severity | Advisory | Runtime or dev | Fixed in | Major bump of a direct dep? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `proxy-addr` 2.0.7 | `express@5.2.1` → `proxy-addr` | **critical** | GHSA-jqcg-44mw-7w3h: IP spoofing via an IPv4-mapped IPv6 trust subnet | **runtime** (api, bank) | 2.0.8 | No. Express 5.2.1 asks for `^2.0.7` |
| 2 | `body-parser` 2.3.0 | `express@5.2.1` → `body-parser` | high | GHSA-27r3-jxmh-p828: DoS via trailing bytes after a compressed request body | **runtime** (`express.json()` in the api, `express.urlencoded()` in the bank and escalation console) | 2.4.0 | No. Express 5.2.1 asks for `^2.2.1` |
| 3 | `zod` 4.4.3 | direct (also `@anthropic-ai/sdk` → peer `zod ^3.25 \|\| ^4`, deduped) | high | GHSA-mrhx-c7xc-m3w5: memory exhaustion validating oversized constrained collections | **runtime** (every schema: artifacts, queue rows, API bodies) | 4.6.6 | No. `^4.4.3` already allows 4.6.7 |
| 4 | `vite` 8.2.1 | `vitest@4.1.10` → `vite` (and `@vitest/mocker` → `vite`) | high | six advisories: GHSA-587h-7wmj-h5pm (high), GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg (moderate), GHSA-9jrq-w75r-8gcw (low): launch-editor and dev-server `fs` issues | dev | 8.2.4 | No. vitest asks for `^6 \|\| ^7 \|\| ^8` |
| 5 | `source-map-js` 1.2.1 | `vitest` → `vite` → `postcss@8.5.26` → `source-map-js` | high | GHSA-68fv-2mgg-jv7q: event-loop DoS via indexed source-map section offsets | dev | 1.2.2 | No. postcss asks for `^1.2.1` |
| 6 | `qs` 6.16.0 | `express@5.2.1` → `qs`, and `express` → `body-parser` → `qs` (deduped) | moderate | GHSA-6pq8-jhm2-2vcw: `qs.stringify` with `arrayFormat: 'comma'` throws on a non-callable `toString` (DoS) | **runtime** | 6.16.1 | No. Express asks for `^6.14.0` |
| 7 | `vitest` 4.1.10 | direct (dev) | moderate | GHSA-82fw-gwwq-j7x9 (through `@vitest/mocker`) | dev | 4.1.11 (4.1.12 for #8) | No. `^4.1.10` already allows 4.1.12 |
| 8 | `@vitest/mocker` 4.1.10 | `vitest` → `@vitest/mocker` | moderate | GHSA-82fw-gwwq-j7x9 (redirect-mock path traversal), GHSA-qxg6-89mg-rqv8 (code injection via manual mock registration) | dev | 4.1.12 | No. Pinned exactly by vitest, which moves with it |

How exposed this repo is today (none of this lowers the priority, since everything gets fixed):
- `proxy-addr` matters only with Express's `trust proxy` setting, which the repo never sets (grep: no match).
- body-parser's compressed-body DoS reaches the api's `express.json()`, which inflates by default. The api is
  bound to 127.0.0.1.
- The repo never calls `qs.stringify`. Express uses `qs.parse`.
- The vite and vitest advisories concern the dev server and mocking, which only the test runner uses.

`npm outdated` (beyond the findings):

| Package | Current | Wanted (in range) | Latest | Runtime or dev |
| --- | --- | --- | --- | --- |
| `@anthropic-ai/sdk` | 0.116.0 | 0.116.0 | **1.10.0 (major)** | runtime (discovery agent) |
| `@types/node` | 26.2.0 | 26.6.6 | 26.6.6 | dev |
| `commander` | 15.0.0 | 15.1.0 | 15.1.0 | runtime (CLI) |
| `dotenv` | 17.4.2 | 17.4.2 | **18.0.10 (major)** | runtime |
| `express` | 5.2.1 | 5.3.0 | 5.3.0 | runtime |
| `fast-check` | 4.10.2 | 4.10.3 | 4.10.3 | dev |
| `pino` | 10.3.1 | 10.4.0 | 10.4.0 | runtime |
| `playwright` | 1.62.1 | **1.65.1** | 1.65.1 | runtime, and it pins the worker image and the browser build |
| `tsx` | 4.23.12 | 4.23.15 | 4.23.15 | dev |
| `vitest` | 4.1.10 | 4.1.12 | 4.1.12 | dev |
| `zod` | 4.4.3 | 4.6.7 | 4.6.7 | runtime |

**`playwright`'s "Wanted" is 1.65.1.** `^1.62.1` allows it, so a plain `npm update` would move Playwright, which
the stop rule forbids without approval. This step therefore never runs a bare `npm update`. Every change
names its packages.

## 2. The stop rule, applied

No major bump is needed to clear the audit. No needed bump touches the Playwright version. So the stop rule
("a needed major on runtime code, or any Playwright change → stop after the plan") is **not triggered**, and
the groups in section 3 proceed. What the rule would have caught, and what else stays out, is in section 4.
None of it is applied without the reviewer's approval.

## 3. The upgrade plan: in-range patch/minor bumps, one commit per group

**One resolution rule for every group: a 7-day cooling-off.** Every command runs with
`--before=2026-11-12`, so npm never picks a version published in the last 7 days. Two reasons:
- `source-map-js` 1.2.3 and 1.2.4 were published on 2026-11-18 and 2026-11-19. The fix is in 1.2.2
  (2026-09-30).
- zod's 4.6.6 release note reports six malicious commits pushed to its `main` with a stolen credential in
  September. They were reverted and never published, but a version a few days old has had no time to be noticed.

The cutoff costs nothing the audit needs (every fixed version predates it). It leaves out `fast-check` 4.10.3
(2026-11-18). That is a dev patch nobody needs, and it stays at 4.10.2.

Each group: run the commands, `npm ls` for the touched packages, `npm run typecheck`, then a full `npm test`
(Postgres up, no fleet). The log goes to `evidence/step-12/group-N-npm-test.txt`. Commit only on green.

### Group 1 — the test runner (dev only; findings 4, 5, 7, 8)

`npm install --save-dev vitest@4.1.12 --before=2026-11-12`, then
`npm update vite postcss source-map-js --before=2026-11-12`.
Result: vitest/`@vitest/*` 4.1.12, vite 8.3.8, source-map-js 1.2.2. The devDependency floor moves to
`^4.1.12`.

Release notes read:
- **vitest 4.1.11:** "revive global concurrency limit for test lifecycle". This touches the scheduling that D31
  and D48 rely on: three projects, group 1's pool of 3, and the longest-first `vitest.sequencer.ts`.
- **vitest 4.1.11 and 4.1.12:** hardened manual and redirect mocks. The repo has no `vi.mock`/`vi.doMock` (grep:
  no match).
- **vite 8.3:** a build preload optimisation, a CRLF fix in code frames, `node_modules` segment matching. None
  of it is an API change.
- **source-map-js 1.2.2:** the DoS fix and a CSP fix.

Could touch here: the suite's wall time and the file order in group 1 (watched against Step 11's 190–205 s);
the coverage-count prints (they write to stdout directly, D60). Risk: low.

### Group 2 — Express's transitive dependencies (runtime; findings 1, 2, 6)

`npm update body-parser proxy-addr qs --before=2026-11-12`. **express itself stays 5.2.1** (section 4).
Result: body-parser 2.4.0, proxy-addr 2.0.8, qs 6.17.1. `package.json` does not change, only the lockfile.

Release notes read:
- **body-parser 2.4.0:** the security fix, zstd decoding support, "avoid mutating read options", JSON parse
  perf. The 2.3.0 fix that is already installed makes an invalid `limit` throw at init. The repo passes no
  `limit` (grep: no match).
- **proxy-addr 2.0.8:** the CVE fix only.
- **qs 6.16.1–6.17.1:** parse fixes:
  - `__proto__` copied as data, and bracket-wrapped prototype keys guarded at depth 0;
  - percent-encoded dots decoded case-insensitively;
  - comma and `arrayLimit` edge cases;
  - a new WHATWG `stringify` format.

Could touch here: `express.urlencoded({ extended: true })` in the mock bank (`mock-app/app.ts:325`) and the
escalation console (`src/escalation/console.ts:77`); `express.json()` in the api (`src/catalog/http.ts:242`).
The forms post plain scalar fields (memberId, amount, memo, account), so none of the changed qs paths applies.
The mock-app, catalog/API, escalation and transfer browser tests cover all three. Risk: low.

### Group 3 — zod (runtime; finding 3)

`npm install zod@4.6.7 --before=2026-11-12`. The floor moves to `^4.6.7`, so a fresh resolve can never land on
a vulnerable 4.x again.

Release notes read:
- **4.5:**
  - `z.compile()` (opt-in, unused here);
  - `z.validate()`;
  - a 9× smaller schema memory footprint (internal restructuring);
  - new locales;
  - an out-of-memory regression in recursive schemas, fixed in 4.6.
- **4.6:** `.validate()`, `z.properties()`; `fromJSONSchema()` enforces six more keywords (unused here); faster
  CommonJS.
- **4.6.6:** the security fix (size bounds checked before the elements), plus "declare record output and input
  as members, not base type arguments", a type-level change to `z.record`.
- **4.6.7:** a re-publish.

Could touch here:
- **`z.record`:** used in `src/artifact/replayResult.ts`, `src/queue/types.ts`, `src/tenant/types.ts` and
  `src/confidence/types.ts`. `npm run typecheck` will show any inferred-type change.
- **`z.prettifyError` text:** used in `serialize.ts`, `invoke.ts`, `enqueue.ts`, `tenant/types.ts`,
  `confidence/types.ts` and `discover.ts`. Tests that match error text would see a wording change.
- **`z.toJSONSchema`:** used in `src/catalog/schema.ts`. `catalog.test.ts` checks `required` and `properties`.
- **The D24 approval digests.** These are SHA-256 of the canonical artifact JSON *after* schema validation. If
  zod 4.6 parsed the same file into a different object (a default added, key order changed), every approval
  would be refused. `committedApprovals.test.ts` guards exactly this.
- **The worker's param-error field list:** `parsed.error.issues` paths in `src/worker/runJob.ts:97`.

Risk: medium, because zod runs on every boundary. It is covered by the suite, and section 5 adds a chaos run
on the rebuilt image.

### Group 4 — the in-range refresh, dev only (not in the audit)

`npm install --save-dev tsx@4.23.15 @types/node@26.6.6 --before=2026-11-12`. Notes read:
- **tsx 4.23.13–15:** the transform cache's memory is bounded; CJS-bridge and namespace fixes.
- **@types/node 26.6:** type additions; `npm run typecheck` is the check.

Risk: low.

### Group 5 — the in-range refresh, runtime minors (not in the audit)

`npm install commander@15.1.0 pino@10.4.0 --before=2026-11-12`. Notes read:
- **commander 15.1.0:** parsing fixes (an uppercase `E` exponent in negative numbers, Unicode variadic
  placeholders, help groups, global option sources); deprecates `storeOptionsAsProperties()` and
  `combineFlagAndOptionalValue()`. The repo uses neither (grep: no match).
- **pino 10.4.0:**
  - "escape child binding keys";
  - "build the redaction shape without Object.prototype";
  - log objects with an own `__proto__` key;
  - multistream fixes;
  - a named `default` export.

Could touch here: the redaction tests (`src/worker/credentials.ts`'s redactor and the evidence redaction), and
the chaos/matrix log parsers that read worker log lines ("reconcile: ABANDONED", fault-point lines).
Risk: low. The chaos run in section 5 reads real worker logs from the rebuilt image.

Groups 4 and 5 are not needed by the audit. They go in because CLAUDE.md gives dependency upgrades their own
step, and a later step would otherwise inherit an outdated in-range set. If the reviewer prefers an audit-only
PR, they are the two commits to drop.

## 4. Not applied: needs the reviewer

| Bump | Kind | Why it is held |
| --- | --- | --- |
| `playwright` 1.62.1 → 1.65.1 | in range (minor), **runtime** | **Stop rule.** Changes the browser build (Chromium → 158.0.8127.18), the base image `mcr.microsoft.com/playwright:v1.65.1-noble` (`Dockerfile` `ARG PLAYWRIGHT_VERSION`, re-checked by the worker at startup, D28), and CI's `npx playwright install`. Release notes: 1.64 forwards `screen` from device descriptors (breaking only with `devices[...]`, which the repo does not use), encodes videos with VP9, and moves the cursor overlay; 1.65 loads CSS imports in test files as empty modules. Screenshots are evidence, and the screenshot-retry fix (D8) is tuned to Chromium's behaviour, so it needs its own step with a fresh crash matrix and chaos run on the new image. |
| `express` 5.2.1 → 5.3.0 | in range (minor), runtime | Not needed: 5.2.1's ranges already accept every fixed transitive. **Redaction risk:** 5.3.0's default error handler logs the *full error object* instead of the stack. The repo has no error handler of its own, and body-parser's parse errors carry the raw request `body`. A malformed POST to the api would then log its body (job params). Also: `content-type` 2 (`res.send` keeps existing parameters and no longer throws on an unparseable type), unquoted `Content-Disposition` names (unused here), HTML in `res.redirect()` bodies (the bank redirects; tests read the target, not the body). Proposed: a later step adds an explicit, redacting JSON error handler to the api, bank and console first, then bumps. |
| `@anthropic-ai/sdk` 0.116 → 1.10 | **major**, runtime | Not needed by the audit. Discovery's agent loop (`src/agent/`) is the only user. A 1.0 major needs its migration notes read against `discover.ts`, and discovery needs an API key to exercise, which this repo's tests do not have. |
| `dotenv` 17 → 18 | **major**, runtime | Not needed. Loaded once by the CLI and the worker; its own reviewed step. |
| `fast-check` 4.10.2 → 4.10.3 | patch, dev | Published 2026-11-18, inside the 7-day cooling-off. Nothing needs it. |

## 5. Proof after the upgrades (`evidence/step-12/`)

All on the final commit, with the fleet down for the test runs. Never the suite with a fleet up.

1. **`npm ci` from scratch:** delete `node_modules`, `npm ci`, `npx playwright --version` (must still say
   1.62.1). Log: `npm-ci-clean.txt`.
2. **`npm test` ×3**, back to back, unfiltered (`scripts/npm-test-log.ps1`): `npm-test-1.txt` … `-3.txt`.
3. **`npm run typecheck`**: `typecheck.txt`.
4. **The crash matrix at 5/2** (CI's command: `--lease-seconds 5 --heartbeat-seconds 2 --expect step-10
   --reconcile-margin-seconds 5 --drain-timeout 90s --out evidence/step-12/crash-matrix`). Expect **23/23**.
5. **`npm run mutation-check -- --out evidence/step-12/mutation-check`**. Expect **12/12**. Not the default
   folder, which would delete `evidence/mutation-check/ci-linux/`.
6. **One standard chaos run** after `docker compose up -d --build` (the image rebuilt with the new runtime
   dependencies): `npm run chaos -- --seed <n>`, 100 jobs, `--out evidence/step-12/chaos-seed-<n>`. The oracle
   must pass (0 DUPLICATE, 0 LOST). The harness stops the stack at the end. The image's `npm ls` for the
   bumped runtime packages is recorded from inside a container (`image-versions.txt`).
7. **`npm audit` afterwards:** `audit-after.json` / `audit-after.txt`. Expect 0. Any remaining finding is listed
   with why it cannot be fixed yet.

`evidence/step-12/README.md` indexes it all. Then the D-entry (D61), the REPO_NOTES section, the push, and the
PR `chore: dependency upgrades (npm audit)` into `main`, not merged. Then `docs/plans/step-13.md` (Day 3,
observability; plan only).

## Built (2026-11-19)

| Commit | What |
| --- | --- |
| `5b3fc7e` | this plan and the before-state (`audit-before.*`, `outdated-before.txt`, `npm-ls-before.txt`) |
| `20129a1` | group 1: vitest 4.1.12, vite 8.3.8, source-map-js 1.2.2 (dev); 723/723 |
| `836d798` | group 2: proxy-addr 2.0.8, body-parser 2.4.0, qs 6.17.1 (runtime, express unchanged); 723/723 |
| `b1f2825` | group 3: zod 4.6.7 (runtime); `npm audit` 0; 723/723 |
| `28d21b7` | group 4: tsx 4.23.15, @types/node 26.6.6 (dev); 723/723 |
| `4401c7d` | group 5: commander 15.1.0, pino 10.4.0 (runtime); 723/723 |
| `25ca3d0` | not planned: `.gitattributes` keeps `scripts/mutations/*.patch` LF (D54 amendment); 723/723 |
| `299113c` | the proof (section 5), `evidence/step-12/README.md` |
| (docs) | D61, the D54 amendment, REPO_NOTES "Fleet Step 12", this section, `docs/plans/step-13.md` |

Every group went as planned. The stop rule never fired, and the 7-day cutoff picked exactly the versions in
section 3. Two things were not in the plan:
1. **The first mutation check failed, 11/12.** Mutant 03 was a `STALE PATCH`: the CRLF working-tree copy of a
   patch with a bare empty context line (D54 amendment). The upgrades did not cause it. It was fixed in
   `25ca3d0`, the re-run is 12/12, and the failed run is kept.
2. **This machine's `.env` has no worker credentials.** The chaos run used `.env.example`'s fake values
   from the process environment, and `.env` was not changed.

Results (section 5):
- `npm ci` clean;
- `npm test` ×3: 723/723 each;
- typecheck: exit 0;
- the matrix: 23/23;
- mutants: 12/12;
- chaos seed 412432443: PASS, 0 DUPLICATE, 0 LOST;
- `npm audit`: **0**.
