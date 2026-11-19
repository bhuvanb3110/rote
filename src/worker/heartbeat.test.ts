// The heartbeat class (T2's caller) with fake timers and a fake extend(): no Postgres, no browser
// (docs/plans/step-08.md section 8, unit). The SQL itself is tested in heartbeat.db.test.ts.
import { describe, expect, it } from "vitest";
import type { Queryable } from "../queue/index.js";
import { Heartbeat, validateLeaseTiming, type HeartbeatTimers, type LeaseArgs } from "./heartbeat.js";
import { LeaseLostError } from "./leaseErrors.js";

/** A manual interval: tick() fires the registered callback once. */
function fakeTimers() {
  let fn: (() => void) | null = null;
  let ms = -1;
  let cleared = 0;
  const timers: HeartbeatTimers = {
    setInterval: (f, interval) => {
      fn = f;
      ms = interval;
      return 1;
    },
    clearInterval: () => {
      fn = null;
      cleared += 1;
    },
  };
  return {
    timers,
    get intervalMs() {
      return ms;
    },
    get cleared() {
      return cleared;
    },
    get armed() {
      return fn !== null;
    },
    tick() {
      fn?.();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const pool = {} as Queryable;

function make(extend: (db: Queryable, args: LeaseArgs) => Promise<boolean>) {
  const t = fakeTimers();
  const controller = new AbortController();
  const warnings: string[] = [];
  const hb = new Heartbeat({
    pool,
    jobId: "job-1",
    fencingToken: 7,
    workerId: "w1",
    leaseSeconds: 30,
    intervalMs: 10_000,
    controller,
    extend,
    timers: t.timers,
    log: { info() {}, warn: (_o, m) => warnings.push(m), error() {} },
  });
  return { hb, t, controller, warnings };
}

describe("validateLeaseTiming (the worker refuses heartbeat * 2 >= lease)", () => {
  it("accepts the brief's 30/10 and the matrix's 5/2", () => {
    expect(() => validateLeaseTiming(30, 10)).not.toThrow();
    expect(() => validateLeaseTiming(5, 2)).not.toThrow();
  });
  it("refuses a lease that one missed beat could lose, and nonsense values", () => {
    expect(() => validateLeaseTiming(30, 15)).toThrow(/x 2 must be less than the lease 30 s/);
    expect(() => validateLeaseTiming(5, 3)).toThrow(RangeError);
    expect(() => validateLeaseTiming(30, 0)).toThrow(/positive integer/);
    expect(() => validateLeaseTiming(0, 1)).toThrow(/1\.\.3600/);
    expect(() => validateLeaseTiming(30, 2.5)).toThrow(RangeError);
  });
});

describe("Heartbeat", () => {
  it("beats every interval with the job's (id, token, owner, lease), extending while it gets 1 row", async () => {
    const calls: LeaseArgs[] = [];
    const { hb, t, controller } = make(async (_db, args) => {
      calls.push(args);
      return true;
    });
    hb.start();
    expect(t.intervalMs).toBe(10_000);
    for (let i = 0; i < 3; i += 1) {
      t.tick();
      await flush();
    }
    expect(calls).toEqual(Array(3).fill({ jobId: "job-1", fencingToken: 7, workerId: "w1", leaseSeconds: 30 }));
    expect(hb.beats).toBe(3);
    expect(controller.signal.aborted).toBe(false);
  });

  it("0 rows -> stops and aborts the job with a LeaseLostError (the reason runReplay rejects with)", async () => {
    const { hb, t, controller } = make(async () => false);
    hb.start();
    t.tick();
    await flush();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(LeaseLostError);
    expect((controller.signal.reason as LeaseLostError).details).toEqual({ jobId: "job-1", fencingToken: 7, workerId: "w1" });
    expect((controller.signal.reason as Error).message).toMatch(/matched 0 rows/);
    expect(hb.isStopped).toBe(true);
    expect(t.armed).toBe(false);
  });

  it("a transient DB error does NOT abort: it is counted and the next beat tries again", async () => {
    let n = 0;
    const { hb, t, controller, warnings } = make(async () => {
      n += 1;
      if (n <= 2) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:55432"), { code: "ECONNREFUSED" });
      return true;
    });
    hb.start();
    for (let i = 0; i < 3; i += 1) {
      t.tick();
      await flush();
    }
    expect(controller.signal.aborted).toBe(false);
    expect(hb.transientMisses).toBe(2);
    expect(hb.beats).toBe(1);
    expect(warnings.filter((w) => /Postgres unavailable/.test(w))).toHaveLength(2);
  });

  it("a non-transient error gives the job up: aborts with a LeaseLostError carrying the cause", async () => {
    const cause = Object.assign(new Error('relation "jobs" does not exist'), { code: "42P01" });
    const { hb, t, controller } = make(async () => {
      throw cause;
    });
    hb.start();
    t.tick();
    await flush();
    expect(controller.signal.reason).toBeInstanceOf(LeaseLostError);
    expect((controller.signal.reason as Error).cause).toBe(cause);
    expect(hb.isStopped).toBe(true);
  });

  it("stop() clears the timer, and a beat still in flight cannot abort afterwards", async () => {
    let release!: (v: boolean) => void;
    const { hb, t, controller } = make(() => new Promise<boolean>((resolve) => (release = resolve)));
    hb.start();
    t.tick(); // beat in flight
    hb.stop();
    expect(t.cleared).toBe(1);
    release(false); // the late answer says "lost"...
    await flush();
    expect(controller.signal.aborted).toBe(false); // ...but the job had already moved on to completion
  });

  it("beats never overlap: a tick while one is in flight joins it", async () => {
    let calls = 0;
    let release!: (v: boolean) => void;
    const { hb, t } = make(() => {
      calls += 1;
      return new Promise<boolean>((resolve) => (release = resolve));
    });
    hb.start();
    t.tick();
    t.tick();
    t.tick();
    expect(calls).toBe(1);
    release(true);
    await flush();
    t.tick();
    expect(calls).toBe(2);
  });

  it("setToken: later beats carry the new token (Step 9's verify phase)", async () => {
    const tokens: number[] = [];
    const { hb, t } = make(async (_db, args) => {
      tokens.push(args.fencingToken);
      return true;
    });
    hb.start();
    t.tick();
    await flush();
    hb.setToken(9);
    t.tick();
    await flush();
    expect(tokens).toEqual([7, 9]);
    expect(hb.fencingToken).toBe(9);
  });

  it("start() after stop() does nothing", () => {
    const { hb, t } = make(async () => true);
    hb.stop();
    hb.start();
    expect(t.armed).toBe(false);
  });
});
