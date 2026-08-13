#!/usr/bin/env node
import { Command } from "commander";
import pino from "pino";

const logger = pino();
const program = new Command();

program
  .name("rote")
  .description("Computer-use automation CLI for legacy back-office UIs")
  .version("0.1.0");

program
  .command("discover")
  .description("Discover a UI task via LLM and compile it into a Capability artifact")
  .action(() => {
    logger.info("discover: not implemented yet");
  });

program
  .command("replay")
  .description("Replay a compiled Capability artifact deterministically, no LLM in the loop")
  .action(() => {
    logger.info("replay: not implemented yet");
  });

program
  .command("operator")
  .description("Run the operator escalation session for human hand-off")
  .action(() => {
    logger.info("operator: not implemented yet");
  });

program.parse();
