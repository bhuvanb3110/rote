// The discovery loop: observe (Surface.perceive) -> decide (Claude, structured tool-use) ->
// act (Surface.act), until the goal's success condition is met or a stopping condition hits.
// The safety gate is enforced INSIDE the loop, before any action is executed -- the model
// proposes, the gate (and the harness) disposes.
import { randomUUID } from "node:crypto";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { WebSurface } from "../surface/index.js";
import type { ExecutableAction } from "../surface/index.js";
import { buildPolicyForOrigin, evaluateAction, type SafetyPolicy } from "../safety/index.js";
import { EvidenceRecorder, redactValue } from "../evidence/index.js";
import { ElementDescriptorSchema, CheckpointSchema } from "../artifact/index.js";
import { DISCOVERY_TOOLS } from "./tools.js";
import { evaluateCheckpoint } from "../replay/checkpoint.js";
import { isKnownSensitiveField } from "./fieldHints.js";
import { resolveGoalConfig, type GoalConfig } from "./goals.js";
import { compileCapability } from "./compile.js";
import type { DiscoveryOptions, DiscoveryOutcome, RecordedOutput, RecordedStep } from "./types.js";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const DEFAULT_MAX_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
const APP_ID = "great-plains-cu-backoffice";

function buildSystemPrompt(goal: GoalConfig, entryUrl: string, origin: string): string {
  return [
    "You are a UI discovery agent. Complete the GOAL below by operating a legacy web",
    "back-office application one step at a time, using the provided tools. You cannot see",
    "raw HTML -- only the compact observation given each turn (URL, an accessibility",
    "snapshot, an excerpt of visible text, landmark labels, and a screenshot).",
    "",
    `GOAL: ${goal.description}`,
    `STARTING URL: ${entryUrl}`,
    `ALLOWED ORIGIN: ${origin} -- you may only act within this origin.`,
    "",
    "Rules:",
    "- Take exactly one tool call per turn.",
    "- For every action targeting an element, rank your strategies from most to least",
    "  reliable: prefer roleName (ARIA role + accessible name) or labelText; use tableCell",
    "  for a value inside a labeled table row; use textAnchor for a clickable near some",
    "  anchor text with no formal label; use css only as a last resort. Give each strategy",
    "  a confidence between 0 and 1.",
    '- Give a short "intent" with every action: one sentence on WHY, not a transcript of',
    "  your reasoning.",
    '- If you land on a login screen, log in with username "operator" and password',
    '  "operator" -- mark the password value redact: true.',
    "- After an action that should produce a specific, checkable next state, call",
    "  assert_checkpoint to confirm it happened before continuing.",
    "- When you read a value the goal asked you to capture, call emit_output with a short",
    "  camelCase name and the value.",
    "- If you reach a state you cannot make progress from, call escalate with a reason",
    "  instead of guessing.",
    '- You are inside a safety gate: actions outside the allowed origin, or actions this',
    '  app marks irreversible (e.g. a final "Confirm" click), will be blocked or will end',
    "  the run rather than being executed -- reaching the point just before such an action",
    "  can itself be the goal's success condition.",
  ].join("\n");
}

