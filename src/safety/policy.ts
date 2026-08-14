// The guardrail model: a single policyGate(action, context) is the one place that decides
// whether an action is allowed to run at all (an allowlist of URL origins + permitted action
// kinds per origin) and whether it's risky/irreversible (an action-kind table, plus a
// name-pattern check for the one kind that can ever be risky: click). BOTH discovery
// (src/agent/discover.ts) and replay (src/replay/replay.ts) call this same function before
// every action -- there is no second, parallel safety check anywhere else in the codebase.
//
// What this DOES protect against: acting outside the URLs a capability was scoped to; running
// an action kind that wasn't explicitly permitted at the current URL; and silently committing an
// irreversible click (a final "Confirm"/"Submit"/"Delete"/"Remove") without either discovery
// stopping first or replay's caller explicitly setting approveRisky.
//
// What this does NOT protect against (worth restating in REPORT.md's Safety section): it does
// not sandbox the browser process or the target page -- a compromised or adversarial page could
// still attempt prompt injection against the LLM driving discovery, or exploit the browser
// itself; it does not validate the CONTENT of what's being submitted (a "safe" action can still
// submit wrong data); it does not authenticate or authorize WHO is allowed to invoke replay or
// pass approveRisky -- that's a deployment-level concern, not implemented here; and the risky-
// click name patterns and redaction patterns (see redact.ts) are heuristics, not guarantees --
// an irreversible action given an unexpected label, or a secret in a format the patterns don't
// recognize, can still slip through.
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

export interface PolicyContext {
  policy: SafetyPolicy;
  /** The page URL the action would run against (irrelevant for `navigate`, which supplies its own). */
  currentUrl: string;
}

const ALL_ACTION_KINDS: ExecutableAction["kind"][] = [
  "navigate",
  "click",
  "type",
  "selectOption",
  "waitFor",
  "readText",
];

/**
 * Action kinds that can ever be classified risky. Per CLAUDE.md: navigate/readText/waitFor/
 * type/selectOption are always reversible -- typing text or reading/waiting/navigating doesn't
 * destroy anything. Only `click` can be irreversible, because in this system a real "delete" or
 * "submit" is always expressed as a click on a button with that accessible name; there's no
 * separate action kind for it to classify structurally.
 */
export const RISK_ELIGIBLE_KINDS: ReadonlySet<ExecutableAction["kind"]> = new Set(["click"]);

/** Default irreversible-click name patterns — illustrative for the demo app, not exhaustive. */
export const DEFAULT_RISKY_CLICK_NAMES: RegExp[] = [
  /^confirm$/i,
  /^submit$/i,
  /^delete$/i,
  /^remove$/i,
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
    riskyClickNames: DEFAULT_RISKY_CLICK_NAMES,
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
 * (discovery/replay) must not execute it without a further, explicit decision: discovery always
 * stops rather than committing it; replay executes it only when the caller passed
 * `approveRisky: true` (see ReplayOptions), otherwise it also stops and reports `needs_human`.
 */
export function policyGate(action: ExecutableAction, context: PolicyContext): PolicyDecision {
  const { policy, currentUrl } = context;
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
  if (RISK_ELIGIBLE_KINDS.has(action.kind) && action.kind === "click") {
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
