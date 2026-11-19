// The redacting error handler (docs/plans/step-12b.md item 2, D62). A fake credential travels in a malformed
// body, a header and a cookie, and must appear in no log line and no response, from any of the three apps.
//
// Two things keep this test honest:
//  - Every app under test runs with Express's env set to "development". Under NODE_ENV=test (vitest's default)
//    Express's own default handler logs nothing, which would hide a leak that bypassed our handler.
//  - The control case: a bare Express app WITHOUT the handler gets the same body, and the test asserts the
//    credential DOES show up in what it logged. So the capture below can see a leak when there is one.
//    (Measured on Express 5.2.1: body-parser's strict-mode JSON error copies a short non-JSON body into its
//    message, and the default handler logs the stack. Express 5.3.0 logs the whole error object, `body` too.)
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bankApp from "../../mock-app/app.js";
import { createCatalogApp } from "../catalog/http.js";
import { createOperatorConsole } from "../escalation/console.js";
import { EscalationController } from "../escalation/controller.js";
import { listenOnSafePort } from "../testing/listen.js";
import { mountRouter, redactingErrorHandler, requestId, type ErrorSummary } from "./errorHandler.js";

const CRED = "fake-cred-12b";
/** Short and not JSON: body-parser's strict-mode error quotes all of it (the measured 5.2.1 leak). */
const SHORT_NON_JSON = `p=${CRED}`;
const MALFORMED_JSON = `{"tenant":"tenant-a","params":{"password":"${CRED}"}, oops}`;
/** Nested deeper than body-parser's urlencoded `depth` (32): a 400 parse error that carries the raw body. */
const DEEP_FORM = `a${"[b]".repeat(40)}=1&password=${CRED}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Everything written to stdout, stderr or console.* while installed (swallowed, not forwarded). */
function captureOutput() {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const consoleFns = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const grab = (chunk: unknown) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  for (const k of Object.keys(consoleFns) as (keyof typeof consoleFns)[]) {
    console[k] = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.stack} ${JSON.stringify(a)}` : String(a))).join(" "));
  }
  return {
    text: () => lines.join("\n"),
    restore: () => {
      process.stdout.write = out;
      process.stderr.write = err;
      Object.assign(console, consoleFns);
    },
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function serve(app: Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  const port = await listenOnSafePort(server, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

interface Sent {
  status: number;
  body: string;
  headers: string;
  requestIdHeader: string | null;
  logged: string;
}

/** POST `body` with the credential also in a header and a cookie; return the response and everything logged meanwhile. */
async function post(base: string, path: string, contentType: string, body: string): Promise<Sent> {
  const capture = captureOutput();
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${CRED}`,
        cookie: `rote_session=${CRED}; other=${CRED}`,
        "x-request-id": CRED, // must not be echoed or logged: the id is always generated
      },
      body,
    });
    const text = await res.text();
    const headers: string[] = [];
    res.headers.forEach((v, k) => headers.push(`${k}: ${v}`));
    return { status: res.status, body: text, headers: headers.join("\n"), requestIdHeader: res.headers.get("x-request-id"), logged: capture.text() };
  } finally {
    capture.restore();
  }
}

function expectNoCredential(sent: Sent, summaries: ErrorSummary[] = []): void {
  expect(sent.body).not.toContain(CRED);
  expect(sent.headers).not.toContain(CRED);
  expect(sent.logged).not.toContain(CRED);
  expect(JSON.stringify(summaries)).not.toContain(CRED);
}

/** The summary lines the default sink (stderr JSON) wrote, parsed. */
function stderrSummaries(logged: string): (ErrorSummary & { msg: string })[] {
  return logged
    .split("\n")
    .filter((l) => l.includes('"msg":"http: request failed"'))
    .map((l) => JSON.parse(l) as ErrorSummary & { msg: string });
}

describe("control: Express's default handler, without ours", () => {
  it("logs the credential from a short non-JSON body (so the capture below can see a leak)", async () => {
    const app = express();
    app.set("env", "development");
    app.use(express.json());
    app.post("/x", (_req, res) => void res.send("ok"));
    const sent = await post(await serve(app), "/x", "application/json", SHORT_NON_JSON);
    expect(sent.status).toBe(400);
    expect(sent.logged).toContain(CRED);
  });
});

describe("the api (createCatalogApp, JSON)", () => {
  async function api() {
    const summaries: ErrorSummary[] = [];
    const app = createCatalogApp({ logError: (s) => summaries.push(s) });
    app.set("env", "development");
    return { base: await serve(app), summaries };
  }

  for (const [label, body] of [
    ["a short non-JSON body", SHORT_NON_JSON],
    ["a malformed JSON body", MALFORMED_JSON],
  ] as const) {
    it(`${label} with a fake credential: a generic 400, one redacted summary, the credential nowhere`, async () => {
      const { base, summaries } = await api();
      const sent = await post(base, "/capabilities/member-lookup/invoke", "application/json", body);
      expect(sent.status).toBe(400);
      expect(sent.requestIdHeader).toMatch(UUID_RE);
      expect(JSON.parse(sent.body)).toEqual({ error: "Bad Request", requestId: sent.requestIdHeader });
      expect(summaries).toEqual([
        { name: "SyntaxError", code: "entity.parse.failed", status: 400, method: "POST", route: "(no route)", requestId: sent.requestIdHeader },
      ]);
      expectNoCredential(sent, summaries);
    });
  }

  it("a body that parses still reaches its route (the handler changes nothing on the success path)", async () => {
    const { base, summaries } = await api();
    const sent = await post(base, "/capabilities/no-such-capability/invoke", "application/json", JSON.stringify({ params: {} }));
    expect(sent.status).toBe(404);
    expect(JSON.parse(sent.body).error).toMatch(/No capability with id/);
    expect(summaries).toEqual([]);
    expect(sent.requestIdHeader).toMatch(UUID_RE);
  });
});

describe("the mock bank (HTML, default stderr sink)", () => {
  let previousEnv: unknown;
  beforeAll(() => {
    previousEnv = bankApp.get("env");
    bankApp.set("env", "development");
  });
  afterAll(() => {
    bankApp.set("env", previousEnv);
  });

  it("a malformed (too deeply nested) login form: a generic 400 page, a redacted summary, the credential nowhere", async () => {
    const sent = await post(await serve(bankApp), "/login", "application/x-www-form-urlencoded", DEEP_FORM);
    expect(sent.status).toBe(400);
    expect(sent.body).toContain("400 Bad Request");
    expect(sent.body).toContain(`Request id: ${sent.requestIdHeader}`);
    const summaries = stderrSummaries(sent.logged);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ status: 400, method: "POST", route: "(no route)", requestId: sent.requestIdHeader });
    expectNoCredential(sent, summaries);
  });

  it("a JSON login the bank has no parser for (the route throws on req.body): a generic 500, route /login", async () => {
    const sent = await post(await serve(bankApp), "/login", "application/json", JSON.stringify({ username: "op", password: CRED }));
    expect(sent.status).toBe(500);
    expect(sent.body).toContain("500 Internal Server Error");
    expect(sent.body).not.toMatch(/Cannot read|TypeError|at /);
    const summaries = stderrSummaries(sent.logged);
    expect(summaries).toEqual([
      expect.objectContaining({ name: "TypeError", status: 500, method: "POST", route: "/login", requestId: sent.requestIdHeader }),
    ]);
    expectNoCredential(sent, summaries);
  });

  it("a prefixed tenant's route is logged with its mount: /tenant-b/login", async () => {
    const sent = await post(await serve(bankApp), "/tenant-b/login", "application/json", JSON.stringify({ password: CRED }));
    expect(sent.status).toBe(500);
    expect(stderrSummaries(sent.logged)).toEqual([expect.objectContaining({ route: "/tenant-b/login" })]);
    expectNoCredential(sent);
  });

  it("the unprefixed tenant (mounted with no path) adds nothing: /login", async () => {
    const sent = await post(await serve(bankApp), "/login", "application/json", JSON.stringify({ password: CRED }));
    expect(stderrSummaries(sent.logged)).toEqual([expect.objectContaining({ route: "/login" })]);
  });
});

describe("the operator console (HTML)", () => {
  async function opConsole() {
    const summaries: ErrorSummary[] = [];
    const app = createOperatorConsole(new EscalationController(), { logError: (s) => summaries.push(s) });
    app.set("env", "development");
    return { base: await serve(app), summaries };
  }

  it("a malformed hand-back form carrying the credential: a generic 400, the credential nowhere", async () => {
    const { base, summaries } = await opConsole();
    const sent = await post(base, "/hand-back", "application/x-www-form-urlencoded", `note=${CRED}&${DEEP_FORM}`);
    expect(sent.status).toBe(400);
    expect(sent.body).toContain("400 Bad Request");
    expect(summaries).toEqual([expect.objectContaining({ status: 400, route: "(no route)", requestId: sent.requestIdHeader })]);
    expectNoCredential(sent, summaries);
  });

  it("a JSON hand-back (no JSON parser; the route throws): a generic 500, route /hand-back", async () => {
    const { base, summaries } = await opConsole();
    const sent = await post(base, "/hand-back", "application/json", JSON.stringify({ note: CRED }));
    expect(sent.status).toBe(500);
    expect(summaries).toEqual([expect.objectContaining({ name: "TypeError", status: 500, route: "/hand-back" })]);
    expectNoCredential(sent, summaries);
  });
});

describe("route patterns through mounts: the pattern, never concrete values", () => {
  const TENANT = "acme-corp-7731"; // stands in for a value a mount's parameter would capture
  const MEMBER = "10001";

  /** An app with: a parameterized mount via mountRouter, the same router via plain app.use (unregistered), and a nested mount. */
  function mountedApp(summaries: ErrorSummary[]) {
    const app = express();
    app.set("env", "development");
    app.use(requestId());
    const members = express.Router({ mergeParams: true });
    members.post("/member/:id/transfer", () => {
      throw new Error(`refused ${CRED}`);
    });
    const inner = express.Router();
    inner.post("/history/:memo", () => {
      throw new Error("x");
    });
    mountRouter(members, "/archive/:year", inner);
    mountRouter(app, "/t/:tenant", members);
    const plain = express.Router();
    plain.post("/member/:id/transfer", () => {
      throw new Error("x");
    });
    app.use("/legacy/:tenant", plain);
    app.use(redactingErrorHandler({ format: "json", log: (s) => summaries.push(s) }));
    return app;
  }

  it("a parameterized mount logs /t/:tenant/member/:id/transfer, with neither the tenant nor the member id", async () => {
    const summaries: ErrorSummary[] = [];
    const base = await serve(mountedApp(summaries));
    const sent = await post(base, `/t/${TENANT}/member/${MEMBER}/transfer`, "text/plain", "x");
    expect(sent.status).toBe(500);
    expect(summaries).toEqual([expect.objectContaining({ route: "/t/:tenant/member/:id/transfer" })]);
    const everything = JSON.stringify(summaries) + sent.logged + sent.body + sent.headers;
    expect(everything).not.toContain(TENANT);
    expect(everything).not.toContain(MEMBER);
    expectNoCredential(sent, summaries);
  });

  it("a nested parameterized mount adds every pattern on the way down", async () => {
    const summaries: ErrorSummary[] = [];
    const base = await serve(mountedApp(summaries));
    await post(base, `/t/${TENANT}/archive/2026/history/rent-${MEMBER}`, "text/plain", "x");
    expect(summaries).toEqual([expect.objectContaining({ route: "/t/:tenant/archive/:year/history/:memo" })]);
    expect(JSON.stringify(summaries)).not.toMatch(new RegExp(`${TENANT}|2026|${MEMBER}`));
  });

  it("a router mounted with plain app.use(path, …) is marked unregistered, never shown by its concrete path", async () => {
    const summaries: ErrorSummary[] = [];
    const base = await serve(mountedApp(summaries));
    await post(base, `/legacy/${TENANT}/member/${MEMBER}/transfer`, "text/plain", "x");
    expect(summaries).toEqual([expect.objectContaining({ route: "/(unregistered mount)/member/:id/transfer" })]);
    expect(JSON.stringify(summaries)).not.toMatch(new RegExp(`${TENANT}|${MEMBER}`));
  });
});

describe("redactingErrorHandler on its own", () => {
  function appThatThrows(format: "json" | "html", summaries: ErrorSummary[], thrower: () => never | void) {
    const app = express();
    app.set("env", "development");
    app.use(requestId());
    app.post("/boom/:id", (_req, res) => {
      thrower();
      res.send("unreachable");
    });
    app.post("/partial", (_req, res) => {
      res.status(200).write("partial ");
      thrower();
    });
    app.use(redactingErrorHandler({ format, log: (s) => summaries.push(s) }));
    return app;
  }

  it("an error whose message, body, cause and code-like fields carry the credential: none of it is logged or sent", async () => {
    const summaries: ErrorSummary[] = [];
    const err = Object.assign(new Error(`login failed for password=${CRED}`), {
      body: `password=${CRED}`,
      cause: new Error(CRED),
      headers: { authorization: CRED },
      status: 502,
      code: `not an identifier: ${CRED}`,
      type: "upstream.failed",
    });
    const base = await serve(appThatThrows("json", summaries, () => { throw err; }));
    const sent = await post(base, "/boom/10001", "application/json", "{}");
    expect(sent.status).toBe(502);
    expect(JSON.parse(sent.body)).toEqual({ error: "Bad Gateway", requestId: sent.requestIdHeader });
    // The concrete path (/boom/10001) never appears: only the pattern.
    expect(summaries).toEqual([{ name: "Error", code: "upstream.failed", status: 502, method: "POST", route: "/boom/:id", requestId: sent.requestIdHeader }]);
    expect(JSON.stringify(summaries)).not.toContain("10001");
    expectNoCredential(sent, summaries);
  });

  it("a thrown non-Error, a status outside 4xx/5xx and a name that is not an identifier all fall back safely", async () => {
    const summaries: ErrorSummary[] = [];
    let n = 0;
    const thrown: unknown[] = [CRED, Object.assign(new Error("x"), { status: 302 }), Object.assign(new Error("x"), { name: `Bad ${CRED}` })];
    const base = await serve(appThatThrows("html", summaries, () => { throw thrown[n++]; }));
    for (let i = 0; i < thrown.length; i += 1) {
      const sent = await post(base, "/boom/1", "text/plain", "x");
      expect(sent.status).toBe(500);
      expect(sent.body).toContain("500 Internal Server Error");
      expectNoCredential(sent, summaries);
    }
    expect(summaries.map((s) => [s.name, s.status])).toEqual([["NonError", 500], ["Error", 500], ["Error", 500]]);
  });

  it("headers already sent: the connection is closed, one summary is logged, Express's default handler never runs", async () => {
    const summaries: ErrorSummary[] = [];
    const base = await serve(appThatThrows("json", summaries, () => { throw new Error(CRED); }));
    const capture = captureOutput();
    let bodyFailed = false;
    try {
      const res = await fetch(`${base}/partial`, { method: "POST" });
      await res.text().catch(() => (bodyFailed = true));
    } catch {
      bodyFailed = true;
    } finally {
      capture.restore();
    }
    expect(bodyFailed).toBe(true);
    expect(summaries).toEqual([expect.objectContaining({ name: "Error", status: 500, route: "/partial" })]);
    expect(capture.text()).not.toContain(CRED);
  });

  it("a log sink that throws does not stop the response", async () => {
    const app = express();
    app.use(requestId());
    app.post("/boom", () => {
      throw new Error("x");
    });
    app.use(redactingErrorHandler({ format: "json", log: () => { throw new Error("sink down"); } }));
    const sent = await post(await serve(app), "/boom", "text/plain", "x");
    expect(sent.status).toBe(500);
    expect(JSON.parse(sent.body).error).toBe("Internal Server Error");
  });

  it("the request id is generated per request, never taken from the client's X-Request-Id", async () => {
    const summaries: ErrorSummary[] = [];
    const base = await serve(appThatThrows("json", summaries, () => { throw new Error("x"); }));
    const a = await post(base, "/boom/1", "text/plain", "x");
    const b = await post(base, "/boom/1", "text/plain", "x");
    expect(a.requestIdHeader).toMatch(UUID_RE);
    expect(b.requestIdHeader).toMatch(UUID_RE);
    expect(a.requestIdHeader).not.toBe(b.requestIdHeader);
    expect(summaries.map((s) => s.requestId)).toEqual([a.requestIdHeader, b.requestIdHeader]);
  });
});
