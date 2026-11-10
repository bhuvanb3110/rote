// The run-level approval gate. Structurally mirrors src/safety/policy.ts's policyGate: a single
// {allowed, reason} decision, called once per run (not per-action, since this is a property of
// the capability's proven-ness, not of any one step), refusal producing a needs_human result the
// same way an unapproved risky action already does.
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
 * `capabilityVersion` is the artifact's own `version`. An approval is bound to the version it was
 * given for (docs/DECISIONS.md D15): an edited artifact with a bumped version does not inherit it.
 */
export async function checkApproval(
  capabilityId: string,
  capabilityVersion: string,
  options: ApprovalCheckOptions,
): Promise<ApprovalDecision> {
  if (options.approveUnattended) {
    return { allowed: true, reason: "Unattended replay explicitly approved for this run (approveUnattended)." };
  }

  const status = await readCapabilityStatus(capabilityId, options.statusDir ?? DEFAULT_STATUS_DIR);
  if (status.approvalStatus === "approved") {
    if (status.approvedVersion === undefined) {
      return {
        allowed: true,
        reason:
          `Capability "${capabilityId}" is approved for unattended replay under a grandfathered approval ` +
          `that records no approvedVersion (it predates version-bound approvals); artifact is ` +
          `${capabilityVersion}. Re-approve to bind it to a version.`,
      };
    }
    if (status.approvedVersion === capabilityVersion) {
      return {
        allowed: true,
        reason: `Capability "${capabilityId}" is approved for unattended replay at version ${capabilityVersion}.`,
      };
    }
    return {
      allowed: false,
      reason:
        `Capability "${capabilityId}" was approved for ${status.approvedVersion}, artifact is ` +
        `${capabilityVersion}; re-approve (see "catalog approve") before unattended replay.`,
    };
  }

  return {
    allowed: false,
    reason:
      `Capability "${capabilityId}" is in draft status and is not yet approved for unattended ` +
      `replay (rerun with approveUnattended to proceed, or approve it once its confidence ` +
      `history qualifies -- see "catalog approve").`,
  };
}
