// Compiles a recorded discovery transcript into a Capability artifact: concrete values typed
// during the run are promoted into declared inputs + paramRefs (never baked as literals), and
// the result is validated through the canonical CapabilitySchema before being returned — a
// compiler bug that produces something invalid fails immediately, not on first replay.
import {
  CapabilitySchema,
  CURRENT_SCHEMA_VERSION,
  type Action,
  type Capability,
  type Step,
  type TypedOutput,
  type TypedParam,
  type ValueRef,
} from "../artifact/index.js";
import { hintedParamName } from "./fieldHints.js";
import type { DiscoveryTranscript, RecordedStep } from "./types.js";

// Named after the field it's for, so the compiled artifact reads naturally (e.g. "memberId",
// not "memberIdField"). Anything unmatched falls back to a generic slugify. Redaction is NOT
// decided here -- it was already decided at record time (see fieldHints.ts) so evidence and
// the compiled artifact never disagree about which fields are sensitive.
function slugify(describedAs: string): string {
  const words = describedAs
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "value";
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

function paramNameFor(describedAs: string, used: Set<string>): string {
  const base = hintedParamName(describedAs) ?? slugify(describedAs);
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

function buildAction(step: RecordedStep): Action {
  switch (step.actionKind) {
    case "navigate":
      return { kind: "navigate", url: step.url ?? "" };
    case "waitFor":
      return step.timeoutMs !== undefined
        ? { kind: "waitFor", timeoutMs: step.timeoutMs }
        : { kind: "waitFor" };
    default:
      return { kind: step.actionKind };
  }
}

export interface CompileOptions {
  id: string;
  name: string;
  description: string;
  appId: string;
  entryUrlPattern: string;
}

export function compileCapability(transcript: DiscoveryTranscript, options: CompileOptions): Capability {
  const usedNames = new Set<string>();
  const paramByStepId = new Map<string, { name: string; redact: boolean }>();
  const inputs: TypedParam[] = [];

  for (const step of transcript.steps) {
    if (!step.rawValue) continue;
    const name = paramNameFor(step.target?.describedAs ?? step.id, usedNames);
    const redact = step.rawValue.redact;
    paramByStepId.set(step.id, { name, redact });
    inputs.push({
      name,
      type: "string",
      required: true,
      description: `Value typed into "${step.target?.describedAs ?? "an input"}".`,
      redact,
    });
  }

  const steps: Step[] = transcript.steps.map((step) => {
    const param = paramByStepId.get(step.id);
    const value: ValueRef | undefined = param
      ? { kind: "paramRef", paramName: param.name, redact: param.redact }
      : undefined;
    const built: Step = {
      id: step.id,
      intent: step.intent,
      action: buildAction(step),
      risk: step.risk,
    };
    if (step.target) built.target = step.target;
    if (value) built.value = value;
    if (step.checkpoint) built.checkpoint = step.checkpoint;
    return built;
  });

  const outputs: TypedOutput[] = transcript.outputs.map((output) => ({
    name: output.name,
    type: "string",
    shape: "text captured via readText",
    producedByStepId: output.producedByStepId,
  }));

  const capability: Capability = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    description: options.description,
    version: "1.0.0",
    target: {
      appId: options.appId,
      entryUrlPattern: options.entryUrlPattern,
      surfaceType: "web",
    },
    inputs,
    outputs,
    steps,
    successCondition: transcript.successCondition,
    // Known failure modes of the target app, attached post-hoc from documented behavior
    // (mock-app/README.md) rather than discovered live during this particular run.
    knownOutcomes: [
      {
        code: "NO_SUCH_MEMBER",
        recognizer: { kind: "textPresent", text: "Record not found" },
        detail: "No member exists with the given ID.",
      },
      {
        code: "PERMISSION_DENIED",
        recognizer: { kind: "textPresent", text: "do not have permission" },
        detail: "The current operator is not permitted to view this member.",
      },
    ],
    recoverables: [
      {
        recognizer: { kind: "textPresent", text: "System temporarily unavailable" },
        action: "retry",
        maxAttempts: 3,
        backoffMs: 500,
      },
    ],
    provenance: {
      recordedAt: new Date().toISOString(),
      model: transcript.model,
      transcriptRef: transcript.transcriptRef,
      tokenUsage: transcript.tokenUsage,
    },
  };

  return CapabilitySchema.parse(capability);
}
