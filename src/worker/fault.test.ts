// The fault flag (D34): doubly gated, unknown points refused, fires exactly at its point. Also the
// worker entry point refuses to start on a bad flag (a child process, before it touches anything).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFaultInjector, FaultConfigError, NO_FAULT, parseFaultConfig, RECOVERY_FAULT_POINTS, TRANSFER_FAULT_POINTS } from "./fault.js";

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
