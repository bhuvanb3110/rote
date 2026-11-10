// Step 4 (docs/plans/step-04.md): the optional, additive runReplay options the fleet needs, and
// the rules that apply once an irreversible action has been attempted. Correctness is judged by
// the mock bank's ledger (/control/ledger), never by what the page says.
//
// One Chromium is shared by the whole file and passed in as `browser`, which is itself the
// feature under test in the first block; every other block relies on it too.
//
// Approval: both transfer capabilities are approved into a temp statusDir (see transfer.test.ts).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../mock-app/app.js";
import { TENANTS, type TenantConfig } from "../../mock-app/tenants.js";
import { deserializeCapability, type Capability, type ReplayResult } from "../artifact/index.js";
import { approveCapability } from "../confidence/index.js";
import { WebSurface } from "../surface/index.js";
import { applyTenantOverride, deserializeTenantOverride } from "../tenant/index.js";
import { runReplay } from "./replay.js";
import type { ReplayOptions } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../..");
const [TENANT_A] = TENANTS as [TenantConfig, TenantConfig, TenantConfig];
const CREDS = { username: "operator", password: "operator" };

let server: Server;
let baseUrl: string;
let statusDir: string;
let browser: Browser;
let memberLookup: Capability;
let transferBase: Capability;
let lookupBase: Capability;

interface LedgerRow {
  id: string;
  tenantId: string;
  memo: string;
}

async function control(route: string): Promise<void> {
  const res = await fetch(`${baseUrl}/control/${route}`, { redirect: "manual" });
  if (res.status !== 200) throw new Error(`/control/${route} -> HTTP ${res.status}`);
}

async function ledger(): Promise<LedgerRow[]> {
  return ((await (await fetch(`${baseUrl}/control/ledger`)).json()) as { entries: LedgerRow[] }).entries;
}

async function loadArtifact(id: string): Promise<Capability> {
  return deserializeCapability(await readFile(path.join(repo, "artifacts", `${id}.json`), "utf8"));
}

/** The real tenant override applied the real way, with only the port relaxed (ephemeral bank). */
async function forTenant(base: Capability, tenant: TenantConfig): Promise<{ capability: Capability; entryUrl: string }> {
  const override = deserializeTenantOverride(
    await readFile(path.join(repo, "overrides", `${base.id}.${tenant.id}.json`), "utf8"),
  );
  const applied = applyTenantOverride(base, override);
  return {
    capability: { ...applied, target: { ...applied.target, entryUrlPattern: "^http://localhost:\\d+/" } },
    entryUrl: `${baseUrl}${tenant.pathPrefix}/`,
  };
}

function relaxed(capability: Capability): Capability {
  return { ...capability, target: { ...capability.target, entryUrlPattern: "^http://localhost:\\d+/" } };
}

type TransferFields = { memberId?: string; toMemberId?: string; amount?: string; memo: string };

/** A transfer on tenant-a through the shared browser, with approveRisky on unless overridden. */
async function transfer(fields: TransferFields, extra: Partial<ReplayOptions> = {}): Promise<ReplayResult> {
  const { capability, entryUrl } = await forTenant(transferBase, TENANT_A);
  return runReplay({
    capability,
    entryUrl,
    params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", ...fields },
    approveRisky: true,
    statusDir,
    browser,
    ...extra,
  });
}

async function matchingCount(memo: string): Promise<string> {
  const { capability, entryUrl } = await forTenant(lookupBase, TENANT_A);
  const result = await runReplay({ capability, entryUrl, params: { ...CREDS, memberId: "10001", memo }, statusDir, browser });
  expect(result.status, JSON.stringify(result)).toBe("success");
  return result.status === "success" ? String(result.outputs.matchingCount) : "";
}

/** Every entry of the run's evidence log. */
async function evidenceLog(result: ReplayResult): Promise<Array<{ kind: string; detail: Record<string, unknown> }>> {
  const ref = result.status === "needs_human" ? result.contextRef : result.evidenceRef;
  const log = await readFile(ref.replace("evidence://", ""), "utf8");
  return log.trim().split("\n").map((line) => JSON.parse(line));
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
  memberLookup = relaxed(await loadArtifact("member-lookup"));
  transferBase = await loadArtifact("transfer");
  lookupBase = await loadArtifact("transfer-history-lookup");
  statusDir = await mkdtemp(path.join(tmpdir(), "rote-fleet-status-"));
  for (const id of ["member-lookup", "transfer", "transfer-history-lookup"]) {
    await approveCapability(id, { statusDir, reason: "test-only approval in a temp statusDir" });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await control("transient/off");
  await control("errors/off");
  await control("latency/0");
  await control("ledger/reset");
  // Every test must leave the shared browser as it found it: connected, no contexts.
  expect(browser.isConnected()).toBe(true);
  expect(browser.contexts()).toHaveLength(0);
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(statusDir, { recursive: true, force: true });
});

describe("browser: reuse the worker's browser, close only the run's context", () => {
  function lookupMember(memberId: string): Promise<ReplayResult> {
    return runReplay({ capability: memberLookup, entryUrl: baseUrl, params: { ...CREDS, memberId }, statusDir, browser });
  }

  it("two sequential runs on one browser both succeed; the browser stays up with 0 contexts", async () => {
    for (const [memberId, balance] of [["10001", "4532.10"], ["10002", "812.55"]] as const) {
      const result = await lookupMember(memberId);
      expect(result.status, JSON.stringify(result)).toBe("success");
      if (result.status === "success") expect(String(result.outputs.savingsBalance)).toContain(balance);
      expect(browser.isConnected()).toBe(true);
      expect(browser.contexts()).toHaveLength(0);
    }
  }, 60_000);

  it("two concurrent runs on one browser get their own balances (contexts share no cookies)", async () => {
    const seen: number[] = [];
    const origLaunch = WebSurface.launch.bind(WebSurface);
    vi.spyOn(WebSurface, "launch").mockImplementation(async (opts) => {
      const surface = await origLaunch(opts);
      seen.push(browser.contexts().length);
      return surface;
    });
    // Different usernames too, so a shared cookie jar would show the wrong "Signed in as".
    const [a, b] = await Promise.all([
      runReplay({ capability: memberLookup, entryUrl: baseUrl, params: { username: "op-a", password: "x", memberId: "10001" }, statusDir, browser }),
      runReplay({ capability: memberLookup, entryUrl: baseUrl, params: { username: "op-b", password: "x", memberId: "10002" }, statusDir, browser }),
    ]);
    expect(a.status === "success" && String(a.outputs.savingsBalance)).toContain("4532.10");
    expect(b.status === "success" && String(b.outputs.savingsBalance)).toContain("812.55");
    expect(Math.max(...seen)).toBe(2); // both contexts were open at once
  }, 60_000);

  it("a run that throws after its context opened still closes that context and leaves the browser up", async () => {
    vi.spyOn(WebSurface.prototype, "act").mockRejectedValueOnce(new Error("simulated navigate crash"));
    await expect(lookupMember("10001")).rejects.toThrow("simulated navigate crash");
    // afterEach asserts 0 contexts and a connected browser.
  }, 30_000);

  it("headless is ignored (not rejected) when a browser is passed", async () => {
    const result = await runReplay({
      capability: memberLookup,
      entryUrl: baseUrl,
      params: { ...CREDS, memberId: "10001" },
      statusDir,
      browser,
      headless: false,
    });
    expect(result.status).toBe("success");
  }, 30_000);
});
