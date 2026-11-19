import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, CapabilitySchema, type Capability } from "./schema.js";
import { deserializeCapability, serializeCapability } from "./serialize.js";
import { ReplayResultSchema, commitUncertainWarning, type ReplayResult } from "./replayResult.js";

// Hand-written example: look up member 10001 and read their current savings balance. Mirrors
// the mock-app routes/markup exercised in src/surface/locate.test.ts.
const memberLookupCapability: Capability = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "member-lookup",
  name: "Member Lookup",
  description: "Look up a credit union member by ID and read their current savings balance.",
  version: "1.0.0",
  target: {
    appId: "great-plains-cu-backoffice",
    entryUrlPattern: "^https?://[^/]+/$",
    surfaceType: "web",
  },
  inputs: [
    {
      name: "memberId",
      type: "string",
      required: true,
      description: "The member ID to look up.",
      redact: false,
    },
  ],
  outputs: [
    {
      name: "savingsBalance",
      type: "string",
      shape: "decimal currency string, e.g. 4532.10",
      producedByStepId: "read-balance",
    },
  ],
  steps: [
    {
      id: "navigate-home",
      intent: "Start at the member lookup screen.",
      action: { kind: "navigate", url: "https://mock-app.local/" },
      risk: "safe",
    },
    {
      id: "enter-member-id",
      intent: "Enter the member ID to search for.",
      action: { kind: "type" },
      target: {
        describedAs: "Member ID field",
        strategies: [{ kind: "labelText", labelText: "Member ID", confidence: 0.9 }],
      },
      value: { kind: "paramRef", paramName: "memberId", redact: false },
      risk: "safe",
    },
    {
      id: "click-search",
      intent: "Submit the member lookup search.",
      action: { kind: "click" },
      target: {
        describedAs: "Search button",
        strategies: [{ kind: "roleName", role: "button", name: "Search", confidence: 0.95 }],
      },
      checkpoint: { kind: "urlMatches", pattern: "^/member/\\d+$" },
      risk: "safe",
    },
    {
      id: "read-balance",
      intent: "Capture the member's current savings balance.",
      action: { kind: "readText" },
      target: {
        describedAs: "Current Savings Balance value",
        strategies: [
          { kind: "tableCell", rowLabel: "Current Savings Balance", confidence: 0.85 },
          { kind: "visual", confidence: 0.1 },
        ],
      },
      risk: "safe",
    },
  ],
  successCondition: {
    kind: "elementPresent",
    target: {
      describedAs: "Current Savings Balance value",
      strategies: [{ kind: "tableCell", rowLabel: "Current Savings Balance", confidence: 0.85 }],
    },
  },
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
    recordedAt: "2026-08-13T00:00:00.000Z",
    model: "claude-sonnet-5",
    transcriptRef: "transcript://discovery/member-lookup/2026-08-13",
  },
};

