// The last word on any error in the three Express apps (the api, the mock bank, the operator console):
// docs/plans/step-12b.md item 2, docs/DECISIONS.md D62.
//
// Why it exists: Express's default error handler logs the error -- its stack in 5.2, the whole object in
// 5.3 -- and both can carry what a client sent. body-parser puts the raw request body on its parse errors
// (`err.body`), and its strict-mode JSON error copies the body's first characters into `err.message`
// (measured on 5.2.1: a short non-JSON body is logged verbatim). CLAUDE.md: credentials and full PII never
// land in logs. So every app ends with this handler, and Express's default handler is never reached.
//
// What it logs: ONE summary built from an allowlist -- the error's name and code (each only if it is a plain
// identifier), the status, the method, the matched route PATTERN (never the concrete path, which can carry
// an id), and a request id. Never the message, the stack, `err.body`, the request body, query, headers or
// cookies. What it answers: the status and Node's generic text for it (`http.STATUS_CODES`), plus the
// request id, as JSON or a minimal HTML page. No internals.
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { ErrorRequestHandler, Express, Request, RequestHandler, Response, Router } from "express";

/** Everything the handler ever logs about a failed request. Every field is built from an allowlist. */
export interface ErrorSummary {
  /** `err.name` when it is a plain identifier (SyntaxError, TypeError, BadRequestError…), else "Error"; "NonError" for a thrown non-object. */
  name: string;
  /** `err.code`, else body-parser's `err.type` (e.g. entity.parse.failed), when it is a short identifier; else absent. */
  code?: string;
  /** The status sent: the error's own 4xx/5xx, else 500. */
  status: number;
  method: string;
  /**
   * The matched route's full PATTERN, mount included (`/jobs/:id`, `/tenant-b/login`, `/t/:tenant/member/:id`),
   * or "(no route)" for an error before routing (a body-parser error) or in a router-level middleware. Never
   * concrete values: a mount's pattern comes from `mountRouter` (below), not from `req.baseUrl`, which is the
   * concrete matched path (`/t/acme`) and is restored to "" before the error reaches the app-level handler. A
   * router mounted with `app.use(path, router)` instead shows as `/(unregistered mount)` (one mounted with no
   * path, `app.use(router)`, adds nothing).
   */
  route: string;
  /** The id in the response's X-Request-Id header and body, to find this line from a client's report. */
  requestId: string;
}

export type ErrorSummaryLog = (summary: ErrorSummary) => void;

/** The default sink: one JSON line on stderr (the mock bank has no logger of its own). */
export const stderrErrorLog: ErrorSummaryLog = (summary) => {
  process.stderr.write(`${JSON.stringify({ level: "error", time: new Date().toISOString(), msg: "http: request failed", ...summary })}\n`);
};

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NO_ROUTE = "(no route)";

/**
 * First middleware of every app: a fresh request id per request, in `res.locals.requestId` and the
 * `X-Request-Id` response header. Always generated, never taken from the request: echoing a client's header
 * would put a client-chosen value in the log line.
 */
export function requestId(): RequestHandler {
  return (_req, res, next) => {
    const id = randomUUID();
    res.locals.requestId = id;
    res.set("X-Request-Id", id);
    next();
  };
}

