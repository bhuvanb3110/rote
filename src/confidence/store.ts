// Per-capability approval status + confidence run history, one flat JSON sidecar file per
// capability under status/ -- same convention as overrides/<capabilityId>.<tenant>.json. No
// database: a capability transitions draft -> approved once its history's tail has enough
// consecutive runs at or above the confidence threshold, or a human overrides with a reason.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { capabilityDigest, type Capability } from "../artifact/index.js";
import {
  deserializeCapabilityStatus,
  serializeCapabilityStatus,
  type CapabilityStatus,
  type ConfidenceRunRecord,
} from "./types.js";

export const DEFAULT_STATUS_DIR = "status";
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_REQUIRED_CONSECUTIVE_RUNS = 3;

function statusPath(capabilityId: string, statusDir: string): string {
  return path.join(statusDir, `${capabilityId}.json`);
}

/** No sidecar file found -- a fresh, never-seen capability -- returns the draft default. */
export async function readCapabilityStatus(
  capabilityId: string,
  statusDir: string = DEFAULT_STATUS_DIR,
): Promise<CapabilityStatus> {
  try {
    const json = await readFile(statusPath(capabilityId, statusDir), "utf8");
    return deserializeCapabilityStatus(json);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { capabilityId, approvalStatus: "draft", history: [] };
    }
    throw err;
  }
}

/**
 * Writes via a temp file + rename so a concurrent reader (a second replay of the same capability
 * racing this one -- e.g. two test files touching the same real, grandfathered status/*.json in
 * parallel workers) never observes a truncated/partial write. rename() is atomic on the same
 * volume. This does NOT solve the read-modify-write "lost update" race (two writers reading the
 * same old state and each appending their own run could still drop one entry) -- a real file
 * lock or single-writer queue would, but this file store predates the fleet (which keeps its state in
 * Postgres, docs/DECISIONS.md D2) and fleet workers never write it (D7); the honest limit is a lost history entry under true concurrent writes, not corrupt
 * JSON.
 */
