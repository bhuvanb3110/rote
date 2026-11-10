// One-off, reproducible backfill for D24: adds approvedDigest (capabilityDigest of the committed
// artifact) to every committed status/<id>.json, touching nothing else (approvedAt, approvedReason,
// approvedVersion and history stay byte-for-byte).
//
// It refuses (exit 1) unless, for every artifact:
//   - the status is approved and its approvedVersion equals the artifact's version, and
//   - git shows the artifact file was last changed in a commit that is an ancestor of the commit that
//     last wrote its status file (i.e. the approval was given to exactly the content on disk now), and
//   - the artifact file has no uncommitted changes.
// So the backfilled digest records what was actually approved, not merely what is on disk.
//
// Usage: npx tsx scripts/backfill-approval-digests.ts [--check]   (--check writes nothing)
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { capabilityDigest } from "../src/artifact/index.js";
import { loadCapabilities } from "../src/catalog/registry.js";
import { readCapabilityStatus, serializeCapabilityStatus } from "../src/confidence/index.js";

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
  for (const capability of await loadCapabilities()) {
    const artifactFile = path.join("artifacts", `${capability.id}.json`);
    const statusFile = path.join("status", `${capability.id}.json`);
    const status = await readCapabilityStatus(capability.id);
    const digest = capabilityDigest(capability);
    const artifactCommit = git("log", "-1", "--format=%h", "--", artifactFile);
    const statusCommit = git("log", "-1", "--format=%h", "--", statusFile);
    const dirty = git("status", "--porcelain", "--", artifactFile) !== "";
    const problems: string[] = [];
    if (status.approvalStatus !== "approved") problems.push("not approved");
    if (status.approvedVersion !== capability.version) {
      problems.push(`approvedVersion ${status.approvedVersion ?? "(none)"} != artifact ${capability.version}`);
    }
    if (dirty) problems.push("artifact has uncommitted changes");
    if (!isAncestor(artifactCommit, statusCommit)) {
      problems.push(`artifact last changed in ${artifactCommit}, which is not an ancestor of the approval ${statusCommit}`);
    }
    if (status.approvedDigest !== undefined && status.approvedDigest !== digest) {
      problems.push(`existing approvedDigest ${status.approvedDigest} != ${digest}`);
    }
    lines.push(
      `${capability.id} ${capability.version}: digest ${digest}; artifact last changed ${artifactCommit}, ` +
        `approval written ${statusCommit}; ${problems.length ? `REFUSED: ${problems.join("; ")}` : "ok"}`,
    );
    if (problems.length) {
      ok = false;
      continue;
    }
    if (!CHECK_ONLY && status.approvedDigest === undefined) {
      // Re-serialize through the schema; check that only the new field changed.
      const before = await readFile(statusFile, "utf8");
      const after = serializeCapabilityStatus({ ...status, approvedDigest: digest });
      const beforeObj = JSON.parse(before);
      const afterObj = JSON.parse(after);
      delete afterObj.approvedDigest;
      if (JSON.stringify(beforeObj) !== JSON.stringify(afterObj)) {
        throw new Error(`${statusFile}: re-serialization would change more than approvedDigest`);
      }
      await writeFile(statusFile, after, "utf8");
    }
  }
  for (const line of lines) console.log(line);
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  if (!ok) process.exitCode = 1;
}

await main();
