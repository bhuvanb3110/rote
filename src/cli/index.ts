#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pino from "pino";
import { runDiscovery } from "../agent/index.js";
import { runReplay } from "../replay/index.js";
import { deserializeCapability } from "../artifact/index.js";

const logger = pino();
const program = new Command();

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
  .option("-u, --url <url>", "entry URL to replay against", DEFAULT_URL)
  .option("--headed", "run the browser headed instead of headless", false)
  .option(
    "--approve-risky",
    "allow a risky/irreversible step (e.g. a final Confirm) to actually execute; " +
      "without this, replay stops at needs_human instead",
    false,
  )
  .action(async (opts: { artifact: string; params: string; url: string; headed: boolean; approveRisky: boolean }) => {
    const capability = deserializeCapability(await readFile(opts.artifact, "utf8"));
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(opts.params) as Record<string, unknown>;
    } catch (err) {
      logger.error({ err }, "replay: --params is not valid JSON");
      process.exitCode = 1;
      return;
    }
    logger.info(
      { artifact: opts.artifact, capabilityId: capability.id, url: opts.url, approveRisky: opts.approveRisky },
      "replay: starting",
    );
    const result = await runReplay({
      capability,
      params,
      entryUrl: opts.url,
      headless: !opts.headed,
      approveRisky: opts.approveRisky,
    });
    if (result.status === "success") {
      logger.info({ outputs: result.outputs, evidenceRef: result.evidenceRef }, "replay: success");
    } else {
      logger.warn(result, "replay: did not succeed");
      process.exitCode = 1;
    }
  });

program
  .command("operator")
  .description("Run the operator escalation session for human hand-off")
  .action(() => {
    logger.info("operator: not implemented yet");
  });

program.parse();
