// The Capability artifact: the typed, versioned output of discovery and the sole input to
// replay. This file is the focal point of the project, so the shape choices below are spelled
// out rather than left implicit.
//
// - Action carries no literal data or target. Action is just {kind, + kind-intrinsic config}
//   (navigate's url, waitFor's timeoutMs) -- click/type/selectOption/waitFor/readText carry
//   nothing else. Step composes action + target: ElementDescriptor + value: ValueRef. This
//   keeps raw data out of the persisted action shape entirely, so redaction is enforceable at
//   the schema level: a ValueRef with kind "literal" and redact: true is rejected outright (a
//   secret baked into an artifact as plaintext is exactly what CLAUDE.md's redaction rule
//   forbids -- if it needs redacting, it must be a paramRef, supplied at replay time, never
//   stored). Step also requires target unless action.kind is "navigate", and requires value iff
//   action.kind is "type" or "selectOption".
// - LocatorStrategy kinds are ranked by ARRAY ORDER on ElementDescriptor.strategies, not by a
//   hardcoded priority table -- the discovery run (or a human reviewer) decides and records the
//   order. Never a single brittle CSS selector: a descriptor is a ranked list of ways to find
//   the same element, from resilient (roleName/labelText) to fragile (css) to a last-resort
//   "visual" stub that always "succeeds" by carrying describedAs forward with no live handle.
// - Checkpoint is ONE declarative predicate vocabulary reused in four places: a step's own
//   checkpoint, the capability's overall successCondition, a BusinessOutcome's recognizer, and
//   a RecoverableRule's recognizer. A human reviewer only has to learn one small vocabulary
//   (urlMatches | textPresent | textAbsent | elementPresent) to read every recognizer in the
//   artifact. This file only defines the shape; evaluating a Checkpoint against a live
//   Observation is replay's job in a later stage.
// - schemaVersion (the format revision of this Zod definition, currently 1) is distinct from
//   version (this particular capability's own semver, bumped when the discovered flow changes).
//   Conflating the two would make it impossible to evolve the schema without touching every
//   capability's own version history.
// - provenance.transcriptRef is a REFERENCE (an id/URI), never the inline transcript -- this is
//   the literal mechanism of "decoupled from the raw LLM transcript" from CLAUDE.md. A Step's
//   intent is sanitized reasoning (the WHY), not raw model output.
// - Referential integrity beyond shape is enforced via superRefine on CapabilitySchema: step ids
//   are unique; every paramRef.paramName used by a step resolves to a declared input; every
//   TypedOutput.producedByStepId resolves to a declared step id. A structurally valid but
//   referentially broken artifact must not parse -- this is where Zod earns its "fail loudly"
//   keep, per CLAUDE.md's "one definition = type + JSON serialization + runtime validator."
import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1;

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const ConfidenceSchema = z.number().min(0).max(1);

// --- LocatorStrategy ---------------------------------------------------------------------

const RoleNameLocatorStrategySchema = z.object({
  kind: z.literal("roleName"),
  role: z.string().min(1),
  name: z.string().min(1),
  confidence: ConfidenceSchema,
});

const LabelTextLocatorStrategySchema = z.object({
  kind: z.literal("labelText"),
  labelText: z.string().min(1),
  confidence: ConfidenceSchema,
});

const TextAnchorLocatorStrategySchema = z.object({
  kind: z.literal("textAnchor"),
  anchorText: z.string().min(1),
  confidence: ConfidenceSchema,
});

const TableCellLocatorStrategySchema = z.object({
  kind: z.literal("tableCell"),
  rowLabel: z.string().min(1),
  column: z.number().int().nonnegative().optional(),
  confidence: ConfidenceSchema,
});

const CssLocatorStrategySchema = z.object({
  kind: z.literal("css"),
  css: z.string().min(1),
  confidence: ConfidenceSchema,
});

// Documented stub: no coordinate-based resolution is implemented yet. The description shown to
// a human/visual-matcher is the parent ElementDescriptor.describedAs, so no field is needed here.
const VisualLocatorStrategySchema = z.object({
  kind: z.literal("visual"),
  confidence: ConfidenceSchema,
});

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  RoleNameLocatorStrategySchema,
  LabelTextLocatorStrategySchema,
  TextAnchorLocatorStrategySchema,
  TableCellLocatorStrategySchema,
  CssLocatorStrategySchema,
  VisualLocatorStrategySchema,
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

// --- ElementDescriptor ---------------------------------------------------------------------

export const ElementDescriptorSchema = z.object({
  describedAs: z.string().min(1),
  strategies: z.array(LocatorStrategySchema).min(1),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

// --- Action ---------------------------------------------------------------------------------

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click") }),
  z.object({ kind: z.literal("type") }),
  z.object({ kind: z.literal("selectOption") }),
  z.object({ kind: z.literal("navigate"), url: z.string().min(1) }),
  z.object({ kind: z.literal("waitFor"), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("readText") }),
]);
export type Action = z.infer<typeof ActionSchema>;

const ACTIONS_NEEDING_TARGET = new Set<Action["kind"]>([
  "click",
  "type",
  "selectOption",
  "waitFor",
  "readText",
]);
const ACTIONS_NEEDING_VALUE = new Set<Action["kind"]>(["type", "selectOption"]);

