import { describe, expect, it } from "vitest";
import type { ExecutableAction } from "../surface/index.js";
import { buildPolicyForOrigin, policyGate, type SafetyPolicy } from "./policy.js";

const ORIGIN = "http://localhost:4100";

function clickOn(name: string): ExecutableAction {
  return {
    kind: "click",
    target: {
      describedAs: `${name} button`,
      strategies: [{ kind: "roleName", role: "button", name, confidence: 0.95 }],
    },
  };
}

describe("policyGate", () => {
  it("refuses a navigate to an off-allowlist URL with a clear reason", () => {
    const policy = buildPolicyForOrigin(ORIGIN);
    const decision = policyGate(
      { kind: "navigate", url: "http://evil.example.com/" },
      { policy, currentUrl: `${ORIGIN}/` },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/outside the allowlisted origin/i);
    expect(decision.reason).toContain("http://evil.example.com/");
  });

  it("refuses an action kind not permitted by the matching rule, with a clear reason", () => {
    const policy: SafetyPolicy = {
      rules: [{ originPattern: new RegExp(`^${ORIGIN}(?:/|$)`), allowedActionKinds: ["navigate", "readText"] }],
      riskyClickNames: [],
    };
    const decision = policyGate(clickOn("Search"), { policy, currentUrl: `${ORIGIN}/` });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/action "click" is not allowed/i);
  });

  it("classifies a click named Confirm as risky", () => {
    const policy = buildPolicyForOrigin(ORIGIN);
    const decision = policyGate(clickOn("Confirm"), { policy, currentUrl: `${ORIGIN}/member/10001` });
    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("risky");
  });

  it("classifies an ordinary click (e.g. Search) as safe", () => {
    const policy = buildPolicyForOrigin(ORIGIN);
    const decision = policyGate(clickOn("Search"), { policy, currentUrl: `${ORIGIN}/` });
    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("safe");
  });

  it("classifies non-click action kinds as always safe, even with a risky-sounding target", () => {
    const policy = buildPolicyForOrigin(ORIGIN);
    const decision = policyGate(
      {
        kind: "readText",
        target: {
          describedAs: "Delete confirmation text",
          strategies: [{ kind: "roleName", role: "button", name: "Delete", confidence: 0.9 }],
        },
      },
      { policy, currentUrl: `${ORIGIN}/` },
    );
    expect(decision.risk).toBe("safe");
  });
});