describe("Capability schema", () => {
  it("round-trips the member-lookup example through serialize -> validate -> deserialize", () => {
    const json = serializeCapability(memberLookupCapability);
    const restored = deserializeCapability(json);
    expect(restored).toEqual(memberLookupCapability);
  });

  it("rejects duplicate step ids", () => {
    const broken: Capability = {
      ...memberLookupCapability,
      steps: [memberLookupCapability.steps[0]!, memberLookupCapability.steps[0]!],
    };
    expect(CapabilitySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a paramRef naming an undeclared input", () => {
    const broken: Capability = {
      ...memberLookupCapability,
      steps: memberLookupCapability.steps.map((step) =>
        step.id === "enter-member-id"
          ? { ...step, value: { kind: "paramRef" as const, paramName: "notDeclared", redact: false } }
          : step,
      ),
    };
    expect(CapabilitySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a literal ValueRef marked redact: true", () => {
    const broken: Capability = {
      ...memberLookupCapability,
      steps: memberLookupCapability.steps.map((step) =>
        step.id === "enter-member-id"
          ? { ...step, value: { kind: "literal" as const, value: "secret", redact: true } }
          : step,
      ),
    };
    expect(CapabilitySchema.safeParse(broken).success).toBe(false);
  });
});

describe("ReplayResult", () => {
  it("constructs and narrows a success result", () => {
    const result: ReplayResult = {
      status: "success",
      outputs: { savingsBalance: "4532.10" },
      evidenceRef: "evidence://runs/1/final.png",
    };
    expect(ReplayResultSchema.parse(result)).toEqual(result);
    if (result.status === "success") {
      expect(result.outputs.savingsBalance).toBe("4532.10");
    } else {
      throw new Error("expected success to narrow");
    }
  });

  it("constructs and narrows a business_outcome result", () => {
    const result: ReplayResult = {
      status: "business_outcome",
      code: "NO_SUCH_MEMBER",
      detail: "No member exists with id 99999.",
      evidenceRef: "evidence://runs/2/final.png",
    };
    expect(ReplayResultSchema.parse(result)).toEqual(result);
    if (result.status === "business_outcome") {
      expect(result.code).toBe("NO_SUCH_MEMBER");
    } else {
      throw new Error("expected business_outcome to narrow");
    }
  });

  it("constructs and narrows a needs_human result", () => {
    const result: ReplayResult = {
      status: "needs_human",
      reason: "Unexpected confirmation dialog before the sub-account form.",
      atStepId: "click-search",
      contextRef: "context://runs/3/session.json",
    };
    expect(ReplayResultSchema.parse(result)).toEqual(result);
    if (result.status === "needs_human") {
      expect(result.atStepId).toBe("click-search");
    } else {
      throw new Error("expected needs_human to narrow");
    }
  });

  it("constructs and narrows a failure result", () => {
    const result: ReplayResult = {
      status: "failure",
      atStepId: "click-search",
      expected: "URL matches ^/member/\\d+$",
      observed: "URL was still /",
      category: "unexpected-state",
      evidenceRef: "evidence://runs/4/final.png",
    };
    expect(ReplayResultSchema.parse(result)).toEqual(result);
    if (result.status === "failure") {
      expect(result.category).toBe("unexpected-state");
    } else {
      throw new Error("expected failure to narrow");
    }
  });
});

describe("ReplayResult.commitUncertain (docs/DECISIONS.md D10)", () => {
  const marker = { irreversibleStepId: "step-11", detail: "failure (unexpected-state) after the attempt" };
  const nonSuccess: ReplayResult[] = [
    { status: "business_outcome", code: "INSUFFICIENT_FUNDS", detail: "x", evidenceRef: "evidence://r" },
    { status: "needs_human", reason: "x", atStepId: "step-11", contextRef: "evidence://r" },
    { status: "failure", atStepId: "step-12", expected: "x", observed: "y", category: "unknown", evidenceRef: "evidence://r" },
  ];

  it("every non-success member parses with and without the field", () => {
    for (const result of nonSuccess) {
      expect(ReplayResultSchema.parse(result)).toEqual(result);
      const marked = { ...result, commitUncertain: marker };
      expect(ReplayResultSchema.parse(marked)).toEqual(marked);
      expect(commitUncertainWarning(result)).toBeNull();
      expect(commitUncertainWarning(ReplayResultSchema.parse(marked))).toBe(
        "commit may have happened at step-11 -- verify before retrying (failure (unexpected-state) after the attempt)",
      );
    }
  });

  it("the field is not part of success: Zod strips it, so it can never reach a caller", () => {
    const parsed = ReplayResultSchema.parse({
      status: "success",
      outputs: {},
      evidenceRef: "evidence://r",
      commitUncertain: marker,
    });
    expect(parsed).not.toHaveProperty("commitUncertain");
    expect(commitUncertainWarning(parsed)).toBeNull();
  });

  it("a malformed marker is rejected", () => {
    expect(() => ReplayResultSchema.parse({ ...nonSuccess[2], commitUncertain: { irreversibleStepId: "" } })).toThrow();
  });
});
