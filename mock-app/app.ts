// Mock legacy back-office web app (fake data) used as the discovery/replay target.
// Exported unstarted so tests can mount it on an ephemeral port; mock-app/index.ts is the
// runnable bootstrap that calls app.listen(...).
//
// Two tenants share this one Express app: TENANT_A (mounted at "/", the app's original,
// unchanged behavior) and TENANT_B (mounted at "/tenant-b", different branding/labels). Routes
// are defined once in createTenantRouter() and mounted per tenant -- see mock-app/tenants.ts for
// what differs and mock-app/README.md for the full writeup.
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import {
  createSession,
  deleteSession,
  findMember,
  getSession,
  clearPendingSubAccount,
  setPendingSubAccount,
  clearPendingTransfer,
  setPendingTransfer,
  appendLedgerEntry,
  allLedgerEntries,
  resetLedger,
  PERMISSION_DENIED_ID,
  type Session,
} from "./data.js";
import {
  renderLogin,
  renderHome,
  renderMemberDetail,
  renderNotFound,
  renderPermissionDenied,
  renderTransientInterstitial,
  renderSubAccountForm,
  renderUnexpectedDialog,
  renderSubAccountConfirm,
  renderCreated,
  renderNoPendingSubAccount,
  renderTransferForm,
  renderTransferConfirm,
  renderTransferSubmitted,
  renderNoPendingTransfer,
  renderSystemUnavailable,
  renderTransferHistory,
} from "./views.js";
import { MEMO_MAX_LENGTH, truncateMemo, validateTransfer } from "./transfer.js";
import { TENANTS, TENANT_A, tenantUrl, type TenantConfig } from "./tenants.js";

const TRANSIENT_RATE = 0.3;

