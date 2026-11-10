// Replay tests for the two hand-authored transfer capabilities (docs/plans/step-03.md), on all
// three tenants. Correctness is judged by the mock bank's ledger (/control/ledger), never by what
// the page says. Every runReplay launches its own Chromium today (Step 4 adds browser reuse), so
// scenarios are merged where that keeps them readable, to launch as few browsers as possible.
//
// Approval: the tests never read the committed status/*.json. Both capabilities are approved into
// a temp statusDir in beforeAll (D7 forbids approveUnattended in workers, not in tests; a temp dir
// also keeps a successful draft run from writing status/<id>.json into the repo).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../mock-app/app.js";
import { TENANTS, type TenantConfig } from "../../mock-app/tenants.js";
import { deserializeCapability, serializeCapability, type Capability, type ReplayResult } from "../artifact/index.js";
import { approvalKey, approveCapability } from "../confidence/index.js";
import { buildPolicyForOrigin, policyGate } from "../safety/index.js";
import { applyTenantOverride, deserializeTenantOverride } from "../tenant/index.js";
import { runReplay } from "./replay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../..");
const [TENANT_A, TENANT_B, TENANT_C] = TENANTS as [TenantConfig, TenantConfig, TenantConfig];
const CREDS = { username: "operator", password: "operator" };

let server: Server;
let baseUrl: string;
let statusDir: string;
let transferBase: Capability;
let lookupBase: Capability;

