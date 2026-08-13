// Runtime-only Surface types. ElementDescriptor/Action/LocatorStrategy are now the canonical
// Zod-derived types from src/artifact -- imported here, not redefined. Handle/Observation/
// Surface/LocatorProvenanceEntry stay local: a live Playwright Locator and a screenshot Buffer
// are runtime-only, not persisted artifact data, so they don't belong in the Zod schema.
import type { Locator } from "playwright";
import type { Action, ElementDescriptor, LocatorStrategy } from "../artifact/index.js";

export type { Action, ElementDescriptor, LocatorStrategy };

/**
 * A fully resolved, directly-executable action for Surface.act(): the artifact's declarative
 * Action (kind + kind-intrinsic config like navigate's url) plus the runtime target/value that,
 * in a persisted Capability, live on the Step instead. target: ElementDescriptor is not
 * sensitive, so it's safe to carry directly here; value has already been resolved from a
 * ValueRef (literal or param-substituted) and any redaction decisions already made upstream, so
 * it is a plain string here.
 */
export type ExecutableAction = Action & { target?: ElementDescriptor; value?: string };

/**
 * Result of resolving an ElementDescriptor. `locator` is null only for the "visual" strategy,
 * which is a documented stub (no coordinate-based resolution yet) — callers that need a live
 * element must check for that case.
 */
export interface Handle {
  strategy: LocatorStrategy["kind"];
  describedAs: string;
  locator: Locator | null;
}

/** Compact snapshot of surface state — enough for an LLM to decide and recognizers to classify. */
export interface Observation {
  url: string;
  accessibilitySnapshot: string;
  visibleText: string;
  landmarks: string[];
  screenshot: Buffer;
}

/** A resolved locate() call, recorded for provenance/drift-detection by later stages. */
export interface LocatorProvenanceEntry {
  descriptor: ElementDescriptor;
  strategy: LocatorStrategy["kind"];
  timestamp: number;
}

/**
 * All UI interaction goes through this interface. WebSurface (Playwright) is the only concrete
 * implementation now; a future DesktopSurface (OS accessibility tree) should be able to swap in
 * without changing this contract or the artifact schema built on top of it.
 */
export interface Surface {
  perceive(): Promise<Observation>;
  act(action: ExecutableAction): Promise<void>;
  locate(descriptor: ElementDescriptor): Promise<Handle | null>;
}
