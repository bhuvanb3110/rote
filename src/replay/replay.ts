// Deterministic replay: executes a compiled Capability's steps via the Surface, no LLM anywhere
// in this file. Every exit path builds a ReplayResult and validates it through
// ReplayResultSchema.parse before returning -- the same "fail loudly" discipline as artifact
// serialization.
//
// needs_human is either a terminal exit (no controller supplied -- unattended replay, the
// original behavior, still exercised by every test that doesn't pass one) or a PAUSE (a
// controller supplied -- see pauseOrFail below and src/escalation/controller.ts).
import { randomUUID } from "node:crypto";
import { WebSurface } from "../surface/index.js";
import type { ExecutableAction, Observation } from "../surface/index.js";
import { buildPolicyForOrigin, policyGate, redact } from "../safety/index.js";
import { EvidenceRecorder, defaultEvidenceBaseDir } from "../evidence/index.js";
import { ReplayResultSchema, type Capability, type ReplayResult, type Step } from "../artifact/index.js";
import { approvalKey, checkApproval, computeRunConfidence, recordConfidenceRun, stepConfidence } from "../confidence/index.js";
import type { EscalationController } from "../escalation/index.js";
import { evaluateCheckpoint } from "./checkpoint.js";
import { describeCheckpoint, findBusinessOutcome, findRecoverableRule, isSessionTimeoutState } from "./recognize.js";
import { resolveStepValue, validateParams } from "./params.js";
import type { ReplayOptions } from "./types.js";

/** Upper bound on waiting for the bank's answer to the irreversible click (IrreversibleHooks.after). */
const IRREVERSIBLE_SETTLE_TIMEOUT_MS = 10_000;

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

type PauseOutcome =
  | { kind: "exit"; result: ReplayResult }
  | { kind: "complete" }
  | { kind: "skip" }
  | { kind: "retry" };

/**
 * The single place every needs_human trigger funnels through. Without a controller, behavior is
 * unchanged: builds and returns the same terminal ReplayResult as before. With one, it pauses
 * (raise + wait) and, on resume, decides where to continue from -- this is what "re-checks the
 * current checkpoint, and resumes from where it paused (or completes)" means concretely:
 * successCondition now passing means the human already finished the job by hand ("complete");
 * the current step's own checkpoint now passing means just this step is done ("skip", so its
 * action -- e.g. a click on a button the human already clicked -- is never re-run); neither
 * means retry the step fresh (safe even if the human did nothing: it just re-pauses).
 */
