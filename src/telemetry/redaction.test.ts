// Redaction of span attributes (CLAUDE.md non-negotiable; step-13.md section 2 rule 10, section 7 row 2). A span
// carries only the keys on its name's allowlist (names.ts SPAN_ATTRIBUTES), and only values that are numbers,
// booleans or plain identifiers. Params, credentials, memo text, URLs and error messages are never copied in,
// whoever offers them. No browser and no database here, so the mutation check can run it anywhere (mutant 16:
// the allowlist skipped). The spans of a FULL transfer run are checked the same way in the equivalence test's
// in-memory mode (src/worker/telemetry.db.test.ts).
import { describe, expect, it } from "vitest";
import type { ReplayObservation } from "../replay/index.js";
import { OtelTelemetry, SPAN_ATTRIBUTES, allowedAttributes, stepObserver, type SpanRecord } from "./index.js";

const TRACE = "fedcba9876543210fedcba9876543210";
/** A transfer job's params, the tenant's fake credentials, and its memo key: none may reach a span. */
const PARAMS = { memberId: "10001", toMemberId: "10002", amount: "1.00" };
const CREDS = { username: "fleet-op-a-x91", password: "pw-a-Zq83-fake" };
const MEMO = "rote-6f1c2a9e-memo-key";
const FORBIDDEN_VALUES = [...Object.values(PARAMS), ...Object.values(CREDS), MEMO, "http://localhost:4100/member/10001?q=1", "refused: insufficient funds for 10001"];

function expectClean(spans: SpanRecord[]): void {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    const allowed: readonly string[] = SPAN_ATTRIBUTES[span.name as keyof typeof SPAN_ATTRIBUTES];
    expect(allowed, `span name ${span.name} has an allowlist`).toBeDefined();
    for (const key of Object.keys(span.attributes)) expect(allowed, `${span.name}: attribute ${key}`).toContain(key);
    // Name, attributes and events (random hex ids could contain a digit string like "10001" by chance).
    const text = JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events });
    for (const value of FORBIDDEN_VALUES) expect(text, `${span.name} carries "${value}"`).not.toContain(value);
  }
}

describe("span attributes: the allowlist", () => {
  it("allowedAttributes keeps only the span's allowlisted keys", () => {
    expect(
      allowedAttributes("capability.step", { step_index: 2, step_id: "step-02", irreversible: true, ...PARAMS, ...CREDS, memo: MEMO, params: PARAMS, url: "http://x/", error: "boom" }),
    ).toEqual({ step_index: 2, step_id: "step-02", irreversible: true });
  });

  it("an allowlisted key with a value that is not a plain identifier (a URL, text with spaces, an object) is dropped too", () => {
    expect(
      allowedAttributes("capability.step", { step_id: "http://localhost:4100/member/10001?q=1", locator_strategy: "refused: insufficient funds", retries: { n: 1 }, ended: ["x"], step_index: Number.NaN }),
    ).toEqual({});
  });

  it("a caller that spreads the params and credentials onto a span's attributes gets none of them exported", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: { kind: "memory" }, metrics: false });
    const span = t.startSpan("capability.step", { traceId: TRACE, attributes: { ...PARAMS, ...CREDS, memo: MEMO, step_index: 0, step_id: "step-01" } });
    span.setAttributes({ ...PARAMS, ...CREDS, memo: MEMO, locator_strategy: "roleName" });
    span.addEvent(`memo ${MEMO}`); // not an identifier-shaped event name: dropped
    span.end();
    await t.flush(1000);
    const spans = t.finishedSpans();
    expectClean(spans);
    expect(spans[0]!.attributes).toEqual({ step_index: 0, step_id: "step-01", locator_strategy: "roleName" });
    expect(spans[0]!.events).toEqual([]);
    await t.shutdown(100);
  });

  it("the step observer turns a run's events into capability.step spans with allowlisted attributes only", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: { kind: "memory" }, metrics: true });
    const observe = stepObserver(t, TRACE);
    const events: ReplayObservation[] = [];
    let at = Date.now();
    for (let i = 0; i < 12; i += 1) {
      const irreversible = i === 10;
      events.push({ kind: "step_start", stepIndex: i, stepId: `step-${String(i + 1).padStart(2, "0")}`, irreversible, at: at++ });
      events.push({ kind: "step_end", stepIndex: i, stepId: `step-${String(i + 1).padStart(2, "0")}`, irreversible, ended: "completed", locatorStrategy: i % 2 ? "roleName" : null, screenshotRetries: i === 3 ? 1 : 0, at: at++ });
    }
    events.push({ kind: "run_end", screenshotRetries: 1, at: at++ });
    for (const e of events) observe(e);
    await t.flush(1000);
    const spans = t.finishedSpans();
    expect(spans).toHaveLength(12);
    expectClean(spans);
    expect(spans.every((s) => s.traceId === TRACE)).toBe(true);
    expect(spans.filter((s) => s.attributes.irreversible === true).map((s) => s.attributes.step_id)).toEqual(["step-11"]);
    expect(spans.find((s) => s.attributes.step_index === 3)!.events).toEqual(["screenshot.retry"]);
    expect(await t.metricsText()).toMatch(/^rote_screenshot_retries_total 1$/m);
    await t.shutdown(100);
  });
});
