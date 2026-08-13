// The two canonical demo goals. Discovery itself is not scripted — the LLM decides every step
// — but "what does success look like" and "what output does this goal need" are goal-specific
// facts a human author supplies, not something inferred from free text at this stage. A goal
// string that matches neither pattern fails loudly rather than guessing.
import type { Checkpoint } from "../artifact/index.js";

export interface GoalConfig {
  id: string;
  name: string;
  description: string;
  successCondition: Checkpoint;
  requiredOutputs: string[];
}

const BALANCE_TARGET = {
  describedAs: "Current Savings Balance value",
  strategies: [{ kind: "tableCell" as const, rowLabel: "Current Savings Balance", confidence: 0.85 }],
};

const MEMBER_LOOKUP_GOAL: GoalConfig = {
  id: "member-lookup",
  name: "Member Lookup",
  description: "Look up member 10001 and read their current savings balance.",
  successCondition: { kind: "elementPresent", target: BALANCE_TARGET },
  requiredOutputs: ["savingsBalance"],
};

const OPEN_SUB_ACCOUNT_GOAL: GoalConfig = {
  id: "open-sub-account",
  name: "Open Sub-Account",
  description: "Open a new sub-account for member 10001 and reach the confirmation screen.",
  successCondition: { kind: "urlMatches", pattern: "/sub-account/confirm$" },
  requiredOutputs: [],
};

export function resolveGoalConfig(goalText: string): GoalConfig {
  const lower = goalText.toLowerCase();
  if (lower.includes("savings balance") || (lower.includes("look up") && lower.includes("member"))) {
    return MEMBER_LOOKUP_GOAL;
  }
  if (lower.includes("sub-account") && (lower.includes("confirm") || lower.includes("open"))) {
    return OPEN_SUB_ACCOUNT_GOAL;
  }
  throw new Error(
    `Unrecognized goal: "${goalText}". This stage supports two canonical demo goals: ` +
      `"look up member 10001 and read their current savings balance" and ` +
      `"open a new sub-account for member 10001 and reach the confirmation screen".`,
  );
}
