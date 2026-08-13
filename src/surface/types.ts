// Local minimal types for the Surface abstraction. ElementDescriptor/Action will become the
// canonical Zod schemas in Stage 3; these capture the same shape so Surface implementations
// have something concrete to build against in the meantime.
import type { Locator } from "playwright";

/**
 * Ranked, ordered set of ways to find an element. Never a single brittle CSS selector: a
 * descriptor may carry fields for several strategies, tried in priority order by locate().
 */
export interface ElementDescriptor {
  /** Human description of the element, e.g. "Search button". Also the visual-strategy fallback. */
  describedAs: string;
  role?: { role: string; name: string };
  labelText?: string;
  textAnchor?: { anchorText: string };
  tableCell?: { rowLabel: string; column?: number };
  css?: string;
}

export type LocatorStrategy =
  | "role"
  | "labelText"
  | "textAnchor"
  | "tableCell"
  | "css"
  | "visual";

/**
 * Result of resolving an ElementDescriptor. `locator` is null only for the "visual" strategy,
 * which is a documented stub (no coordinate-based resolution yet) — callers that need a live
 * element must check for that case.
 */
export interface Handle {
  strategy: LocatorStrategy;
  describedAs: string;
  locator: Locator | null;
}

export type Action =
  | { kind: "click"; target: ElementDescriptor }
  | { kind: "type"; target: ElementDescriptor; text: string }
  | { kind: "selectOption"; target: ElementDescriptor; value: string }
  | { kind: "navigate"; url: string }
  | { kind: "waitFor"; target: ElementDescriptor; timeoutMs?: number }
  | { kind: "readText"; target: ElementDescriptor };

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
  strategy: LocatorStrategy;
  timestamp: number;
}

/**
 * All UI interaction goes through this interface. WebSurface (Playwright) is the only concrete
 * implementation now; a future DesktopSurface (OS accessibility tree) should be able to swap in
 * without changing this contract or the artifact schema built on top of it.
 */
export interface Surface {
  perceive(): Promise<Observation>;
  act(action: Action): Promise<void>;
  locate(descriptor: ElementDescriptor): Promise<Handle | null>;
}
