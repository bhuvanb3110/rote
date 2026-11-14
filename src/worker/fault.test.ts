// The fault flag (D34): doubly gated, unknown points refused, fires exactly at its point. Also the
// worker entry point refuses to start on a bad flag (a child process, before it touches anything).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFaultInjector, FaultConfigError, NO_FAULT, parseFaultConfig, parseStallMs, RECOVERY_FAULT_POINTS, STALL_FAULT_POINTS, TRANSFER_FAULT_POINTS } from "./fault.js";

const run = promisify(execFile);

describe("parseFaultConfig", () => {
  it("no ROTE_FAULT: no fault", () => {
    expect(parseFaultConfig({})).toBeNull();
    expect(parseFaultConfig({ ROTE_FAULT: "" })).toBeNull();
  });

  it("refuses ROTE_FAULT without ROTE_FAULT_ENABLE=1 (any other value too)", () => {
    for (const enable of [undefined, "", "0", "true", "yes"]) {
      expect(() => parseFaultConfig({ ROTE_FAULT: "after-submit", ROTE_FAULT_ENABLE: enable })).toThrow(FaultConfigError);
    }
    expect(() => parseFaultConfig({ ROTE_FAULT: "after-submit" })).toThrow(/ROTE_FAULT_ENABLE is not "1": refusing to start/);
  });

  it("refuses ROTE_FAULT_ENABLE alone", () => {
    expect(() => parseFaultConfig({ ROTE_FAULT_ENABLE: "1" })).toThrow(/ROTE_FAULT is not/);
  });

  it("refuses an unknown point; accepts every transfer point and every recovery-internal point (Step 9)", () => {
    for (const bad of ["after-submitt", "after-step-1", "before-dequeue", "AFTER-SUBMIT", "after-step-011", "verify-after", "recover-in-transactions"]) {
      expect(() => parseFaultConfig({ ROTE_FAULT: bad, ROTE_FAULT_ENABLE: "1" }), bad).toThrow(/not a known fault point/);
    }
    for (const point of [...TRANSFER_FAULT_POINTS, ...RECOVERY_FAULT_POINTS]) expect(parseFaultConfig({ ROTE_FAULT: point, ROTE_FAULT_ENABLE: "1" })).toBe(point);
    expect(RECOVERY_FAULT_POINTS).toEqual([
      "verify-after-login",
      "verify-after-count",
      "verify-before-result",
      "verify-before-requeue",
      "verify-after-requeue",
      "recover-in-transaction",
    ]);
  });

  it("the matrix covers every boundary of the 12-step transfer, in order", () => {
    expect(TRANSFER_FAULT_POINTS).toEqual([
      "after-dequeue",
      "after-step-01", "after-step-02", "after-step-03", "after-step-04", "after-step-05",
      "after-step-06", "after-step-07", "after-step-08", "after-step-09", "after-step-10",
      "before-submit", "after-submit", "after-step-12", "before-complete", "after-complete",
    ]);
  });
});

describe("the stall point (stall-after-intent, Step 10, D52)", () => {
  const on = { ROTE_FAULT: "stall-after-intent", ROTE_FAULT_ENABLE: "1" };

  it("needs ROTE_FAULT_STALL_MS (1..600000); ROTE_FAULT_STALL_MS is refused with any other point, and alone", () => {
    expect(STALL_FAULT_POINTS).toEqual(["stall-after-intent"]);
    expect(() => parseFaultConfig(on)).toThrow(/needs ROTE_FAULT_STALL_MS/);
    expect(parseFaultConfig({ ...on, ROTE_FAULT_STALL_MS: "30000" })).toBe("stall-after-intent");
    expect(parseStallMs({ ...on, ROTE_FAULT_STALL_MS: "30000" }, "stall-after-intent")).toBe(30_000);
    for (const bad of ["0", "-1", "1.5", "600001", "soon"]) expect(() => parseStallMs({ ...on, ROTE_FAULT_STALL_MS: bad }, "stall-after-intent"), bad).toThrow(FaultConfigError);
    expect(() => parseFaultConfig({ ROTE_FAULT: "after-submit", ROTE_FAULT_ENABLE: "1", ROTE_FAULT_STALL_MS: "1000" })).toThrow(/only for a stall point/);
    expect(() => parseFaultConfig({ ROTE_FAULT_STALL_MS: "1000" })).toThrow(/ROTE_FAULT is not/);
    expect(() => parseFaultConfig({ ROTE_FAULT: "stall-after-intent", ROTE_FAULT_STALL_MS: "1000" })).toThrow(/ROTE_FAULT_ENABLE is not "1"/); // still doubly gated
    expect(parseStallMs({}, "after-submit")).toBe(0);
    expect(parseStallMs({}, null)).toBe(0);
  });

  it("stalls only at its point (a line, the sleep, a line) and never kills", async () => {
    const calls: string[] = [];
    const f = createFaultInjector("stall-after-intent", { stallMs: 1234, kill: () => calls.push("kill"), write: (l) => calls.push(l), sleep: async (ms) => void calls.push(`sleep ${ms}`) });
    expect(f.stallMs("stall-after-intent")).toBe(1234);
    expect(f.stallMs("before-submit")).toBe(0);
    f.at("stall-after-intent");
    await f.stall("before-submit");
    expect(calls).toEqual([]);
    await f.stall("stall-after-intent");
    expect(calls).toEqual([
      expect.stringMatching(/^ROTE_FAULT stalling at stall-after-intent for 1234 ms, heartbeat suspended \(pid \d+\)/),
      "sleep 1234",
      expect.stringMatching(/^ROTE_FAULT stall over at stall-after-intent: clicking Submit now/),
    ]);
  });

  it("a kill point never stalls; the no-op injector neither", async () => {
    expect(createFaultInjector("after-submit", { kill: () => undefined, write: () => undefined }).stallMs("after-submit")).toBe(0);
    expect(NO_FAULT.stallMs("stall-after-intent")).toBe(0);
    await NO_FAULT.stall("stall-after-intent");
  });
});

describe("createFaultInjector", () => {
  it("fires only at its point: one log line, then kill", () => {
    const calls: string[] = [];
    const f = createFaultInjector("after-submit", { kill: () => calls.push("kill"), write: (l) => calls.push(l) });
    f.at("before-submit");
    f.at("after-step-10");
    expect(calls).toEqual([]);
    f.at("after-submit");
    expect(calls).toEqual([expect.stringMatching(/^ROTE_FAULT firing at after-submit \(pid \d+\)\n$/), "kill"]);
  });

  it("null point is the shared no-op", () => {
    expect(createFaultInjector(null)).toBe(NO_FAULT);
    expect(() => NO_FAULT.at("after-submit")).not.toThrow();
  });
});

describe("the worker refuses to start on a bad fault flag", () => {
  async function startWorker(env: Record<string, string>): Promise<{ code: number; stderr: string; stdout: string }> {
    try {
      const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "src/worker/main.ts"], {
        env: { ...process.env, ROTE_FAULT: "", ROTE_FAULT_ENABLE: "", ...env, ROTE_DATABASE_URL: "postgres://x:y@127.0.0.1:1/none" },
        timeout: 30_000,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("ROTE_FAULT without the enable flag: exit 1 before connecting to anything", async () => {
    const r = await startWorker({ ROTE_FAULT: "after-submit" });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("refusing to start (fault injection is test-only)");
  }, 30_000);

  it("an unknown point: exit 1", async () => {
    const r = await startWorker({ ROTE_FAULT: "after-lunch", ROTE_FAULT_ENABLE: "1" });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("not a known fault point");
  }, 30_000);
});
