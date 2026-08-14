// Deterministic replay: executes a compiled Capability's steps via the Surface, no LLM anywhere
// in this file. Every exit path builds a ReplayResult and validates it through
// ReplayResultSchema.parse before returning -- the same "fail loudly" discipline as artifact
// serialization.
import { randomUUID } from "node:crypto";
import { WebSurface } from "../surface/index.js";
import type { ExecutableAction, Observation } from "../surface/index.js";
import { buildPolicyForOrigin, evaluateAction } from "../safety/index.js";
import { EvidenceRecorder, redactValue } from "../evidence/index.js";
import { ReplayResultSchema, type ReplayResult, type Step } from "../artifact/index.js";
import { evaluateCheckpoint } from "./checkpoint.js";
import { describeCheckpoint, findBusinessOutcome, findRecoverableRule, isSessionTimeoutState } from "./recognize.js";
import { resolveStepValue, validateParams } from "./params.js";
import type { ReplayOptions } from "./types.js";

function buildExecutableAction(step: Step, params: Record<string, unknown>): ExecutableAction {
  switch (step.action.kind) {
    case "navigate":
      return { kind: "navigate", url: step.action.url };
    case "waitFor":
      return { kind: "waitFor", target: step.target, timeoutMs: step.action.timeoutMs };
    case "type":
    case "selectOption":
      return { kind: step.action.kind, target: step.target, value: resolveStepValue(step, params) };
    case "click":
    case "readText":
      return { kind: step.action.kind, target: step.target };
  }
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const { capability, params } = options;
  validateParams(capability, params);

  // entryUrlPattern is always generated as "^<origin>/" (see compile.ts), so normalize the
  // caller's entryUrl to its origin + trailing slash before testing -- otherwise a perfectly
  // valid "http://localhost:4100" (no trailing slash, the natural way to type it) would fail
  // this check for lacking one.
  const normalizedEntryOrigin = `${new URL(options.entryUrl).origin}/`;
  if (!new RegExp(capability.target.entryUrlPattern).test(normalizedEntryOrigin)) {
    throw new Error(
      `entryUrl "${options.entryUrl}" does not match the capability's entryUrlPattern ` +
        `${capability.target.entryUrlPattern}.`,
    );
  }

  const runId = `${capability.id}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const evidence = await EvidenceRecorder.create(options.evidenceBaseDir ?? "evidence", runId);
  const evidenceRef = `evidence://${evidence.directory.replace(/\\/g, "/")}/run.jsonl`;

  const policy = buildPolicyForOrigin(options.entryUrl);
  const surface = await WebSurface.launch({ headless: options.headless ?? true });
  const outputsByStepId = new Map<string, string>();

  let closed = false;
  const closeSurface = async () => {
    if (!closed) {
      closed = true;
      await surface.close();
    }
  };

  async function finish(result: ReplayResult): Promise<ReplayResult> {
    const validated = ReplayResultSchema.parse(result);
    await evidence.append({ turn: -1, kind: "result", detail: { status: validated.status } });
    await closeSurface();
    return validated;
  }

  try {
    await surface.act({ kind: "navigate", url: options.entryUrl });

    for (let stepIndex = 0; stepIndex < capability.steps.length; stepIndex += 1) {
      const step = capability.steps[stepIndex]!;
      const executable = buildExecutableAction(step, params);

      const currentUrl = surface.playwrightPage.url();
      const decision = evaluateAction(policy, currentUrl, executable);
      if (!decision.allowed) {
        await evidence.append({
          turn: stepIndex,
          kind: "blocked",
          detail: { stepId: step.id, reason: decision.reason },
        });
        return await finish({
          status: "failure",
          atStepId: step.id,
          expected: step.intent,
          observed: decision.reason,
          category: "unexpected-state",
          evidenceRef,
        });
      }
      // Same gate, same behavior as discovery: a live-classified risky action is never
      // auto-executed, even if the artifact's own recorded risk happens to say "safe" for a
      // different reason -- nothing in this stage authorizes bypassing human review of an
      // irreversible action.
      if (decision.risk === "risky") {
        await evidence.append({
          turn: stepIndex,
          kind: "blocked",
          detail: { stepId: step.id, reason: `risky/irreversible: ${decision.reason}` },
        });
        return await finish({
          status: "needs_human",
          reason: `Step "${step.id}" is risky/irreversible and requires human authorization: ${decision.reason}`,
          atStepId: step.id,
          contextRef: evidenceRef,
        });
      }

      let observation: Observation | null = null;
      let actionError: Error | null = null;
      let attempts = 0;
      let isFirstAttempt = true;

      while (true) {
        // Only the FIRST pass runs the step's actual action. A retry must not re-run it: once
        // a recoverable interstitial is showing, the original target (e.g. a "Log In" button)
        // is no longer on the page at all, so re-clicking it would just throw and we'd spin
        // until maxAttempts with the interstitial never actually re-requested. Recovery instead
        // reloads the CURRENT page below, matching what the mock app's own "Retry" link does.
        if (isFirstAttempt) {
          isFirstAttempt = false;
          try {
            await surface.act(executable);
          } catch (err) {
            actionError = err as Error;
          }

          if (executable.target) {
            const entries = surface.provenance;
            const last = entries[entries.length - 1];
            const topChoice = executable.target.strategies[0]?.kind;
            if (last && topChoice && last.strategy !== topChoice) {
              await evidence.append({
                turn: stepIndex,
                kind: "drift",
                detail: { stepId: step.id, expectedStrategy: topChoice, actualStrategy: last.strategy },
              });
            }
          }
        }

        observation = await surface.perceive();
        const screenshotFile = await evidence.recordScreenshot(observation.screenshot);

        const businessOutcome = await findBusinessOutcome(surface, observation, capability.knownOutcomes);
        if (businessOutcome) {
          await evidence.append({
            turn: stepIndex,
            kind: "business_outcome",
            detail: { stepId: step.id, code: businessOutcome.code, detail: businessOutcome.detail },
            screenshotFile,
          });
          return await finish({
            status: "business_outcome",
            code: businessOutcome.code,
            detail: businessOutcome.detail,
            evidenceRef,
          });
        }

        const recoverable = await findRecoverableRule(surface, observation, capability.recoverables);
        if (recoverable) {
          attempts += 1;
          const maxAttempts = recoverable.maxAttempts ?? 3;
          await evidence.append({
            turn: stepIndex,
            kind: "recover",
            detail: { stepId: step.id, action: recoverable.action, attempt: attempts, maxAttempts },
            screenshotFile,
          });
          if (attempts > maxAttempts) {
            return await finish({
              status: "needs_human",
              reason:
                `Recoverable rule ("${recoverable.action}") exhausted after ${maxAttempts} ` +
                `attempts at step "${step.id}".`,
              atStepId: step.id,
              contextRef: evidenceRef,
            });
          }
          if (recoverable.backoffMs) {
            await new Promise((resolve) => setTimeout(resolve, recoverable.backoffMs));
          }
          if (recoverable.action === "retry") {
            // Re-request the current (interstitial) page -- not the original step's action.
            await surface.playwrightPage.reload();
          }
          // "dismiss" has no target field in the schema to click, so it degrades to a bounded
          // wait-and-recheck of the same page -- a documented limitation, not exercised by any
          // required test.
          continue;
        }

        break;
      }

      const finalObservationForStep: Observation = observation ?? (await surface.perceive());

      await evidence.append({
        turn: stepIndex,
        kind: "action",
        detail: {
          stepId: step.id,
          actionKind: step.action.kind,
          target: step.target?.describedAs,
          value: step.value ? redactValue(executable.value ?? "", step.value.redact) : undefined,
          intent: step.intent,
          actionError: actionError?.message,
        },
      });

      if (step.action.kind === "readText" && !actionError) {
        outputsByStepId.set(step.id, surface.lastReadText ?? "");
      }

      if (step.checkpoint) {
        const evalResult = await evaluateCheckpoint(surface, finalObservationForStep, step.checkpoint);
        await evidence.append({
          turn: stepIndex,
          kind: "checkpoint",
          detail: {
            stepId: step.id,
            checkpoint: step.checkpoint,
            passed: evalResult.passed,
            message: evalResult.detail,
          },
        });
        if (!evalResult.passed) {
          const category = isSessionTimeoutState(finalObservationForStep, step) ? "session-timeout" : "unexpected-state";
          return await finish({
            status: "failure",
            atStepId: step.id,
            expected: describeCheckpoint(step.checkpoint),
            observed: evalResult.detail,
            category,
            evidenceRef,
          });
        }
      } else if (actionError) {
        const category = isSessionTimeoutState(finalObservationForStep, step) ? "session-timeout" : "unexpected-state";
        return await finish({
          status: "failure",
          atStepId: step.id,
          expected: step.intent,
          observed: actionError.message,
          category,
          evidenceRef,
        });
      }
    }

    const finalObservation = await surface.perceive();
    const successEval = await evaluateCheckpoint(surface, finalObservation, capability.successCondition);
    if (!successEval.passed) {
      const lastStep = capability.steps[capability.steps.length - 1]!;
      return await finish({
        status: "failure",
        atStepId: lastStep.id,
        expected: describeCheckpoint(capability.successCondition),
        observed: successEval.detail,
        category: "unexpected-state",
        evidenceRef,
      });
    }

    const outputs: Record<string, unknown> = {};
    for (const output of capability.outputs) {
      outputs[output.name] = outputsByStepId.get(output.producedByStepId) ?? null;
    }
    return await finish({ status: "success", outputs, evidenceRef });
  } catch (err) {
    await closeSurface();
    throw err;
  }
}