// --- ValueRef -------------------------------------------------------------------------------

export const ValueRefSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: z.string(), redact: z.boolean() }),
    z.object({ kind: z.literal("paramRef"), paramName: z.string().min(1), redact: z.boolean() }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind === "literal" && value.redact) {
      ctx.addIssue({
        code: "custom",
        message:
          'A "literal" ValueRef cannot be marked redact: true -- a value that needs redacting ' +
          'must be a "paramRef" supplied at replay time, never a literal stored in the artifact.',
        path: ["redact"],
      });
    }
  });
export type ValueRef = z.infer<typeof ValueRefSchema>;

// --- Checkpoint / Recognizer -----------------------------------------------------------------

export const CheckpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("urlMatches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("textPresent"), text: z.string().min(1) }),
  z.object({ kind: z.literal("textAbsent"), text: z.string().min(1) }),
  z.object({ kind: z.literal("elementPresent"), target: ElementDescriptorSchema }),
]);
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// --- Step -----------------------------------------------------------------------------------

export const StepSchema = z
  .object({
    id: z.string().min(1),
    intent: z.string().min(1),
    action: ActionSchema,
    target: ElementDescriptorSchema.optional(),
    value: ValueRefSchema.optional(),
    checkpoint: CheckpointSchema.optional(),
    risk: z.enum(["safe", "risky"]),
  })
  .superRefine((step, ctx) => {
    if (ACTIONS_NEEDING_TARGET.has(step.action.kind) && !step.target) {
      ctx.addIssue({
        code: "custom",
        message: `Step "${step.id}": action "${step.action.kind}" requires a target.`,
        path: ["target"],
      });
    }
    if (ACTIONS_NEEDING_VALUE.has(step.action.kind) && !step.value) {
      ctx.addIssue({
        code: "custom",
        message: `Step "${step.id}": action "${step.action.kind}" requires a value.`,
        path: ["value"],
      });
    }
  });
export type Step = z.infer<typeof StepSchema>;

// --- TypedParam / TypedOutput -----------------------------------------------------------------

export const TypedValueTypeSchema = z.enum(["string", "number", "boolean"]);
export type TypedValueType = z.infer<typeof TypedValueTypeSchema>;

export const TypedParamSchema = z.object({
  name: z.string().min(1),
  type: TypedValueTypeSchema,
  required: z.boolean(),
  description: z.string().min(1),
  redact: z.boolean(),
});
export type TypedParam = z.infer<typeof TypedParamSchema>;

export const TypedOutputSchema = z.object({
  name: z.string().min(1),
  type: TypedValueTypeSchema,
  shape: z.string().min(1),
  producedByStepId: z.string().min(1),
});
export type TypedOutput = z.infer<typeof TypedOutputSchema>;

// --- BusinessOutcome / RecoverableRule ---------------------------------------------------------

export const BusinessOutcomeSchema = z.object({
  code: z.string().min(1),
  recognizer: CheckpointSchema,
  detail: z.string().min(1),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>;

export const RecoverableRuleSchema = z.object({
  recognizer: CheckpointSchema,
  action: z.enum(["dismiss", "retry"]),
  maxAttempts: z.number().int().positive().optional(),
  backoffMs: z.number().int().nonnegative().optional(),
});
export type RecoverableRule = z.infer<typeof RecoverableRuleSchema>;

// --- Capability (top-level artifact) -----------------------------------------------------------

export const CapabilitySchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().regex(SEMVER_REGEX, "version must be semantic, e.g. 1.0.0"),
    target: z.object({
      appId: z.string().min(1),
      entryUrlPattern: z.string().min(1),
      surfaceType: z.literal("web"),
    }),
    inputs: z.array(TypedParamSchema),
    outputs: z.array(TypedOutputSchema),
    steps: z.array(StepSchema).min(1),
    successCondition: CheckpointSchema,
    knownOutcomes: z.array(BusinessOutcomeSchema),
    recoverables: z.array(RecoverableRuleSchema),
    provenance: z.object({
      recordedAt: z.iso.datetime(),
      model: z.string().min(1),
      tenantId: z.string().optional(),
      appVersion: z.string().optional(),
      transcriptRef: z.string().min(1),
    }),
  })
  .superRefine((capability, ctx) => {
    const stepIds = new Set<string>();
    capability.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate step id "${step.id}".`,
          path: ["steps", index, "id"],
        });
      }
      stepIds.add(step.id);
    });

    const inputNames = new Set(capability.inputs.map((input) => input.name));
    capability.steps.forEach((step, index) => {
      if (step.value?.kind === "paramRef" && !inputNames.has(step.value.paramName)) {
        ctx.addIssue({
          code: "custom",
          message: `Step "${step.id}" references undeclared input param "${step.value.paramName}".`,
          path: ["steps", index, "value", "paramName"],
        });
      }
    });

    capability.outputs.forEach((output, index) => {
      if (!stepIds.has(output.producedByStepId)) {
        ctx.addIssue({
          code: "custom",
          message: `Output "${output.name}" references unknown step id "${output.producedByStepId}".`,
          path: ["outputs", index, "producedByStepId"],
        });
      }
    });
  });
export type Capability = z.infer<typeof CapabilitySchema>;
