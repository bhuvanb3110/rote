// The chaos schedule (D33): a seed reproduces it exactly; kills are 5-15 s apart inside the window;
// the pause fits; no kill hits the paused replica around its pause or a replica that is still down.
import { describe, expect, it } from "vitest";
import { buildSchedule, DEFAULT_CHAOS, mulberry32, type ChaosConfig } from "./schedule.js";

const cfg = (seed: number, over: Partial<ChaosConfig> = {}): ChaosConfig => ({ ...DEFAULT_CHAOS, seed, ...over });

describe("mulberry32", () => {
  it("is deterministic per seed, in [0, 1), and differs across seeds", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
    // Pinned, so a change to the generator (which would change every committed schedule) is noticed.
    expect(mulberry32(1)()).toBeCloseTo(0.6270739405881613, 15);
  });
});

describe("buildSchedule", () => {
  it("the same seed gives the same schedule; another seed another one", () => {
    expect(buildSchedule(cfg(7))).toEqual(buildSchedule(cfg(7)));
    expect(buildSchedule(cfg(8)).actions).not.toEqual(buildSchedule(cfg(7)).actions);
  });

  for (const seed of [1, 2, 3, 99, 123456, 2 ** 31 - 1]) {
    it(`seed ${seed}: gaps 5-15 s, all within the window, every kill followed by a start, the pause respected`, () => {
      const s = buildSchedule(cfg(seed));
      const kills = s.actions.filter((a) => a.kind === "kill");
      expect(kills.length).toBeGreaterThanOrEqual(Math.floor(DEFAULT_CHAOS.durationMs / DEFAULT_CHAOS.maxGapMs) - 1);
      for (const a of s.actions.filter((x) => x.kind === "kill" || x.kind === "pause")) {
        expect(a.atMs).toBeGreaterThanOrEqual(0);
        expect(a.atMs).toBeLessThan(DEFAULT_CHAOS.durationMs);
      }
      let prev = 0;
      for (const k of kills) {
        // A kill skipped because every replica was unavailable widens one gap; with 4 workers it never happens here.
        expect(k.atMs - prev).toBeGreaterThanOrEqual(DEFAULT_CHAOS.minGapMs);
        expect(k.atMs - prev).toBeLessThanOrEqual(DEFAULT_CHAOS.maxGapMs);
        prev = k.atMs;
        expect(s.actions).toContainEqual({ atMs: k.atMs + DEFAULT_CHAOS.restartDelayMs, kind: "start", replica: k.replica });
        expect(k.replica).toBeGreaterThanOrEqual(1);
        expect(k.replica).toBeLessThanOrEqual(DEFAULT_CHAOS.workers);
      }
      const p = s.pause!;
      expect(p.toMs - p.fromMs).toBe(45_000);
      expect(p.toMs).toBeLessThanOrEqual(DEFAULT_CHAOS.durationMs);
      for (const k of kills.filter((x) => x.replica === p.replica)) {
        expect(k.atMs < p.fromMs - DEFAULT_CHAOS.restartDelayMs || k.atMs >= p.toMs).toBe(true);
      }
      // Sorted by time.
      expect(s.actions.map((a) => a.atMs)).toEqual([...s.actions.map((a) => a.atMs)].sort((x, y) => x - y));
    });
  }

  it("redirects a kill drawn for the paused replica, and says so", () => {
    let found = false;
    for (let seed = 0; seed < 200 && !found; seed += 1) {
      const s = buildSchedule(cfg(seed));
      const r = s.actions.find((a) => a.kind === "kill" && a.redirectedFrom !== undefined);
      if (r && r.kind === "kill") {
        found = true;
        expect(r.replica).not.toBe(r.redirectedFrom);
      }
    }
    expect(found).toBe(true);
  });

  it("no pause when pauseMs is 0; refuses fewer than 2 workers and bad gaps", () => {
    expect(buildSchedule(cfg(1, { pauseMs: 0 })).pause).toBeNull();
    expect(() => buildSchedule(cfg(1, { workers: 1 }))).toThrow(/at least 2 workers/);
    expect(() => buildSchedule(cfg(1, { minGapMs: 10, maxGapMs: 5 }))).toThrow(/minGapMs/);
  });
});
