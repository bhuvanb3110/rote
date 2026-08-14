# mock-app

A small local Express app standing in for a legacy credit-union back-office tool: server-rendered
HTML, nested table/div layout, non-semantic class names, no `data-testid` attributes. Real
`<label>`/`<input id>` pairs and real button text are kept, so semantic locators (role +
accessible name, label anchors) are possible — just not handed over as a convenient hook.

All data is fake/seeded. Nothing here is real PII.

## Run

```
npm run mock
```

Listens on `http://localhost:4100` by default. Override with `MOCK_APP_PORT`.

## Three tenants, one app

The same routes, same flow, and same seed members are served for **three tenants**. Each is
defined once in `app.ts`'s `createTenantRouter()` factory and configured in
[tenants.ts](tenants.ts):

| Tenant | Mounted at | Institution name | What differs | Why |
| ------ | ---------- | ----------------- | ------------- | --- |
| `tenant-a` | `/` (unprefixed) | Great Plains Member Credit Union | Nothing — this is the app's original behavior | Baseline |
| `tenant-b` | `/tenant-b` | Rolling Hills Credit Union | Search button says "Find Member"; balance row says "Savings Balance" | Same vendor product, different **branding/labels** |
| `tenant-c` | `/tenant-c` | Frontier Legacy Credit Union | Every control is real, visible-text-identical to tenant-a, but structurally hostile (see below) | Same vendor product, deliberately **hostile markup** |

`tenant-a` is exactly this app's original, single-tenant behavior — mounting it unprefixed at
`/` with unchanged labels means every artifact/test written before multi-tenancy existed still
works with zero changes.

`tenant-b` varies **text**: its Member Lookup button is labeled "Find Member" (not "Search"), and
its member-detail balance row is labeled "Savings Balance" (not "Current Savings Balance") — a
Capability recorded against tenant A breaks if replayed unmodified.

`tenant-c` is **hostile-DOM mode** (`TenantConfig.hostile: true`), not a text change — every
visible string is identical to tenant-a on purpose, so any locator failure there is provably a
structural problem, not a relabeling one:
- **Buttons/links are `<a href="#">`, not `<button>`** (with an inline `onclick` that submits the
  enclosing form) — implicit role "link," not "button," so `roleName` matching a `button` role
  finds nothing.
- **No `<label for>` association on any input** — label text sits in a plain sibling `<div>`,
  visually identical but with no accessible-name link, so `labelText` finds nothing. Inputs also
  carry no `id`/`placeholder` (a `placeholder` would accidentally supply an accessible name and
  defeat the point).
- **The savings balance has no `<table>`/`<tr>` at all** — label and value are bare sibling
  `<div>`s, so a `tableCell` strategy (which requires a `tr`) cleanly finds nothing.
- **Every field/action lives in its own isolated wrapper `<div>`** (nothing else inside it) so a
  `textAnchor` fallback — which needs to find *exactly one* clickable/input near the anchor text
  — resolves cleanly instead of failing for the wrong reason (a shared container with multiple
  inputs would make it ambiguous).
- **Class names are short and non-semantic** (`zk9f`, `zk9bv`, ...) — no `data-testid`, nothing
  a naive `css` selector could guess without having actually inspected the page.

See [src/tenant/](../src/tenant/) for the override layer that lets one base Capability replay
against all three tenants without being re-recorded, [overrides/member-lookup.tenant-c.json](../overrides/member-lookup.tenant-c.json)
for exactly which fallback strategy each hostile control needs, and the root
[REPORT.md](../REPORT.md) §3/§4 for the design writeup.

Each tenant has its own session cookie (`sid`, `sid_tenant_b`, `sid_tenant_c`), so visiting all
three in the same browser doesn't cross-contaminate sessions. The failure-injection controls
below are global (shared across all tenants) except `/control/session-timeout`, which only ever
clears tenant-a's session (unchanged from before multi-tenancy).

## Routes

Routes below are shown unprefixed (tenant-a); tenant-b and tenant-c serve the identical set under
`/tenant-b/...` / `/tenant-c/...` (e.g. `/tenant-c/member/:id`).

| Method | Path                                  | Notes                                              |
| ------ | -------------------------------------- | --------------------------------------------------- |
| GET    | `/login`                               | Login form                                          |
| POST   | `/login`                               | Any non-empty user/pass creates a session           |
| GET    | `/`                                    | Member Lookup form (requires session)               |
| GET    | `/member/search?id=`                   | Redirects to `/member/:id`                          |
| GET    | `/member/:id`                          | Member detail page (name, status, savings balance)  |
| GET    | `/member/:id/sub-account`              | Open Sub-Account form                               |
| POST   | `/member/:id/sub-account`              | Stores the draft, redirects to the confirm screen    |
| GET    | `/member/:id/sub-account/confirm`      | Confirmation screen (summary of the stored draft)   |
| POST   | `/member/:id/sub-account/confirm`      | Irreversible step — flashes "Created"               |

## Seed members

| Member ID | Name           | Status | Notes                        |
| --------- | -------------- | ------ | ----------------------------- |
| `10001`   | Alice Johnson  | Active |                                |
| `10002`   | Robert Chen    | Active |                                |
| `10003`   | Maria Alvarez  | Closed |                                |
| `40404`   | —              | —      | Reserved: permission-denied   |
| any other id |             |        | Not found                     |

## Failure modes

- **Unknown member id (business outcome, HTTP 200)** — search/visit any id not in the seed list,
  e.g. `/member/99999`.
- **Permission denied (business outcome, HTTP 200)** — visit `/member/40404`.
- **Session timeout** — visit `GET /control/session-timeout` in the same browser session. It
  deletes your session server-side and clears the `sid` cookie; the next navigation you make will
  redirect to `/login`.
- **Random transient interstitial ("System temporarily unavailable, please retry", HTTP 200)** —
  visit `GET /control/transient/on` to enable (each authenticated request then has a ~30% chance
  of hitting the interstitial instead of proceeding, with a Retry link back to the same page).
  Visit `GET /control/transient/off` to disable.
- **Unexpected confirmation dialog before the sub-account form** — visit
  `GET /control/unexpected-dialog/on` to enable. The next visit to
  `/member/:id/sub-account` shows an "Are you sure?" dialog first; its Proceed link appends
  `?ack=1` to reach the real form. Visit `GET /control/unexpected-dialog/off` to disable.

## Golden path

1. `POST /login` with any username/password.
2. `/` → search member id `10001`.
3. `/member/10001` → Open Sub-Account.
4. `/member/10001/sub-account` → pick an account type, enter a deposit, Continue.
5. `/member/10001/sub-account/confirm` → review the summary, Confirm.
6. "Created" flash page.