function ownString(err: unknown, key: string): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function statusOf(err: unknown): number {
  if (typeof err !== "object" || err === null) return 500;
  const e = err as { status?: unknown; statusCode?: unknown };
  const status = typeof e.status === "number" ? e.status : e.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

// --- Route patterns, mount included ------------------------------------------------------------------------
// Express (router 2.x) keeps neither a mount's pattern nor, once the error has left the router, its baseUrl. So
// `mountRouter` records the pattern against the Layer that `use()` creates, and the handler walks the app's
// router stack to the Layer whose Route is `req.route`, adding the patterns of the mounts on the way. This reads
// router 2.x's Layer fields (`route`, `handle`, `slash`) and Express 5's `app.router`; the tests cover a static,
// a parameterized, an unregistered and a path-less mount, so an upgrade that moves them turns them red.
//
// It FAILS CLOSED (the reviewer's condition for reading internals, D62 notes): whenever the walk cannot prove the
// whole pattern -- `app.router.stack` is not an array, the Route is not found under any Layer's `route`, or
// `req.route.path` is not a string -- the route is the fixed `UNKNOWN_ROUTE`, with nothing appended. Never the
// concrete URL, and not even the router-relative pattern, since an upgrade that moved the fields may have
// changed what they hold.

interface RouterLayer {
  route?: unknown;
  handle?: { stack?: unknown };
  slash?: boolean;
}

const mountPatterns = new WeakMap<object, string>();
const UNREGISTERED_MOUNT = "/(unregistered mount)";
/** The route when Express's internals are not where `routeOf` expects them: a fixed string, nothing appended. */
export const UNKNOWN_ROUTE = "/(unknown route)";

/**
 * `parent.use(pattern, router)`, and remember `pattern` for that mount, so an error inside the router logs
 * `pattern + route pattern` (`/t/:tenant/member/:id`) and never the concrete `/t/acme/member/10001`.
 * `parent` is an Express app (its stack is `app.router.stack`) or a Router (`router.stack`).
 */
export function mountRouter(parent: Express | Router, pattern: string, router: Router): void {
  (parent as Router).use(pattern, router); // app.use and router.use take (path, router) alike
  const holder = parent as unknown as { stack?: unknown[]; router?: { stack?: unknown[] } };
  const stack = holder.stack ?? holder.router?.stack;
  const layer = stack?.[stack.length - 1];
  if (typeof layer === "object" && layer !== null) mountPatterns.set(layer, pattern);
}

function findRoute(stack: unknown, target: object, prefix: string, depth: number): string | undefined {
  if (!Array.isArray(stack) || depth > 8) return undefined;
  for (const item of stack as RouterLayer[]) {
    if (typeof item !== "object" || item === null) continue;
    if (item.route === target) return prefix;
    const sub = item.handle?.stack;
    if (Array.isArray(sub)) {
      const mount = mountPatterns.get(item) ?? (item.slash ? "" : UNREGISTERED_MOUNT);
      const found = findRoute(sub, target, prefix + mount, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function routeOf(req: Request): string {
  const route = (req as Request & { route?: unknown }).route;
  if (route === undefined || route === null) return NO_ROUTE; // an error before routing, or in a router-level middleware
  // From here a Route was matched, so anything unexpected means the internals moved: fail closed.
  if (typeof route !== "object" || typeof (route as { path?: unknown }).path !== "string") return UNKNOWN_ROUTE;
  const appStack = (req.app as unknown as { router?: { stack?: unknown } } | undefined)?.router?.stack;
  if (!Array.isArray(appStack)) return UNKNOWN_ROUTE;
  const prefix = findRoute(appStack, route, "", 0);
  return prefix === undefined ? UNKNOWN_ROUTE : `${prefix}${(route as { path: string }).path}`;
}

/** The summary of one failed request. Exported for the tests; nothing else reads the error. */
export function summarize(err: unknown, req: Request, res: Response): ErrorSummary {
  const name = typeof err === "object" && err !== null ? ownString(err, "name") : undefined;
  const code = [ownString(err, "code"), ownString(err, "type")].find((c) => c !== undefined && CODE_RE.test(c));
  const summary: ErrorSummary = {
    name: typeof err !== "object" || err === null ? "NonError" : name && NAME_RE.test(name) ? name : "Error",
    status: statusOf(err),
    method: req.method,
    route: routeOf(req),
    requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : "none",
  };
  if (code !== undefined) summary.code = code;
  return summary;
}

function htmlPage(status: number, text: string, id: string): string {
  // `text` is from http.STATUS_CODES and `id` a UUID (or "none"): neither needs escaping.
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${status} ${text}</title></head>
<body><h1>${status} ${text}</h1><p>Request id: ${id}</p></body>
</html>`;
}

export interface RedactingErrorHandlerOptions {
  /** "json" for the api, "html" for the bank and the console. */
  format: "json" | "html";
  /** Where the summary goes (default: one JSON line on stderr). A sink that throws is ignored. */
  log?: ErrorSummaryLog;
}

/** The last middleware of every app. Never calls `next(err)`: Express's default handler must not see the error. */
export function redactingErrorHandler(options: RedactingErrorHandlerOptions): ErrorRequestHandler {
  const log = options.log ?? stderrErrorLog;
  return (err: unknown, req, res, _next) => {
    const summary = summarize(err, req, res);
    try {
      log(summary);
    } catch {
      // A failing log sink must not stop the response (and must not be logged with the error either).
    }
    if (res.headersSent) {
      // Part of a response is already out; there is no clean way to send an error now. Do what Express's
      // default handler does in this case (close the connection), without its logging.
      req.socket?.destroy();
      return;
    }
    const text = STATUS_CODES[summary.status] ?? "Error";
    res.status(summary.status).set("Cache-Control", "no-store");
    if (options.format === "json") {
      res.json({ error: text, requestId: summary.requestId });
    } else {
      res.type("html").send(htmlPage(summary.status, text, summary.requestId));
    }
  };
}