function summarizeObservation(observation: {
  url: string;
  visibleText: string;
  landmarks: string[];
  accessibilitySnapshot: string;
}): string {
  return [
    `URL: ${observation.url}`,
    `Visible text (excerpt): ${observation.visibleText}`,
    `Landmarks: ${observation.landmarks.join(" | ")}`,
    `Accessibility snapshot:\n${observation.accessibilitySnapshot}`,
  ].join("\n");
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set (checked process.env after loading .env).");
  }
  const goal = resolveGoalConfig(options.goal);
  const model = options.model ?? DEFAULT_MODEL;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = new URL(options.entryUrl).origin;
  const policy: SafetyPolicy = buildPolicyForOrigin(options.entryUrl);

  const runId = `${goal.id}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const evidence = await EvidenceRecorder.create(options.evidenceBaseDir ?? "evidence", runId);
  const artifactsDir = options.artifactsDir ?? "artifacts";

  const client = new Anthropic({ apiKey });
  const surface = await WebSurface.launch({ headless: options.headless ?? false });

  const steps: RecordedStep[] = [];
  const outputs: RecordedOutput[] = [];
  let lastReadTextStepId: string | undefined;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let consecutiveFailures = 0;
  let stepIdCounter = 0;
  const nextStepId = () => `step-${String((stepIdCounter += 1)).padStart(2, "0")}`;

  const systemPrompt = buildSystemPrompt(goal, options.entryUrl, origin);
  const messages: Anthropic.MessageParam[] = [];

  let closed = false;
  const closeSurface = async () => {
    if (!closed) {
      closed = true;
      await surface.close();
    }
  };

  async function finish(
    result: { status: "success" } | { status: "needs_human" | "failure"; reason: string },
  ): Promise<DiscoveryOutcome> {
    await evidence.append({
      turn: -1,
      kind: "action",
      detail: { finalStatus: result.status, reason: "reason" in result ? result.reason : undefined },
    });
    await closeSurface();

    if (result.status !== "success") {
      return { status: result.status, reason: result.reason, evidenceDir: evidence.directory, steps: steps.length };
    }

    const capability = compileCapability(
      {
        goalId: goal.id,
        goalName: goal.name,
        goalDescription: goal.description,
        entryUrl: options.entryUrl,
        model,
        steps,
        outputs,
        successCondition: goal.successCondition,
        transcriptRef: `evidence://${evidence.directory.replace(/\\/g, "/")}/run.jsonl`,
        tokenUsage: usage,
      },
      {
        id: goal.id,
        name: goal.name,
        description: goal.description,
        appId: APP_ID,
        entryUrlPattern: `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
      },
    );

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(artifactsDir, { recursive: true });
    const capabilityPath = path.join(artifactsDir, `${goal.id}.json`);
    await writeFile(capabilityPath, JSON.stringify(capability, null, 2), "utf8");

    return { status: "success", capability, capabilityPath, evidenceDir: evidence.directory, steps: steps.length };
  }

  try {
    await surface.act({ kind: "navigate", url: options.entryUrl });
    const startedAt = Date.now();
    let turn = 0;

    while (true) {
      if (Date.now() - startedAt > timeoutMs) {
        return await finish({ status: "failure", reason: `Timed out after ${timeoutMs}ms.` });
      }
      if (turn >= maxSteps) {
        return await finish({ status: "failure", reason: `Exceeded max steps (${maxSteps}).` });
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return await finish({
          status: "needs_human",
          reason: "Stuck: too many consecutive failed/blocked actions in a row.",
        });
      }

      const observation = await surface.perceive();
      const screenshotFile = await evidence.recordScreenshot(observation.screenshot);

      const outcomeCheck = await evaluateCheckpoint(surface, observation, goal.successCondition);
      const emittedNames = new Set(outputs.map((o) => o.name));
      const hasRequiredOutputs = goal.requiredOutputs.every((name) => emittedNames.has(name));
      if (outcomeCheck.passed && hasRequiredOutputs) {
        return await finish({ status: "success" });
      }

      turn += 1;
      messages.push({
        role: "user",
        content: [
          { type: "text", text: `Turn ${turn}. Current observation:\n${summarizeObservation(observation)}` },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: observation.screenshot.toString("base64") },
          },
        ],
      });

      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        tools: DISCOVERY_TOOLS,
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        messages,
      });

      usage = {
        inputTokens: usage.inputTokens + response.usage.input_tokens,
        outputTokens: usage.outputTokens + response.usage.output_tokens,
      };
      await evidence.append({
        turn,
        kind: "model_call",
        detail: { model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        screenshotFile,
      });

      messages.push({ role: "assistant", content: response.content });

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (!toolUse) {
        return await finish({
          status: "needs_human",
          reason: `Model did not call a tool (stop_reason: ${response.stop_reason}).`,
        });
      }

      let resultText: string;
      let isError = false;
      let checkpointFailed = false;
      let terminal: DiscoveryOutcome | null = null;

      switch (toolUse.name) {
        case "click":
        case "type":
        case "selectOption":
        case "navigate":
        case "readText":
        case "waitFor": {
          const outcome = await handleSurfaceAction(toolUse.name, toolUse.input);
          resultText = outcome.resultText;
          isError = outcome.isError;
          terminal = outcome.terminal;
          break;
        }
        case "assert_checkpoint": {
          const outcome = await handleAssertCheckpoint(toolUse.input);
          resultText = outcome.resultText;
          isError = outcome.isError;
          checkpointFailed = outcome.passed === false;
          break;
        }
        case "emit_output": {
          const outcome = handleEmitOutput(toolUse.input);
          resultText = outcome.resultText;
          isError = outcome.isError;
          break;
        }
        case "escalate": {
          const inputResult = z.object({ reason: z.string().min(1) }).safeParse(toolUse.input);
          const reason = inputResult.success ? inputResult.data.reason : "escalate called with invalid input";
          await evidence.append({ turn, kind: "escalate", detail: { reason } });
          terminal = await finish({ status: "needs_human", reason });
          resultText = "Escalated to a human.";
          break;
        }
        default: {
          resultText = `Unknown tool "${toolUse.name}".`;
          isError = true;
        }
      }

      if (isError || checkpointFailed) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }

      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText, is_error: isError }],
      });

      if (terminal) return terminal;
    }

    async function handleSurfaceAction(
      name: "click" | "type" | "selectOption" | "navigate" | "readText" | "waitFor",
      rawInput: unknown,
    ): Promise<{ resultText: string; isError: boolean; terminal: DiscoveryOutcome | null }> {
      const inputObj = (rawInput ?? {}) as Record<string, unknown>;
      const intent = typeof inputObj.intent === "string" ? inputObj.intent : "(no intent given)";

      if (name === "navigate") {
        const parsed = z.object({ url: z.string().min(1) }).safeParse(rawInput);
        if (!parsed.success) {
          return { resultText: `Invalid navigate input: ${z.prettifyError(parsed.error)}`, isError: true, terminal: null };
        }
        const action: ExecutableAction = { kind: "navigate", url: parsed.data.url };
        const decision = evaluateAction(policy, surface.playwrightPage.url(), action);
        if (!decision.allowed) {
          await evidence.append({ turn, kind: "blocked", detail: { action: "navigate", url: parsed.data.url, reason: decision.reason } });
          return { resultText: `Blocked by safety policy: ${decision.reason}`, isError: true, terminal: null };
        }
        await surface.act(action);
        const stepId = nextStepId();
        steps.push({ id: stepId, intent, actionKind: "navigate", url: parsed.data.url, risk: decision.risk });
        lastReadTextStepId = undefined;
        await evidence.append({ turn, kind: "action", detail: { actionKind: "navigate", url: parsed.data.url, intent, stepId } });
        return { resultText: `Navigated to ${parsed.data.url}.`, isError: false, terminal: null };
      }

      const targetParsed = ElementDescriptorSchema.safeParse(inputObj.target);
      if (!targetParsed.success) {
        return { resultText: `Invalid target: ${z.prettifyError(targetParsed.error)}`, isError: true, terminal: null };
      }
      const target = targetParsed.data;

      let rawValue: { value: string; redact: boolean } | undefined;
      let executable: ExecutableAction;
      if (name === "type" || name === "selectOption") {
        const valueParsed = z.object({ value: z.string(), redact: z.boolean().optional() }).safeParse(inputObj);
        if (!valueParsed.success) {
          return { resultText: `Invalid ${name} input: ${z.prettifyError(valueParsed.error)}`, isError: true, terminal: null };
        }
        // Combine the model's own redact flag with our own knowledge of sensitive fields --
        // decided once, here, before anything is written to evidence, so the evidence log and
        // the compiled artifact can never disagree about which fields are sensitive.
        const effectiveRedact = (valueParsed.data.redact ?? false) || isKnownSensitiveField(target.describedAs);
        rawValue = { value: valueParsed.data.value, redact: effectiveRedact };
        executable = { kind: name, target, value: rawValue.value };
      } else if (name === "waitFor") {
        const timeoutParsed = z.object({ timeoutMs: z.number().int().positive().optional() }).safeParse(inputObj);
        const timeoutMsForWait = timeoutParsed.success ? timeoutParsed.data.timeoutMs : undefined;
        executable = { kind: "waitFor", target, timeoutMs: timeoutMsForWait };
      } else {
        executable = { kind: name, target };
      }

      const decision = evaluateAction(policy, surface.playwrightPage.url(), executable);
      if (!decision.allowed) {
        await evidence.append({
          turn,
          kind: "blocked",
          detail: { actionKind: name, target: target.describedAs, reason: decision.reason },
        });
        return { resultText: `Blocked by safety policy: ${decision.reason}`, isError: true, terminal: null };
      }
      if (decision.risk === "risky") {
        await evidence.append({
          turn,
          kind: "blocked",
          detail: { actionKind: name, target: target.describedAs, reason: `risky/irreversible: ${decision.reason}` },
        });
        const already = await evaluateCheckpoint(surface, await surface.perceive(), goal.successCondition);
        const terminalOutcome = await finish(
          already.passed
            ? { status: "success" }
            : { status: "needs_human", reason: `Stopped before irreversible action: ${decision.reason}` },
        );
        return {
          resultText: `This action is irreversible and was NOT executed: ${decision.reason}. Discovery has ended.`,
          isError: false,
          terminal: terminalOutcome,
        };
      }

      const handle = await surface.locate(target);
      await surface.act(executable);

      const stepId = nextStepId();
      steps.push({
        id: stepId,
        intent,
        actionKind: name,
        target,
        rawValue,
        risk: decision.risk,
      });
      if (name === "readText") lastReadTextStepId = stepId;

      await evidence.append({
        turn,
        kind: "action",
        detail: {
          actionKind: name,
          target: target.describedAs,
          resolvedStrategy: handle?.strategy,
          value: rawValue ? redactValue(rawValue.value, rawValue.redact) : undefined,
          intent,
          stepId,
        },
      });

      const readResult = name === "readText" ? ` Read text: "${surface.lastReadText ?? ""}"` : "";
      return { resultText: `${name} executed on "${target.describedAs}".${readResult}`, isError: false, terminal: null };
    }

    async function handleAssertCheckpoint(
      rawInput: unknown,
    ): Promise<{ resultText: string; isError: boolean; passed?: boolean }> {
      const parsed = z.object({ checkpoint: CheckpointSchema }).safeParse(rawInput);
      if (!parsed.success) {
        return { resultText: `Invalid checkpoint: ${z.prettifyError(parsed.error)}`, isError: true };
      }
      const observation = await surface.perceive();
      const evaluation = await evaluateCheckpoint(surface, observation, parsed.data.checkpoint);
      const lastStep = steps[steps.length - 1];
      if (lastStep) lastStep.checkpoint = parsed.data.checkpoint;
      await evidence.append({
        turn,
        kind: "checkpoint",
        detail: { checkpoint: parsed.data.checkpoint, passed: evaluation.passed, message: evaluation.detail },
      });
      return {
        resultText: `${evaluation.passed ? "PASS" : "FAIL"}: ${evaluation.detail}`,
        isError: false,
        passed: evaluation.passed,
      };
    }

    function handleEmitOutput(rawInput: unknown): { resultText: string; isError: boolean } {
      const parsed = z.object({ name: z.string().min(1), value: z.string() }).safeParse(rawInput);
      if (!parsed.success) {
        return { resultText: `Invalid emit_output input: ${z.prettifyError(parsed.error)}`, isError: true };
      }
      if (!lastReadTextStepId) {
        return { resultText: "emit_output must follow a readText action.", isError: true };
      }
      outputs.push({ name: parsed.data.name, value: parsed.data.value, producedByStepId: lastReadTextStepId });
      void evidence.append({ turn, kind: "output", detail: { name: parsed.data.name, value: parsed.data.value } });
      return { resultText: `Recorded output "${parsed.data.name}".`, isError: false };
    }
  } catch (err) {
    await closeSurface();
    throw err;
  }
}
