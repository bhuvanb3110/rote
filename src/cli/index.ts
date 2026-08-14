#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pino from "pino";
import { runDiscovery } from "../agent/index.js";
import { runReplay } from "../replay/index.js";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { EscalationController, createOperatorConsole } from "../escalation/index.js";
import { applyTenantOverride, deserializeTenantOverride } from "../tenant/index.js";

const logger = pino();
const program = new Command();

const DEFAULT_OVERRIDES_DIR = "overrides";

/**
 * When --tenant is given, loads overrides/<capabilityId>.<tenantId>.json (convention-based, no
 * separate lookup step needed) and applies it, returning the effective Capability AND the
 * entry URL to replay against -- the override's own entryUrl, not the CLI's --url default,
 * since the whole point of --tenant is that the caller shouldn't have to also know each
 * tenant's URL by hand. Without --tenant, this is a no-op: same capability, same --url.
 */
async function applyTenantIfRequested(
  capability: Capability,
  tenantId: string | undefined,
  fallbackUrl: string,
): Promise<{ capability: Capability; entryUrl: string }> {
  if (!tenantId) return { capability, entryUrl: fallbackUrl };
  const overridePath = path.join(DEFAULT_OVERRIDES_DIR, `${capability.id}.${tenantId}.json`);
  const override = deserializeTenantOverride(await readFile(overridePath, "utf8"));
  return { capability: applyTenantOverride(capability, override), entryUrl: override.entryUrl };
}

program
  .name("rote")
  .description("Computer-use automation CLI for legacy back-office UIs")
  .version("0.1.0");

const DEFAULT_GOAL = "look up member 10001 and read their current savings balance";
const DEFAULT_URL = "http://localhost:4100";

program
  .command("discover")
  .description("Discover a UI task via LLM and compile it into a Capability artifact")
  .option("-g, --goal <text>", "natural-language goal", DEFAULT_GOAL)
  .option("-u, --url <url>", "entry URL of the target app", DEFAULT_URL)
  .option("--headless", "run the browser headless instead of headed", false)
  .option("--model <id>", "override the Claude model (default: claude-opus-5)")
  .option("--max-steps <n>", "max tool-call turns before giving up", (v) => Number(v))
  .action(async (opts: { goal: string; url: string; headless: boolean; model?: string; maxSteps?: number }) => {
    logger.info({ goal: opts.goal, url: opts.url, headless: opts.headless }, "discover: starting");
    const outcome = await runDiscovery({
      goal: opts.goal,
      entryUrl: opts.url,
      headless: opts.headless,
      model: opts.model,
      maxSteps: opts.maxSteps,
    });
    if (outcome.status === "success") {
      logger.info(
        { steps: outcome.steps, capabilityPath: outcome.capabilityPath, evidenceDir: outcome.evidenceDir },
        "discover: success",
      );
    } else {
      logger.warn(
        { status: outcome.status, reason: outcome.reason, steps: outcome.steps, evidenceDir: outcome.evidenceDir },
        "discover: did not succeed",
      );
      process.exitCode = 1;
    }
  });

const DEFAULT_ARTIFACT = "artifacts/member-lookup.json";

