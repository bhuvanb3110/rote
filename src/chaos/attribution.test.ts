// The standard family's attributed escalation (D58; the reviewer decision during 10b, decision 3): every death in a
// needs_human / crash_limit job's history must match a scheduled kill or pause of that worker, and the ledger must
// show at most 1 row. Tested on the real case first: chaos seed 2080386450's job 1ba81fdf, read from the committed
// evidence (evidence/chaos/day2-exit/seed-01-2080386450/, written by scripts/chaos.ts on 0a30ac0).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attributeDeaths,
  deathsOf,
  describeAttributed,
  judgeCrashLimitEscalation,
  type AttemptRowForDeaths,
  type ChaosEventForDeaths,
  type PhaseRowForDeaths,
} from "./attribution.js";

const SEED_1 = path.join("evidence", "chaos", "day2-exit", "seed-01-2080386450");
const JOB = "1ba81fdf-1644-404d-a644-7314afddd597";
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(SEED_1, file), "utf8")) as T;
/** From the run's check.txt: "replicas: rote-worker-1=6c42b3e6387b, ...". */
const HOSTNAMES = new Map([
  [1, "6c42b3e6387b"],
  [2, "828771f3daa5"],
  [3, "d4dbfd1a450d"],
  [4, "3e162a9b4b49"],
]);
const events = (): ChaosEventForDeaths[] =>
  readFileSync(path.join(SEED_1, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ChaosEventForDeaths);

describe("deathsOf / attributeDeaths on the real escalated job (chaos seed 2080386450)", () => {
  const attempts = read<AttemptRowForDeaths[]>("attempts.json");
  const phases = read<PhaseRowForDeaths[]>("verifications.json");

  it("finds its four deaths: the attempt's (T6.4) and three verifiers' (T6.5, T6.5, T6.6), oldest first", () => {
    const deaths = deathsOf(JOB, attempts, phases);
    expect(deaths.map((d) => [d.row, d.hostname, d.recovery])).toEqual([
      ["attempt", "d4dbfd1a450d", "T6.4"],
      ["verify phase", "828771f3daa5", "T6.5"],
      ["verify phase", "828771f3daa5", "T6.5"],
      ["verify phase", "6c42b3e6387b", "T6.6"],
    ]);
  });

  it("matches each death to the scheduled kill of its worker's replica while it held the job (139.5 s, 170.3 s, 212.1 s, 242.1 s)", () => {
    const attributed = attributeDeaths(deathsOf(JOB, attempts, phases), events(), HOSTNAMES);
    expect(attributed.map((d) => [d.event?.kind, d.event?.container, d.event ? Math.round(d.event.tMs! / 100) / 10 : null])).toEqual([
      ["kill", "rote-worker-3", 139.5],
      ["kill", "rote-worker-2", 170.3],
      ["kill", "rote-worker-2", 212.1],
      ["kill", "rote-worker-1", 242.1],
    ]);
  });

  it("the verdict: attributed when the job counted those 4 deaths and has its 1 ledger row; the description names every kill", () => {
    const v = judgeCrashLimitEscalation({ jobId: JOB, crashes: 4, ledgerRows: 1, attempts, phases, events: events(), hostnameOfReplica: HOSTNAMES });
    expect(v).toMatchObject({ attributed: true, reasons: [] });
    expect(describeAttributed(v)).toBe(
      `${JOB} (4 deaths, 1 ledger row(s): kill of rote-worker-3 at 139.5 s, kill of rote-worker-2 at 170.3 s, kill of rote-worker-2 at 212.1 s, kill of rote-worker-1 at 242.1 s)`,
    );
  });

  it("NOT attributed with 2 ledger rows, with a death count that disagrees with the job's, or without the kills", () => {
    const base = { jobId: JOB, attempts, phases, events: events(), hostnameOfReplica: HOSTNAMES };
    expect(judgeCrashLimitEscalation({ ...base, crashes: 4, ledgerRows: 2 }).reasons).toEqual(["2 ledger rows for its memo_key (at most 1 allowed)"]);
    expect(judgeCrashLimitEscalation({ ...base, crashes: 5, ledgerRows: 1 }).reasons).toEqual(["4 death row(s) found, but the job counted 5 crash(es)"]);
    const noKills = judgeCrashLimitEscalation({ ...base, crashes: 4, ledgerRows: 1, events: events().filter((e) => e.kind !== "kill") });
    expect(noKills.attributed).toBe(false);
    expect(noKills.reasons[0]).toMatch(/^4 death\(s\) match no scheduled kill or pause of their worker: attempt 1 of d4dbfd1a450d-7-0416 \(T6\.4\)/);
  });
});

describe("attributeDeaths: the matching rule", () => {
  const t0 = Date.parse("2026-11-18T01:00:00.000Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const death = (startS: number, endS: number | null) => ({
    row: "verify phase" as const,
    n: 3,
    holder: "aaaa1111bbbb-7-1234",
    hostname: "aaaa1111bbbb",
    startedAt: at(startS),
    endedAt: endS === null ? null : at(endS),
    recovery: "T6.5",
  });
  const hosts = new Map([
    [1, "aaaa1111bbbb"],
    [2, "cccc2222dddd"],
  ]);

  it("a kill or a pause of the holder's replica, while it held the job (2 s of clock slack either side)", () => {
    expect(attributeDeaths([death(10, 50)], [{ kind: "kill", replica: 1, container: "rote-worker-1", at: at(20), tMs: 20_000 }], hosts)[0]!.event).toMatchObject({ kind: "kill" });
    expect(attributeDeaths([death(10, 50)], [{ kind: "pause", replica: 1, container: "rote-worker-1", at: at(9), tMs: 9_000 }], hosts)[0]!.event).toMatchObject({ kind: "pause" });
  });

  it("never another replica's kill, an event outside the holder's tenure, or a restart", () => {
    const none = (e: ChaosEventForDeaths) => attributeDeaths([death(10, 50)], [e], hosts)[0]!.event;
    expect(none({ kind: "kill", replica: 2, container: "rote-worker-2", at: at(20) })).toBeNull();
    expect(none({ kind: "kill", replica: 1, container: "rote-worker-1", at: at(5) })).toBeNull();
    expect(none({ kind: "kill", replica: 1, container: "rote-worker-1", at: at(55) })).toBeNull();
    expect(none({ kind: "start", replica: 1, container: "rote-worker-1", at: at(20) })).toBeNull();
  });

  it("reconcile rows are never deaths; a phase without recovery's note is not one either", () => {
    const row = (reason: string, error: string | null): PhaseRowForDeaths => ({ job_id: "j", fencing_token: 4, worker_id: "w-1", reason, decision: "crashed", error, started_at: at(0), ended_at: at(30) });
    expect(deathsOf("j", [], [row("reconcile", "lease expired in verifying; recovered by w-2 (T6.5 verify)")])).toEqual([]);
    expect(deathsOf("j", [], [row("lease_expired_in_verifying", "verify deferred 5 s")])).toEqual([]);
    // A holder that woke re-labels its row lease_lost and keeps the note: still a death.
    const relabelled = { ...row("lease_expired_in_verifying", "verify: lease lost [recovery had recorded: lease expired in verifying; recovered by w-2 (T6.5 verify)]"), decision: "lease_lost" };
    expect(deathsOf("j", [], [relabelled]).map((d) => d.recovery)).toEqual(["T6.5"]);
  });
});
