import { describe, expect, it } from "vitest";
import { canonicalizePath, matchesCanonically } from "./canonicalize.js";

describe("canonicalizePath", () => {
  it("replaces a numeric path segment with :id", () => {
    expect(canonicalizePath("/member/12345")).toBe("/member/:id");
  });

  it("replaces multiple numeric segments independently", () => {
    expect(canonicalizePath("/tenant/7/member/12345")).toBe("/tenant/:id/member/:id");
  });

  it("leaves non-numeric segments untouched", () => {
    expect(canonicalizePath("/member/12345/sub-account/confirm")).toBe(
      "/member/:id/sub-account/confirm",
    );
  });

  it("leaves a path with no numeric segments untouched", () => {
    expect(canonicalizePath("/member/sub-account")).toBe("/member/sub-account");
  });

  it("handles the root path", () => {
    expect(canonicalizePath("/")).toBe("/");
  });
});

describe("matchesCanonically", () => {
  it("recognizes the same record id, same path, as an exact canonical match", () => {
    expect(matchesCanonically("/member/10001", "http://localhost:4100/member/10001")).toBe(true);
  });

  it("recognizes a DIFFERENT record id at the same route shape", () => {
    expect(matchesCanonically("/member/10001", "http://localhost:4100/member/99999")).toBe(true);
  });

  it("recognizes the same route shape under a different tenant path prefix", () => {
    expect(
      matchesCanonically("/member/10001", "http://localhost:4100/tenant-b/member/99999"),
    ).toBe(true);
  });

  it("does not match a genuinely different route shape", () => {
    expect(
      matchesCanonically("/member/10001", "http://localhost:4100/member/10001/sub-account"),
    ).toBe(false);
  });

  it("works when both sides are given as bare paths, not full URLs", () => {
    expect(matchesCanonically("/member/10001", "/tenant-b/member/42")).toBe(true);
  });
});
