// The chaos harness's schedule (docs/plans/step-07.md section 2, docs/DECISIONS.md D33): decided up
// front, entirely by a seeded PRNG, so a seed reproduces the SCHEDULE exactly (kill times, victims, the
// pause window). It does not reproduce the interleaving of jobs with it: container start-up, Chromium
// and bank timing vary between runs. Pure; scripts/chaos.ts executes it against Docker.

/** mulberry32: a tiny, well-known 32-bit PRNG. Same seed, same sequence, on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChaosConfig {
  seed: number;
  /** Worker replicas, addressed by index 1..workers (Compose names them rote-worker-<i>). */
  workers: number;
  /** Kill workers (default true). false: the bank-fault-only family (no kills; set pauseMs 0 for no pause). */
  kills?: boolean;
  /**
   * Step 10b (plan section 4): seeded bank events -- the bank DOWN for 30 s (/control/errors/on: its 503 on
   * every page but /login) and SLOW for 60 s (/control/latency/2000) -- in disjoint halves of the window,
   * drawn from their own PRNG stream so a seed's kills and pause are the same with or without them.
   */
  bankFaults?: boolean;
  /** Kills happen in [0, durationMs) after the schedule clock starts (the first enqueue). */
  durationMs: number;
  /** Gap between consecutive kills, uniform in [minGapMs, maxGapMs]. Brief: 5-15 s. */
  minGapMs: number;
  maxGapMs: number;
  /** One `docker pause` of this length (0 = none). Reviewer decision B1: 45 s. */
  pauseMs: number;
  /** After a kill, the supervisor `docker start`s the same replica after this delay. */
  restartDelayMs: number;
}

export const DEFAULT_CHAOS: Omit<ChaosConfig, "seed"> = {
  workers: 4,
  durationMs: 150_000,
  minGapMs: 5_000,
  maxGapMs: 15_000,
  pauseMs: 45_000,
  restartDelayMs: 2_000,
};

/** A mock-bank control the harness GETs (/control/<control>): its 503 mode, or its latency. */
export type BankControl = "errors/on" | "errors/off" | `latency/${number}`;

export type ChaosAction =
  | { atMs: number; kind: "kill"; replica: number; redirectedFrom?: number }
  | { atMs: number; kind: "start"; replica: number }
  | { atMs: number; kind: "pause"; replica: number }
  | { atMs: number; kind: "unpause"; replica: number }
  | { atMs: number; kind: "bank"; control: BankControl };

/** The brief's bank-slow / bank-down row (plan section 4): down 30 s, slow (2 s per request) 60 s. */
export const BANK_OUTAGE_MS = 30_000;
export const BANK_SLOW_MS = 60_000;
export const BANK_LATENCY_MS = 2_000;
/** Bank faults need a window this long: each half must hold the 60 s slow period plus a 10 s lead. */
export const BANK_FAULT_MIN_DURATION_MS = 150_000;

export interface BankFaultPlan {
  outage: { fromMs: number; toMs: number };
  slow: { fromMs: number; toMs: number; latencyMs: number };
}

export interface ChaosSchedule {
  config: ChaosConfig;
  pause: { replica: number; fromMs: number; toMs: number } | null;
  /** The bank events (bankFaults only). */
  bank: BankFaultPlan | null;
  /** Sorted by atMs (ties: bank, unpause, start, pause, kill). */
  actions: ChaosAction[];
}

const ORDER: Record<ChaosAction["kind"], number> = { bank: 0, unpause: 1, start: 2, pause: 3, kill: 4 };

/**
 * The bank events: a separate stream (the seed xor a constant), so adding them never moves a kill or the
 * pause. The window splits into halves [10 s, D/2) and [D/2, D - 10 s); a coin decides which half is down
 * (30 s) and which is slow (60 s); each starts uniformly where it still fits in its half.
 */
