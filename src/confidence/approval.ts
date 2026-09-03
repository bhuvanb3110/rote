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

export async function checkApproval(
  capabilityId: string,
  options: ApprovalCheckOptions,
): Promise<ApprovalDecision> {
  if (options.approveUnattended) {
    return { allowed: true, reason: "Unattended replay explicitly approved for this run (approveUnattended)." };
  }

  const status = await readCapabilityStatus(capabilityId, options.statusDir ?? DEFAULT_STATUS_DIR);
  if (status.approvalStatus === "approved") {
    return { allowed: true, reason: `Capability "${capabilityId}" is approved for unattended replay.` };
  }

  return {
    allowed: false,
    reason:
      `Capability "${capabilityId}" is in draft status and is not yet approved for unattended ` +
      `replay (rerun with approveUnattended to proceed, or approve it once its confidence ` +
      `history qualifies -- see "catalog approve").`,
  };
}
