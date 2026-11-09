// HTTP-level tests (plain fetch, no browser) for the mock bank's transfer flow, ledger, history
// page and fault controls. The browser-level proof across all three tenants is in
// transfer.browser.test.ts.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "./app.js";
import { TENANTS, type TenantConfig } from "./tenants.js";
import { MEMO_MAX_LENGTH } from "./transfer.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await fetch(`${base}/control/errors/off`);
  await fetch(`${base}/control/latency/0`);
  await fetch(`${base}/control/ledger/reset`);
});

interface LedgerRow {
  id: string;
  tenantId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  memo: string;
  at: string;
}

async function ledger(): Promise<LedgerRow[]> {
  const body = (await (await fetch(`${base}/control/ledger`)).json()) as { entries: LedgerRow[] };
  return body.entries;
}

/** A logged-in browser stand-in: one cookie, tenant-prefixed paths, manual redirects. */
class Client {
  private cookie = "";
  constructor(readonly tenant: TenantConfig) {}

  static async login(tenant: TenantConfig): Promise<Client> {
    const c = new Client(tenant);
    const res = await fetch(`${base}${tenant.pathPrefix}/login`, {
      method: "POST",
      body: new URLSearchParams({ username: "operator", password: "operator" }),
      redirect: "manual",
    });
    c.cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    return c;
  }

  get(path: string): Promise<Response> {
    return fetch(`${base}${this.tenant.pathPrefix}${path}`, {
      headers: { cookie: this.cookie },
      redirect: "manual",
    });
  }

