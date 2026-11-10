// The run-level approval gate. Structurally mirrors src/safety/policy.ts's policyGate: a single
// {allowed, reason} decision, called once per run (not per-action, since this is a property of
// the capability's proven-ness, not of any one step), refusal producing a needs_human result the
// same way an unapproved risky action already does.
import { capabilityDigest, type Capability } from "../artifact/index.js";
import { readCapabilityStatus, DEFAULT_STATUS_DIR } from "./store.js";

export interface ApprovalDecision {
  allowed: boolean;
  reason: string;
}

export interface ApprovalCheckOptions {
  /** Defaults to false, same polarity as ReplayOptions.approveRisky. */
  approveUnattended?: boolean;
  statusDir?: string;
}

/**
 * `capability` is the artifact the approval is about (the BASE artifact, before any tenant
 * override: see ReplayOptions.approvalArtifact). An approval is bound to its version (D15) and to
 * the SHA-256 of its canonical JSON (D24); the gate computes the digest itself, so a caller cannot
 * hand it a stale one. The content check runs first: a content change is refused whatever the
 * version says.
 */
export async function checkApproval(capability: Capability, options: ApprovalCheckOptions): Promise<ApprovalDecision> {
  const { id, version } = capability;
  if (options.approveUnattended) {
    return { allowed: true, reason: "Unattended replay explicitly approved for this run (approveUnattended)." };
  }

  const status = await readCapabilityStatus(id, options.statusDir ?? DEFAULT_STATUS_DIR);
  if (status.approvalStatus !== "approved") {
    return {
      allowed: false,
      reason:
        `Capability "${id}" is in draft status and is not yet approved for unattended ` +
        `replay (rerun with approveUnattended to proceed, or approve it once its confidence ` +
        `history qualifies -- see "catalog approve").`,
    };
  }

  if (status.approvedVersion !== undefined && status.approvedVersion !== version) {
    return {
      allowed: false,
      reason:
        `Capability "${id}" was approved for ${status.approvedVersion}, artifact is ` +
        `${version}; re-approve (see "catalog approve") before unattended replay.`,
    };
  }

  const digest = capabilityDigest(capability);
  if (status.approvedDigest !== undefined && status.approvedDigest !== digest) {
    return {
      allowed: false,
      reason:
        `Capability "${id}" ${version}: artifact content changed since approval; re-approve (see ` +
        `"catalog approve") before unattended replay. Approved digest ${status.approvedDigest}, ` +
        `artifact digest ${digest}.`,
    };
  }

  if (status.approvedVersion === undefined) {
    return {
      allowed: true,
      reason:
        `Capability "${id}" is approved for unattended replay under a grandfathered approval ` +
        `that records no approvedVersion (it predates version-bound approvals); artifact is ` +
        `${version}. Re-approve to bind it to a version and its content.`,
    };
  }
  if (status.approvedDigest === undefined) {
    return {
      allowed: true,
      reason:
        `Capability "${id}" is approved for unattended replay at version ${version} under a ` +
        `grandfathered approval that records no approvedDigest (it predates content-bound ` +
        `approvals), so only the version was checked. Re-approve to bind it to its content.`,
    };
  }
  return {
    allowed: true,
    reason: `Capability "${id}" is approved for unattended replay at version ${version} (content digest matches).`,
  };
}
