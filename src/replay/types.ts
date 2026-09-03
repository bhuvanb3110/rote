import type { Capability } from "../artifact/index.js";
import type { EscalationController } from "../escalation/index.js";

export interface ReplayOptions {
  capability: Capability;
  params: Record<string, unknown>;
  /**
   * Concrete URL to navigate to before step 1. The artifact's own `target.entryUrlPattern` is a
   * regex, not a navigable URL (deliberately, so one capability can point at staging or prod) --
   * this is checked against that pattern and rejected if it doesn't match.
   */
  entryUrl: string;
  /** Defaults to true -- unlike discovery, replay doesn't need a human watching. */
  headless?: boolean;
  evidenceBaseDir?: string;
  /**
   * Defaults to false. A risky/irreversible step is refused unless this is explicitly true --
   * the artifact's own recorded `risk` reflects what discovery observed, not a standing
   * authorization to replay it unattended. See src/safety/policy.ts's guardrail comment.
   */
  approveRisky?: boolean;
  /**
   * When supplied, every needs_human trigger PAUSES instead of exiting: replay hands the live
   * session to a human via this controller and waits for hand-back, rather than returning a
   * terminal `needs_human` ReplayResult. Omit it (the default) to keep replay's old, unattended
   * behavior -- needs_human/failure remain normal terminal outcomes, exactly as before.
   */
  controller?: EscalationController;
  /**
   * Defaults to false, same polarity as approveRisky. A capability whose accumulated confidence
   * history hasn't yet earned it "approved" status is refused before any browser launches unless
   * this is explicitly true -- see src/confidence/approval.ts. This is how a draft capability's
   * history gets to accumulate in the first place: a human opts individual runs in one at a time
   * until enough consecutive high-confidence runs auto-promote it.
   */
  approveUnattended?: boolean;
  /** Defaults to "status" -- where per-capability approval/confidence sidecar files live. */
  statusDir?: string;
}
