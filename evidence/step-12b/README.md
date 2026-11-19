# Step 12b evidence: the held upgrades

The plan is `docs/plans/step-12b.md`; the decisions are D61 (amendment) and D62. Branch `chore/deps-held-2026-11`.
Items 1–3, 5 and 6 are done (2026-11-19), plus the part 1 review's two changes: the route pattern with its mount,
and mutant 13. Item 4, Playwright 1.65.1, became Step 12c (on or after 2026-11-21), with its own evidence folder.

| File | What | Result |
| --- | --- | --- |
| `audit-before.txt`, `outdated-before.txt` | `npm audit` / `npm outdated` on `main` (`1195371`), before any change | 0 vulnerabilities; 5 outdated (sdk, dotenv, express, fast-check, playwright) |
| `item-2-npm-test.txt`, `item-2-typecheck.txt` | full `npm test` and typecheck at the error handler's commit (`8085e5f`) | **67 files, 737/737**, 219.1 s; typecheck exit 0 |
| `item-3-lockdiff.txt` | the lockfile, HEAD vs after `npm install express@5.3.0 --before=2026-11-12` | 5 runtime paths: express 5.3.0, content-type 2.1.0 (one deduped copy), content-disposition 2.0.1 |
| `item-3-npm-test.txt`, `item-3-typecheck.txt` | full `npm test` and typecheck on Express 5.3.0 (`c38de78`) | **67 files, 737/737**, 236.4 s; typecheck exit 0 |
| `item-3-built-bank-smoke.txt`, `smoke-built-bank.mjs` | the *built* bank (`dist/mock-app/index.js`, what the image runs), `NODE_ENV=production`: a too-deeply nested login form and an `Authorization` header, each carrying a fake credential | 400 with a generic page; one stderr summary (`code: querystring.parse.rangeError`, `route: (no route)`); the credential in neither the response nor the bank's output |
| `audit-after-items-1-3.txt`, `outdated-after-items-1-3.txt` | after items 1–3 | 0 vulnerabilities; 4 outdated (sdk, dotenv, fast-check, playwright: all held) |
| `review-1-npm-test.txt` | full `npm test` at the part 1 review's route-pattern commit (`4be450f`) | **67 files, 741/741**, 231.5 s |
| `review-2-npm-test.txt` | full `npm test` at the mutant-13 commit (`53a9275`) | **67 files, 741/741**, 238.8 s |
| `mutation-check/`, `mutation-check-stdout.txt` | `npm run mutation-check -- --out evidence/step-12b/mutation-check` on `53a9275` | **13/13 caught**, `RESULT: PASS`; mutant 13 caught by 5 tests |

Not committed: item 1 (`.env` is git-ignored). Six `ROTE_CRED_*` keys were appended; the two existing lines were
left as they were.

Measured while building item 2. The probes were scratch scripts; their results are recorded in D62:
- **Express 5.2.1's default handler** (env `development`) logs a short non-JSON body to `express.json()` verbatim,
  from body-parser's strict-mode error message. Longer malformed bodies are not logged.
- **5.3.0's default handler** also logs a 120-character malformed JSON body in full.
- **Taking the handler out of `createCatalogApp`** turns both api leak tests red.