  post(path: string, fields: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}${this.tenant.pathPrefix}${path}`, {
      method: "POST",
      headers: { cookie: this.cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  }

  /** Fills the transfer form and returns the response to the "Continue" POST. */
  fill(from: string, fields: { toMemberId: string; amount: string; memo?: string }): Promise<Response> {
    return this.post(`/member/${from}/transfer`, { memo: "", ...fields });
  }

  /** Continue + Submit. Returns the final (Submit) response. */
  async transfer(
    from: string,
    fields: { toMemberId: string; amount: string; memo?: string },
  ): Promise<Response> {
    const cont = await this.fill(from, fields);
    expect(cont.status).toBe(302);
    return this.post(`/member/${from}/transfer/confirm`);
  }

  async matchingCount(memberId: string, memo?: string): Promise<number> {
    const q = memo === undefined ? "" : `?memo=${encodeURIComponent(memo)}`;
    const html = await (await this.get(`/member/${memberId}/history${q}`)).text();
    // Classic: <th>Matching transfers</th><td>N</td>; hostile: sibling divs. Both: label then value.
    const m = /Matching transfers<\/(?:th|div)><(?:td|div)[^>]*>(\d+)</.exec(html);
    if (!m) throw new Error(`no "Matching transfers" row in:\n${html}`);
    return Number(m[1]);
  }
}

describe("transfer flow: happy path on every tenant", () => {
  for (const tenant of TENANTS) {
    it(`${tenant.id}: Continue -> Submit appends exactly one ledger row`, async () => {
      const c = await Client.login(tenant);
      const res = await c.transfer("10001", { toMemberId: "10002", amount: "25.50", memo: "rent" });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Transfer Submitted");
      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: tenant.id,
        fromMemberId: "10001",
        toMemberId: "10002",
        amount: 25.5,
        memo: "rent",
      });
      expect(rows[0]!.id).toBe("TXN-000001");
    });
  }

  it("the confirm page shows what was typed and a Submit control", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.fill("10001", { toMemberId: "10002", amount: "$7", memo: "hello" });
    const html = await (await c.get("/member/10001/transfer/confirm")).text();
    expect(html).toContain("<td>10002</td>");
    expect(html).toContain("<td>$7.00</td>"); // amount normalized, "$" accepted on input
    expect(html).toContain("<td>hello</td>");
    expect(html).toContain('<button type="submit">Submit</button>');
  });

  it("Continue alone writes nothing to the ledger", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.fill("10001", { toMemberId: "10002", amount: "5" });
    expect(await ledger()).toHaveLength(0);
  });

  it("submitting the same draft twice does not write twice (draft is consumed)", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.fill("10001", { toMemberId: "10002", amount: "5", memo: "once" });
    await c.post("/member/10001/transfer/confirm");
    const second = await c.post("/member/10001/transfer/confirm");
    expect(await second.text()).toContain("No pending transfer");
    expect(await ledger()).toHaveLength(1);
  });

  it("confirm without a draft says no pending transfer", async () => {
    const c = await Client.login(TENANTS[0]!);
    expect(await (await c.get("/member/10001/transfer/confirm")).text()).toContain("No pending transfer");
    expect(await (await c.post("/member/10001/transfer/confirm")).text()).toContain("No pending transfer");
    expect(await ledger()).toHaveLength(0);
  });

  it("member balances are not changed by a transfer", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.transfer("10001", { toMemberId: "10002", amount: "100" });
    expect(await (await c.get("/member/10001")).text()).toContain("$4532.10");
    expect(await (await c.get("/member/10002")).text()).toContain("$812.55");
  });

  it("the member page offers Transfer and History", async () => {
    const c = await Client.login(TENANTS[0]!);
    const html = await (await c.get("/member/10001")).text();
    expect(html).toContain('<button type="submit">Transfer</button>');
    expect(html).toContain('<button type="submit">History</button>');
  });
});

describe("transfer validation", () => {
  const cases: Array<[string, string, { toMemberId: string; amount: string }, string]> = [
    ["unknown recipient", "10001", { toMemberId: "99999", amount: "5" }, "Recipient not found"],
    ["closed recipient", "10001", { toMemberId: "10003", amount: "5" }, "is closed"],
    ["closed source", "10003", { toMemberId: "10001", amount: "5" }, "Source member 10003 is closed"],
    ["same member", "10001", { toMemberId: "10001", amount: "5" }, "same member"],
    ["missing recipient", "10001", { toMemberId: "  ", amount: "5" }, "To Member ID is required"],
    ["missing amount", "10001", { toMemberId: "10002", amount: "" }, "Amount is required"],
    ["non-numeric amount", "10001", { toMemberId: "10002", amount: "abc" }, "positive dollar amount"],
    ["negative amount", "10001", { toMemberId: "10002", amount: "-5" }, "positive dollar amount"],
    ["zero amount", "10001", { toMemberId: "10002", amount: "0" }, "positive dollar amount"],
    ["three decimals", "10001", { toMemberId: "10002", amount: "1.234" }, "positive dollar amount"],
    ["exponent notation", "10001", { toMemberId: "10002", amount: "1e3" }, "positive dollar amount"],
    ["insufficient funds", "10002", { toMemberId: "10001", amount: "812.56" }, "Insufficient funds"],
  ];
  for (const [name, from, fields, message] of cases) {
    it(`${name}: re-renders the form with an error and writes nothing`, async () => {
      const c = await Client.login(TENANTS[0]!);
      const res = await c.fill(from, fields);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(message);
      expect(html).toContain('<div class="msg1 err">');
      expect(await ledger()).toHaveLength(0);
    });
  }

  it("an amount equal to the seeded balance is allowed", async () => {
    const c = await Client.login(TENANTS[0]!);
    const res = await c.transfer("10002", { toMemberId: "10001", amount: "812.55" });
    expect(await res.text()).toContain("Transfer Submitted");
    expect(await ledger()).toHaveLength(1);
  });

  it("an unknown source member shows the not-found page", async () => {
    const c = await Client.login(TENANTS[0]!);
    expect(await (await c.get("/member/99999/transfer")).text()).toContain("Record not found");
    expect(await (await c.fill("99999", { toMemberId: "10002", amount: "5" })).text()).toContain(
      "Record not found",
    );
  });

  it("the permission-denied member cannot open the transfer form or history", async () => {
    const c = await Client.login(TENANTS[0]!);
    expect(await (await c.get("/member/40404/transfer")).text()).toContain("do not have permission");
    expect(await (await c.get("/member/40404/history")).text()).toContain("do not have permission");
  });
});

describe("memo handling", () => {
  it(`truncates memos to ${MEMO_MAX_LENGTH} characters on submit, silently, and shows the stored value`, async () => {
    const c = await Client.login(TENANTS[0]!);
    const long = "m".repeat(100);
    const res = await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: long });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/truncat|too long|error/i);
    const rows = await ledger();
    expect(rows[0]!.memo).toBe("m".repeat(MEMO_MAX_LENGTH));
    const history = await (await c.get("/member/10001/history")).text();
    expect(history).toContain(`<td>${"m".repeat(MEMO_MAX_LENGTH)}</td>`);
    expect(history).not.toContain("m".repeat(MEMO_MAX_LENGTH + 1));
  });

  it("keeps a 64-character memo whole and a 41-character fleet key whole", async () => {
    const c = await Client.login(TENANTS[0]!);
    const exact = "e".repeat(MEMO_MAX_LENGTH);
    const key = `rote-${"0123456789abcdef0123456789abcdef0123".slice(0, 36)}`;
    expect(key).toHaveLength(41);
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: exact });
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: key });
    expect((await ledger()).map((r) => r.memo)).toEqual([exact, key]);
  });

  it("does not split a surrogate pair at the cut", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: "😀".repeat(70) });
    expect(Array.from((await ledger())[0]!.memo)).toHaveLength(MEMO_MAX_LENGTH);
  });

  it("escapes HTML in memos on the confirm page and the history page", async () => {
    const c = await Client.login(TENANTS[0]!);
    const evil = `<script>alert(1)</script> & "q"`;
    await c.fill("10001", { toMemberId: "10002", amount: "1", memo: evil });
    const confirm = await (await c.get("/member/10001/transfer/confirm")).text();
    expect(confirm).not.toContain("<script>alert");
    expect(confirm).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;");
    await c.post("/member/10001/transfer/confirm");
    const history = await (await c.get(`/member/10001/history?memo=${encodeURIComponent(evil)}`)).text();
    expect(history).not.toContain("<script>alert");
    expect(history).toContain("&lt;script&gt;");
    expect(await c.matchingCount("10001", evil)).toBe(1);
  });

  it("escapes a hostile ?memo= filter echoed back into the filter input", async () => {
    const c = await Client.login(TENANTS[0]!);
    const html = await (await c.get(`/member/10001/history?memo=${encodeURIComponent('"><img src=x>')}`)).text();
    expect(html).not.toContain("<img src=x>");
  });
});

describe("history page", () => {
  it("counts matching transfers and filters by memo", async () => {
    const c = await Client.login(TENANTS[0]!);
    expect(await c.matchingCount("10001")).toBe(0);
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: "rote-aaa" });
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: "rote-aaa" });
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: "rote-bbb" });
    expect(await c.matchingCount("10001")).toBe(3);
    expect(await c.matchingCount("10001", "rote-aaa")).toBe(2);
    expect(await c.matchingCount("10001", "rote-bbb")).toBe(1);
    expect(await c.matchingCount("10001", "rote-zzz")).toBe(0);
  });

  it("shows a transfer to both the sender and the recipient, and to nobody else", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: "x" });
    expect(await c.matchingCount("10001")).toBe(1);
    expect(await c.matchingCount("10002")).toBe(1);
    expect(await c.matchingCount("10003")).toBe(0);
  });

  it("shows only the viewing tenant's rows; /control/ledger shows all", async () => {
    const [a, b, cc] = await Promise.all(TENANTS.map((t) => Client.login(t)));
    await a!.transfer("10001", { toMemberId: "10002", amount: "1", memo: "from-a" });
    await a!.transfer("10001", { toMemberId: "10002", amount: "1", memo: "from-a-2" });
    await b!.transfer("10001", { toMemberId: "10002", amount: "1", memo: "from-b" });
    expect(await a!.matchingCount("10001")).toBe(2);
    expect(await b!.matchingCount("10001")).toBe(1);
    expect(await cc!.matchingCount("10001")).toBe(0);
    expect((await ledger()).map((r) => r.tenantId)).toEqual(["tenant-a", "tenant-a", "tenant-b"]);
  });

  it("renders the count in tenant-c's hostile markup too", async () => {
    const c = await Client.login(TENANTS[2]!);
    await c.transfer("10001", { toMemberId: "10002", amount: "1", memo: "hz" });
    const html = await (await c.get("/member/10001/history")).text();
    expect(html).not.toContain("<label");
    expect(await c.matchingCount("10001")).toBe(1);
  });

  it("requires a session", async () => {
    const res = await fetch(`${base}/member/10001/history`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("control endpoints", () => {
  it("/control/ledger/reset empties the ledger and restarts ids", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.transfer("10001", { toMemberId: "10002", amount: "1" });
    expect(await ledger()).toHaveLength(1);
    expect(await (await fetch(`${base}/control/ledger/reset`)).text()).toContain("reset");
    expect(await ledger()).toHaveLength(0);
    await c.transfer("10001", { toMemberId: "10002", amount: "1" });
    expect((await ledger())[0]!.id).toBe("TXN-000001");
  });

  it("errors/on: tenant routes return 503 before any write; login still works", async () => {
    const c = await Client.login(TENANTS[0]!);
    await c.fill("10001", { toMemberId: "10002", amount: "3", memo: "pre" });
    expect(await (await fetch(`${base}/control/errors/on`)).text()).toContain("on");
    const confirm = await c.post("/member/10001/transfer/confirm");
    expect(confirm.status).toBe(503);
    expect(await confirm.text()).toContain("System unavailable");
    expect((await c.get("/member/10001")).status).toBe(503);
    expect(await ledger()).toHaveLength(0);
    expect((await fetch(`${base}/login`)).status).toBe(200);

    await fetch(`${base}/control/errors/off`);
    // The draft survived the outage (nothing was consumed), so the same Submit now commits once.
    const retry = await c.post("/member/10001/transfer/confirm");
    expect(await retry.text()).toContain("Transfer Submitted");
    expect(await ledger()).toHaveLength(1);
  });

  it("errors/after-write: the ledger row is written AND the page is a 503", async () => {
    const c = await Client.login(TENANTS[0]!);
    await fetch(`${base}/control/errors/after-write`);
    // Everything before the confirm POST behaves normally in this mode.
    expect((await c.get("/member/10001")).status).toBe(200);
    await c.fill("10001", { toMemberId: "10002", amount: "9", memo: "rote-after" });
    const confirm = await c.post("/member/10001/transfer/confirm");
    expect(confirm.status).toBe(503);
    expect(await confirm.text()).toContain("System unavailable");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memo: "rote-after", amount: 9 });
    // The truth is visible through the read-only history page, even while the confirm errored.
    expect(await c.matchingCount("10001", "rote-after")).toBe(1);
  });

  it("errors/after-write: a blind retry of Submit cannot duplicate (draft was consumed)", async () => {
    const c = await Client.login(TENANTS[0]!);
    await fetch(`${base}/control/errors/after-write`);
    await c.fill("10001", { toMemberId: "10002", amount: "9", memo: "k" });
    await c.post("/member/10001/transfer/confirm");
    await c.post("/member/10001/transfer/confirm");
    expect(await ledger()).toHaveLength(1);
  });

  it("errors/off clears both modes", async () => {
    const c = await Client.login(TENANTS[0]!);
    await fetch(`${base}/control/errors/on`);
    expect((await c.get("/member/10001")).status).toBe(503);
    await fetch(`${base}/control/errors/off`);
    expect((await c.get("/member/10001")).status).toBe(200);

    await fetch(`${base}/control/errors/after-write`);
    await fetch(`${base}/control/errors/off`);
    const res = await c.transfer("10001", { toMemberId: "10002", amount: "1" });
    expect(res.status).toBe(200);
  });

  it("errors/<bogus> is a 400 and leaves the mode unchanged", async () => {
    const c = await Client.login(TENANTS[0]!);
    expect((await fetch(`${base}/control/errors/sometimes`)).status).toBe(400);
    expect((await c.get("/member/10001")).status).toBe(200);
  });

  it("latency/:ms delays tenant routes; 0 clears it; bad values are 400", async () => {
    const c = await Client.login(TENANTS[0]!);
    expect((await fetch(`${base}/control/latency/-1`)).status).toBe(400);
    expect((await fetch(`${base}/control/latency/abc`)).status).toBe(400);
    expect((await fetch(`${base}/control/latency/60001`)).status).toBe(400);
    await fetch(`${base}/control/latency/200`);
    const t0 = Date.now();
    await c.get("/member/10001");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    await fetch(`${base}/control/latency/0`);
    const t1 = Date.now();
    await c.get("/member/10001");
    expect(Date.now() - t1).toBeLessThan(150);
  });
});

describe("older controls work without a session cookie (registered before the tenants)", () => {
  it("a cookie-less GET /control/transient/off (and /on) answers 200 and takes effect", async () => {
    const off = await fetch(`${base}/control/transient/off`, { redirect: "manual" });
    expect(off.status).toBe(200);
    expect(await off.text()).toBe("transient interstitial: off");

    const c = await Client.login(TENANTS[0]!);
    const on = await fetch(`${base}/control/transient/on`, { redirect: "manual" });
    expect(on.status).toBe(200);
    try {
      // ~30% per request; 60 requests without one interstitial would be ~1e-9.
      let sawInterstitial = false;
      for (let i = 0; i < 60 && !sawInterstitial; i += 1) {
        sawInterstitial = (await (await c.get("/member/10001")).text()).includes("System temporarily unavailable");
      }
      expect(sawInterstitial).toBe(true);
    } finally {
      await fetch(`${base}/control/transient/off`);
    }
    for (let i = 0; i < 20; i += 1) {
      expect(await (await c.get("/member/10001")).text()).not.toContain("System temporarily unavailable");
    }
  });

  it("cookie-less GET /control/unexpected-dialog/off answers 200", async () => {
    const res = await fetch(`${base}/control/unexpected-dialog/off`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("unexpected dialog: off");
  });

  it("/control/session-timeout still ends tenant-a's session from the request cookie, and only tenant-a's", async () => {
    const a = await Client.login(TENANTS[0]!);
    const b = await Client.login(TENANTS[1]!);
    const cookieA = (a as unknown as { cookie: string }).cookie;
    const cookieB = (b as unknown as { cookie: string }).cookie;
    const res = await fetch(`${base}/control/session-timeout`, {
      headers: { cookie: `${cookieA}; ${cookieB}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().join(";")).toMatch(/^sid=;/);

    const afterA = await a.get("/");
    expect(afterA.status).toBe(302);
    expect(afterA.headers.get("location")).toBe("/login");
    expect((await b.get("/")).status).toBe(200);

    // Cookie-less: no session to end, but it answers instead of bouncing to /login.
    const bare = await fetch(`${base}/control/session-timeout`, { redirect: "manual" });
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe("/");
  });
});
