// Single policy gate enforcing an allowlist (URL patterns + allowed action types), used in
// BOTH discovery and replay. Actions are classified safe(reversible) vs risky(irreversible);
// callers are expected to STOP rather than execute when an action comes back risky.
import type { ElementDescriptor, ExecutableAction } from "../surface/index.js";

export interface PolicyRule {
  originPattern: RegExp;
  allowedActionKinds: ExecutableAction["kind"][];
}

export interface SafetyPolicy {
  rules: PolicyRule[];
  /** Accessible-name/description patterns that mark a click as irreversible. */
  riskyClickNames: RegExp[];
}

export interface PolicyDecision {
  allowed: boolean;
  risk: "safe" | "risky";
  reason: string;
}

const ALL_ACTION_KINDS: ExecutableAction["kind"][] = [
  "navigate",
  "click",
  "type",
  "selectOption",
  "waitFor",
  "readText",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scopes the allowlist to the entry URL's origin — the app under discovery/replay. */
export function buildPolicyForOrigin(entryUrl: string): SafetyPolicy {
  const origin = new URL(entryUrl).origin;
  return {
    rules: [
      {
        originPattern: new RegExp(`^${escapeRegExp(origin)}(?:/|$)`),
        allowedActionKinds: ALL_ACTION_KINDS,
      },
    ],
    // Illustrative default for the demo app: an accessible name of exactly "Confirm" is
    // treated as the irreversible step. A real policy would carry a richer, app-specific list.
    riskyClickNames: [/^confirm$/i],
  };
}

function clickTargetName(target: ElementDescriptor | undefined): string | undefined {
  if (!target) return undefined;
  const roleStrategy = target.strategies.find((s) => s.kind === "roleName");
  if (roleStrategy && roleStrategy.kind === "roleName") return roleStrategy.name;
  return target.describedAs;
}

/**
 * Checks an action against the policy before it is executed. `navigate` is checked against its
 * destination URL; every other action is checked against the current page URL, since that's
 * where it will actually act. `risk: "risky"` does not mean "denied" — it means the caller
 * (discovery/replay) must not execute it and should instead stop, per CLAUDE.md's rule that
 * discovery stops at confirmation screens rather than committing irreversible actions.
 */
export function evaluateAction(
  policy: SafetyPolicy,
  currentUrl: string,
  action: ExecutableAction,
): PolicyDecision {
  const urlToCheck = action.kind === "navigate" ? action.url : currentUrl;
  const rule = policy.rules.find((r) => r.originPattern.test(urlToCheck));
  if (!rule) {
    return { allowed: false, risk: "safe", reason: `"${urlToCheck}" is outside the allowlisted origin.` };
  }
  if (!rule.allowedActionKinds.includes(action.kind)) {
    return {
      allowed: false,
      risk: "safe",
      reason: `Action "${action.kind}" is not allowed at "${urlToCheck}".`,
    };
  }
  if (action.kind === "click") {
    const name = clickTargetName(action.target);
    if (name && policy.riskyClickNames.some((pattern) => pattern.test(name))) {
      return {
        allowed: true,
        risk: "risky",
        reason: `Click target "${name}" matches a risky/irreversible action pattern.`,
      };
    }
  }
  return { allowed: true, risk: "safe", reason: "OK" };
}
