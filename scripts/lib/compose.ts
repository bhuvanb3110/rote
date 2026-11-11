// Docker / Compose helpers shared by the fleet harnesses (scripts/evidence-day1-exit.ts,
// scripts/chaos.ts). They drive the Docker CLI, so they run the same from PowerShell or Linux.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Fake mock-bank credentials (the same defaults as .env.example), passed to `docker compose` through
 * the environment so .env is never read or edited here. Harnesses grep their evidence for exactly
 * these values.
 */
export const FAKE_CREDS: Record<string, string> = {
  ROTE_CRED_TENANT_A_USERNAME: process.env.ROTE_CRED_TENANT_A_USERNAME || "fleet-op-a",
  ROTE_CRED_TENANT_A_PASSWORD: process.env.ROTE_CRED_TENANT_A_PASSWORD || "fake-pass-a",
  ROTE_CRED_TENANT_B_USERNAME: process.env.ROTE_CRED_TENANT_B_USERNAME || "fleet-op-b",
  ROTE_CRED_TENANT_B_PASSWORD: process.env.ROTE_CRED_TENANT_B_PASSWORD || "fake-pass-b",
  ROTE_CRED_TENANT_C_USERNAME: process.env.ROTE_CRED_TENANT_C_USERNAME || "fleet-op-c",
  ROTE_CRED_TENANT_C_PASSWORD: process.env.ROTE_CRED_TENANT_C_PASSWORD || "fake-pass-c",
};

export function dockerEnv(workers: number): NodeJS.ProcessEnv {
  return { ...process.env, ...FAKE_CREDS, ROTE_WORKERS: String(workers) };
}

export function createDocker(env: NodeJS.ProcessEnv) {
  async function docker(args: string[], timeoutMs = 15 * 60_000): Promise<string> {
    const { stdout, stderr } = await run("docker", args, { env, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
    return stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
  }

  /** `docker inspect` prints one JSON array; `ps`/`stats --format json` print one object per line. */
  async function dockerJson<T>(args: string[]): Promise<T[]> {
    const { stdout } = await run("docker", args, { env, maxBuffer: 64 * 1024 * 1024 });
    try {
      const whole = JSON.parse(stdout);
      return Array.isArray(whole) ? whole : [whole];
    } catch {
      // fall through: JSON lines
    }
    return stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("{") || l.trim().startsWith("["))
      .flatMap((l) => {
        const parsed = JSON.parse(l);
        return Array.isArray(parsed) ? parsed : [parsed];
      });
  }

  async function waitHealthy(services: Record<string, number>, timeoutMs: number): Promise<PsRow[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await dockerJson<PsRow>(["compose", "ps", "--all", "--format", "json"]);
      const ok = Object.entries(services).every(
        ([svc, n]) => rows.filter((r) => r.Service === svc && r.State === "running" && r.Health === "healthy").length === n,
      );
      if (ok) return rows;
      const dead = rows.filter((r) => Object.hasOwn(services, r.Service) && r.State === "exited");
      if (dead.length > 0) throw new Error(`containers exited while starting: ${dead.map((r) => `${r.Name}(${r.ExitCode})`).join(", ")}`);
      if (Date.now() > deadline) throw new Error(`not healthy after ${timeoutMs} ms: ${rows.map((r) => `${r.Name}=${r.State}/${r.Health}`).join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return { docker, dockerJson, waitHealthy };
}

export interface PsRow {
  Name: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

/** "123.4MiB / 700MiB" -> MiB (of the first figure). */
export function toMiB(s: string): number {
  const m = /([\d.]+)\s*([KMG]i?B|B)/i.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  if (unit.startsWith("G")) return n * 1024;
  if (unit.startsWith("M")) return n;
  if (unit.startsWith("K")) return n / 1024;
  return n / 1024 / 1024;
}

export async function http(method: string, url: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

/** "3m", "45s", "1500ms", "2h" or a bare number of milliseconds. */
export function parseDuration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!m) throw new Error(`not a duration: "${value}" (use e.g. 45s, 3m, 1500ms)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

/** --name value / --name=value / --flag, from process.argv. */
export function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

export function argFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