let transientEnabled = false;
let unexpectedDialogEnabled = false;
// Bank fault knobs for the fleet's "bank slow or down" scenarios (docs/DECISIONS.md D6):
//   "on"          -- every tenant route (except /login) returns 503 BEFORE any write.
//   "after-write" -- POST .../transfer/confirm appends the ledger row, THEN returns the 503.
let errorMode: "off" | "on" | "after-write" = "off";
let latencyMs = 0;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function createTenantRouter(tenant: TenantConfig): Router {
  const router = express.Router();

  function sessionFromReq(req: Request): Session | undefined {
    const token = parseCookies(req.headers.cookie)[tenant.cookieName];
    return getSession(token);
  }

  function sessionOf(res: Response): Session {
    return res.locals.session as Session;
  }

  // Auth gate: everything except /login requires a valid session for THIS tenant.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/login") {
      next();
      return;
    }
    const session = sessionFromReq(req);
    if (!session) {
      res.redirect(tenantUrl(tenant, "/login"));
      return;
    }
    res.locals.session = session;
    next();
  });

  // Artificial latency (/control/latency/:ms) and hard-error mode (/control/errors/on).
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/login") {
      next();
      return;
    }
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (errorMode === "on") {
      res.status(503).send(renderSystemUnavailable(tenant));
      return;
    }
    next();
  });

  // Random transient interstitial, toggled globally via /control/transient/on|off.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/login") {
      next();
      return;
    }
    if (transientEnabled && Math.random() < TRANSIENT_RATE) {
      res.status(200).send(renderTransientInterstitial(tenant, req.originalUrl));
      return;
    }
    next();
  });

  router.get("/login", (_req, res) => {
    res.send(renderLogin(tenant));
  });

  router.post("/login", (req, res) => {
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "").trim();
    if (!username || !password) {
      res.status(200).send(renderLogin(tenant, "User ID and Password are required."));
      return;
    }
    const session = createSession(username);
    res.cookie(tenant.cookieName, session.token, { httpOnly: true });
    res.redirect(tenantUrl(tenant, "/"));
  });

  router.get("/", (_req, res) => {
    res.send(renderHome(tenant, sessionOf(res).username));
  });

  router.get("/member/search", (req, res) => {
    const id = String(req.query.id ?? "").trim();
    res.redirect(tenantUrl(tenant, `/member/${encodeURIComponent(id)}`));
  });

  router.get("/member/:id", (req, res) => {
    const id = req.params.id;
    if (id === PERMISSION_DENIED_ID) {
      res.status(200).send(renderPermissionDenied(tenant, id));
      return;
    }
    const member = findMember(id);
    if (!member) {
      res.status(200).send(renderNotFound(tenant, id));
      return;
    }
    res.send(renderMemberDetail(tenant, member));
  });

  router.get("/member/:id/sub-account", (req, res) => {
    const id = req.params.id;
    const acknowledged = req.query.ack === "1";
    if (unexpectedDialogEnabled && !acknowledged) {
      res.status(200).send(renderUnexpectedDialog(tenant, id));
      return;
    }
    res.send(renderSubAccountForm(tenant, id));
  });

  router.post("/member/:id/sub-account", (req, res) => {
    const id = req.params.id;
    const accountType = String(req.body.accountType ?? "");
    const initialDeposit = String(req.body.initialDeposit ?? "");
    setPendingSubAccount(sessionOf(res), id, { accountType, initialDeposit });
    res.redirect(tenantUrl(tenant, `/member/${encodeURIComponent(id)}/sub-account/confirm`));
  });

  router.get("/member/:id/sub-account/confirm", (req, res) => {
    const id = req.params.id;
    const session = sessionOf(res);
    if (!session.pendingSubAccount || session.pendingSubAccount.memberId !== id) {
      res.status(200).send(renderNoPendingSubAccount(tenant, id));
      return;
    }
    res.send(renderSubAccountConfirm(tenant, id, session.pendingSubAccount.draft));
  });

  router.post("/member/:id/sub-account/confirm", (req, res) => {
    const id = req.params.id;
    clearPendingSubAccount(sessionOf(res));
    res.status(200).send(renderCreated(tenant, id));
  });

  router.get("/member/:id/transfer", (req, res) => {
    const id = req.params.id;
    if (id === PERMISSION_DENIED_ID) {
      res.status(200).send(renderPermissionDenied(tenant, id));
      return;
    }
    if (!findMember(id)) {
      res.status(200).send(renderNotFound(tenant, id));
      return;
    }
    res.send(renderTransferForm(tenant, id));
  });

  router.post("/member/:id/transfer", (req, res) => {
    const id = req.params.id;
    const from = findMember(id);
    if (!from) {
      res.status(200).send(renderNotFound(tenant, id));
      return;
    }
    const result = validateTransfer(from, {
      toMemberId: String(req.body.toMemberId ?? ""),
      amount: String(req.body.amount ?? ""),
      memo: String(req.body.memo ?? ""),
    });
    if (!result.ok) {
      res.status(200).send(renderTransferForm(tenant, id, result.error));
      return;
    }
    setPendingTransfer(sessionOf(res), id, {
      toMemberId: result.toMemberId,
      amount: result.amount,
      memo: result.memo,
    });
    res.redirect(tenantUrl(tenant, `/member/${encodeURIComponent(id)}/transfer/confirm`));
  });

  router.get("/member/:id/transfer/confirm", (req, res) => {
    const id = req.params.id;
    const session = sessionOf(res);
    if (!session.pendingTransfer || session.pendingTransfer.memberId !== id) {
      res.status(200).send(renderNoPendingTransfer(tenant, id));
      return;
    }
    res.send(renderTransferConfirm(tenant, id, session.pendingTransfer.draft));
  });

  // THE irreversible step. Re-validates (never trusts the session draft blindly), truncates the
  // memo silently, appends to the ledger, clears the draft. In "after-write" error mode the
  // commit has happened by the time the 503 goes out.
  router.post("/member/:id/transfer/confirm", (req, res) => {
    const id = req.params.id;
    const session = sessionOf(res);
    const pending = session.pendingTransfer;
    const from = findMember(id);
    if (!pending || pending.memberId !== id || !from) {
      res.status(200).send(renderNoPendingTransfer(tenant, id));
      return;
    }
    const result = validateTransfer(from, pending.draft);
    if (!result.ok) {
      clearPendingTransfer(session);
      res.status(200).send(renderTransferForm(tenant, id, result.error));
      return;
    }
    const entry = appendLedgerEntry({
      tenantId: tenant.id,
      fromMemberId: id,
      toMemberId: result.toMemberId,
      amount: Number(result.amount),
      memo: truncateMemo(result.memo),
    });
    clearPendingTransfer(session);
    if (errorMode === "after-write") {
      res.status(503).send(renderSystemUnavailable(tenant));
      return;
    }
    res.status(200).send(renderTransferSubmitted(tenant, id, entry));
  });

  // Read-only. Shows only THIS tenant's rows that involve the member; ?memo= keeps rows whose
  // stored (already truncated) memo contains the text.
  router.get("/member/:id/history", (req, res) => {
    const id = req.params.id;
    if (id === PERMISSION_DENIED_ID) {
      res.status(200).send(renderPermissionDenied(tenant, id));
      return;
    }
    if (!findMember(id)) {
      res.status(200).send(renderNotFound(tenant, id));
      return;
    }
    const memo = typeof req.query.memo === "string" ? req.query.memo : "";
    const rows = allLedgerEntries().filter(
      (r) =>
        r.tenantId === tenant.id &&
        (r.fromMemberId === id || r.toMemberId === id) &&
        (memo === "" || r.memo.includes(memo)),
    );
    res.send(renderTransferHistory(tenant, id, memo, rows));
  });

  return router;
}

