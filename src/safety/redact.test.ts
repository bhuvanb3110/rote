import { describe, expect, it } from "vitest";
import type { TypedParam } from "../artifact/index.js";
import { REDACTED_PLACEHOLDER, redact, redactObject, sensitiveKeysFromInputs } from "./redact.js";

describe("redact", () => {
  it("always redacts when explicit is true", () => {
    expect(redact("hunter2", true)).toBe(REDACTED_PLACEHOLDER);
  });

  it("leaves non-sensitive business data (a member id) intact", () => {
    expect(redact("10001", false)).toBe("10001");
  });

  it("auto-redacts an SSN-like value even without an explicit flag", () => {
    expect(redact("123-45-6789", false)).toBe(REDACTED_PLACEHOLDER);
  });

  it("auto-redacts a card-like value even without an explicit flag", () => {
    expect(redact("4111 1111 1111 1111", false)).toBe(REDACTED_PLACEHOLDER);
  });

  it("auto-redacts a long opaque token-like value even without an explicit flag", () => {
    expect(redact("sk-ant-api03-abcdefghijklmnopqrstuvwxyz", false)).toBe(REDACTED_PLACEHOLDER);
  });

  it("does not auto-redact short, ordinary business text", () => {
    expect(redact("Holiday Club", false)).toBe("Holiday Club");
    expect(redact("50.00", false)).toBe("50.00");
  });
});

describe("redactObject / sensitiveKeysFromInputs", () => {
  const inputs: TypedParam[] = [
    { name: "username", type: "string", required: true, description: "op", redact: true },
    { name: "password", type: "string", required: true, description: "pw", redact: true },
    { name: "memberId", type: "string", required: true, description: "id", redact: false },
  ];

  it("scrubs marked params from a serialized (JSON.stringify'd) object, leaving business data intact", () => {
    const params = { username: "operator", password: "hunter2", memberId: "10001" };
    const scrubbed = redactObject(params, sensitiveKeysFromInputs(inputs));
    const serialized = JSON.stringify(scrubbed);

    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("operator");
    expect(serialized).toContain("10001");
    expect(scrubbed.memberId).toBe("10001");
  });

  it("scrubs a marked value from a single log-line-style JSON record", () => {
    const logLine = JSON.stringify({
      kind: "action",
      detail: { stepId: "step-02", value: redact("hunter2", true) },
    });
    expect(logLine).not.toContain("hunter2");
    expect(logLine).toContain(REDACTED_PLACEHOLDER);
  });
});
