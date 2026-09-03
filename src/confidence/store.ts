// Per-capability approval status + confidence run history, one flat JSON sidecar file per
// capability under status/ -- same convention as overrides/<capabilityId>.<tenant>.json. No
// database: a capability transitions draft -> approved once its history's tail has enough
// consecutive runs at or above the confidence threshold, or a human overrides with a reason.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
 * lock or single-writer queue would, but that's exactly the scaling infra CLAUDE.md says not to
 * build here; the honest limit is a lost history entry under true concurrent writes, not corrupt
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
 * Consecutive qualifying runs at the TAIL of history -- i.e. since the last run below threshold.
 * A sub-threshold run isn't flagged or filtered out; it just breaks the streak, the same way any
 * real chronological sequence would, which is exactly what "doesn't count toward promotion" means.
 */
export function consecutiveQualifyingRuns(
  history: ConfidenceRunRecord[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.confidence < threshold) break;
    count += 1;
  }
  return count;
}

export interface RecordRunOptions {
  statusDir?: string;
  threshold?: number;
  requiredConsecutive?: number;
}

/**
 * Appends one successful run's confidence to a DRAFT capability's history, then auto-promotes to
 * approved once the tail has requiredConsecutive runs each >= threshold -- this is how a draft
 * capability's history accumulates in the first place, once a human opts individual runs in via
 * approveUnattended (or operator). A capability that's already approved is left untouched (no
 * write at all): approval no longer depends on history once earned, so there's nothing further to
 * track, and it keeps replaying an already-proven capability from growing its sidecar file (and
 * dirtying a committed one) on every single successful run forever.
 */
export async function recordConfidenceRun(
  capabilityId: string,
  confidence: number,
  runId: string,
  options: RecordRunOptions = {},
): Promise<CapabilityStatus> {
  const statusDir = options.statusDir ?? DEFAULT_STATUS_DIR;
  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const required = options.requiredConsecutive ?? DEFAULT_REQUIRED_CONSECUTIVE_RUNS;

  const status = await readCapabilityStatus(capabilityId, statusDir);
  if (status.approvalStatus === "approved") {
    return status;
  }

  status.history.push({ runId, confidence, at: new Date().toISOString() });
  if (consecutiveQualifyingRuns(status.history, threshold) >= required) {
    status.approvalStatus = "approved";
    status.approvedAt = new Date().toISOString();
    status.approvedReason = `Auto-promoted: ${required} consecutive runs with confidence >= ${threshold}.`;
  }

  await writeCapabilityStatus(status, statusDir);
  return status;
}

export interface ApproveOptions {
  reason?: string;
  statusDir?: string;
  threshold?: number;
  requiredConsecutive?: number;
}

/**
 * Manual approval. With `reason`, a human override always wins, regardless of history. Without
 * one, this only promotes a capability whose history already qualifies -- it re-checks the same
 * rule recordConfidenceRun applies automatically, useful when a run happened with a stricter
 * requiredConsecutive/threshold than the defaults, or simply to confirm current status.
 */
export async function approveCapability(
  capabilityId: string,
  options: ApproveOptions = {},
): Promise<CapabilityStatus> {
  const statusDir = options.statusDir ?? DEFAULT_STATUS_DIR;
  const status = await readCapabilityStatus(capabilityId, statusDir);

  if (options.reason) {
    status.approvalStatus = "approved";
    status.approvedAt = new Date().toISOString();
    status.approvedReason = options.reason;
    await writeCapabilityStatus(status, statusDir);
    return status;
  }

  if (status.approvalStatus === "approved") {
    return status;
  }

  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const required = options.requiredConsecutive ?? DEFAULT_REQUIRED_CONSECUTIVE_RUNS;
  const qualifying = consecutiveQualifyingRuns(status.history, threshold);
  if (qualifying < required) {
    throw new Error(
      `Capability "${capabilityId}" does not yet qualify for approval: ${qualifying}/${required} ` +
        `consecutive runs at confidence >= ${threshold}. Pass a reason to override manually.`,
    );
  }

  status.approvalStatus = "approved";
  status.approvedAt = new Date().toISOString();
  status.approvedReason = `Auto-promoted: ${required} consecutive runs with confidence >= ${threshold}.`;
  await writeCapabilityStatus(status, statusDir);
  return status;
}
