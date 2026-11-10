#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pino from "pino";
import { runDiscovery } from "../agent/index.js";
import { runReplay } from "../replay/index.js";
import { commitUncertainWarning, deserializeCapability, type Capability, type ReplayResult } from "../artifact/index.js";
import { EscalationController, createOperatorConsole } from "../escalation/index.js";
import { resolveTenant } from "../tenant/index.js";
import { createCatalogApp, findCapability, invokeCapability, listCapabilities, DEFAULT_ARTIFACTS_DIR } from "../catalog/index.js";
import { approvalKey, approveCapability, readRunConfidence } from "../confidence/index.js";
import { createPool, databaseUrlFromEnv, migrate, redactDatabaseUrl } from "../queue/index.js";

const logger = pino();
const program = new Command();

program
  .name("rote")
  .description("Computer-use automation CLI for legacy back-office UIs")
  .version("0.1.0");

/**
 * A distinct warning line when an irreversible action was attempted (docs/DECISIONS.md D10), so an
 * operator reading the log cannot miss it inside the full result dump. Exit code stays 1.
 */
function warnIfCommitUncertain(result: ReplayResult, command: string): void {
  if (result.status === "success" || !result.commitUncertain) return;
  logger.warn({ commitUncertain: result.commitUncertain }, `${command}: ${commitUncertainWarning(result)}`);
}

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
  .option(
    "--approve-unattended",
    "replay a draft (not yet approved) capability unattended anyway; without this, an " +
      "unapproved capability is refused before any browser launches -- see \"catalog approve\"",
    false,
  )
  .option("--show-confidence", "print the run's confidence score, read back from its evidence log", false)
  .action(
    async (opts: {
      artifact: string;
      params: string;
      url: string;
      tenant?: string;
      headed: boolean;
      approveRisky: boolean;
      approveUnattended: boolean;
      showConfidence: boolean;
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
        ({ capability, entryUrl } = await resolveTenant(baseCapability, opts.tenant, opts.url));
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
        approvalArtifact: baseCapability, // the approval covers the artifact, not the tenant-merged copy (D24)
        params,
        entryUrl,
        headless: !opts.headed,
        approveRisky: opts.approveRisky,
        approveUnattended: opts.approveUnattended,
      });
      const confidence = opts.showConfidence
        ? await readRunConfidence(result.status === "needs_human" ? result.contextRef : result.evidenceRef)
        : undefined;
      if (result.status === "success") {
        logger.info({ outputs: result.outputs, evidenceRef: result.evidenceRef, confidence }, "replay: success");
      } else {
        logger.warn({ ...result, confidence }, "replay: did not succeed");
        warnIfCommitUncertain(result, "replay");
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
  .option(
    "--approve-unattended",
    "run a draft (not yet approved) capability anyway; without this, an unapproved capability " +
      "is refused before any browser launches, even under operator -- see \"catalog approve\"",
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
      approveUnattended: boolean;
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
        ({ capability, entryUrl } = await resolveTenant(baseCapability, opts.tenant, opts.url));
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
        approvalArtifact: baseCapability, // the approval covers the artifact, not the tenant-merged copy (D24)
        params,
        entryUrl,
        headless: false, // a human must be able to see and click the SAME window
        approveRisky: opts.approveRisky,
        approveUnattended: opts.approveUnattended,
        controller,
      });

      if (result.status === "success") {
        logger.info({ outputs: result.outputs, evidenceRef: result.evidenceRef }, "operator: success");
      } else {
        logger.warn(result, "operator: did not succeed");
        warnIfCommitUncertain(result, "operator");
        process.exitCode = 1;
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );

const DEFAULT_CATALOG_PORT = 4300;

const catalogCommand = program
  .command("catalog")
  .description("Agent-facing capability discovery and invocation over the existing replay path");

catalogCommand
  .command("list")
  .description("List every capability with a JSON-Schema-shaped view of its typed inputs/outputs")
  .option("--tenant <id>", "include the resolved entry URL where a per-tenant override exists")
  .option("-a, --artifacts-dir <dir>", "directory of Capability artifacts", DEFAULT_ARTIFACTS_DIR)
  .action(async (opts: { tenant?: string; artifactsDir: string }) => {
    const entries = await listCapabilities({ tenant: opts.tenant, artifactsDir: opts.artifactsDir });
    console.log(JSON.stringify(entries, null, 2));
  });

catalogCommand
  .command("invoke <id>")
  .description("Invoke a capability by id: validates params, then replays via the existing runReplay path")
  .option("-p, --params <json>", "JSON object of input params", "{}")
  .option(
    "--tenant <id>",
    "apply this tenant's override (overrides/<capabilityId>.<tenant>.json) before invoking, " +
      "including its own entry URL",
  )
  .option("-u, --url <url>", "entry URL to invoke against (ignored if --tenant is given)", DEFAULT_URL)
  .option("--headed", "run the browser headed instead of headless", false)
  .option(
    "--approve-risky",
    "allow a risky/irreversible step (e.g. a final Confirm) to actually execute; " +
      "without this, invoke stops at needs_human instead",
    false,
  )
  .option(
    "--approve-unattended",
    "invoke a draft (not yet approved) capability anyway; without this, an unapproved " +
      "capability is refused before any browser launches -- see \"catalog approve\"",
    false,
  )
  .option("--show-confidence", "print the run's confidence score, read back from its evidence log", false)
  .action(
    async (
      id: string,
      opts: {
        params: string;
        tenant?: string;
        url: string;
        headed: boolean;
        approveRisky: boolean;
        approveUnattended: boolean;
        showConfidence: boolean;
      },
    ) => {
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(opts.params) as Record<string, unknown>;
      } catch (err) {
        logger.error({ err }, "catalog invoke: --params is not valid JSON");
        process.exitCode = 1;
        return;
      }

      let result;
      try {
        result = await invokeCapability({
          id,
          params,
          tenant: opts.tenant,
          entryUrl: opts.url,
          headless: !opts.headed,
          approveRisky: opts.approveRisky,
          approveUnattended: opts.approveUnattended,
        });
      } catch (err) {
        logger.error({ err, id, tenant: opts.tenant }, "catalog invoke: failed before replay started");
        process.exitCode = 1;
        return;
      }

      const confidence = opts.showConfidence
        ? await readRunConfidence(result.status === "needs_human" ? result.contextRef : result.evidenceRef)
        : undefined;
      if (result.status === "success") {
        logger.info({ outputs: result.outputs, evidenceRef: result.evidenceRef, confidence }, "catalog invoke: success");
      } else {
        logger.warn({ ...result, confidence }, "catalog invoke: did not succeed");
        warnIfCommitUncertain(result, "catalog invoke");
        process.exitCode = 1;
      }
    },
  );

