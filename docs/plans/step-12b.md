# Step 12b — the held upgrades: a redacting error handler, Express 5.3, Playwright 1.65.1

Branch `chore/deps-held-2026-11`, from `main` at `1195371` (PR #2 merged). Reads `CLAUDE.md`, `docs/REPO_NOTES.md`,
`docs/DECISIONS.md` (D61), `docs/plans/step-12.md` section 4 (the held items) and `docs/plans/step-13.md`. The
reviewer approved Step 12 (groups 4–5 kept) and Step 13's plan. Their answers to Step 13's section 10 are recorded
at the end of `step-13.md` (commit `74f3905`).

D61 applies to every change: named packages only, never `npm audit fix`, one commit per item after a full
`npm test`, and the 7-day cooling-off. **Today is 2026-11-19, so every resolution runs with
`--before=2026-11-12`.**

## 0. Publish dates (`npm view <pkg> time`), against the cutoff

| Package | Wanted | Published | Past the cooling-off? |
| --- | --- | --- | --- |
| `express` | 5.3.0 | 2026-10-09 | yes |
| `playwright`, `playwright-core` | 1.65.1 | 2026-11-13 21:15 / 21:36 UTC | **no: 7 days old on 2026-11-20 21:36 UTC; under the date-only `--before`, from 2026-11-21** |
| `fast-check` | 4.10.3 | 2026-11-18 | **no, not until 2026-11-25** |
| `@anthropic-ai/sdk` | 1.10.0 (1.11.0 is from today) | 2026-11-17 | major, not bumped |
| `dotenv` | 18.0.10 | 2026-11-09 | major, not bumped |

**Playwright 1.65.1 is inside the cooling-off.** Under the rule, `--before` resolves 1.65.0 (2026-11-05). 1.65.1 only
fixes two test-runner bugs; this repo uses the `playwright` library, not `@playwright/test`. But it moves Chromium
158 → 159. Taking 1.65.0 now and 1.65.1 later would mean running the browser proof twice. **The reviewer's
decision (2026-11-19): wait for 1.65.1.** Items 1–3, 5 and 6 are done now. Then the branch is pushed as a backup,
with no PR. Item 4 runs on **2026-11-21 or later**. D61's `--before=<today − 7 days>` is a date, so on 2026-11-20
it would be `2026-11-13` (midnight), which still excludes 1.65.1. On 2026-11-21 it is `--before=2026-11-14`, which
resolves 1.65.1 and nothing newer (1.66 is still alpha). The PR opens after item 4.

## 1. Local `.env` (not committed)

A small Node script appends to `.env` only the `ROTE_CRED_*` lines from `.env.example` whose keys `.env` does not
already have. It prints only the key names it appended. No other line is changed or printed, and `.env` stays
ignored by git. This closes REPO_NOTES's "This machine's `.env` has no `ROTE_CRED_*`" note.

## 2. A redacting error handler, before any Express bump (D62)

**Why first:** Express 5.3.0's default error handler logs the *full error object*. body-parser attaches the raw
request body to its parse errors (`err.body`). V8's `JSON.parse` message also quotes the start of the input. None of
the three apps has an error handler of its own today, so a malformed POST would log its body.

`src/http/errorHandler.ts`, one module used by all three apps:
- **`requestId()`** (the first middleware): reuses an incoming `X-Request-Id` when it is 1–64 characters of
  `[A-Za-z0-9._-]`, or makes a UUID. It is echoed back in an `X-Request-Id` response header.
- **`redactingErrorHandler({ format, log })`** (the last middleware):
  - **It logs one safe summary:** `name` (`err.name`, only if it is a plain identifier), `code` (`err.code`, or
    body-parser's `err.type`, only if it matches `[A-Za-z0-9_.:-]{1,64}`), `status`, `method`, `route` and
    `requestId`.
    - `route` is the matched route's pattern (e.g. `/jobs/:id`). It is never the concrete path, which can carry
      an id.
      - Inside a mounted router (the bank's `/tenant-b`) it is the router-relative pattern (`/login`): Express
        has restored `baseUrl` by the time the error reaches the app-level handler.
      - A body-parser error happens before routing, so it logs `(no route)`.
  - **It never logs** the error's message or stack, `err.body`, the request body, query, headers or cookies.
  - **It responds** with the status (4xx kept, anything else 500) and the generic text from
    `http.STATUS_CODES`, plus the request id. The api gets JSON (`{ error, requestId }`). The bank and console get a
    minimal HTML page. If headers were already sent, it destroys the socket and does not call `next(err)`. Express's
    default handler is never reached.
  - **Where `log` goes:** the api and console are given the CLI's pino logger. The mock bank, a module-level app,
    uses the default: one JSON line on stderr.

Wired in `createCatalogApp`, `createOperatorConsole` and `mock-app/app.ts`, with new optional options only. Every
existing call site is unchanged.

**Tests** (`src/http/errorHandler.test.ts`):
- **The api:** a malformed JSON body carrying a fake credential, sent in a header and a cookie too.
- **The bank and the console:** a malformed urlencoded body (nesting deeper than body-parser's `depth`, which is a
  parse error that carries the raw body) with the credential. Also a JSON body to the console's `/hand-back`, which
  has no JSON parser, so the route throws.
- **A route that throws an Error whose message contains the credential.**
- **What every case asserts:**
  - the credential is in no log line and in no response (body or headers);
  - the summary has the expected status, code and route;
  - stdout, stderr and `console.*` are captured, so nothing else logged it either.
- **The capture is proven able to fail:** a control app with Express's default handler, run under a non-`test`
  env, gets the same body, and the test asserts the credential **does** appear in what it logged. The app's `env`
  is set to `development` in every case, because Express's default handler is silent under `NODE_ENV=test`, which
  would hide a leak.

## 3. `express` 5.3.0 (after item 2 is green)

`npm install express@5.3.0 --before=2026-11-12`. Its new ranges (`content-type` 2, `content-disposition` 2,
`type-is` 2.1, `qs ^6.16`, `body-parser ^2.3`, `proxy-addr ^2.0.8`) resolve under the same cutoff. The lockfile diff
goes to `evidence/step-12b/item-3-lockdiff.txt`.

5.3.0's notes, read against this repo:
- **The default handler logs the full error:** neutralised by item 2. The tests run on 5.3.0 too.
- **`res.send` keeps existing Content-Type parameters and no longer throws on an unparseable type:** the repo sets
  types with `res.type()` / `res.json()` only.
- **`res.redirect()` HTML body:** the bank redirects. Tests read `Location`, not the body.
- **Unquoted `Content-Disposition` names:** unused.
- **QUERY freshness:** unused.
- **`Content-Length` with `Transfer-Encoding`:** the repo sets neither header itself.

Risk: low.

## 4. `playwright` 1.65.1 (on or after 2026-11-21)

Changed together:
- `npm install playwright@1.65.1 --before=<today − 7 days>`, with the floor moved to `^1.65.1`;
- the `Dockerfile`'s `ARG PLAYWRIGHT_VERSION` (base `mcr.microsoft.com/playwright:v1.65.1-noble`);
- the Day-1 exit script's base-image line (`scripts/evidence-day1-exit.ts`);
- the unit test's example version;
- CI: `npx playwright install --with-deps chromium` already follows the lockfile. A new check step fails if the
  lockfile's Playwright differs from the `Dockerfile`'s `PLAYWRIGHT_VERSION`;
- the REPO_NOTES pin notes.

**Release notes 1.63–1.65.1:** anything that could touch locators, screenshots, `ariaSnapshot`, or context and
browser lifecycle. Each item is checked against the code (grep):

| Version | Change | Could touch here |
| --- | --- | --- |
| 1.63 | `locator.visible()`; `frameLocator()` with no selector; `ariaSnapshotJSON()`; `dialogclosed` events; aria and screen snapshots in traces | new APIs only |
| 1.63 | `npx playwright install` removes other installs' browsers unless `--no-remove` | a local dev machine's 1.62 Chromium is removed on install |
| 1.63 | Ubuntu 20.04 unsupported | CI is `ubuntu-24.04`, the image is `noble` |
| 1.64 | `screen` forwarded from device descriptors | the repo uses no `devices[...]` |
| 1.64 | elements inside hidden iframes count as hidden | the mock bank has no iframes |
| 1.64 | VP9 videos, cursor overlay | no video recording |
| 1.64.1 | Chromium 155+ aborted a preflighted cross-origin redirect whenever any route is registered | the repo registers no `page.route` |
| 1.65 | **actions wait for the element to be not `inert`** | locators/actions: no `inert` in `mock-app/` |
| 1.65 | **text the browser does not render is no longer part of accessible names and aria snapshots** | **`roleName` locators** (`getByRole` with a name) and `ariaSnapshot`, if the repo uses it (grep) |
| 1.65 | cookie matching follows RFC 6265 (`context.cookies(url)`) | the tenants' cookies, if any code reads them by URL (grep) |
| 1.65 | proxy credentials only answer proxy challenges | no proxy |
| 1.65 | Docker images ship **Node 26** instead of 24 | **the worker image's Node** (`engines >=22`; CI runs 22 and 25); recorded from inside the image |
| 1.65.1 | test-runner fixes only; **Chromium 159.0.8154.6** | the browser build: screenshots (D8's retry), timing |

**The proof, all on the new browser** (`evidence/step-12b/`), fleet down for every test run:
- `npm test` ×3;
- typecheck;
- the crash matrix at 5/2 (`--expect step-10`, expect 23/23);
- `npm run mutation-check -- --out evidence/step-12b/mutation-check` (expect 12/12);
- one standard chaos seed on the rebuilt image (oracle PASS, 0 DUPLICATE, 0 LOST), with `node --version` and
  `npm ls playwright` from inside a container.

**Screenshot retries:** the suite doesn't log `screenshotRetries` today. So the three runs' logs are searched for
retry traces, and the chaos run's worker logs for the D8 retry line. Any count that is noticeably different from
Step 12's is reported.

## 5. `fast-check` 4.10.3

Published 2026-11-18, inside the cooling-off until 2026-11-25. **Still held**, and nothing needs it. If item 4
runs after 2026-11-25, it is taken then as its own commit. Otherwise it waits for a later step.

## 6. The majors, not bumped: a plan for a later step

**`@anthropic-ai/sdk` 0.116 → 1.x.** 1.0.0 switches the API version from `2023-06-01` to `2026-10-21`. Migration
guide: <https://platform.claude.com/docs/en/api/migration-2026-10-21>. Discovery (`src/agent/discover.ts`,
`tools.ts`) is its only user. Checked against the guide:
- **Sampling parameters removed (`temperature`/`top_p`/`top_k` → 400):** discovery sets none. Not affected.
- **`document` blocks in assistant turns, `citations` on user text → 400:** discovery sends only text, image,
  `tool_use` and `tool_result` blocks. Not affected.
- **Admin / Analytics API field renames:** not called. Not affected.
- **`MessageParam` becomes a union of per-role types:** discovery builds `Anthropic.MessageParam[]` from literals
  that name their role (`{ role: "user", … }`, `{ role: "assistant", content: response.content }`). Per the guide
  these type-check as before. `npm run typecheck` is the check.
- **The API key goes out as `Authorization: Bearer`; a client holds one credential:** discovery passes only
  `apiKey` and uses no proxy. Not affected.
- **Text Completions removed; `betas` removed from the non-beta Models methods:** unused.
- **The license changes MIT → Apache 2.0.** No code change; noted for the dependency-license record.
- **Not the SDK, but adjacent:** `DEFAULT_MODEL` is `claude-opus-5` with `tool_choice: { type: "any" }`. Forced tool
  choice returns a 400 on Claude Opus 5.5 and later models. That is a model migration, separate from the SDK major.
  It matters only if `ANTHROPIC_MODEL` is pointed at a newer model.
- **Verdict:** discovery should need no code change. But no test exercises it, because it needs an API key and a
  live, billed call. The later step: the bump under the cooling-off, a typecheck, then one live discovery run of
  the read-only `member-lookup` goal with the reviewer's approval of the cost, kept as evidence.

**`dotenv` 17 → 18.** Loaded by `import "dotenv/config"` in the CLI (which runs discovery: it is how
`ANTHROPIC_API_KEY` comes from `.env`), `scripts/chaos.ts` and `scripts/evidence-day1-exit.ts`. The worker and the
image don't load it (Compose passes the environment).
- **18.0.0:**
  - the "injected env" message moves from stdout to stderr;
  - preloading (`node -r dotenv/config`) is removed, in favour of a new `dotenv run` CLI;
  - `.env.vault` support is removed;
  - an opt-in fast parser.
- **18.0.4:** `dotenv/config` defaults to `quiet: true`.
- **Here:** no `-r dotenv/config` and no `.env.vault` (grep).
  - `import "dotenv/config"` still exists and behaves the same, apart from the message.
  - Discovery is affected only in that the key keeps loading the same way, which the later step checks with
    `catalog list` / one `discover` run.
  - The stdout change *helps* anything that parses the CLI's stdout, such as `catalog list`'s JSON: 17 prints
    "◇ injected env (N) from .env" on stdout.
- **The later step:** the bump, then the chaos and Day-1 scripts, which load it, plus a check that `catalog list`'s
  stdout is pure JSON.

## 7. Evidence and docs

- **`evidence/step-12b/`:**
  - `audit-before.txt` and `outdated-before.txt`;
  - the per-item `npm test` logs and typecheck;
  - `item-3-lockdiff.txt`;
  - after item 4: its lockdiff and every proof output;
  - `audit-after.*` (must be 0);
  - a README.
- **D62** (the error handler). **A D61 amendment:** what a reviewer-named version inside the cooling-off does (it
  waits, the rest proceeds), and the held list now.
- **REPO_NOTES** "Fleet Step 12b".
- **After item 4:** the PR `chore: held upgrades: redacting error handler, express 5.3, playwright 1.65` into
  `main`, not merged, with its four required checks reported.

## Built so far (2026-11-19)

| Commit | What |
| --- | --- |
| `74f3905` | `step-13.md`: the reviewer's decisions on its section 10 |
| `4d0cef9` | this plan; `audit-before.txt`, `outdated-before.txt` |
| (none) | item 1: `.env` gained the six fake `ROTE_CRED_*` keys (not committed; git-ignored) |
| `8085e5f` | item 2: `src/http/errorHandler.ts` in all three apps, 14 tests, D62; 737/737 |
| `c38de78` | item 3: express 5.3.0; 737/737; the built bank's smoke check |
| (docs) | the D61 amendment, REPO_NOTES "Fleet Step 12b" (in progress), `evidence/step-12b/README.md`, this section |

- **Item 5:** fast-check 4.10.3 is still held, until 2026-11-25. Nothing needs it.
- **Item 6:** section 6 is the written plan for the majors. Nothing was bumped.
- **Item 4 waits for 2026-11-21.** The branch is pushed as a backup, with no PR until then.
- **Off-plan:** in item 2, the route of an error inside a mounted router turned out to be router-relative
  (`/tenant-b/login` logs `/login`), because Express restores `baseUrl` before the app-level handler runs. That is
  documented, not worked around.
