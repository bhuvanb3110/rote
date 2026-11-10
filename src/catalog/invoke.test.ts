// invokeCapability passes the fleet options (browser, onIrreversible, signal, evidenceBaseDir,
// statusDir) through to runReplay (docs/plans/step-04.md, reviewer decision 5). Workers call
// invokeCapability -- it resolves tenant overrides -- so this drives the same path a worker will:
// a tenant-b transfer through a temp artifacts dir and the real tenant-b override re-pointed at the
// ephemeral bank, checked against the bank's ledger.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../mock-app/app.js";
import { approveCapability } from "../confidence/index.js";
import { WebSurface } from "../surface/index.js";
import { invokeCapability, type InvokeCapabilityOptions } from "./invoke.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../..");

let server: Server;
let baseUrl: string;
let browser: Browser;
let workDir: string;
let artifactsDir: string;
let overridesDir: string;
let statusDir: string;

async function ledger(): Promise<Array<{ tenantId: string; memo: string }>> {
  return ((await (await fetch(`${baseUrl}/control/ledger`)).json()) as { entries: Array<{ tenantId: string; memo: string }> }).entries;
}

function invokeTransfer(memo: string, extra: Partial<InvokeCapabilityOptions>) {
  return invokeCapability({
    id: "transfer",
    tenant: "tenant-b",
    params: { username: "operator", password: "operator", memberId: "10001", toMemberId: "10002", amount: "5.00", memo },
    artifactsDir,
    overridesDir,
    headless: true, // what invokeCapability's callers always pass; ignored with a browser
    approveRisky: true,
    ...extra,
  });
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });

  workDir = await mkdtemp(path.join(tmpdir(), "rote-invoke-"));
  artifactsDir = path.join(workDir, "artifacts");
  overridesDir = path.join(workDir, "overrides");
  statusDir = path.join(workDir, "status");
  await Promise.all([mkdir(artifactsDir), mkdir(overridesDir), mkdir(statusDir)]);

  const artifact = JSON.parse(await readFile(path.join(repo, "artifacts/transfer.json"), "utf8"));
  artifact.target.entryUrlPattern = "^http://localhost:\\d+/";
  await writeFile(path.join(artifactsDir, "transfer.json"), JSON.stringify(artifact));
  const override = JSON.parse(await readFile(path.join(repo, "overrides/transfer.tenant-b.json"), "utf8"));
  override.entryUrl = `${baseUrl}/tenant-b/`;
  await writeFile(path.join(overridesDir, "transfer.tenant-b.json"), JSON.stringify(override));
  await approveCapability("transfer", {
    version: artifact.version,
    statusDir,
    reason: "test-only approval in a temp statusDir",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fetch(`${baseUrl}/control/ledger/reset`);
  expect(browser.isConnected()).toBe(true);
  expect(browser.contexts()).toHaveLength(0);
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

describe("invokeCapability passes the fleet options through to runReplay", () => {
  it("browser, onIrreversible, signal, evidenceBaseDir and statusDir all reach replay (tenant-b transfer)", async () => {
    const evidenceBaseDir = path.join(workDir, "evidence-1");
    const launch = vi.spyOn(WebSurface, "launch");
    const calls: string[] = [];
    const result = await invokeTransfer("rote-s4-invoke", {
      browser,
      onIrreversible: {
        before: async (step) => void calls.push(`before:${step.id}`),
        after: async (step) => void calls.push(`after:${step.id}`),
      },
      signal: new AbortController().signal,
      evidenceBaseDir,
      statusDir,
    });

    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ browser }));
    expect(calls).toEqual(["before:step-11", "after:step-11"]);
    expect(result.status === "success" && result.evidenceRef).toContain(evidenceBaseDir.replace(/\\/g, "/"));
    expect(await readdir(evidenceBaseDir)).toHaveLength(1);
    expect(await ledger()).toEqual([expect.objectContaining({ tenantId: "tenant-b", memo: "rote-s4-invoke" })]);
  }, 60_000);

  it("statusDir is the one consulted: an empty one refuses the run before any browser (needs_human)", async () => {
    const emptyStatusDir = await mkdtemp(path.join(workDir, "status-empty-"));
    const launch = vi.spyOn(WebSurface, "launch");
    const result = await invokeTransfer("rote-s4-invoke-unapproved", { browser, statusDir: emptyStatusDir });
    // The committed status/transfer.json IS approved, so this proves the temp dir was used.
    expect(result).toMatchObject({ status: "needs_human", atStepId: "step-01" });
    expect(launch).not.toHaveBeenCalled();
    expect(await ledger()).toEqual([]);
  });

  it("an aborted signal rejects with its reason before any browser", async () => {
    const launch = vi.spyOn(WebSurface, "launch");
    const ac = new AbortController();
    const reason = new Error("lease lost before start");
    ac.abort(reason);
    await expect(invokeTransfer("rote-s4-invoke-aborted", { browser, statusDir, signal: ac.signal })).rejects.toBe(reason);
    expect(launch).not.toHaveBeenCalled();
  });
});