export function buildBankFaults(seed: number, durationMs: number): BankFaultPlan {
  if (durationMs < BANK_FAULT_MIN_DURATION_MS) throw new Error(`bank faults need --duration >= ${BANK_FAULT_MIN_DURATION_MS / 1000} s (got ${durationMs / 1000} s)`);
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const half = Math.floor(durationMs / 2);
  const halves = [
    { from: 10_000, to: half },
    { from: half, to: durationMs - 10_000 },
  ];
  const outageFirst = rand() < 0.5;
  const place = (h: { from: number; to: number }, len: number) => {
    const fromMs = Math.round(h.from + rand() * (h.to - len - h.from));
    return { fromMs, toMs: fromMs + len };
  };
  const outage = place(halves[outageFirst ? 0 : 1]!, BANK_OUTAGE_MS);
  const slow = place(halves[outageFirst ? 1 : 0]!, BANK_SLOW_MS);
  return { outage, slow: { ...slow, latencyMs: BANK_LATENCY_MS } };
}

/**
 * The whole schedule from the seed. Draw order is fixed (pause first, then kills), so adding a kill
 * never moves the pause. A kill drawn for the paused replica around its pause, or for a replica
 * that is still down from the previous kill, goes to the next replica (index + 1, wrapping) that is
 * up: `docker kill` refuses a paused container, and a down one has nothing to kill. The redirect is
 * recorded (`redirectedFrom`).
 */
export function buildSchedule(config: ChaosConfig): ChaosSchedule {
  if (config.workers < 2) throw new Error("chaos needs at least 2 workers (one may be paused)");
  if (config.minGapMs <= 0 || config.maxGapMs < config.minGapMs) throw new Error("need 0 < minGapMs <= maxGapMs");
  const rand = mulberry32(config.seed);
  const pick = () => 1 + Math.floor(rand() * config.workers);

  let pause: ChaosSchedule["pause"] = null;
  if (config.pauseMs > 0) {
    const latestStart = Math.max(0, config.durationMs - config.pauseMs);
    const earliest = Math.min(10_000, latestStart);
    const fromMs = Math.round(earliest + rand() * (latestStart - earliest));
    pause = { replica: pick(), fromMs, toMs: fromMs + config.pauseMs };
  }

  const actions: ChaosAction[] = [];
  if (pause) {
    actions.push({ atMs: pause.fromMs, kind: "pause", replica: pause.replica });
    actions.push({ atMs: pause.toMs, kind: "unpause", replica: pause.replica });
  }
  const downUntil = new Map<number, number>();
  let t = 0;
  for (;;) {
    if (config.kills === false) break;
    t += Math.round(config.minGapMs + rand() * (config.maxGapMs - config.minGapMs));
    if (t >= config.durationMs) break;
    const drawn = pick();
    // The paused replica is off limits from restartDelay before the pause (it must be up to be
    // paused) until it is unpaused.
    const unavailable = (r: number) =>
      (pause !== null && r === pause.replica && t >= pause.fromMs - config.restartDelayMs && t < pause.toMs) ||
      (downUntil.get(r) ?? -1) > t;
    let replica = drawn;
    for (let i = 0; i < config.workers && unavailable(replica); i += 1) replica = (replica % config.workers) + 1;
    if (unavailable(replica)) continue; // every replica paused or down: skip this kill (recorded by its absence)
    actions.push({ atMs: t, kind: "kill", replica, ...(replica !== drawn ? { redirectedFrom: drawn } : {}) });
    actions.push({ atMs: t + config.restartDelayMs, kind: "start", replica });
    downUntil.set(replica, t + config.restartDelayMs);
  }
  const bank = config.bankFaults ? buildBankFaults(config.seed, config.durationMs) : null;
  if (bank) {
    actions.push({ atMs: bank.outage.fromMs, kind: "bank", control: "errors/on" });
    actions.push({ atMs: bank.outage.toMs, kind: "bank", control: "errors/off" });
    actions.push({ atMs: bank.slow.fromMs, kind: "bank", control: `latency/${bank.slow.latencyMs}` });
    actions.push({ atMs: bank.slow.toMs, kind: "bank", control: "latency/0" });
  }
  actions.sort((a, b) => a.atMs - b.atMs || ORDER[a.kind] - ORDER[b.kind]);
  return { config, pause, bank, actions };
}

/** A fresh seed when none is given (printed and saved by the harness). */
export function drawSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