catalogCommand
  .command("approve <id>")
  .description(
    "Promote a capability draft -> approved: auto-promotes if its confidence history already " +
      "qualifies, or force-approves with --reason as a human override",
  )
  .option("--reason <text>", "human override reason -- force-approves regardless of history")
  .action(async (id: string, opts: { reason?: string }) => {
    // An approval is bound to the artifact version it was given for (docs/DECISIONS.md D15), so the
    // version comes from the artifact on disk, never from the operator.
    const capability = await findCapability(id);
    if (!capability) {
      logger.error({ id }, "catalog approve: no capability with this id");
      process.exitCode = 1;
      return;
    }
    try {
      const status = await approveCapability(id, { ...approvalKey(capability), reason: opts.reason });
      logger.info(
        {
          capabilityId: status.capabilityId,
          approvedVersion: status.approvedVersion,
          approvedDigest: status.approvedDigest,
          approvedAt: status.approvedAt,
          reason: status.approvedReason,
        },
        "catalog approve: approved",
      );
    } catch (err) {
      logger.error({ err, id }, "catalog approve: does not yet qualify");
      process.exitCode = 1;
    }
  });

catalogCommand
  .command("serve")
  .description("Host the catalog's HTTP endpoint (GET /capabilities, POST /capabilities/:id/invoke)")
  .option("--port <n>", "catalog server port", (v) => Number(v), DEFAULT_CATALOG_PORT)
  .option(
    "--queue",
    "also serve the fleet's async mode (?mode=async, GET /jobs/:id, GET /healthz) on ROTE_DATABASE_URL; runs migrations at startup",
  )
  .action(async (opts: { port: number; queue?: boolean }) => {
    let app;
    if (opts.queue) {
      const url = databaseUrlFromEnv();
      const pool = createPool({
        connectionString: url,
        onIdleError: (err) => logger.warn({ err: err.message }, "catalog: idle Postgres connection dropped"),
      });
      try {
        await migrate(pool); // advisory lock: safe while workers migrate too (D17)
      } catch (err) {
        logger.error({ err, database: redactDatabaseUrl(url) }, "catalog: migrations failed; not serving");
        process.exitCode = 1;
        await pool.end();
        return;
      }
      app = createCatalogApp({ queue: { pool } });
      logger.info({ database: redactDatabaseUrl(url) }, "catalog: async mode enabled");
    } else {
      app = createCatalogApp();
    }
    const server = app.listen(opts.port, () => {
      logger.info({ port: opts.port }, `catalog: serving on http://localhost:${opts.port}`);
    });
    // docker stop sends SIGTERM: stop accepting, let in-flight requests finish, exit.
    process.once("SIGTERM", () => server.close(() => process.exit(0)));
  });

const dbCommand = program.command("db").description("The fleet's Postgres job queue (docker compose up -d postgres)");

dbCommand
  .command("migrate")
  .description("Apply pending db/migrations/*.sql to ROTE_DATABASE_URL (safe to run concurrently)")
  .action(async () => {
    const url = databaseUrlFromEnv();
    const pool = createPool({ connectionString: url, max: 1 });
    try {
      const result = await migrate(pool);
      logger.info({ database: redactDatabaseUrl(url), ...result }, "db migrate: done");
    } catch (err) {
      logger.error({ err, database: redactDatabaseUrl(url) }, "db migrate: failed");
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  });

program.parse();
