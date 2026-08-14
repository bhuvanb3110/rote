import type { Capability } from "../artifact/index.js";

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
}