const app = express();
app.use(express.urlencoded({ extended: true }));

// Fleet/test controls are registered BEFORE the tenants on purpose: tenant-a is mounted at "/", so
// its auth gate would otherwise redirect a cookie-less script (the fleet's chaos and ledger-check
// scripts have no session) to /login. (The older session-timeout/transient/unexpected-dialog
// controls below are unchanged and still need a session cookie.)
// Test oracle: ALL ledger rows, every tenant. Fleet workers must never call this.
app.get("/control/ledger", (_req, res) => {
  res.json({ memoMaxLength: MEMO_MAX_LENGTH, entries: allLedgerEntries() });
});

app.get("/control/ledger/reset", (_req, res) => {
  resetLedger();
  res.type("text/plain").send("ledger: reset");
});

app.get("/control/latency/:ms", (req, res) => {
  const ms = Number(req.params.ms);
  if (!Number.isInteger(ms) || ms < 0 || ms > 60_000) {
    res.status(400).type("text/plain").send("latency must be an integer 0..60000 (ms)");
    return;
  }
  latencyMs = ms;
  res.type("text/plain").send(`latency: ${latencyMs}ms`);
});

app.get("/control/errors/:mode", (req, res) => {
  const mode = req.params.mode;
  if (mode !== "on" && mode !== "off" && mode !== "after-write") {
    res.status(400).type("text/plain").send("mode must be on, off or after-write");
    return;
  }
  errorMode = mode;
  res.type("text/plain").send(`errors: ${errorMode}`);
});

// Path-PREFIXED tenants must be mounted before the unprefixed one: app.use(router) with no path
// runs its middleware for every request (including /tenant-b/*), so if it were registered
// first, its own auth-gate would intercept and redirect /tenant-b/* requests before Express ever
// got to try tenant-b's router at all. Mounting prefixed tenants first means Express only falls
// through to the unprefixed (default) tenant for paths that don't match any prefix.
const prefixedTenants = TENANTS.filter((tenant) => tenant.pathPrefix);
const unprefixedTenants = TENANTS.filter((tenant) => !tenant.pathPrefix);
for (const tenant of prefixedTenants) {
  app.use(tenant.pathPrefix, createTenantRouter(tenant));
}
for (const tenant of unprefixedTenants) {
  app.use(createTenantRouter(tenant));
}

// Failure-injection controls: unprefixed, shared across tenants. session-timeout clears
// TENANT_A's cookie specifically (matching this route's original, pre-multi-tenant behavior).
app.get("/control/session-timeout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[TENANT_A.cookieName];
  deleteSession(token);
  res.clearCookie(TENANT_A.cookieName);
  res.redirect(req.headers.referer ?? "/");
});

app.get("/control/transient/:state", (req, res) => {
  transientEnabled = req.params.state === "on";
  res.type("text/plain").send(`transient interstitial: ${transientEnabled ? "on" : "off"}`);
});

app.get("/control/unexpected-dialog/:state", (req, res) => {
  unexpectedDialogEnabled = req.params.state === "on";
  res.type("text/plain").send(`unexpected dialog: ${unexpectedDialogEnabled ? "on" : "off"}`);
});

export default app;
