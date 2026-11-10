// checkApproval is bound to the artifact version (docs/DECISIONS.md D15) AND its content digest
// (D24): match, version mismatch, content change with the same version, a formatting-only change
// (still allowed), missing digest (version fallback, grandfathered), missing version, draft, and
// the per-run approveUnattended opt-in.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { capabilityDigest, deserializeCapability, type Capability } from "../artifact/index.js";
import { checkApproval } from "./approval.js";
import { approvalKey, approveCapability } from "./store.js";

let statusDir: string;
let rawArtifact: Record<string, unknown>;
let cap: Capability;

/** The committed transfer artifact, renamed "cap", at a chosen version. */
function capAt(version: string): Capability {
  return { ...cap, version };
}

beforeAll(async () => {
  rawArtifact = JSON.parse(await readFile(path.join("artifacts", "transfer.json"), "utf8"));
  rawArtifact.id = "cap";
  cap = deserializeCapability(JSON.stringify(rawArtifact));
});

beforeEach(async () => {
  statusDir = await mkdtemp(path.join(tmpdir(), "approval-gate-test-"));
});

afterEach(async () => {
  await rm(statusDir, { recursive: true, force: true });
});

/** Recursively reverses key order at every level (arrays keep their order: it is meaningful). */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
}

describe("checkApproval: version (D15)", () => {
  it("match: approved for 1.1.0 with this content, artifact is 1.1.0 -> allowed", async () => {
    await approveCapability("cap", { ...approvalKey(capAt("1.1.0")), reason: "ok", statusDir });
    const decision = await checkApproval(capAt("1.1.0"), { statusDir });
    expect(decision).toEqual({
      allowed: true,
      reason: `Capability "cap" is approved for unattended replay at version 1.1.0 (content digest matches).`,
    });
  });

  it("mismatch: approved for 1.0.0, artifact is 1.1.0 -> not allowed, says re-approve", async () => {
    await approveCapability("cap", { ...approvalKey(capAt("1.0.0")), reason: "ok", statusDir });
    const decision = await checkApproval(capAt("1.1.0"), { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("approved for 1.0.0, artifact is 1.1.0; re-approve");
  });

  it("mismatch also refuses a DOWNGRADE (approved for 1.1.0, artifact is 1.0.0)", async () => {
    await approveCapability("cap", { ...approvalKey(capAt("1.1.0")), reason: "ok", statusDir });
    const decision = await checkApproval(capAt("1.0.0"), { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("approved for 1.1.0, artifact is 1.0.0; re-approve");
  });

  it("missing approvedVersion and approvedDigest (grandfathered) -> allowed, and the reason says so", async () => {
    await writeFile(
      path.join(statusDir, "cap.json"),
      JSON.stringify({
        capabilityId: "cap",
        approvalStatus: "approved",
        history: [],
        approvedAt: "2026-09-03T20:53:01.785Z",
        approvedReason: "Grandfathered: pre-existing artifact",
      }),
    );
    const decision = await checkApproval(capAt("1.0.0"), { statusDir });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/grandfathered/);
    expect(decision.reason).toMatch(/no approvedVersion/);
    expect(decision.reason).toMatch(/artifact is 1\.0\.0/);
  });

  it("draft (no status file) -> not allowed", async () => {
    const decision = await checkApproval({ ...cap, id: "never-seen" }, { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/draft/);
  });

  it("approveUnattended allows a stale approval for this one run, without reading status", async () => {
    await approveCapability("cap", { ...approvalKey(capAt("1.0.0")), reason: "ok", statusDir });
    const decision = await checkApproval(capAt("1.1.0"), { statusDir, approveUnattended: true });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/approveUnattended/);
  });
});

describe("checkApproval: content digest (D24)", () => {
  it("digest match -> allowed", async () => {
    await approveCapability("cap", { ...approvalKey(cap), reason: "ok", statusDir });
    const decision = await checkApproval(cap, { statusDir });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("content digest matches");
  });

  it("content change with the SAME version -> refused: content changed since approval", async () => {
    await approveCapability("cap", { ...approvalKey(cap), reason: "ok", statusDir });
    const raw = structuredClone(rawArtifact) as { steps: Array<{ intent: string }> };
    raw.steps[0]!.intent = `${raw.steps[0]!.intent} -- edited without a version bump`;
    const edited = deserializeCapability(JSON.stringify(raw));
    expect(edited.version).toBe(cap.version);

    const decision = await checkApproval(edited, { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("artifact content changed since approval; re-approve");
    expect(decision.reason).toContain(capabilityDigest(cap));
    expect(decision.reason).toContain(capabilityDigest(edited));
  });

  it("whitespace, line endings and key order change nothing -> still allowed", async () => {
    await approveCapability("cap", { ...approvalKey(cap), reason: "ok", statusDir });
    const reformatted = JSON.stringify(reverseKeys(rawArtifact), null, "\t").replace(/\n/g, "\r\n   ");
    expect(reformatted).not.toBe(JSON.stringify(rawArtifact, null, 2));
    const fromReformatted = deserializeCapability(reformatted);

    expect(capabilityDigest(fromReformatted)).toBe(capabilityDigest(cap));
    const decision = await checkApproval(fromReformatted, { statusDir });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("content digest matches");
  });

  it("missing approvedDigest -> falls back to the version check (grandfathered), and the reason says so", async () => {
    await writeFile(
      path.join(statusDir, "cap.json"),
      JSON.stringify({ capabilityId: "cap", approvalStatus: "approved", history: [], approvedVersion: cap.version }),
    );
    const allowed = await checkApproval(cap, { statusDir });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toMatch(/grandfathered approval that records no approvedDigest/);
    expect(allowed.reason).toMatch(/only the version was checked/);

    // The fallback still enforces the version.
    const refused = await checkApproval(capAt("9.9.9"), { statusDir });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain(`approved for ${cap.version}, artifact is 9.9.9; re-approve`);
  });
});
