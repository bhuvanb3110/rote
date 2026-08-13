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

## Routes

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
