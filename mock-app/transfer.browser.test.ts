// ONE browser test that drives the whole transfer flow through the real UI on all three tenants,
// resolving every control with rote's own ranked strategies (resolveDescriptor) -- the same
// mechanism replay uses. tenant-c's hostile markup (no labels, <a> instead of <button>) is the
// reason the third strategy, textAnchor, is on every descriptor. Correctness is judged by the
// bank's ledger via /control/ledger, not by what the page says.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app.js";
import { TENANTS } from "./tenants.js";
import { resolveDescriptor } from "../src/surface/locate.js";
import type { ElementDescriptor } from "../src/surface/index.js";
import { buildPolicyForOrigin, policyGate } from "../src/safety/policy.js";
import { listenOnSafePort } from "../src/testing/listen.js";

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(app);
  await listenOnSafePort(server); // never a port Chromium/fetch refuse (D31)
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function textbox(name: string): ElementDescriptor {
  return {
    describedAs: `${name} textbox`,
    strategies: [
      { kind: "roleName", role: "textbox", name, confidence: 0.95 },
      { kind: "labelText", labelText: name, confidence: 0.8 },
      { kind: "textAnchor", anchorText: name, confidence: 0.6 },
    ],
  };
}

function button(name: string): ElementDescriptor {
  return {
    describedAs: `${name} button`,
    strategies: [
      { kind: "roleName", role: "button", name, confidence: 0.95 },
      { kind: "textAnchor", anchorText: name, confidence: 0.6 },
    ],
  };
}

async function locator(page: Page, descriptor: ElementDescriptor) {
  const handle = await resolveDescriptor(page, descriptor);
  if (!handle?.locator) throw new Error(`could not resolve ${descriptor.describedAs} on ${page.url()}`);
  return handle.locator;
}

interface LedgerEntry {
  tenantId: string;
  memo: string;
  amount: number;
}

/** GET /control/ledger. Response.json() is typed unknown, so the shape is stated once, here. */
async function ledgerEntries(): Promise<LedgerEntry[]> {
  const body = (await (await fetch(`${base}/control/ledger`)).json()) as { entries: LedgerEntry[] };
  return body.entries;
}

const fill = async (page: Page, d: ElementDescriptor, value: string) =>
  (await locator(page, d)).fill(value);
const click = async (page: Page, d: ElementDescriptor) => (await locator(page, d)).click();

describe("transfer + history through the browser, all three tenants", () => {
  it("each tenant: login -> Transfer -> Continue -> Submit -> History filter; ledger has exactly one row each", async () => {
    await fetch(`${base}/control/ledger/reset`);
    const policy = buildPolicyForOrigin(base);

    for (const tenant of TENANTS) {
      const memo = `rote-browser-${tenant.id}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${base}${tenant.pathPrefix}/login`);

      await fill(page, textbox("User ID"), "operator");
      await fill(page, textbox("Password"), "operator");
      await click(page, button("Log In"));
      await fill(page, textbox("Member ID"), "10001");
      await click(page, button(tenant.searchButtonLabel));
      await click(page, button("Transfer"));

      await fill(page, textbox("To Member ID"), "10002");
      await fill(page, textbox("Amount"), "12.34");
      await fill(page, textbox("Memo"), memo);
      await click(page, button("Continue"));

      // Confirm page: the summary is shown and nothing is in the ledger yet.
      await page.getByText("Confirm Transfer").first().waitFor();
      expect(await page.getByText(memo).count()).toBeGreaterThan(0);
      expect(await ledgerEntries()).toHaveLength(
        TENANTS.indexOf(tenant),
      );

      // The irreversible control is classified risky by the live gate on every tenant.
      const submit = button("Submit");
      const decision = policyGate(
        { kind: "click", target: submit },
        { policy, currentUrl: page.url() },
      );
      expect(decision, `${tenant.id} Submit`).toMatchObject({ allowed: true, risk: "risky" });

      await click(page, submit);
      await page.getByText("Transfer Submitted").waitFor();

      // Read-only history lookup, driven through its filter form.
      await page.goto(`${base}${tenant.pathPrefix}/member/10001`);
      await click(page, button("History"));
      await fill(page, textbox("Memo"), memo);
      await click(page, button("Filter"));
      const count = await locator(page, {
        describedAs: "Matching transfers value",
        strategies: [
          { kind: "tableCell", rowLabel: "Matching transfers", confidence: 0.9 },
          { kind: "css", css: ".zk9bv", confidence: 0.4 },
        ],
      });
      expect((await count.innerText()).trim()).toBe("1");

      await context.close();
    }

    const entries = await ledgerEntries();
    expect(entries.map((e) => [e.tenantId, e.memo, e.amount])).toEqual(
      TENANTS.map((t) => [t.id, `rote-browser-${t.id}`, 12.34]),
    );
  }, 60_000);
});
