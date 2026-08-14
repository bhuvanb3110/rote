// Evaluates a Checkpoint (the artifact's shared recognizer vocabulary) against a live
// Observation/Surface. This is replay's canonical recognizer primitive -- used directly for
// step checkpoints and successCondition, and reused by recognize.ts for knownOutcomes/
// recoverables recognizers (they're all just Checkpoints). Discovery also uses this (for
// assert_checkpoint and its own success-condition polling); it imports this file directly
// rather than the src/agent barrel, so it isn't the one pulling the Anthropic SDK in here.
import type { Checkpoint } from "../artifact/index.js";
import type { Observation, Surface } from "../surface/index.js";

export interface CheckpointEvaluation {
  passed: boolean;
  detail: string;
}

export async function evaluateCheckpoint(
  surface: Surface,
  observation: Observation,
  checkpoint: Checkpoint,
): Promise<CheckpointEvaluation> {
  switch (checkpoint.kind) {
    case "urlMatches": {
      const passed = new RegExp(checkpoint.pattern).test(observation.url);
      return {
        passed,
        detail: passed
          ? `URL "${observation.url}" matches /${checkpoint.pattern}/`
          : `URL "${observation.url}" does not match /${checkpoint.pattern}/`,
      };
    }
    case "textPresent": {
      const passed = observation.visibleText.includes(checkpoint.text);
      return {
        passed,
        detail: passed ? `Found text "${checkpoint.text}".` : `Text "${checkpoint.text}" not found on page.`,
      };
    }
    case "textAbsent": {
      const passed = !observation.visibleText.includes(checkpoint.text);
      return {
        passed,
        detail: passed
          ? `Text "${checkpoint.text}" absent, as expected.`
          : `Text "${checkpoint.text}" unexpectedly present.`,
      };
    }
    case "elementPresent": {
      const handle = await surface.locate(checkpoint.target);
      const passed = !!handle && handle.locator !== null;
      return {
        passed,
        detail: passed
          ? `Element "${checkpoint.target.describedAs}" is present (via ${handle?.strategy}).`
          : `Element "${checkpoint.target.describedAs}" not found.`,
      };
    }
  }
}
