// Confidence scoring, derived from the SAME comparison that already produces "drift" evidence
// entries in src/replay/replay.ts (expectedStrategy = strategies[0].kind, actualStrategy =
// surface.provenance's last resolved kind) -- this just also records WHERE in the ranked list the
// winning strategy was, not only whether it matched the top choice.
import type { LocatorStrategy } from "../artifact/index.js";

/**
 * How far down descriptor.strategies the resolved kind was: 1.0 at index 0, degrading linearly to
 * 0.0 at the last index. index === -1 (the resolved kind isn't even authored in the list -- the
 * guaranteed "visual" stub every locate() falls back to when every real strategy fails) scores 0,
 * the documented worst case. Two strategies sharing the same kind in one descriptor (structurally
 * legal, not used by any real artifact today) resolve to whichever one findIndex sees first -- a
 * known, minor imprecision, consistent with this project's other documented locator limits.
 */
export function stepConfidence(strategies: LocatorStrategy[], resolvedKind: LocatorStrategy["kind"]): number {
  const index = strategies.findIndex((strategy) => strategy.kind === resolvedKind);
  if (index === -1) return 0;
  if (strategies.length === 1) return 1;
  return 1 - index / (strategies.length - 1);
}

/** Run-level confidence: the average of every resolved step's score. 1.0 if no step had a target. */
export function computeRunConfidence(stepScores: number[]): number {
  if (stepScores.length === 0) return 1;
  return stepScores.reduce((sum, score) => sum + score, 0) / stepScores.length;
}
