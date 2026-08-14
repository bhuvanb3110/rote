import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { applyTenantOverride } from "./apply.js";
import { deserializeTenantOverride } from "./types.js";

async function loadJson(relativePath: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.join(here, relativePath), "utf8");
}

describe("applyTenantOverride", () => {
  it("reuses the base descriptor untouched for any step not named in stepOverrides", async () => {
    const base = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
    const override = deserializeTenantOverride(
      await loadJson("../../overrides/member-lookup.tenant-b.json"),
    );
    const effective = applyTenantOverride(base, override);

    const untouchedStepIds = ["step-01", "step-02", "step-03", "step-04"];
    for (const id of untouchedStepIds) {
      const baseStep = base.steps.find((s) => s.id === id)!;
      const effectiveStep = effective.steps.find((s) => s.id === id)!;
      expect(effectiveStep.target).toEqual(baseStep.target);
    }
  });

  it("replaces the target for exactly the steps named in stepOverrides", async () => {
    const base = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
    const override = deserializeTenantOverride(
      await loadJson("../../overrides/member-lookup.tenant-b.json"),
    );
    const effective = applyTenantOverride(base, override);

    const step05 = effective.steps.find((s) => s.id === "step-05")!;
    expect(step05.target?.describedAs).toBe("Find Member button");
    const step06 = effective.steps.find((s) => s.id === "step-06")!;
    expect(step06.target?.describedAs).toBe("Savings Balance value cell");
  });

  it("never mutates the base capability object", async () => {
    const base = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
    const originalStep05Target = base.steps.find((s) => s.id === "step-05")!.target;
    const override = deserializeTenantOverride(
      await loadJson("../../overrides/member-lookup.tenant-b.json"),
    );
    applyTenantOverride(base, override);
    expect(base.steps.find((s) => s.id === "step-05")!.target).toBe(originalStep05Target);
  });

  it("returns a fully schema-valid Capability", async () => {
    const base = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
    const override = deserializeTenantOverride(
      await loadJson("../../overrides/member-lookup.tenant-b.json"),
    );
    // applyTenantOverride itself parses through CapabilitySchema -- a throw here would mean the
    // override produced something invalid.
    expect(() => applyTenantOverride(base, override)).not.toThrow();
  });

  it("rejects an override authored for a different capability id", async () => {
    const base = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
    const mismatched = {
      tenantId: "tenant-b",
      capabilityId: "some-other-capability",
      entryUrl: "http://localhost:4100/tenant-b/",
      stepOverrides: {},
    };
    expect(() => applyTenantOverride(base, mismatched)).toThrow(/is for capability/);
  });

  it("a no-op override (empty stepOverrides) reproduces the base capability's steps exactly", async () => {
    const base = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
    const override = deserializeTenantOverride(
      await loadJson("../../overrides/member-lookup.tenant-a.json"),
    );
    const effective: Capability = applyTenantOverride(base, override);
    expect(effective.steps).toEqual(base.steps);
  });
});
