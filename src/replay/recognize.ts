// Classifies observed state after an action into the taxonomy from CLAUDE.md's error-taxonomy
// section: expected-next is handled by the caller (a step's own checkpoint); this file covers
// the other branches -- known business outcome, recoverable interstitial/transient, and a
// session-timeout heuristic -- all built on the same Checkpoint recognizer vocabulary via
// evaluateCheckpoint, since a BusinessOutcome/RecoverableRule "recognizer" IS just a Checkpoint.
import type { BusinessOutcome, Checkpoint, RecoverableRule, Step } from "../artifact/index.js";
import type { Observation, Surface } from "../surface/index.js";
import { evaluateCheckpoint } from "./checkpoint.js";

export async function findBusinessOutcome(
  surface: Surface,
  observation: Observation,
  knownOutcomes: BusinessOutcome[],
): Promise<BusinessOutcome | null> {
  for (const outcome of knownOutcomes) {
    const result = await evaluateCheckpoint(surface, observation, outcome.recognizer);
    if (result.passed) return outcome;
  }
  return null;
}

export async function findRecoverableRule(
  surface: Surface,
  observation: Observation,
  recoverables: RecoverableRule[],
): Promise<RecoverableRule | null> {
  for (const rule of recoverables) {
    const result = await evaluateCheckpoint(surface, observation, rule.recognizer);
    if (result.passed) return rule;
  }
  return null;
}

// Heuristic: the mock app's auth gate redirects an unauthenticated request to /login. Landing
// there mid-replay is only a genuine session-timeout if THIS step isn't itself part of logging
// in (a login-flow step landing on /login is expected, not a timeout).
export function isSessionTimeoutState(observation: Observation, step: Step): boolean {
  const looksLikeLogin = /\/login(?:[/?]|$)/.test(observation.url);
  if (!looksLikeLogin) return false;
  const describedAs = step.target?.describedAs ?? "";
  const stepIsLoginRelated =
    /user\s*id|password|log\s*in/i.test(describedAs) || /log\s*in/i.test(step.intent);
  return !stepIsLoginRelated;
}

export function describeCheckpoint(checkpoint: Checkpoint): string {
  switch (checkpoint.kind) {
    case "urlMatches":
      return `URL matches /${checkpoint.pattern}/`;
    case "textPresent":
      return `text "${checkpoint.text}" present`;
    case "textAbsent":
      return `text "${checkpoint.text}" absent`;
    case "elementPresent":
      return `element "${checkpoint.target.describedAs}" present`;
  }
}