async function writeCapabilityStatus(status: CapabilityStatus, statusDir: string): Promise<void> {
  await mkdir(statusDir, { recursive: true });
  const finalPath = statusPath(status.capabilityId, statusDir);
  const tmpPath = path.join(statusDir, `.${status.capabilityId}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, serializeCapabilityStatus(status), "utf8");
  await rename(tmpPath, finalPath);
}

/**
 * What an approval is bound to: the artifact's version (D15) and the SHA-256 of its canonical JSON
 * (D24). Every approval records both; every check compares both.
 */
export interface ApprovalKey {
  version: string;
  digest: string;
}

/** The approval key of an artifact as it is now. */
export function approvalKey(capability: Capability): ApprovalKey {
  return { version: capability.version, digest: capabilityDigest(capability) };
}

/**
 * True when `status` lets the artifact with this key replay unattended: approved, and the approval
 * names exactly this version (or none: grandfathered, D15) AND exactly this digest (or none:
 * grandfathered, D24). An approval for any other version or content is stale.
 */
export function isApprovalCurrent(status: CapabilityStatus, key: ApprovalKey): boolean {
  return (
    status.approvalStatus === "approved" &&
    (status.approvedVersion === undefined || status.approvedVersion === key.version) &&
    (status.approvedDigest === undefined || status.approvedDigest === key.digest)
  );
}

/**
 * Consecutive qualifying runs at the TAIL of history -- i.e. since the last run below threshold.
 * A sub-threshold run isn't flagged or filtered out; it just breaks the streak, the same way any
 * real chronological sequence would, which is exactly what "doesn't count toward promotion" means.
 *
 * With `version`, a run of any other version (or one recorded before runs carried a version) also
 * breaks the streak: runs of 1.0.0 say nothing about whether 1.1.0 is proven. With `digest`, the
 * same holds for content (D24): runs of other content, or runs that recorded no digest, break it.
 */
export function consecutiveQualifyingRuns(
  history: ConfidenceRunRecord[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  version?: string,
  digest?: string,
): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const run = history[i]!;
    if (run.confidence < threshold) break;
    if (version !== undefined && run.version !== version) break;
    if (digest !== undefined && run.digest !== digest) break;
    count += 1;
  }
  return count;
}

function markApproved(status: CapabilityStatus, key: ApprovalKey, reason: string): void {
  status.approvalStatus = "approved";
  status.approvedAt = new Date().toISOString();
  status.approvedReason = reason;
  status.approvedVersion = key.version;
  status.approvedDigest = key.digest;
}

export interface RecordRunOptions extends ApprovalKey {
  // version: the artifact version that was replayed; digest: its capabilityDigest(). Both are
  // recorded on the run and on any auto-promotion.
  statusDir?: string;
  threshold?: number;
  requiredConsecutive?: number;
}

/**
 * Appends one successful run's confidence to a capability's history, then auto-promotes to
 * approved -- for this run's version -- once the tail has requiredConsecutive runs of that version,
 * each >= threshold. This is how a draft capability's history accumulates in the first place, once
 * a human opts individual runs in via approveUnattended (or operator). A capability whose approval
 * already covers this version is left untouched (no write at all): approval no longer depends on
 * history once earned, and it keeps replaying an already-proven capability from growing its
 * sidecar file (and dirtying a committed one) on every single successful run forever. An approval
 * for a DIFFERENT version is stale, so the run is recorded as for a draft.
 */
export async function recordConfidenceRun(
  capabilityId: string,
  confidence: number,
  runId: string,
  options: RecordRunOptions,
): Promise<CapabilityStatus> {
  const statusDir = options.statusDir ?? DEFAULT_STATUS_DIR;
  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const required = options.requiredConsecutive ?? DEFAULT_REQUIRED_CONSECUTIVE_RUNS;

  const status = await readCapabilityStatus(capabilityId, statusDir);
  if (isApprovalCurrent(status, options)) {
    return status;
  }

  status.history.push({
    runId,
    confidence,
    at: new Date().toISOString(),
    version: options.version,
    digest: options.digest,
  });
  if (consecutiveQualifyingRuns(status.history, threshold, options.version, options.digest) >= required) {
    markApproved(
      status,
      options,
      `Auto-promoted: ${required} consecutive runs of ${options.version} with confidence >= ${threshold}.`,
    );
  }

  await writeCapabilityStatus(status, statusDir);
  return status;
}

export interface ApproveOptions extends ApprovalKey {
  // version + digest of the artifact being approved: required, an approval always names both (D15,
  // D24). Use approvalKey(capability).
  reason?: string;
  statusDir?: string;
  threshold?: number;
  requiredConsecutive?: number;
}

/**
 * Manual approval of one artifact version. With `reason`, a human override always wins,
 * regardless of history. Without one, this only promotes a capability whose history of THIS
 * version already qualifies -- it re-checks the same rule recordConfidenceRun applies
 * automatically, useful when a run happened with a stricter requiredConsecutive/threshold than the
 * defaults, or simply to confirm current status.
 */
export async function approveCapability(capabilityId: string, options: ApproveOptions): Promise<CapabilityStatus> {
  const statusDir = options.statusDir ?? DEFAULT_STATUS_DIR;
  const status = await readCapabilityStatus(capabilityId, statusDir);

  if (options.reason) {
    markApproved(status, options, options.reason);
    await writeCapabilityStatus(status, statusDir);
    return status;
  }

  if (isApprovalCurrent(status, options)) {
    return status;
  }

  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const required = options.requiredConsecutive ?? DEFAULT_REQUIRED_CONSECUTIVE_RUNS;
  const qualifying = consecutiveQualifyingRuns(status.history, threshold, options.version, options.digest);
  if (qualifying < required) {
    throw new Error(
      `Capability "${capabilityId}" ${options.version} does not yet qualify for approval: ` +
        `${qualifying}/${required} consecutive runs of ${options.version} at confidence >= ${threshold}. ` +
        `Pass a reason to override manually.`,
    );
  }

  markApproved(
    status,
    options,
    `Auto-promoted: ${required} consecutive runs of ${options.version} with confidence >= ${threshold}.`,
  );
  await writeCapabilityStatus(status, statusDir);
  return status;
}
