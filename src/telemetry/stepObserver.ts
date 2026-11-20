// Replay's `observe` events (src/replay/types.ts ReplayObservation) -> one `capability.step` span per step, in the
// job's trace, plus rote_screenshot_retries_total from each run's total (D8 promised the metric). Step 13a's one
// span (docs/plans/step-13a.md section 1): its parent is the synthetic remote parent of the job's trace_id until
// migration 0009 (13b) gives the job a real root.
//
// Attributes are the allowlisted ones only (names.ts SPAN_ATTRIBUTES): the step's index and id, whether it is the
// irreversible one, the locator strategy that won, its screenshot retries and how it ended. Never a value typed,
// a URL, page text or an error message: the events carry none.
import type { ReplayObservation } from "../replay/types.js";
import type { Telemetry, TelemetrySpan } from "./types.js";

export function stepObserver(telemetry: Telemetry, traceId: string): (event: ReplayObservation) => void {
  const open = new Map<number, TelemetrySpan>();
  return (event) => {
    if (event.kind === "step_start") {
      open.get(event.stepIndex)?.end(event.at);
      open.set(
        event.stepIndex,
        telemetry.startSpan("capability.step", {
          traceId,
          startTime: event.at,
          attributes: { step_index: event.stepIndex, step_id: event.stepId, irreversible: event.irreversible },
        }),
      );
      return;
    }
    if (event.kind === "step_end") {
      const span = open.get(event.stepIndex);
      open.delete(event.stepIndex);
      if (!span) return;
      span.setAttributes({
        ...(event.locatorStrategy ? { locator_strategy: event.locatorStrategy } : {}),
        retries: event.screenshotRetries,
        ended: event.ended,
      });
      if (event.screenshotRetries > 0) span.addEvent("screenshot.retry");
      span.end(event.at);
      return;
    }
    for (const span of open.values()) span.end(event.at);
    open.clear();
    if (event.screenshotRetries > 0) telemetry.count("rote_screenshot_retries_total", undefined, event.screenshotRetries);
  };
}