program
  .command("replay")
  .description("Replay a compiled Capability artifact deterministically, no LLM in the loop")
  .option("-a, --artifact <path>", "path to the Capability JSON file", DEFAULT_ARTIFACT)
  .option("-p, --params <json>", "JSON object of input params", "{}")
  .option("-u, --url <url>", "entry URL to replay against (ignored if --tenant is given)", DEFAULT_URL)
  .option(
    "--tenant <id>",
    "apply this tenant's override (overrides/<capabilityId>.<tenant>.json) before replaying, " +
      "including its own entry URL -- lets one base artifact replay against multiple tenants",
  )
  .option("--headed", "run the browser headed instead of headless", false)
  .option(
    "--approve-risky",
    "allow a risky/irreversible step (e.g. a final Confirm) to actually execute; " +
      "without this, replay stops at needs_human instead",
    false,
  )
  .action(
    async (opts: {
      artifact: string;
      params: string;
      url: string;
      tenant?: string;
      headed: boolean;
      approveRisky: boolean;
    }) => {
      const baseCapability = deserializeCapability(await readFile(opts.artifact, "utf8"));
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(opts.params) as Record<string, unknown>;
      } catch (err) {
        logger.error({ err }, "replay: --params is not valid JSON");
        process.exitCode = 1;
        return;
      }

      let capability: Capability;
      let entryUrl: string;
      try {
        ({ capability, entryUrl } = await applyTenantIfRequested(baseCapability, opts.tenant, opts.url));
      } catch (err) {
        logger.error({ err, tenant: opts.tenant }, "replay: failed to load/apply tenant override");
        process.exitCode = 1;
        return;
      }

      logger.info(
        { artifact: opts.artifact, capabilityId: capability.id, tenant: opts.tenant, url: entryUrl, approveRisky: opts.approveRisky },
        "replay: starting",
      );
      const result = await runReplay({
        capability,
        params,
        entryUrl,
        headless: !opts.headed,
        approveRisky: opts.approveRisky,
      });
      if (result.status === "success") {
        logger.info({ outputs: result.outputs, evidenceRef: result.evidenceRef }, "replay: success");
      } else {
        logger.warn(result, "replay: did not succeed");
        process.exitCode = 1;
      }
    },
  );

const DEFAULT_OPERATOR_PORT = 4200;

program
  .command("operator")
  .description(
    "Replay an artifact with human-in-the-loop escalation: hosts an operator console and " +
      "PAUSES on needs_human (headed browser) instead of exiting, resuming once handed back",
  )
  .option("-a, --artifact <path>", "path to the Capability JSON file", DEFAULT_ARTIFACT)
  .option("-p, --params <json>", "JSON object of input params", "{}")
  .option("-u, --url <url>", "entry URL to replay against (ignored if --tenant is given)", DEFAULT_URL)
  .option(
    "--tenant <id>",
    "apply this tenant's override (overrides/<capabilityId>.<tenant>.json) before replaying, " +
      "including its own entry URL -- lets one base artifact replay against multiple tenants",
  )
  .option("--port <n>", "operator console port", (v) => Number(v), DEFAULT_OPERATOR_PORT)
  .option(
    "--approve-risky",
    "allow a risky/irreversible step to execute without pausing for a human at all",
    false,
  )
  .action(
    async (opts: {
      artifact: string;
      params: string;
      url: string;
      tenant?: string;
      port: number;
      approveRisky: boolean;
    }) => {
      const baseCapability = deserializeCapability(await readFile(opts.artifact, "utf8"));
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(opts.params) as Record<string, unknown>;
      } catch (err) {
        logger.error({ err }, "operator: --params is not valid JSON");
        process.exitCode = 1;
        return;
      }

      let capability: Capability;
      let entryUrl: string;
      try {
        ({ capability, entryUrl } = await applyTenantIfRequested(baseCapability, opts.tenant, opts.url));
      } catch (err) {
        logger.error({ err, tenant: opts.tenant }, "operator: failed to load/apply tenant override");
        process.exitCode = 1;
        return;
      }

      const controller = new EscalationController();
      const app = createOperatorConsole(controller);
      const server = app.listen(opts.port, () => {
        logger.info({ port: opts.port }, `operator: console listening on http://localhost:${opts.port}`);
      });

      logger.info(
        { artifact: opts.artifact, capabilityId: capability.id, tenant: opts.tenant, url: entryUrl },
        "operator: starting replay (headed) -- will pause on needs_human instead of exiting",
      );

      const result = await runReplay({
        capability,
        params,
        entryUrl,
        headless: false, // a human must be able to see and click the SAME window
        approveRisky: opts.approveRisky,
        controller,
      });

      if (result.status === "success") {
        logger.info({ outputs: result.outputs, evidenceRef: result.evidenceRef }, "operator: success");
      } else {
        logger.warn(result, "operator: did not succeed");
        process.exitCode = 1;
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );

program.parse();
