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
import { approvalKey, approveCapability } from "../confidence/index.js";
import { EscalationController } from "../escalation/index.js";
import { buildPolicyForOrigin, policyGate } from "../safety/index.js";
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

/**
 * The relaxed committed base of a replayed capability: what the temp statusDir approves (D24) and
 * what every run here passes as approvalArtifact. Tests replay copies edited the way a tenant
 * override edits them (overrides applied, a gate-blind Submit, a step's risk); the approval stays on
 * the base, exactly as invokeCapability passes the base.
 */
function baseOf(capability: Capability): Capability {
  const bases: Record<string, Capability> = {
    transfer: transferBase,
    "transfer-history-lookup": lookupBase,
    "member-lookup": memberLookup,
  };
  return relaxed(bases[capability.id]!);
}

type TransferFields ={ memberId?: string; toMemberId?: string; amount?: string; memo: string };

/** A transfer on tenant-a through the shared browser, with approveRisky on unless overridden. */
async function transfer(fields: TransferFields, extra: Partial<ReplayOptions> = {}): Promise<ReplayResult> {
  const { capability, entryUrl } = await forTenant(transferBase, TENANT_A);
  return runReplay({
    capability, approvalArtifact: baseOf(capability),
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
  const result = await runReplay({ capability, approvalArtifact: baseOf(capability), entryUrl, params: { ...CREDS, memberId: "10001", memo }, statusDir, browser });
  expect(result.status, JSON.stringify(result)).toBe("success");
  return result.status === "success" ? String(result.outputs.matchingCount) : "";
}

/** `base` with step `stepId` replaced by `patch(step)`. */
function withStep(base: Capability, stepId: string, patch: (step: Capability["steps"][number]) => Capability["steps"][number]): Capability {
  return { ...base, steps: base.steps.map((s) => (s.id === stepId ? patch(s) : s)) };
}

/**
 * Transfer on tenant-a whose step-11 looks like a careless tenant override: no roleName "Submit",
 * only a textAnchor, described as "Submit control". The live gate reads describedAs and says safe.
 */
async function transferWithGateBlindSubmit(): Promise<{ capability: Capability; entryUrl: string }> {
  const { capability, entryUrl } = await forTenant(transferBase, TENANT_A);
  return {
    entryUrl,
    capability: withStep(capability, "step-11", (s) => ({
      ...s,
      target: { describedAs: "Submit control", strategies: [{ kind: "textAnchor", anchorText: "Submit", confidence: 0.6 }] },
    })),
  };
}

function gateRisk(capability: Capability, stepId: string): "safe" | "risky" {
  const step = capability.steps.find((s) => s.id === stepId)!;
  return policyGate({ kind: "click", target: step.target }, { policy: buildPolicyForOrigin(baseUrl), currentUrl: `${baseUrl}/` }).risk;
}

type HookCall = { hook: "before" | "after"; stepId: string; ledgerRows: number };

/**
 * onIrreversible hooks that record each call with the ledger size AT that moment, then run the
 * optional extra behavior (arm a fault, throw, abort...).
 */
function recordingHooks(extra: { before?: () => Promise<void>; after?: () => Promise<void> } = {}) {
  const calls: HookCall[] = [];
  const hooks: NonNullable<ReplayOptions["onIrreversible"]> = {
    before: async (step) => {
      calls.push({ hook: "before", stepId: step.id, ledgerRows: (await ledger()).length });
      await extra.before?.();
    },
    after: async (step) => {
      calls.push({ hook: "after", stepId: step.id, ledgerRows: (await ledger()).length });
      await extra.after?.();
    },
  };
  return { calls, hooks };
}

async function waitForPendingRequest(controller: EscalationController, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (controller.pendingRequest) return controller.pendingRequest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no intervention request within ${timeoutMs}ms`);
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
  for (const capability of [memberLookup, transferBase, lookupBase]) {
    await approveCapability(capability.id, {
      ...approvalKey(relaxed(capability)),
      statusDir,
      reason: "test-only approval in a temp statusDir",
    });
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

describe("irreversibility hardening: gate risky OR artifact risky", () => {
  it("gate says safe, artifact says risky: refused without approveRisky (0 rows); runs with it (1 row)", async () => {
    const { capability, entryUrl } = await transferWithGateBlindSubmit();
    expect(gateRisk(capability, "step-11")).toBe("safe");
    const params = { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", memo: "rote-s4-hardening" };

    const refused = await runReplay({ capability, approvalArtifact: baseOf(capability), entryUrl, params, statusDir, browser });
    expect(refused).toMatchObject({ status: "needs_human", atStepId: "step-11" });
    expect(await ledger()).toEqual([]);
    const blocked = (await evidenceLog(refused)).find((e) => e.kind === "blocked");
    expect(blocked?.detail.riskSources).toEqual({ gate: "safe", artifact: "risky" });

    const approved = await runReplay({ capability, approvalArtifact: baseOf(capability), entryUrl, params, statusDir, browser, approveRisky: true });
    expect(approved.status, JSON.stringify(approved)).toBe("success");
    expect((await ledger()).map((r) => r.memo)).toEqual(["rote-s4-hardening"]);
    const riskApproved = (await evidenceLog(approved)).find((e) => e.kind === "risk_approved");
    expect(riskApproved?.detail).toMatchObject({ stepId: "step-11", riskSources: { gate: "safe", artifact: "risky" } });
  }, 60_000);

  it("artifact says safe, gate says risky: still irreversible (today's behavior, pinned)", async () => {
    const { capability: base, entryUrl } = await forTenant(transferBase, TENANT_A);
    const capability = withStep(base, "step-11", (s) => ({ ...s, risk: "safe" }));
    expect(gateRisk(capability, "step-11")).toBe("risky");
    const result = await runReplay({
      capability, approvalArtifact: baseOf(capability),
      entryUrl,
      params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", memo: "rote-s4-converse" },
      statusDir,
      browser,
    });
    expect(result).toMatchObject({ status: "needs_human", atStepId: "step-11" });
    const blocked = (await evidenceLog(result)).find((e) => e.kind === "blocked");
    expect(blocked?.detail.riskSources).toEqual({ gate: "risky", artifact: "safe" });
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("gate-blind Submit with approveRisky still goes through onIrreversible.before", async () => {
    const { capability, entryUrl } = await transferWithGateBlindSubmit();
    const { calls, hooks } = recordingHooks();
    const result = await runReplay({
      capability, approvalArtifact: baseOf(capability),
      entryUrl,
      params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", memo: "rote-s4-blind-hooks" },
      statusDir,
      browser,
      approveRisky: true,
      onIrreversible: hooks,
    });
    expect(result.status).toBe("success");
    expect(calls.map((c) => [c.hook, c.stepId])).toEqual([["before", "step-11"], ["after", "step-11"]]);
  }, 60_000);
});

describe("onIrreversible hooks", () => {
  it("before then after, once each, on step-11; after() runs once the bank answered (ledger already has the row)", async () => {
    const { calls, hooks } = recordingHooks();
    const result = await transfer({ memo: "rote-s4-hooks" }, { onIrreversible: hooks });
    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(calls).toEqual([
      { hook: "before", stepId: "step-11", ledgerRows: 0 },
      { hook: "after", stepId: "step-11", ledgerRows: 1 },
    ]);
    const settle = (await evidenceLog(result)).filter((e) => e.kind === "irreversible_settle");
    expect(settle).toHaveLength(1);
    expect(settle[0]!.detail).toMatchObject({ stepId: "step-11", loaded: true, timeoutMs: 10_000 });
  }, 60_000);

  it("before() throws: runReplay rejects with that same error, the click never happens, after() never runs", async () => {
    const fencing = new Error("fencing token mismatch: lease lost");
    const { calls, hooks } = recordingHooks({ before: async () => { throw fencing; } });
    await expect(transfer({ memo: "rote-s4-before-throws" }, { onIrreversible: hooks })).rejects.toBe(fencing);
    expect(calls.map((c) => c.hook)).toEqual(["before"]);
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("after() throws: runReplay rejects with that error and the click happened (exactly 1 row)", async () => {
    const crash = new Error("simulated crash after submit");
    const { calls, hooks } = recordingHooks({ after: async () => { throw crash; } });
    await expect(transfer({ memo: "rote-s4-after-throws" }, { onIrreversible: hooks })).rejects.toBe(crash);
    expect(calls.map((c) => [c.hook, c.ledgerRows])).toEqual([["before", 0], ["after", 1]]);
    expect((await ledger()).map((r) => r.memo)).toEqual(["rote-s4-after-throws"]);
  }, 60_000);

  it("no hooks for an all-safe capability, nor for a transfer without approveRisky", async () => {
    const { calls, hooks } = recordingHooks();
    const { capability, entryUrl } = await forTenant(lookupBase, TENANT_A);
    const lookupResult = await runReplay({
      capability, approvalArtifact: baseOf(capability), entryUrl, params: { ...CREDS, memberId: "10001", memo: "x" }, statusDir, browser, approveRisky: true, onIrreversible: hooks,
    });
    expect(lookupResult.status).toBe("success");
    const unapproved = await transfer({ memo: "rote-s4-unapproved" }, { approveRisky: false, onIrreversible: hooks });
    expect(unapproved).toMatchObject({ status: "needs_human", atStepId: "step-11" });
    expect(calls).toEqual([]);
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("no navigation after the irreversible action: the bounded wait times out, is noted in evidence, after() still runs", async () => {
    // A non-navigating step marked risky in the artifact (hardening makes it irreversible).
    const capability = withStep(memberLookup, memberLookup.steps[0]!.id, (s) => ({ ...s, risk: "risky" }));
    const { calls, hooks } = recordingHooks();
    const result = await runReplay({
      capability, approvalArtifact: baseOf(capability), entryUrl: baseUrl, params: { ...CREDS, memberId: "10001" }, statusDir, browser, approveRisky: true, onIrreversible: hooks,
    });
    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(calls.map((c) => c.hook)).toEqual(["before", "after"]);
    const settle = (await evidenceLog(result)).find((e) => e.kind === "irreversible_settle");
    expect(settle?.detail).toMatchObject({ loaded: false, timeoutMs: 10_000 });
    expect(String(settle?.detail.reason)).toMatch(/Timeout/i);
  }, 60_000);
});

describe("after an irreversible action has been attempted", () => {
  const AFTER_SUBMIT = new Set(["step-11", "step-12"]);

  it("transient interstitial right after Submit: no reload (no re-POST), non-success with commitUncertain, 0 rows", async () => {
    const memo = "rote-s4-transient-after-submit";
    const { hooks } = recordingHooks({ before: () => control("transient/next") });
    const result = await transfer({ memo }, { onIrreversible: hooks });
    const log = await evidenceLog(result);
    const rows = await ledger();
    const diagnosis = JSON.stringify({ result, rows: rows.length, recover: log.filter((e) => e.kind === "recover") });

    expect(result.status, diagnosis).not.toBe("success");
    expect(rows, diagnosis).toEqual([]);
    expect(result, diagnosis).toMatchObject({ commitUncertain: { irreversibleStepId: "step-11" } });
    // Proves no reload: no recovery attempt at or after the irreversible step.
    expect(log.filter((e) => e.kind === "recover" && AFTER_SUBMIT.has(String(e.detail.stepId))), diagnosis).toEqual([]);
    expect(result).toMatchObject({ status: "failure", atStepId: "step-11", category: "unexpected-state" });
  }, 60_000);

  it("transient interstitial BEFORE Submit still recovers (the rules apply only after the attempt)", async () => {
    await control("transient/next"); // hits the first authenticated request: the post-login landing page
    const result = await transfer({ memo: "rote-s4-transient-before" });
    expect(result.status, JSON.stringify(result)).toBe("success");
    const recovers = (await evidenceLog(result)).filter((e) => e.kind === "recover");
    expect(recovers.map((e) => e.detail.stepId)).toEqual(["step-03"]);
    expect((await ledger()).map((r) => r.memo)).toEqual(["rote-s4-transient-before"]);
  }, 60_000);

  it("503 right after Submit, before the write (errors/on armed in before()): failure + commitUncertain, 0 rows", async () => {
    const { hooks } = recordingHooks({ before: () => control("errors/on") });
    const result = await transfer({ memo: "rote-s4-503-no-write" }, { onIrreversible: hooks });
    expect(result).toMatchObject({ status: "failure", commitUncertain: { irreversibleStepId: "step-11" } });
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("503 right after Submit, after the write (errors/after-write): failure + commitUncertain, 1 row, lookup finds 1", async () => {
    const memo = "rote-s4-503-after-write";
    const { hooks } = recordingHooks({ before: () => control("errors/after-write") });
    const result = await transfer({ memo }, { onIrreversible: hooks });
    await control("errors/off");
    expect(result).toMatchObject({ status: "failure", commitUncertain: { irreversibleStepId: "step-11" } });
    if (result.status === "failure") expect(result.commitUncertain?.detail).toContain("failure (unexpected-state) at step-12");
    expect((await ledger()).map((r) => r.memo)).toEqual([memo]);
    expect(await matchingCount(memo)).toBe("1");
  }, 90_000);

  it("a business_outcome after the attempt carries commitUncertain too", async () => {
    // Test-only outcome so the bank's 503 page is recognized as a business outcome after Submit.
    const { capability: base, entryUrl } = await forTenant(transferBase, TENANT_A);
    const capability: Capability = {
      ...base,
      knownOutcomes: [...base.knownOutcomes, { code: "BANK_DOWN", recognizer: { kind: "textPresent", text: "System unavailable" }, detail: "503" }],
    };
    const { hooks } = recordingHooks({ before: () => control("errors/on") });
    const result = await runReplay({
      capability, approvalArtifact: baseOf(capability),
      entryUrl,
      params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", memo: "rote-s4-bo-after" },
      statusDir,
      browser,
      approveRisky: true,
      onIrreversible: hooks,
    });
    expect(result).toMatchObject({ status: "business_outcome", code: "BANK_DOWN", commitUncertain: { irreversibleStepId: "step-11" } });
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it("business outcomes BEFORE the attempt carry no marker (a blind retry is safe)", async () => {
    const result = await transfer({ memo: "rote-s4-bo-before", amount: "999999.00" });
    expect(result).toMatchObject({ status: "business_outcome", code: "INSUFFICIENT_FUNDS" });
    expect(result).not.toHaveProperty("commitUncertain");
  }, 60_000);

  it("a throw after the attempt becomes failure/unknown with the marker (not an exception)", async () => {
    let submitted = false;
    const realPerceive = WebSurface.prototype.perceive;
    vi.spyOn(WebSurface.prototype, "perceive").mockImplementation(async function (this: WebSurface) {
      if (submitted) throw new Error("page.screenshot: simulated third failure");
      return realPerceive.call(this);
    });
    const { hooks } = recordingHooks({ after: async () => { submitted = true; } });
    const result = await transfer({ memo: "rote-s4-throw-after" }, { onIrreversible: hooks });
    expect(result).toMatchObject({
      status: "failure",
      category: "unknown",
      atStepId: "step-11",
      commitUncertain: { irreversibleStepId: "step-11" },
    });
    if (result.status === "failure") expect(result.observed).toContain("simulated third failure");
    expect(await ledger()).toHaveLength(1);
  }, 60_000);

  it("operator mode: a no-op hand-back after a failed irreversible step ends in needs_human, never a second click", async () => {
    const { capability: base, entryUrl } = await forTenant(transferBase, TENANT_A);
    // Give step-11 a checkpoint, so the 503-after-write page fails it ON the irreversible step.
    const capability = withStep(base, "step-11", (s) => ({ ...s, checkpoint: { kind: "textPresent", text: "Transfer Submitted" } }));
    const controller = new EscalationController();
    const { calls, hooks } = recordingHooks({ before: () => control("errors/after-write") });
    const pending = runReplay({
      capability, approvalArtifact: baseOf(capability),
      entryUrl,
      params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "12.34", memo: "rote-s4-operator" },
      statusDir,
      browser,
      approveRisky: true,
      onIrreversible: hooks,
      controller,
    });
    const request = await waitForPendingRequest(controller);
    expect(request.atStepId).toBe("step-11");
    expect(request.reason).toContain('irreversible step "step-11" was already attempted');
    await controller.handBack("did nothing"); // -> "retry", which must not re-click Submit

    const result = await pending;
    expect(result).toMatchObject({ status: "needs_human", atStepId: "step-11", commitUncertain: { irreversibleStepId: "step-11" } });
    expect(calls.map((c) => c.hook)).toEqual(["before", "after"]);
    expect(await ledger()).toHaveLength(1);
  }, 60_000);
});

describe("signal: abort always rejects, closes the context at once, records nothing but an `aborted` entry", () => {
  /** Evidence of the single run written under `baseDir`. */
  async function onlyRunLog(baseDir: string): Promise<Array<{ kind: string; detail: Record<string, unknown> }>> {
    const runs = await readdir(baseDir);
    expect(runs).toHaveLength(1);
    const log = await readFile(path.join(baseDir, runs[0]!, "run.jsonl"), "utf8");
    return log.trim().split("\n").map((line) => JSON.parse(line));
  }

  it("already aborted: rejects with signal.reason before any evidence, browser or context", async () => {
    const evidenceBaseDir = await mkdtemp(path.join(tmpdir(), "rote-fleet-abort-"));
    try {
      const launch = vi.spyOn(WebSurface, "launch");
      const ac = new AbortController();
      const leaseLost = new Error("lease lost");
      ac.abort(leaseLost);
      await expect(transfer({ memo: "rote-s4-pre-aborted" }, { signal: ac.signal, evidenceBaseDir })).rejects.toBe(leaseLost);
      expect(launch).not.toHaveBeenCalled();
      expect(await readdir(evidenceBaseDir)).toEqual([]);
    } finally {
      await rm(evidenceBaseDir, { recursive: true, force: true });
    }
  });

  it("abort during a slow step (bank latency 3 s): AbortError well under 3 s, shared browser up with 0 contexts, 0 rows", async () => {
    const evidenceBaseDir = await mkdtemp(path.join(tmpdir(), "rote-fleet-abort-"));
    try {
      await control("latency/3000");
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 1000);
      const error = await transfer({ memo: "rote-s4-abort-slow" }, { signal: ac.signal, evidenceBaseDir }).then(
        (r) => { throw new Error(`expected a rejection, got ${JSON.stringify(r)}`); },
        (e: unknown) => e,
      );
      const elapsed = Date.now() - started;
      expect((error as DOMException).name).toBe("AbortError");
      expect(elapsed).toBeLessThan(2_500);
      const log = await onlyRunLog(evidenceBaseDir);
      expect(log.map((e) => e.kind)).toContain("aborted");
      expect(log.map((e) => e.kind)).not.toContain("result");
      expect(log.find((e) => e.kind === "aborted")?.detail).toMatchObject({ irreversibleAttempted: null });
      await control("latency/0");
      expect(await ledger()).toEqual([]);
      // afterEach: browser connected, 0 contexts.
    } finally {
      await rm(evidenceBaseDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("abort inside after() (the click happened): still rejects with AbortError, 1 row, aborted entry names step-11", async () => {
    const evidenceBaseDir = await mkdtemp(path.join(tmpdir(), "rote-fleet-abort-"));
    try {
      const ac = new AbortController();
      const { calls, hooks } = recordingHooks({ after: async () => ac.abort() });
      await expect(
        transfer({ memo: "rote-s4-abort-after" }, { signal: ac.signal, evidenceBaseDir, onIrreversible: hooks }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(calls.map((c) => c.hook)).toEqual(["before", "after"]);
      expect(await ledger()).toHaveLength(1); // the verifier's job, not replay's
      const log = await onlyRunLog(evidenceBaseDir);
      expect(log.find((e) => e.kind === "aborted")?.detail).toMatchObject({ irreversibleAttempted: { stepId: "step-11" } });
      expect(log.map((e) => e.kind)).not.toContain("result");
    } finally {
      await rm(evidenceBaseDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("abort without a shared browser closes the browser replay launched, and still rejects", async () => {
    await control("latency/3000");
    const close = vi.spyOn(WebSurface.prototype, "close");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1000);
    const { capability, entryUrl } = await forTenant(transferBase, TENANT_A);
    await expect(
      runReplay({
        capability, approvalArtifact: baseOf(capability),
        entryUrl,
        params: { ...CREDS, memberId: "10001", toMemberId: "10002", amount: "1.00", memo: "rote-s4-abort-owned" },
        statusDir,
        approveRisky: true,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("the abort listener is removed when the run ends (no leak on a long-lived worker)", async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const result = await runReplay({ capability: memberLookup, entryUrl: baseUrl, params: { ...CREDS, memberId: "10001" }, statusDir, browser, signal: ac.signal });
    expect(result.status).toBe("success");
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
  }, 30_000);
});
