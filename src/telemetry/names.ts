// Every metric and span name the fleet emits, in one place (docs/plans/step-13a.md section 3; step-13.md
// sections 4 and 5; reviewer decision 4: every metric is prefixed `rote_`). The README's metric table maps each
// one to the brief's name, from `brief` below.
//
// Labels are small fixed sets (a decision, a kind, an outcome code, a tenant or capability id), never a job id
// or anything a client chose. A label value that is not a plain identifier is replaced by "other" (labelValue).

export const COUNTERS = {
  rote_jobs_completed_total: { labels: ["outcome"], brief: "jobs_completed_total{outcome}", help: "Jobs a worker moved to a terminal state (T4, T7, T6.2, T6.6), by outcome." },
  rote_job_retries_total: { labels: [], brief: "job_retries_total", help: "Requeues a worker performed: T4 after a failed attempt, and T6.1 after a dead worker's lease." },
  rote_recoveries_total: { labels: ["result"], brief: "recoveries_total{result}", help: "Verify decisions after a possible commit, as the brief's three results (already_done, resubmitted, escalated); T6.6 counts as escalated." },
  rote_worker_crashes_total: { labels: ["kind"], brief: "worker_crashes_total{kind}", help: "Worker deaths, counted by the worker that recovered the job: before_intent, committing, verifier, reconciler." },
  rote_screenshot_retries_total: { labels: [], brief: "screenshot_retries_total", help: "Screenshot captures retried inside WebSurface.perceive (D8)." },
  rote_illegal_transitions_total: { labels: [], brief: "illegal_transitions_total", help: "Fenced writes the state guard refused with the token unchanged: a bug (D41)." },
  rote_verify_decisions_total: { labels: ["decision"], brief: "verify_decisions_total{decision}", help: "Finished verify phases, by decision (D43)." },
  rote_reconcile_decisions_total: { labels: ["decision"], brief: "reconcile_decisions_total{decision}", help: "Recorded reconcile runs, by decision (D50, D55)." },
  rote_duplicates_detected_total: { labels: [], brief: "duplicates_detected_total", help: "Reconciles that found 2+ transfers for one succeeded job (duplicate_suspected)." },
  rote_unrecorded_commits_detected_total: { labels: [], brief: "unrecorded_commits_detected_total", help: "Reconciles that found 1+ transfers for a failed / business_outcome job (D55)." },
  rote_reconcile_abandoned_total: { labels: [], brief: "reconcile_abandoned_total", help: "Reconciles the workers' pass abandoned at the reconcile crash cap (R3, D59)." },
  rote_telemetry_errors_total: { labels: ["kind"], brief: "telemetry_errors_total{kind}", help: "Telemetry's own failures, swallowed: span_export, span_dropped, gauge_query, call, flush, metrics_port." },
} as const;

export const HISTOGRAMS = {
  rote_job_duration_seconds: {
    brief: "job_duration_seconds",
    help: "From jobs.created_at to the terminal write, in seconds.",
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1800],
  },
} as const;

/** Up/down counters (a gauge the process moves itself). */
export const UP_DOWN = {
  rote_browser_contexts_in_use: { brief: "browser_contexts_in_use", help: "Browser contexts open for a job or a lookup in this worker (0 or 1: one at a time)." },
} as const;

/** Gauges the API reads from Postgres on every scrape (apiGauges.ts, reviewer decision 2). */
export const API_GAUGES = {
  rote_queue_depth: { labels: ["tenant"], brief: "queue_depth{tenant}", help: "Queued jobs per tenant." },
  rote_breaker_state: { labels: ["capability"], brief: "breaker_state{capability}", help: "Circuit breaker state: 0 closed, 1 half-open, 2 open. Always 0 until Day 4 builds the breaker." },
  rote_jobs_crashes_sum: { labels: [], brief: "(added) jobs_crashes_sum", help: "Sum of jobs.crashes over non-terminal jobs: the crash budget in use." },
} as const;

/** Not emitted by any process: a Prometheus recording rule over `up` (13c). Listed for the README's table. */
export const RECORDING_RULES = {
  rote_workers_alive: { brief: "workers_alive", help: 'sum(up{job="worker"}), a recording rule: a dead worker cannot report itself.' },
} as const;

export type CounterName = keyof typeof COUNTERS;
export type HistogramName = keyof typeof HISTOGRAMS;
export type UpDownName = keyof typeof UP_DOWN;
export type ApiGaugeName = keyof typeof API_GAUGES;

/** The known values of the closed label sets, seeded at 0 so a series exists before its first event. */
export const SEEDED_LABELS: Partial<Record<CounterName, Record<string, readonly string[]>>> = {
  rote_recoveries_total: { result: ["already_done", "resubmitted", "escalated"] },
  rote_worker_crashes_total: { kind: ["before_intent", "committing", "verifier", "reconciler"] },
  rote_verify_decisions_total: { decision: ["already_done", "resubmitted", "exhausted", "not_committed_final", "escalated", "deferred"] },
  rote_reconcile_decisions_total: { decision: ["reconciled", "duplicate_suspected", "unrecorded_commit_suspected", "reconcile_unreadable", "reconcile_deferred"] },
  rote_telemetry_errors_total: { kind: ["span_export", "span_dropped", "gauge_query", "call", "flush", "metrics_port"] },
};

export type TelemetryErrorKind = "span_export" | "span_dropped" | "gauge_query" | "call" | "flush" | "metrics_port";

// --- Spans -----------------------------------------------------------------------------------------------
// The attribute ALLOWLIST per span name (step-13.md section 2 rule 10, section 4's table). Anything else a
// caller offers is dropped before the span sees it: params, credentials, memo text, URLs and error messages
// are never copied in. 13a emits capability.step only; 13b adds the rest of section 4.
export const SPAN_ATTRIBUTES = {
  "capability.step": ["step_index", "step_id", "irreversible", "locator_strategy", "retries", "ended"],
} as const;

export type SpanName = keyof typeof SPAN_ATTRIBUTES;

/** Attribute values allowed through: numbers, booleans, and strings that are plain identifiers. */
export const ATTRIBUTE_STRING_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const LABEL_VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A label value as exported: itself when it is a plain identifier, else "other". */
export function labelValue(value: unknown): string {
  return typeof value === "string" && LABEL_VALUE_RE.test(value) ? value : "other";
}

/** The worker's existing counter names (src/worker/metrics.ts) and their exported names. */
export const WORKER_COUNTER_EXPORT: Record<string, CounterName> = {
  illegal_transitions_total: "rote_illegal_transitions_total",
  verify_decisions_total: "rote_verify_decisions_total",
  reconcile_decisions_total: "rote_reconcile_decisions_total",
  duplicates_detected_total: "rote_duplicates_detected_total",
  unrecorded_commits_detected_total: "rote_unrecorded_commits_detected_total",
  reconcile_abandoned_total: "rote_reconcile_abandoned_total",
};