interface LedgerRow {
  id: string;
  tenantId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
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

/**
 * The capability exactly as invokeCapability would resolve it for this tenant (the real override
 * file, applied the real way), with only the port relaxed: tests run the bank on an ephemeral port.
 */
async function forTenant(
  base: Capability,
  tenant: TenantConfig,
): Promise<{ capability: Capability; approvalArtifact: Capability; entryUrl: string }> {
  const override = deserializeTenantOverride(
    await readFile(path.join(repo, "overrides", `${base.id}.${tenant.id}.json`), "utf8"),
  );
  expect(new URL(override.entryUrl).pathname).toBe(`${tenant.pathPrefix}/`);
  return {
    capability: relax(applyTenantOverride(base, override)),
    // What the temp statusDir approves (D24): the relaxed BASE, as invokeCapability passes the base.
    approvalArtifact: relax(base),
    entryUrl: `${baseUrl}${tenant.pathPrefix}/`,
  };
}

/** Only the port relaxed: tests run the bank on an ephemeral port. */
function relax(capability: Capability): Capability {
  return { ...capability, target: { ...capability.target, entryUrlPattern: "^http://localhost:\\d+/" } };
}

async function transfer(
  tenant: TenantConfig,
  fields: { memberId?: string; toMemberId?: string; amount?: string; memo: string },
  approveRisky = true,
): Promise<ReplayResult> {
  const { capability, approvalArtifact, entryUrl } = await forTenant(transferBase, tenant);
  return runReplay({
    capability,
    approvalArtifact,
    entryUrl,
    params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", ...fields },
    approveRisky,
    statusDir,
  });
}

async function lookup(tenant: TenantConfig, memo: string, memberId = "10001"): Promise<ReplayResult> {
  const { capability, approvalArtifact, entryUrl } = await forTenant(lookupBase, tenant);
  return runReplay({ capability, approvalArtifact, entryUrl, params: { ...CREDS, memberId, memo }, statusDir });
}

async function matchingCount(tenant: TenantConfig, memo: string): Promise<string> {
  const result = await lookup(tenant, memo);
  expect(result.status, JSON.stringify(result)).toBe("success");
  return result.status === "success" ? String(result.outputs.matchingCount) : "";
}

/** The `kind` of every entry in the run's evidence log. */
async function evidenceKinds(result: ReplayResult): Promise<string[]> {
  const ref = result.status === "needs_human" ? result.contextRef : result.evidenceRef;
  const log = await readFile(ref.replace("evidence://", ""), "utf8");
  return log.trim().split("\n").map((line) => JSON.parse(line).kind as string);
}

/**
 * Makes the bank's ~30% transient interstitial deterministic: the mock app runs in this process,
 * so Math.random is stubbed to alternate fire / pass. Every authenticated request that would draw
 * shows the interstitial first, and the reload that recovery does then goes through.
 */
function alternateTransient(): void {
  let calls = 0;
  vi.spyOn(Math, "random").mockImplementation(() => (calls++ % 2 === 0 ? 0 : 0.99));
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  transferBase = await loadArtifact("transfer");
  lookupBase = await loadArtifact("transfer-history-lookup");
  statusDir = await mkdtemp(path.join(tmpdir(), "rote-transfer-status-"));
  for (const capability of [transferBase, lookupBase]) {
    await approveCapability(capability.id, {
      ...approvalKey(relax(capability)), // what the runs replay: the base with only the port relaxed
      statusDir,
      reason: "test-only approval in a temp statusDir",
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await control("transient/off");
  await control("errors/off");
  await control("ledger/reset");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(statusDir, { recursive: true, force: true });
});

describe("transfer artifacts: static checks (no browser)", () => {
  it("both artifacts and all six overrides round-trip through the schema", async () => {
    for (const id of ["transfer", "transfer-history-lookup"]) {
      const raw = await readFile(path.join(repo, "artifacts", `${id}.json`), "utf8");
      const parsed = deserializeCapability(raw);
      expect(deserializeCapability(serializeCapability(parsed))).toEqual(parsed);
      expect(parsed.target).toEqual({
        appId: "great-plains-cu-backoffice",
        entryUrlPattern: "^http://localhost:4100/",
        surfaceType: "web",
      });
      for (const tenant of TENANTS) {
        const { capability } = await forTenant(parsed, tenant);
        expect(capability.steps.map((s) => s.id)).toEqual(parsed.steps.map((s) => s.id));
      }
    }
    expect(transferBase.inputs.filter((i) => i.redact).map((i) => i.name)).toEqual(["username", "password"]);
    expect(transferBase.outputs).toEqual([
      expect.objectContaining({ name: "confirmationRef", producedByStepId: "step-12" }),
    ]);
    expect(lookupBase.outputs).toEqual([
      expect.objectContaining({ name: "matchingCount", producedByStepId: "step-09" }),
    ]);
    // Only the existing transient retry; deliberately nothing for the 503 "System unavailable".
    for (const cap of [transferBase, lookupBase]) {
      expect(cap.recoverables.map((r) => r.recognizer)).toEqual([
        { kind: "textPresent", text: "System temporarily unavailable" },
      ]);
    }
  });

  it("the live gate says risky on step-11 of transfer only, on every tenant; the lookup is all safe", async () => {
    const policy = buildPolicyForOrigin(baseUrl);
    for (const tenant of TENANTS) {
      for (const [base, expectedRisky] of [
        [transferBase, ["step-11"]],
        [lookupBase, []],
      ] as const) {
        const { capability } = await forTenant(base, tenant);
        const risky = capability.steps
          .filter(
            (step) =>
              policyGate(
                { kind: step.action.kind as "click", target: step.target },
                { policy, currentUrl: `${baseUrl}/` },
              ).risk === "risky",
          )
          .map((step) => step.id);
        expect(risky, `${base.id} on ${tenant.id}`).toEqual(expectedRisky);
        // The artifact's recorded risk agrees with the live gate.
        expect(capability.steps.filter((s) => s.risk === "risky").map((s) => s.id)).toEqual(expectedRisky);
      }
    }
  });
});

describe("transfer artifacts: replay against the mock bank", () => {
  it("success on all three tenants (ref = ledger id); same memo twice -> lookup 2; tenants isolated", async () => {
    const memo = "rote-step3-shared-memo";
    const runs: Array<[TenantConfig, string]> = [
      [TENANT_A, memo],
      [TENANT_B, memo],
      [TENANT_C, "rote-step3-tenant-c-only"],
      [TENANT_A, memo],
    ];
    const refs: string[] = [];
    for (const [tenant, m] of runs) {
      const result = await transfer(tenant, { memo: m });
      expect(result.status, `${tenant.id}: ${JSON.stringify(result)}`).toBe("success");
      if (result.status === "success") refs.push(String(result.outputs.confirmationRef));
    }

    const rows = await ledger();
    expect(rows.map((r) => [r.tenantId, r.fromMemberId, r.toMemberId, r.amount, r.memo])).toEqual(
      runs.map(([tenant, m]) => [tenant.id, "10001", "10002", 12.34, m]),
    );
    // confirmationRef is exactly the bank's own ledger row id, on every tenant.
    expect(refs).toEqual(rows.map((r) => r.id));
    expect(refs).toEqual(["TXN-000001", "TXN-000002", "TXN-000003", "TXN-000004"]);

    expect(await matchingCount(TENANT_A, memo)).toBe("2");
    expect(await matchingCount(TENANT_B, memo)).toBe("1");
    // tenant-c's history never shows a/b rows, even with a memo they share.
    expect(await matchingCount(TENANT_C, memo)).toBe("0");
  }, 180_000);

  it("without approveRisky: needs_human at step-11 and nothing in the ledger", async () => {
    const result = await transfer(TENANT_A, { memo: "rote-step3-unapproved" }, false);
    expect(result).toMatchObject({ status: "needs_human", atStepId: "step-11" });
    expect(await ledger()).toEqual([]);
  }, 60_000);

  const outcomes: Array<[string, { memberId?: string; toMemberId?: string; amount?: string }]> = [
    ["NO_SUCH_MEMBER", { memberId: "99999" }],
    ["PERMISSION_DENIED", { memberId: "40404" }],
    ["SOURCE_CLOSED", { memberId: "10003" }],
    ["NO_SUCH_RECIPIENT", { toMemberId: "99999" }],
    ["RECIPIENT_CLOSED", { toMemberId: "10003" }],
    ["SAME_MEMBER", { toMemberId: "10001" }],
    ["INSUFFICIENT_FUNDS", { amount: "999999.00" }],
    ["INVALID_AMOUNT", { amount: "12.345" }],
  ];
  for (const [code, fields] of outcomes) {
    it(`transfer business outcome ${code}, ledger stays empty (approveRisky on)`, async () => {
      const result = await transfer(TENANT_A, { memo: `rote-step3-${code}`, ...fields });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "business_outcome", code });
      expect(await ledger()).toEqual([]);
    }, 60_000);
  }

  it("a memo containing outcome text is not mistaken for that outcome (recognizers scoped to the error message)", async () => {
    // The confirm page and the history page both show the memo. Whole-page textPresent recognizers
    // read it as INSUFFICIENT_FUNDS / NO_SUCH_MEMBER; scoped to the error element, they don't.
    const memo = "rote-Insufficient funds-Record not found";
    const result = await transfer(TENANT_A, { memo });
    expect(result.status, JSON.stringify(result)).toBe("success");
    expect((await ledger()).map((r) => r.memo)).toEqual([memo]);
    expect(await matchingCount(TENANT_A, memo)).toBe("1");
    // ...and the real outcome is still recognized on the hostile tenant.
    const refused = await transfer(TENANT_C, { memo, amount: "999999.00" });
    expect(refused).toMatchObject({ status: "business_outcome", code: "INSUFFICIENT_FUNDS" });
    expect(await ledger()).toHaveLength(1);
  }, 90_000);

  it("an empty To Member ID or Amount is REQUIRED_FIELD_MISSING (the input schema can't reject it earlier)", async () => {
    for (const fields of [{ toMemberId: "" }, { amount: "" }]) {
      const result = await transfer(TENANT_B, { memo: "rote-s4-required", ...fields });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "business_outcome", code: "REQUIRED_FIELD_MISSING" });
    }
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("lookup business outcomes: NO_SUCH_MEMBER and PERMISSION_DENIED", async () => {
    expect(await lookup(TENANT_A, "x", "99999")).toMatchObject({ status: "business_outcome", code: "NO_SUCH_MEMBER" });
    expect(await lookup(TENANT_A, "x", "40404")).toMatchObject({ status: "business_outcome", code: "PERMISSION_DENIED" });
  }, 60_000);

  it("a 100-char memo is stored at 64; the full-memo lookup finds 0", async () => {
    const memo = `rote-step3-long-${"x".repeat(84)}`;
    expect(memo).toHaveLength(100);
    expect((await transfer(TENANT_A, { memo })).status).toBe("success");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memo).toBe(memo.slice(0, 64));
    expect(await matchingCount(TENANT_A, memo)).toBe("0");
  }, 90_000);

  it("write-then-error (errors/after-write): non-success, exactly 1 row, lookup finds 1", async () => {
    const memo = "rote-step3-after-write";
    await control("errors/after-write");
    const result = await transfer(TENANT_A, { memo });
    await control("errors/off");

    expect(result.status).not.toBe("success");
    // Recorded in Step 3: the 503 lands after Submit, nothing recognizes it, and the run fails
    // reading the reference on step-12. Since Step 4 the result also says the commit may have
    // happened (commitUncertain), so no caller can mistake it for a safe-to-retry failure.
    expect(result).toMatchObject({
      status: "failure",
      category: "unexpected-state",
      atStepId: "step-12",
      commitUncertain: { irreversibleStepId: "step-11" },
    });
    const rows = await ledger();
    expect(rows.map((r) => r.memo)).toEqual([memo]);
    expect(await matchingCount(TENANT_A, memo)).toBe("1");
  }, 90_000);

  it("errors/on (503 before any write): the transfer fails and writes nothing", async () => {
    await control("errors/on");
    const result = await transfer(TENANT_A, { memo: "rote-step3-errors-on" });
    expect(result).toMatchObject({ status: "failure", category: "unexpected-state" });
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("transient interstitials on login and navigation steps are retried (transfer up to Submit, lookup end to end)", async () => {
    await control("transient/on");
    alternateTransient();

    const transferResult = await transfer(TENANT_A, { memo: "rote-step3-transient" }, false);
    expect(transferResult).toMatchObject({ status: "needs_human", atStepId: "step-11" });
    expect((await evidenceKinds(transferResult)).filter((k) => k === "recover").length).toBeGreaterThan(0);
    expect(await ledger()).toEqual([]);

    const lookupResult = await lookup(TENANT_C, "rote-step3-transient");
    expect(lookupResult).toMatchObject({ status: "success", outputs: { matchingCount: "0" } });
    expect((await evidenceKinds(lookupResult)).filter((k) => k === "recover").length).toBeGreaterThan(0);
  }, 90_000);

  it("tenant-c: `.zk9bv` matches exactly one element on the history page and the Submitted page", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const c = (p: string) => `${baseUrl}${TENANT_C.pathPrefix}${p}`;
      await page.goto(c("/login"));
      await page.locator("input[name=username]").fill("operator");
      await page.locator("input[name=password]").fill("operator");
      await page.getByText("Log In").click();
      await page.waitForURL(c("/"));

      await page.goto(c("/member/10001/history?memo=anything"));
      expect(await page.locator(".zk9bv").count()).toBe(1);

      await page.goto(c("/member/10001/transfer"));
      await page.locator("input[name=toMemberId]").fill("10002");
      await page.locator("input[name=amount]").fill("1.00");
      await page.locator("input[name=memo]").fill("rote-step3-zk9bv");
      await page.getByText("Continue").click();
      await page.getByText("Submit").click();
      await page.getByText("Transfer Submitted").waitFor();
      expect(await page.locator(".zk9bv").count()).toBe(1);
      expect((await page.locator(".zk9bv").innerText()).trim()).toBe((await ledger())[0]!.id);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
