import { describe, expect, it } from "vitest";
import type { LocatorStrategy } from "../artifact/index.js";
import { computeRunConfidence, stepConfidence } from "./score.js";

function strategy(kind: LocatorStrategy["kind"]): LocatorStrategy {
  switch (kind) {
    case "roleName":
      return { kind, role: "button", name: "X", confidence: 0.9 };
    case "labelText":
      return { kind, labelText: "X", confidence: 0.8 };
    case "textAnchor":
      return { kind, anchorText: "X", confidence: 0.6 };
    case "tableCell":
      return { kind, rowLabel: "X", confidence: 0.9 };
    case "css":
      return { kind, css: ".x", confidence: 0.4 };
    case "visual":
      return { kind, confidence: 0.1 };
  }
}

describe("stepConfidence", () => {
  it("scores 1 when the top strategy resolved", () => {
    const strategies = [strategy("roleName"), strategy("labelText"), strategy("css")];
    expect(stepConfidence(strategies, "roleName")).toBe(1);
  });

  it("degrades linearly toward the last index", () => {
    const strategies = [strategy("roleName"), strategy("labelText"), strategy("css")];
    expect(stepConfidence(strategies, "labelText")).toBeCloseTo(0.5);
    expect(stepConfidence(strategies, "css")).toBe(0);
  });

  it("scores 1 for a single-strategy descriptor (only option, degenerate case)", () => {
    expect(stepConfidence([strategy("roleName")], "roleName")).toBe(1);
  });

  it("scores 0 when the resolved kind isn't authored in the list at all (the guaranteed 'visual' fallback)", () => {
    const strategies = [strategy("roleName"), strategy("labelText")];
    expect(stepConfidence(strategies, "visual")).toBe(0);
  });
});

describe("computeRunConfidence", () => {
  it("defaults to 1 when no step had a target", () => {
    expect(computeRunConfidence([])).toBe(1);
  });

  it("averages per-step scores", () => {
    expect(computeRunConfidence([1, 1, 0])).toBeCloseTo(2 / 3);
    expect(computeRunConfidence([1, 1, 1])).toBe(1);
    expect(computeRunConfidence([0, 0, 0])).toBe(0);
  });
});
