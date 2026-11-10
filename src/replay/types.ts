import type { Browser } from "playwright";
import type { Capability, Step } from "../artifact/index.js";
import type { EscalationController } from "../escalation/index.js";

/**
 * Callbacks around the one irreversible action in a run (a step the live gate OR the artifact
 * marks risky -- see replay.ts). They run only when that action is actually about to be executed
 * by replay: never for safe steps, and never when approveRisky is false (replay stops first).
 */
export interface IrreversibleHooks {
  /**
   * Runs right before the irreversible click, after the approveRisky check. The fleet writes its
   * commit intent here and throws if its fencing check fails (lease lost, token mismatch). A throw
   * PREVENTS the click: runReplay closes its context and rejects with that same error, unwrapped.
   * It never returns a ReplayResult for it.
   */
  before(step: Step): Promise<void>;
  /**
   * Contract: runs once the bank has ANSWERED the click, not merely when the click was dispatched.
   * After the click, replay waits (bounded, 10 s) for the page's resulting navigation to reach
   * "load", and only then calls after(). So when after() runs, the bank has processed the POST:
   * if it committed, its ledger already has the row. If that wait times out or errors, it does not
   * throw: it is recorded in evidence (`irreversible_settle`, `loaded: false`) and after() still
   * runs. after() also runs if the click itself threw (it may still have been dispatched).
   * Crash-after-submit fault injection fires here. A throw rejects runReplay with that same error
   * (after closing the context); no ReplayResult is returned.
   */
  after(step: Step): Promise<void>;
}

export interface ReplayOptions {
  capability: Capability;
  params: Record<string, unknown>;
  /**
   * Concrete URL to navigate to before step 1. The artifact's own `target.entryUrlPattern` is a
   * regex, not a navigable URL (deliberately, so one capability can point at staging or prod) --
   * this is checked against that pattern and rejected if it doesn't match.
   */
  entryUrl: string;
  /**
   * Defaults to true -- unlike discovery, replay doesn't need a human watching. Ignored when
   * `browser` is given (that browser is already headed or headless); passing both is allowed,
   * because invokeCapability always passes headless.
   */
  headless?: boolean;
  /**
   * Reuse this running browser instead of launching one (fleet: one browser per worker, one
   * context per job). Replay opens a fresh context for the run and closes only that context on
   * every exit path, including throws; the browser stays connected. Omit it to launch and close a
   * browser per run, as before.
   */
  browser?: Browser;
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
  /** Callbacks around the irreversible action (the fleet's commit intent / fault injection). */
  onIrreversible?: IrreversibleHooks;
  /**
   * Aborts the run (fleet: the heartbeat lost the lease). Already aborted at entry → rejects with
   * `signal.reason` before any evidence, browser or context is created. Aborted mid-run → replay
   * closes its context (or the browser it launched) immediately, mid-action, and rejects with
   * `signal.reason`. Abort ALWAYS rejects and never returns a ReplayResult, even after the
   * irreversible action was attempted: a worker that lost its lease must not record anything, and
   * the next lease holder recovers by reading the history. Evidence gets one `aborted` entry
   * (`reason`, `irreversibleAttempted`); no `result` entry and no confidence write. Takes precedence
   * over a hook error. Not observed while paused for a human (controller).
   */
  signal?: AbortSignal;
}
