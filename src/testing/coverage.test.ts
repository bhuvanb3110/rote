import { describe, expect, it } from "vitest";
import { formatCoverage } from "./coverage.js";

describe("formatCoverage", () => {
  it("lists every reached path with its count, sorted, and names the watched paths never reached", () => {
    const counts = new Map([
      ["R1:claimed", 40],
      ["R1:abandoned", 2],
      ["T5:recorded", 250],
    ]);
    expect(formatCoverage("model vs real", counts, ["R1:abandoned", "recover:T6.6", "reverify:moved"])).toBe(
      ["[coverage] model vs real: 3 paths reached", "  R1:abandoned  2", "  R1:claimed    40", "  T5:recorded   250", "  NOT reached (watched): recover:T6.6, reverify:moved"].join("\n"),
    );
    expect(formatCoverage("x", counts, ["R1:claimed"]).split("\n").at(-1)).toBe("  every watched path was reached");
  });
});
