// Mock legacy back-office web app (fake data) used as the discovery/replay target.
// Exported unstarted so tests can mount it on an ephemeral port; mock-app/index.ts is the
// runnable bootstrap that calls app.listen(...).
import express, { type Request, type Response, type NextFunction } from "express";
import {
  createSession,
  deleteSession,
  findMember,
  getSession,
  clearPendingSubAccount,
  setPendingSubAccount,
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
} from "./views.js";

const SESSION_COOKIE = "sid";
const TRANSIENT_RATE = 0.3;

let transientEnabled = false;
let unexpectedDialogEnabled = false;

const app = express();
app.use(express.urlencoded({ extended: true }));

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

function sessionFromReq(req: Request): Session | undefined {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return getSession(token);
}

function sessionOf(res: Response): Session {
  return res.locals.session as Session;
}

const isControlOrLogin = (path: string) => path === "/login" || path.startsWith("/control/");

// Auth gate: everything except /login and /control/* requires a valid session.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (isControlOrLogin(req.path)) {
    next();
    return;
  }
  const session = sessionFromReq(req);
  if (!session) {
    res.redirect("/login");
    return;
  }
  res.locals.session = session;
  next();
});

// Random transient interstitial, toggled via /control/transient/on|off.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (isControlOrLogin(req.path)) {
    next();
    return;
  }
  if (transientEnabled && Math.random() < TRANSIENT_RATE) {
    res.status(200).send(renderTransientInterstitial(req.path));
    return;
  }
  next();
});

app.get("/login", (_req, res) => {
  res.send(renderLogin());
});

app.post("/login", (req, res) => {
  const username = String(req.body.username ?? "").trim();
  const password = String(req.body.password ?? "").trim();
  if (!username || !password) {
    res.status(200).send(renderLogin("User ID and Password are required."));
    return;
  }
  const session = createSession(username);
  res.cookie(SESSION_COOKIE, session.token, { httpOnly: true });
  res.redirect("/");
});

app.get("/", (_req, res) => {
  res.send(renderHome(sessionOf(res).username));
});

app.get("/member/search", (req, res) => {
  const id = String(req.query.id ?? "").trim();
  res.redirect(`/member/${encodeURIComponent(id)}`);
});

app.get("/member/:id", (req, res) => {
  const id = req.params.id;
  if (id === PERMISSION_DENIED_ID) {
    res.status(200).send(renderPermissionDenied(id));
    return;
  }
  const member = findMember(id);
  if (!member) {
    res.status(200).send(renderNotFound(id));
    return;
  }
  res.send(renderMemberDetail(member));
});

app.get("/member/:id/sub-account", (req, res) => {
  const id = req.params.id;
  const acknowledged = req.query.ack === "1";
  if (unexpectedDialogEnabled && !acknowledged) {
    res.status(200).send(renderUnexpectedDialog(id));
    return;
  }
  res.send(renderSubAccountForm(id));
});

app.post("/member/:id/sub-account", (req, res) => {
  const id = req.params.id;
  const accountType = String(req.body.accountType ?? "");
  const initialDeposit = String(req.body.initialDeposit ?? "");
  setPendingSubAccount(sessionOf(res), id, { accountType, initialDeposit });
  res.redirect(`/member/${encodeURIComponent(id)}/sub-account/confirm`);
});

app.get("/member/:id/sub-account/confirm", (req, res) => {
  const id = req.params.id;
  const session = sessionOf(res);
  if (!session.pendingSubAccount || session.pendingSubAccount.memberId !== id) {
    res.status(200).send(renderNoPendingSubAccount(id));
    return;
  }
  res.send(renderSubAccountConfirm(id, session.pendingSubAccount.draft));
});

app.post("/member/:id/sub-account/confirm", (req, res) => {
  const id = req.params.id;
  clearPendingSubAccount(sessionOf(res));
  res.status(200).send(renderCreated(id));
});

app.get("/control/session-timeout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  deleteSession(token);
  res.clearCookie(SESSION_COOKIE);
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
