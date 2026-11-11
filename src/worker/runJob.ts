// Running ONE leased job (docs/plans/step-06.md section 1, "Running a job"). Workers enter replay
// only through invokeCapability (D13: extend replay, never fork it), with:
//   - params = the job's business params + this tenant's credentials for every redact input + the
//     job's memo_key as the memo of an irreversible capability (D5, D23);
//   - approveRisky: true (reviewer decision 2), whose authority is the capability's approval for its
//     current version AND content, re-checked by runReplay at run time (D15, D24; authoritative);
//   - approveUnattended NEVER set: an unapproved capability ends needs_human, never runs;
//   - evidence in the worker's own directory, never the repo's evidence/ (REPO_NOTES Q2).
//
// A preflight first decides whether the job can run at all (capability exists, params valid,
// tenant override present, entry URL allowed). Those failures are deterministic: the job fails at
// once as invalid_job, without a browser and without burning retries.
import type { Browser } from "playwright";
import type { Capability, Step } from "../artifact/index.js";
import { DEFAULT_ENTRY_URL, invokeCapability } from "../catalog/invoke.js";
import { DEFAULT_ARTIFACTS_DIR, findCapability } from "../catalog/registry.js";
import { inputsToZodSchema } from "../catalog/schema.js";
import { hasIrreversibleStep, MEMO_INPUT, type JobRow } from "../queue/index.js";
import { DEFAULT_OVERRIDES_DIR, resolveTenant } from "../tenant/index.js";
import type { TenantCredentials } from "./credentials.js";
import type { RunEnd } from "./outcome.js";
import { NO_FAULT, type FaultInjector } from "./fault.js";

export interface RunJobContext {
  credentials: TenantCredentials;
  /** Where replay writes screenshots/logs (a container volume in Docker). */
  evidenceBaseDir: string;
  artifactsDir?: string;
  overridesDir?: string;
  /** Approvals (status/). Default "status". */
  statusDir?: string;
  /** Test-only crash points inside the run (fault.ts, D34). Default: none. */
  fault?: FaultInjector;
}

/** The job cannot run as given; never retried. */
export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobError";
  }
}

/**
 * The params replay gets: job params (never mutated) + credentials for every redact input + memo =
 * memo_key for a capability with an irreversible step.
 */
export function buildJobParams(
  capability: Pick<Capability, "id" | "inputs" | "steps">,
  job: Pick<JobRow, "tenant_id" | "params" | "memo_key">,
  credentials: TenantCredentials,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...job.params };
  const tenantCreds = credentials.get(job.tenant_id);
  for (const input of capability.inputs.filter((i) => i.redact)) {
    const value = tenantCreds?.[input.name];
    if (value === undefined) {
      throw new InvalidJobError(`no credential "${input.name}" configured for tenant "${job.tenant_id}"`);
    }
    params[input.name] = value;
  }
  if (hasIrreversibleStep(capability) && capability.inputs.some((i) => i.name === MEMO_INPUT && !i.redact)) {
    params[MEMO_INPUT] = job.memo_key;
  }
  return params;
}

export interface RunJobOptions {
  browser: Browser;
  signal: AbortSignal;
}

export interface RunJobResult {
  end: RunEnd;
  /** onIrreversible.before ran (seam 1: Day 2 writes the commit intent there). */
  irreversibleStarted: boolean;
}

async function preflight(ctx: RunJobContext, job: JobRow): Promise<{ capability: Capability; params: Record<string, unknown> }> {
  const capability = await findCapability(job.capability_id, ctx.artifactsDir ?? DEFAULT_ARTIFACTS_DIR);
  if (!capability) throw new InvalidJobError(`No capability with id "${job.capability_id}".`);
  const params = buildJobParams(capability, job, ctx.credentials);
  const parsed = inputsToZodSchema(capability.inputs).safeParse(params);
  if (!parsed.success) {
    // Names the failing fields only: the params include credentials.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new InvalidJobError(`Invalid params for "${capability.id}": ${fields.join(", ")}`);
  }
  let resolved: Awaited<ReturnType<typeof resolveTenant>>;
  try {
    resolved = await resolveTenant(capability, job.tenant_id, DEFAULT_ENTRY_URL, ctx.overridesDir ?? DEFAULT_OVERRIDES_DIR);
  } catch (err) {
    throw new InvalidJobError(`tenant override for "${capability.id}" / "${job.tenant_id}" unusable: ${(err as Error).message}`);
  }
  const origin = `${new URL(resolved.entryUrl).origin}/`;
  if (!new RegExp(capability.target.entryUrlPattern).test(origin)) {
    throw new InvalidJobError(`entry URL ${resolved.entryUrl} does not match ${capability.target.entryUrlPattern}`);
  }
  return { capability, params };
}

export async function runJob(ctx: RunJobContext, job: JobRow, options: RunJobOptions): Promise<RunJobResult> {
  let prepared: { capability: Capability; params: Record<string, unknown> };
  try {
    prepared = await preflight(ctx, job);
  } catch (error) {
    return { end: { kind: "invalid", error }, irreversibleStarted: false };
  }

  let irreversibleStarted = false;
  const fault = ctx.fault ?? NO_FAULT;
  const onIrreversible = {
    // Seam 1 (step-06 section 7): Day 2 writes the fenced commit intent here and throws on a lost lease.
    before: async (_step: Step) => {
      irreversibleStarted = true;
      fault.at("before-submit");
    },
    // Seam 2: the bank has answered the click (D12); crash-after-submit fires here.
    after: async (_step: Step) => {
      fault.at("after-submit");
    },
  };
  // Only a fault-injecting worker passes onStep at all: a normal worker's replay is unchanged.
  const onStep = fault.point ? { after: async (step: Step) => fault.at(`after-${step.id}`) } : undefined;
  try {
    const result = await invokeCapability({
      id: prepared.capability.id,
      tenant: job.tenant_id,
      params: prepared.params,
      browser: options.browser,
      signal: options.signal,
      evidenceBaseDir: ctx.evidenceBaseDir,
      artifactsDir: ctx.artifactsDir,
      overridesDir: ctx.overridesDir,
      statusDir: ctx.statusDir,
      approveRisky: true,
      onIrreversible,
      onStep,
      headless: true,
    });
    return { end: { kind: "result", result }, irreversibleStarted };
  } catch (error) {
    return { end: { kind: "thrown", error, aborted: options.signal.aborted }, irreversibleStarted };
  }
}
