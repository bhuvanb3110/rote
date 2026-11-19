// The standard family's one accepted escalation (the reviewer decision during 10b, 2026-11-18, decision 3; D58):
// a job the crash cap sent to needs_human / crash_limit is accepted ONLY if every death in its history matches a
// scheduled chaos kill or pause of that worker, AND the ledger shows at most 1 row for its memo_key. Pure: the
// harness (scripts/chaos.ts) passes its rows and events in.
//
// A death is one recovery of a dead holder's lease, and recovery leaves exactly one row per death with its note
// ("lease expired in <state>; recovered by <worker> (T6.n <kind>)"): the holder's job_attempts row (T6.1, T6.2,
// T6.4, T6.6 from committing) or its job_verifications phase (T6.5, T6.6 from verifying). A holder that woke
// afterwards re-labels its own row lease_lost and keeps the note ("[recovery had recorded: ...]"), so the note is
// what identifies a death, whatever the row's final label. A reconcile run's row is never one (D58).
//
// A death matches a chaos event when the event is a `kill` or a `pause` of the replica whose hostname the holder's
// worker id starts with, and the event happened while that holder held the job: between the row's started_at and
// the recovery that closed it (ended_at), with SKEW_MS of slack for the host clock (events) against the
// database clock (rows).

/** The host's clock (chaos events) vs Postgres's clock (rows) on one machine: well under this. */
export const SKEW_MS = 2_000;

export interface AttemptRowForDeaths {
  job_id: string;
  attempt: number;
  worker_id: string;
  outcome: string | null;
  error: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
}
export interface PhaseRowForDeaths {
  job_id: string;
  fencing_token: number;
  worker_id: string;
  reason: string;
  decision: string | null;
  error: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
}
/** A chaos event as scripts/chaos.ts writes it to events.jsonl (only the fields used here). */
export interface ChaosEventForDeaths {
  kind: string;
  replica?: number;
  container?: string;
  at: string;
  tMs?: number | null;
}

export interface Death {
  /** Where recovery recorded it. */
  row: "attempt" | "verify phase";
  /** attempt number, or the phase's fencing token. */
  n: number;
  holder: string;
  /** The holder's hostname: the worker id up to its first "-" (src/worker/main.ts). */
  hostname: string;
  startedAt: string;
  endedAt: string | null;
  /** The recovery that closed it (T6.1 ... T6.6), from the note. */
  recovery: string;
}

export interface AttributedDeath extends Death {
  /** The kill or pause of the holder's replica while it held the job; null = no scheduled event explains it. */
  event: { kind: "kill" | "pause"; container: string; at: string; tMs: number | null } | null;
}

export interface CrashLimitVerdict {
  jobId: string;
  deaths: AttributedDeath[];
  /** jobs.crashes: the number of deaths the job counted. */
  crashes: number;
  ledgerRows: number;
  /** true = accepted as "escalated by crash cap (attributed)". */
  attributed: boolean;
  /** Why not, when not. */
  reasons: string[];
}

const RECOVERY_NOTE = /lease expired in (running|committing|verifying); recovered by \S+ \((T6\.\d) [a-z]+\)/;
const ms = (d: Date | string) => new Date(d).getTime();
const iso = (d: Date | string) => new Date(d).toISOString();
const hostOf = (workerId: string) => workerId.split("-")[0] ?? workerId;

/** Every death on one job, oldest first: the attempt and verify-phase rows that carry recovery's note. */
export function deathsOf(jobId: string, attempts: readonly AttemptRowForDeaths[], phases: readonly PhaseRowForDeaths[]): Death[] {
  const deaths: Death[] = [];
  for (const a of attempts) {
    const m = a.job_id === jobId ? RECOVERY_NOTE.exec(a.error ?? "") : null;
    if (m) deaths.push({ row: "attempt", n: a.attempt, holder: a.worker_id, hostname: hostOf(a.worker_id), startedAt: iso(a.started_at), endedAt: a.ended_at ? iso(a.ended_at) : null, recovery: m[2]! });
  }
  for (const p of phases) {
    if (p.job_id !== jobId || p.reason === "reconcile") continue;
    const m = RECOVERY_NOTE.exec(p.error ?? "");
    if (m) deaths.push({ row: "verify phase", n: p.fencing_token, holder: p.worker_id, hostname: hostOf(p.worker_id), startedAt: iso(p.started_at), endedAt: p.ended_at ? iso(p.ended_at) : null, recovery: m[2]! });
  }
  return deaths.sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
}

/** Matches each death to the kill or pause of its holder's replica while it held the job (or null). */
export function attributeDeaths(deaths: readonly Death[], events: readonly ChaosEventForDeaths[], hostnameOfReplica: ReadonlyMap<number, string>): AttributedDeath[] {
  return deaths.map((d) => {
    const from = ms(d.startedAt) - SKEW_MS;
    const to = d.endedAt ? ms(d.endedAt) + SKEW_MS : Number.POSITIVE_INFINITY;
    const e = events.find(
      (x) =>
        (x.kind === "kill" || x.kind === "pause") &&
        x.replica !== undefined &&
        hostnameOfReplica.get(x.replica) === d.hostname &&
        ms(x.at) >= from &&
        ms(x.at) <= to,
    );
    return { ...d, event: e ? { kind: e.kind as "kill" | "pause", container: e.container ?? `replica ${e.replica}`, at: e.at, tMs: e.tMs ?? null } : null };
  });
}

/** The verdict on one needs_human / crash_limit job (decision 3): every death attributed, and at most 1 ledger row. */
export function judgeCrashLimitEscalation(input: {
  jobId: string;
  crashes: number;
  ledgerRows: number;
  attempts: readonly AttemptRowForDeaths[];
  phases: readonly PhaseRowForDeaths[];
  events: readonly ChaosEventForDeaths[];
  hostnameOfReplica: ReadonlyMap<number, string>;
}): CrashLimitVerdict {
  const deaths = attributeDeaths(deathsOf(input.jobId, input.attempts, input.phases), input.events, input.hostnameOfReplica);
  const reasons: string[] = [];
  const unexplained = deaths.filter((d) => d.event === null);
  if (unexplained.length > 0) {
    reasons.push(`${unexplained.length} death(s) match no scheduled kill or pause of their worker: ${unexplained.map((d) => `${d.row} ${d.n} of ${d.holder} (${d.recovery})`).join(", ")}`);
  }
  if (deaths.length !== input.crashes) reasons.push(`${deaths.length} death row(s) found, but the job counted ${input.crashes} crash(es)`);
  if (input.ledgerRows > 1) reasons.push(`${input.ledgerRows} ledger rows for its memo_key (at most 1 allowed)`);
  return { jobId: input.jobId, deaths, crashes: input.crashes, ledgerRows: input.ledgerRows, attributed: reasons.length === 0, reasons };
}

/** "<job> (kills at 139.5 s, 170.3 s, ...)": how the tally lists an accepted escalation. */
export function describeAttributed(v: CrashLimitVerdict): string {
  const at = v.deaths.map((d) => `${d.event!.kind} of ${d.event!.container} at ${d.event!.tMs === null ? d.event!.at : `${(d.event!.tMs / 1000).toFixed(1)} s`}`);
  return `${v.jobId} (${v.deaths.length} deaths, ${v.ledgerRows} ledger row(s): ${at.join(", ")})`;
}