async function pauseOrFail(
  controller: EscalationController | undefined,
  surface: WebSurface,
  capability: Capability,
  step: Step,
  reason: string,
  buildFailureResult: () => Promise<ReplayResult>,
): Promise<PauseOutcome> {
  if (!controller) {
    return { kind: "exit", result: await buildFailureResult() };
  }

  await controller.raise({
    capabilityId: capability.id,
    goal: capability.description,
    atStepId: step.id,
    reason,
  });
  await controller.waitForAutomation();

  const observation = await surface.perceive();
  const successNow = await evaluateCheckpoint(surface, observation, capability.successCondition);
  if (successNow.passed) return { kind: "complete" };
  if (step.checkpoint) {
    const stepNow = await evaluateCheckpoint(surface, observation, step.checkpoint);
    if (stepNow.passed) return { kind: "skip" };
  }
  return { kind: "retry" };
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const { capability, params, controller } = options;
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
  // Already aborted: reject before any evidence, browser or context exists.
  options.signal?.throwIfAborted();

  const runId = `${capability.id}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const evidence = await EvidenceRecorder.create(options.evidenceBaseDir ?? defaultEvidenceBaseDir(), runId);
  const evidenceRef = `evidence://${evidence.directory.replace(/\\/g, "/")}/run.jsonl`;

  // Run-level approval gate, checked once before any browser launches -- mirrors policyGate's
  // {allowed, reason} shape (src/safety/policy.ts) but at run granularity, not per-action: a
  // capability that hasn't earned "approved" status is refused for unattended replay the same way
  // an unapproved risky action already is. finish() isn't reusable here (it assumes a `surface` to
  // close, and none has been launched yet), so this builds and validates the result by hand.
  // The approval is about the base artifact (D24), which differs from `capability` when a tenant
  // override was applied; invokeCapability passes it. Direct callers replay the artifact itself.
  const approvalArtifact = options.approvalArtifact ?? capability;
  if (approvalArtifact.id !== capability.id || approvalArtifact.version !== capability.version) {
    throw new Error(
      `approvalArtifact ${approvalArtifact.id} ${approvalArtifact.version} is not the base of the replayed ` +
        `capability ${capability.id} ${capability.version}.`,
    );
  }
  const approval = await checkApproval(approvalArtifact, {
    approveUnattended: options.approveUnattended,
    statusDir: options.statusDir,
    tenantOverride: options.approvalOverride,
  });
  if (!approval.allowed) {
    await evidence.append({ turn: -1, kind: "blocked", detail: { reason: approval.reason } });
    const gated = ReplayResultSchema.parse({
      status: "needs_human",
      reason: approval.reason,
      atStepId: capability.steps[0]!.id,
      contextRef: evidenceRef,
    });
    await evidence.append({ turn: -1, kind: "result", detail: { status: gated.status } });
    return gated;
  }

  const policy = buildPolicyForOrigin(options.entryUrl);
  const surface = await WebSurface.launch({ headless: options.headless ?? true, browser: options.browser });
  controller?.bind(surface, evidence);
  const outputsByStepId = new Map<string, string>();
  const stepConfidenceScores: number[] = [];

  // One shared close: the abort listener starts it, and every exit path awaits the same promise,
  // so "rejected" also means "context closed".
  let closing: Promise<void> | null = null;
  const closeSurface = (): Promise<void> => (closing ??= surface.close());
  const onAbort = () => {
    closeSurface().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // Set right BEFORE the irreversible action is dispatched (step-04 plan section 5). From then on
  // the bank may have committed, so: no reload/recoverable retry, no second click of the
  // irreversible control, throws become results, and every non-success result carries
  // commitUncertain (added in finish(), the one place every exit goes through).
  let irreversibleAttempted: { stepId: string } | null = null;
  // An onIrreversible hook threw. runReplay must reject with exactly that error, even after the
  // attempt (the fleet threw it; a ReplayResult would only invite a stale worker to record it).
  let hookFailure: { error: unknown } | null = null;
  let currentStepId = capability.steps[0]!.id;

  async function runHook(name: "before" | "after", step: Step): Promise<void> {
    if (!options.onIrreversible) return;
    try {
      await options.onIrreversible[name](step);
    } catch (error) {
      hookFailure = { error };
      throw error;
    }
  }

  /** StepHooks.after (D34); a throw is recorded as a hook failure, so it rejects unchanged. */
  async function runStepHook(step: Step, index: number): Promise<void> {
    if (!options.onStep) return;
    try {
      await options.onStep.after(step, index);
    } catch (error) {
      hookFailure = { error };
      throw error;
    }
  }

  /** Mentions an earlier irreversible attempt in an escalation reason, so the human knows. */
  function pauseReason(reason: string): string {
    return irreversibleAttempted
      ? `${reason} (the irreversible step "${irreversibleAttempted.stepId}" was already attempted in this run -- ` +
          `verify whether it committed before redoing anything by hand)`
      : reason;
  }

  /**
   * Rule 5.2: replay never clicks the irreversible control twice in one run. If the human hands
   * back without resolving a failure of the attempted irreversible step, "retry" would re-run its
   * click; it becomes a terminal needs_human instead. "complete"/"skip" are unchanged.
   */
  async function refuseRetryOfAttempted(outcome: PauseOutcome, step: Step): Promise<PauseOutcome> {
    if (outcome.kind !== "retry" || irreversibleAttempted?.stepId !== step.id) return outcome;
    return {
      kind: "exit",
      result: await finish({
        status: "needs_human",
        reason:
          `Step "${step.id}" is irreversible and was already attempted in this run; replay never repeats it. ` +
          `Verify whether it committed (e.g. via the history) before any retry.`,
        atStepId: step.id,
        contextRef: evidenceRef,
      }),
    };
  }

  function describeOutcome(result: Exclude<ReplayResult, { status: "success" }>): string {
    switch (result.status) {
      case "business_outcome":
        return `business_outcome ${result.code}: ${result.detail}`;
      case "needs_human":
        return `needs_human at ${result.atStepId}: ${result.reason}`;
      case "failure":
        return `failure (${result.category}) at ${result.atStepId}: ${result.observed}`;
    }
  }

  async function finish(result: ReplayResult): Promise<ReplayResult> {
    // An aborted run never returns a result, whatever exit it was heading for.
    options.signal?.throwIfAborted();
    const marked: ReplayResult =
      irreversibleAttempted && result.status !== "success"
        ? {
            ...result,
            commitUncertain: {
              irreversibleStepId: irreversibleAttempted.stepId,
              detail: `Attempted the irreversible step, then the run ended in ${describeOutcome(result)}`.slice(0, 500),
            },
          }
        : result;
    const validated = ReplayResultSchema.parse(marked);
    const confidence = computeRunConfidence(stepConfidenceScores);
    const commitUncertain = validated.status === "success" ? undefined : validated.commitUncertain;
    await evidence.append({ turn: -1, kind: "result", detail: { status: validated.status, confidence, commitUncertain } });
    if (validated.status === "success") {
      await recordConfidenceRun(capability.id, confidence, runId, {
        ...approvalKey(approvalArtifact),
        statusDir: options.statusDir,
      });
    }
    await closeSurface();
    return validated;
  }

  try {
    options.signal?.throwIfAborted(); // aborted while the browser/context was starting
    await surface.act({ kind: "navigate", url: options.entryUrl });

    let stepIndex = 0;
    stepLoop: while (stepIndex < capability.steps.length) {
      options.signal?.throwIfAborted();
      const step = capability.steps[stepIndex]!;
      currentStepId = step.id;
      const executable = buildExecutableAction(step, params);

      const currentUrl = surface.playwrightPage.url();
      const decision = policyGate(executable, { policy, currentUrl });
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
      // Hardening (FLEET_BRIEF amendment 3, step-04 plan section 2): a step is irreversible if the
      // live gate says risky OR the artifact recorded `risk: "risky"`. It can only be stricter than
      // the gate alone -- e.g. a tenant override that drops the roleName "Submit" strategy makes
      // the gate say safe, but the artifact still knows. `irreversible` is the one flag every risk
      // decision below uses; evidence records which source said so.
      const irreversible = decision.risk === "risky" || step.risk === "risky";
      const riskSources = { gate: decision.risk, artifact: step.risk };
      const riskReason =
        decision.risk === "risky"
          ? decision.reason
          : `the artifact marks step "${step.id}" risk: "risky" (the live gate classified it safe)`;

      // An irreversible action is never auto-executed by default -- the artifact's own recorded
      // risk reflects what discovery observed, not a standing authorization to replay it
      // unattended. The caller must explicitly opt in per run via approveRisky; otherwise this
      // pauses for a human (or, with no controller, is exactly the "needs_human" case CLAUDE.md's
      // "discovery stops at confirmation screens" is protecting).
      if (irreversible && !options.approveRisky) {
        await evidence.append({
          turn: stepIndex,
          kind: "blocked",
          detail: { stepId: step.id, reason: `risky/irreversible (unapproved): ${riskReason}`, riskSources },
        });
        const outcome = await pauseOrFail(
          controller,
          surface,
          capability,
          step,
          `risky/irreversible action blocked: ${riskReason}`,
          () =>
            finish({
              status: "needs_human",
              reason: `Step "${step.id}" is risky/irreversible and requires human authorization (rerun with approveRisky to proceed): ${riskReason}`,
              atStepId: step.id,
              contextRef: evidenceRef,
            }),
        );
        if (outcome.kind === "exit") return outcome.result;
        if (outcome.kind === "complete") break stepLoop;
        if (outcome.kind === "skip") {
          stepIndex += 1;
          continue stepLoop;
        }
        continue stepLoop;
      }
      if (irreversible && options.approveRisky) {
        await evidence.append({
          turn: stepIndex,
          kind: "risk_approved",
          detail: { stepId: step.id, reason: riskReason, riskSources },
        });
        // A throw here (the fleet's fencing check) prevents the click; the top-level catch closes
        // the context and rethrows it unchanged. An abort during before() also stops the click.
        await runHook("before", step);
        options.signal?.throwIfAborted();
      }

      let observation: Observation | null = null;
      let actionError: Error | null = null;
      let attempts = 0;
      let isFirstAttempt = true;

      actLoop: while (true) {
        // Only the FIRST pass runs the step's actual action. A retry must not re-run it: once
        // a recoverable interstitial is showing, the original target (e.g. a "Log In" button)
        // is no longer on the page at all, so re-clicking it would just throw and we'd spin
        // until maxAttempts with the interstitial never actually re-requested. Recovery instead
        // reloads the CURRENT page below, matching what the mock app's own "Retry" link does.
        if (isFirstAttempt) {
          isFirstAttempt = false;
          if (irreversible) {
            // Only reachable with approveRisky (an unapproved irreversible step stopped above).
            // Watch BEFORE the click so its navigation can't be missed; see IrreversibleHooks.after
            // for the contract this wait implements.
            const settle = surface.watchNextNavigation(IRREVERSIBLE_SETTLE_TIMEOUT_MS);
            // Before act(), on purpose: if the click is dispatched and then anything goes wrong
            // (or the process dies inside it), the run already says "may have committed".
            irreversibleAttempted = { stepId: step.id };
            try {
              await surface.act(executable);
            } catch (err) {
              actionError = err as Error;
            } finally {
              const settled = await settle;
              await evidence.append({
                turn: stepIndex,
                kind: "irreversible_settle",
                detail: { stepId: step.id, timeoutMs: IRREVERSIBLE_SETTLE_TIMEOUT_MS, ...settled },
              });
              await runHook("after", step);
              options.signal?.throwIfAborted();
            }
          } else {
            try {
              await surface.act(executable);
            } catch (err) {
              actionError = err as Error;
            }
          }

          if (executable.target) {
            const entries = surface.provenance;
            const last = entries[entries.length - 1];
            const topChoice = executable.target.strategies[0]?.kind;
            if (last) {
              stepConfidenceScores.push(stepConfidence(executable.target.strategies, last.strategy));
            }
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
        if (recoverable && irreversibleAttempted) {
          // Rule 5.1: no backoff, no reload, no re-recognize once the irreversible action was
          // attempted. The interstitial may be the answer to the irreversible POST, and reloading a
          // POST response re-posts the form: after Submit, that is a second transfer.
          await evidence.append({
            turn: stepIndex,
            kind: "blocked",
            detail: {
              stepId: step.id,
              reason: `recoverable rule ("${recoverable.action}") NOT applied after the irreversible step was attempted`,
            },
            screenshotFile,
          });
          return await finish({
            status: "failure",
            atStepId: step.id,
            expected: step.intent,
            observed:
              `Recoverable state (${describeCheckpoint(recoverable.recognizer)}) after the irreversible step ` +
              `"${irreversibleAttempted.stepId}" was attempted; not retried, because a reload could re-submit it.`,
            category: "unexpected-state",
            evidenceRef,
          });
        }
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
            const outcome = await pauseOrFail(
              controller,
              surface,
              capability,
              step,
              `recoverable rule ("${recoverable.action}") exhausted after ${maxAttempts} attempts`,
              () =>
                finish({
                  status: "needs_human",
                  reason:
                    `Recoverable rule ("${recoverable.action}") exhausted after ${maxAttempts} ` +
                    `attempts at step "${step.id}".`,
                  atStepId: step.id,
                  contextRef: evidenceRef,
                }),
            );
            if (outcome.kind === "exit") return outcome.result;
            if (outcome.kind === "complete") break stepLoop;
            if (outcome.kind === "skip") {
              stepIndex += 1;
              continue stepLoop;
            }
            continue stepLoop;
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
          continue actLoop;
        }

        break actLoop;
      }

      const finalObservationForStep: Observation = observation ?? (await surface.perceive());

      await evidence.append({
        turn: stepIndex,
        kind: "action",
        detail: {
          stepId: step.id,
          actionKind: step.action.kind,
          target: step.target?.describedAs,
          value: step.value ? redact(executable.value ?? "", step.value.redact) : undefined,
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
          const outcome = await refuseRetryOfAttempted(
            await pauseOrFail(
              controller,
              surface,
              capability,
              step,
              pauseReason(`checkpoint failed: ${evalResult.detail}`),
              () =>
                finish({
                  status: "failure",
                  atStepId: step.id,
                  expected: describeCheckpoint(step.checkpoint!),
                  observed: evalResult.detail,
                  category,
                  evidenceRef,
                }),
            ),
            step,
          );
          if (outcome.kind === "exit") return outcome.result;
          if (outcome.kind === "complete") break stepLoop;
          if (outcome.kind === "skip") {
            stepIndex += 1;
            continue stepLoop;
          }
          continue stepLoop;
        }
      } else if (actionError) {
        const category = isSessionTimeoutState(finalObservationForStep, step) ? "session-timeout" : "unexpected-state";
        const outcome = await refuseRetryOfAttempted(
          await pauseOrFail(
            controller,
            surface,
            capability,
            step,
            pauseReason(`no locator resolved / action failed: ${actionError.message}`),
            () =>
              finish({
                status: "failure",
                atStepId: step.id,
                expected: step.intent,
                observed: actionError!.message,
                category,
                evidenceRef,
              }),
          ),
          step,
        );
        if (outcome.kind === "exit") return outcome.result;
        if (outcome.kind === "complete") break stepLoop;
        if (outcome.kind === "skip") {
          stepIndex += 1;
          continue stepLoop;
        }
        continue stepLoop;
      }

      // The step completed normally (D34). Absent hook: a no-op.
      await runStepHook(step, stepIndex);
      options.signal?.throwIfAborted();
      stepIndex += 1;
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
    // Abort first: whatever was in flight failed because the context was closed under it.
    if (options.signal?.aborted) {
      await closeSurface().catch(() => undefined);
      const reason: unknown = options.signal.reason;
      await evidence
        .append({
          turn: -1,
          kind: "aborted",
          detail: { reason: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason), irreversibleAttempted },
        })
        .catch(() => undefined);
      throw reason;
    }
    // Hook errors reject unchanged, even after the attempt. Before the attempt, any throw rejects
    // exactly as it always did.
    if (hookFailure || !irreversibleAttempted) {
      await closeSurface();
      throw hookFailure ? (hookFailure as { error: unknown }).error : err;
    }
    // Rule 5.3: after the attempt, a throw (Playwright error, a third screenshot failure, a
    // locator crash) becomes a result, so the caller sees commitUncertain instead of an exception
    // it might blindly retry.
    try {
      return await finish({
        status: "failure",
        atStepId: currentStepId,
        expected: "the run to continue normally after the irreversible step",
        observed: `Threw after the irreversible step was attempted: ${err instanceof Error ? err.message : String(err)}`,
        category: "unknown",
        evidenceRef,
      });
    } catch (finishErr) {
      await closeSurface();
      throw finishErr;
    }
  } finally {
    // A long-lived worker reuses one signal source across jobs; never leak a listener.
    options.signal?.removeEventListener("abort", onAbort);
  }
}
