// One-off, reproducible backfill for D30: adds approvedOverrideDigests (tenantId -> digest of every
// overrides/<id>.<tenant>.json) to every committed status/<id>.json, touching nothing else.
//
// It records an override's digest only where git shows the override UNCHANGED SINCE THE APPROVAL:
//   - the approval commit is the commit that introduced the status file's current approvedAt value
//     (`git log -S`), i.e. when the approval was actually given -- not a later metadata write such as
//     the D24 digest backfill;
//   - the commit that last changed the override file is an ancestor of that approval commit, and the
//     override file has no uncommitted changes;
//   - the status is approved, for the artifact's current version and digest.
// If any override of a capability fails, that capability is REFUSED and left without a map (it stays
// grandfathered, and the run-time reason says so); the script exits 1. A capability with no override
// files gets {} (no override approved).
//
// Usage: npx tsx scripts/backfill-approval-override-digests.ts [--check]   (--check writes nothing)
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { capabilityDigest } from "../src/artifact/index.js";
import { loadCapabilities } from "../src/catalog/registry.js";
import { readCapabilityStatus, serializeCapabilityStatus } from "../src/confidence/index.js";
import { tenantOverrideDigests } from "../src/tenant/index.js";

const CHECK_ONLY = process.argv.includes("--check");

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isAncestor(a: string, b: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const lines: string[] = [];
  let ok = true;
  const overrideFiles = (await readdir("overrides")).sort();
  for (const capability of await loadCapabilities()) {
    const statusFile = path.join("status", `${capability.id}.json`);
    const status = await readCapabilityStatus(capability.id);
    const problems: string[] = [];
    if (status.approvalStatus !== "approved" || !status.approvedAt) problems.push("not approved");
    if (status.approvedVersion !== capability.version) problems.push(`approvedVersion ${status.approvedVersion} != ${capability.version}`);
    if (status.approvedDigest !== capabilityDigest(capability)) problems.push("approvedDigest != artifact digest");

    // The commit that gave the approval: the one that introduced the current approvedAt value.
    const introducing = status.approvedAt
      ? git("log", "--format=%h", "-S", `"approvedAt": "${status.approvedAt}"`, "--", statusFile).split("\n").filter(Boolean)
      : [];
    const approvalCommit = introducing[introducing.length - 1];
    if (!approvalCommit) problems.push("cannot find the commit that wrote approvedAt");

    const digests = await tenantOverrideDigests(capability.id, "overrides");
    const files = overrideFiles.filter((f) => f.startsWith(`${capability.id}.`) && Object.hasOwn(digests, f.slice(capability.id.length + 1, -5)));
    const perFile: string[] = [];
    for (const file of files) {
      const rel = path.join("overrides", file);
      const lastChange = git("log", "-1", "--format=%h", "--", rel);
      const dirty = git("status", "--porcelain", "--", rel) !== "";
      const fileProblems: string[] = [];
      if (dirty) fileProblems.push("uncommitted changes");
      if (approvalCommit && !isAncestor(lastChange, approvalCommit)) {
        fileProblems.push(`last changed in ${lastChange}, AFTER the approval ${approvalCommit}`);
      }
      perFile.push(`    ${file}: digest ${digests[file.slice(capability.id.length + 1, -5)]}; last changed ${lastChange}; ${fileProblems.length ? `REFUSED: ${fileProblems.join("; ")}` : "unchanged since approval"}`);
      problems.push(...fileProblems.map((p) => `${file}: ${p}`));
    }
    if (status.approvedOverrideDigests !== undefined && JSON.stringify(status.approvedOverrideDigests) !== JSON.stringify(digests)) {
      problems.push(`existing approvedOverrideDigests differ from the files`);
    }
    lines.push(
      `${capability.id} ${capability.version}: approval written ${approvalCommit ?? "?"} (approvedAt ${status.approvedAt}); ` +
        `${files.length} override file(s); ${problems.length ? `REFUSED: ${problems.join("; ")}` : "ok"}`,
      ...perFile,
    );
    if (problems.length) {
      ok = false;
      continue;
    }
    if (!CHECK_ONLY && status.approvedOverrideDigests === undefined) {
      const before = await readFile(statusFile, "utf8");
      const after = serializeCapabilityStatus({ ...status, approvedOverrideDigests: digests });
      const afterObj = JSON.parse(after);
      delete afterObj.approvedOverrideDigests;
      if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(afterObj)) {
        throw new Error(`${statusFile}: re-serialization would change more than approvedOverrideDigests`);
      }
      await writeFile(statusFile, after, "utf8");
    }
  }
  for (const line of lines) console.log(line);
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  if (!ok) process.exitCode = 1;
}

await main();
