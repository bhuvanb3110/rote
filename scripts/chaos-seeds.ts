// Chaos at scale, unattended (step-10 reviewer decision 1; docs/plans/step-10.md section 5; D56).
//
//   npm run chaos-seeds -- --seeds 20 --jobs 500 [--out evidence/chaos/day2-exit] [--workers 4]
//                          [--duration <auto: 1.6 s per job>] [--drain-timeout 15m] [--rerun <index>]
//
// One command for the overnight batch. It:
//   - draws the seeds UP FRONT and saves them (<out>/seeds.json) before running any; a seed is never
//     re-drawn or dropped. A later run with a larger --seeds keeps the saved seeds and appends new ones;
//   - runs each seed as its own child process (scripts/chaos.ts, the standard family, --gzip-logs) into
//     <out>/seed-NN-<seed>/, so one seed's crash never takes the batch down and its memory is released;
//   - saves each seed's evidence AS SOON AS that seed finishes (chaos.ts writes its folder; summary.json last);
//   - RESUMES after an interruption: a seed whose folder has a summary.json is skipped; a folder without one
//     (the runner was stopped mid-seed) is set aside as <folder>.interrupted-<time> -- never deleted -- and
//     the seed runs again;
//   - rewrites the tally (<out>/tally.md, tally.json) after every seed, so a partial tally always exists:
//     per seed the kills, the oracle's verdicts, needs_human, failed, not settled, the recovery kinds
//     (decision 8) and the wall time; RESULT: PASS only when every seed finished and passed its family judge;
//   - NEVER runs the test suite (the fleet and the suite must never share this 8 GB machine);
//   - stops the whole Compose stack when it is done (`docker compose stop`), and on Ctrl-C.
// A failing seed stays in the tally and is investigated; after the investigation `--rerun <index>` runs that
// one seed again (its old folder is set aside, not deleted). Exit 0 only on RESULT: PASS.
//
// Run it with nothing else running (no test suite, no other fleet): each seed brings up Postgres, the bank,
// the API and 4 workers (about 2.5 GB in the Docker VM).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drawSeed } from "../src/chaos/schedule.js";
import { buildTally, dirName, type SeedSummary } from "../src/chaos/tally.js";
import { argValue, createDocker, dockerEnv, parseDuration } from "./lib/compose.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, argValue("out") ?? path.join("evidence", "chaos", "day2-exit"));
const OUT_REL = path.relative(ROOT, OUT).split(path.sep).join("/");
/** The schedule for N jobs: measured about 1.75 s per job with kills (100 jobs, Step 9); kills cover all but the tail. */
const SECONDS_PER_JOB = 1.6;

interface BatchConfig {
  /** Every seed of the batch, in order. */
  seeds: number[];
  jobs: number;
  workers: number;
  durationMs: number;
  drainTimeoutMs: number;
  family: "standard";
  createdAt: string;
  /** The command that created (or last extended) the batch. */
  command: string;
}

const log = (line: string) => console.log(`[chaos-seeds ${new Date().toISOString()}] ${line}`);
const fail = (msg: string): never => {
  console.error(`chaos-seeds: ${msg}`);
  process.exit(2);
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Loads <out>/seeds.json, or creates it; extends it when more seeds are asked for. Refuses a config change. */
async function loadOrCreateBatch(): Promise<BatchConfig> {
  const file = path.join(OUT, "seeds.json");
  const saved = await readJson<BatchConfig>(file);
  const wantSeeds = argValue("seeds") !== undefined ? Number(argValue("seeds")) : undefined;
  const jobs = Number(argValue("jobs") ?? saved?.jobs ?? 500);
  const workers = Number(argValue("workers") ?? saved?.workers ?? 4);
  const durationMs = argValue("duration") ? parseDuration(argValue("duration")!) : (saved?.durationMs ?? Math.round(jobs * SECONDS_PER_JOB) * 1000);
  const drainTimeoutMs = argValue("drain-timeout") ? parseDuration(argValue("drain-timeout")!) : (saved?.drainTimeoutMs ?? 15 * 60_000);
  if (wantSeeds !== undefined && !(Number.isInteger(wantSeeds) && wantSeeds >= 1 && wantSeeds <= 200)) fail("--seeds must be an integer in 1..200");
  if (!(Number.isInteger(jobs) && jobs >= 1)) fail("--jobs must be a positive integer");
  const command = `npm run chaos-seeds -- ${process.argv.slice(2).join(" ")}`;
  if (saved) {
    const changed = [
      ["jobs", saved.jobs, jobs],
      ["workers", saved.workers, workers],
      ["duration", saved.durationMs, durationMs],
      ["drain-timeout", saved.drainTimeoutMs, drainTimeoutMs],
    ].filter(([, a, b]) => a !== b);
    if (changed.length > 0) {
      fail(
        `${OUT_REL}/seeds.json was created with ${changed.map(([k, a]) => `--${k} ${a}`).join(", ")}; this run asks for ` +
          `${changed.map(([k, , b]) => `--${k} ${b}`).join(", ")}. Seeds in one tally must share one configuration: use another --out.`,
      );
    }
    if (wantSeeds !== undefined && wantSeeds < saved.seeds.length) {
      fail(`${OUT_REL}/seeds.json already has ${saved.seeds.length} seeds; --seeds ${wantSeeds} would drop some (seeds are never dropped)`);
    }
    if (wantSeeds !== undefined && wantSeeds > saved.seeds.length) {
      const added = Array.from({ length: wantSeeds - saved.seeds.length }, () => drawSeed());
      const extended: BatchConfig = { ...saved, seeds: [...saved.seeds, ...added], command };
      await writeFile(file, JSON.stringify(extended, null, 2) + "\n");
      log(`extended the batch from ${saved.seeds.length} to ${wantSeeds} seeds (new: ${added.join(", ")}); the saved seeds are kept`);
      return extended;
    }
    log(`resuming the batch in ${OUT_REL} (${saved.seeds.length} seeds, drawn ${saved.createdAt})`);
    return saved;
  }
  if (wantSeeds === undefined) fail(`no ${OUT_REL}/seeds.json yet: give --seeds <n> (e.g. --seeds 20 --jobs 500)`);
  const batch: BatchConfig = {
    seeds: Array.from({ length: wantSeeds! }, () => drawSeed()),
    jobs,
    workers,
    durationMs,
    drainTimeoutMs,
    family: "standard",
    createdAt: new Date().toISOString(),
    command,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(file, JSON.stringify(batch, null, 2) + "\n");
  log(`drew ${batch.seeds.length} seeds up front and saved them in ${OUT_REL}/seeds.json: ${batch.seeds.join(", ")}`);
  return batch;
}

interface Interruption {
  index: number;
  seed: number;
  movedTo: string;
  at: string;
}

async function runnerLog(entry: Record<string, unknown>): Promise<void> {
  await appendFile(path.join(OUT, "runner-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function interruptionsSoFar(): Promise<Interruption[]> {
  const text = await readFile(path.join(OUT, "runner-log.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.kind === "set-aside")
    .map((e) => ({ index: e.index as number, seed: e.seed as number, movedTo: e.movedTo as string, at: e.at as string }));
}

async function writeTally(batch: BatchConfig): Promise<ReturnType<typeof buildTally>> {
  const summaries = new Map<number, SeedSummary | null>();
  for (let i = 1; i <= batch.seeds.length; i += 1) {
    summaries.set(i, await readJson<SeedSummary>(path.join(OUT, dirName(i, batch.seeds[i - 1]!), "summary.json")));
  }
  const tally = buildTally({
    outDir: OUT_REL,
    seeds: batch.seeds,
    config: { jobs: batch.jobs, workers: batch.workers, durationMs: batch.durationMs, drainTimeoutMs: batch.drainTimeoutMs, family: batch.family },
    summaries,
    interruptions: await interruptionsSoFar(),
    generatedAt: new Date().toISOString(),
  });
  await writeFile(path.join(OUT, "tally.md"), tally.markdown);
  await writeFile(
    path.join(OUT, "tally.json"),
    JSON.stringify({ result: tally.result, finished: tally.finished, passed: tally.passed, seeds: batch.seeds.length, recoveryTotals: tally.totals }, null, 2) + "\n",
  );
  return tally;
}

let child: ReturnType<typeof spawn> | null = null;
const { docker } = createDocker(dockerEnv(4));

async function stopFleet(why: string): Promise<void> {
  log(`stopping the whole Compose stack (${why})`);
  // A seed stopped mid-pause leaves a frozen worker, and Docker will not stop a paused container.
  await docker(["compose", "unpause"], 60_000).catch(() => undefined);
  await docker(["compose", "stop"], 5 * 60_000).catch((err) => log(`docker compose stop failed: ${(err as Error).message.split("\n")[0]}`));
}

/** One seed: scripts/chaos.ts in a child process; its output teed to <folder>/runner-stdout.txt. */
function runSeed(batch: BatchConfig, index: number, seed: number, dir: string): Promise<number> {
  const args = [
    "--import",
    "tsx",
    path.join(ROOT, "scripts", "chaos.ts"),
    "--seed",
    String(seed),
    "--jobs",
    String(batch.jobs),
    "--workers",
    String(batch.workers),
    "--duration",
    `${batch.durationMs}ms`,
    "--drain-timeout",
    `${batch.drainTimeoutMs}ms`,
    "--out",
    dir,
    "--gzip-logs",
  ];
  return new Promise((resolve) => {
    const out = createWriteStream(path.join(dir, "runner-stdout.txt"));
    child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const tee = (chunk: Buffer) => {
      out.write(chunk);
      process.stdout.write(chunk.toString().replace(/^(?=.)/gm, `  [seed ${index}] `));
    };
    child.stdout!.on("data", tee);
    child.stderr!.on("data", tee);
    child.on("close", (code) => {
      child = null;
      out.end(() => resolve(code ?? 1));
    });
  });
}

async function main(): Promise<void> {
  const batch = await loadOrCreateBatch();
  const rerun = argValue("rerun") !== undefined ? Number(argValue("rerun")) : null;
  if (rerun !== null && !(Number.isInteger(rerun) && rerun >= 1 && rerun <= batch.seeds.length)) fail(`--rerun must be a seed index in 1..${batch.seeds.length}`);
  await mkdir(OUT, { recursive: true });
  await writeTally(batch);
  const started = Date.now();
  let ran = 0;
  for (let i = 1; i <= batch.seeds.length; i += 1) {
    const seed = batch.seeds[i - 1]!;
    const dir = path.join(OUT, dirName(i, seed));
    const done = existsSync(path.join(dir, "summary.json"));
    if (rerun !== null && i !== rerun) continue;
    if (done && rerun === null) {
      log(`seed ${i}/${batch.seeds.length} (${seed}): already finished, skipped`);
      continue;
    }
    if (existsSync(dir)) {
      const movedTo = `${dir}.${done ? "rerun" : "interrupted"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(dir, movedTo);
      const rel = path.relative(ROOT, movedTo).split(path.sep).join("/");
      await runnerLog({ kind: "set-aside", index: i, seed, reason: done ? "rerun" : "interrupted", movedTo: rel });
      log(`seed ${i} (${seed}): the earlier ${done ? "run (--rerun)" : "interrupted run"} was set aside as ${rel}`);
    }
    await mkdir(dir, { recursive: true });
    const remaining = batch.seeds.length - i + 1;
    log(`seed ${i}/${batch.seeds.length} (${seed}): starting (${remaining} to go; about ${Math.round((batch.durationMs + 6 * 60_000) / 60_000)} min each)`);
    await runnerLog({ kind: "start", index: i, seed });
    const t = Date.now();
    const code = await runSeed(batch, i, seed, dir);
    ran += 1;
    const summary = await readJson<SeedSummary>(path.join(dir, "summary.json"));
    if (!summary) {
      // chaos.ts writes summary.json even when it throws; none at all means it was killed from outside.
      await runnerLog({ kind: "no-summary", index: i, seed, exitCode: code });
      log(`seed ${i} (${seed}): exited ${code} without a summary.json (stopped from outside?); the runner stops here -- run the same command to resume`);
      break;
    }
    await runnerLog({ kind: "end", index: i, seed, exitCode: code, pass: summary.pass, wallMs: Date.now() - t });
    const tally = await writeTally(batch);
    log(`seed ${i} (${seed}): ${summary.pass ? "PASS" : `FAIL (${summary.problems.join("; ")})`} in ${Math.round((Date.now() - t) / 60_000)} min; tally: ${tally.finished}/${batch.seeds.length} finished, ${tally.passed} passed`);
  }
  const tally = await writeTally(batch);
  await stopFleet("the batch is done");
  log(`ran ${ran} seed(s) in ${Math.round((Date.now() - started) / 60_000)} min. ${OUT_REL}/tally.md: ${tally.markdown.trim().split("\n").at(-1)}`);
  process.exitCode = tally.result === "PASS" ? 0 : 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping the current seed and the fleet; run the same command again to resume`);
    child?.kill("SIGTERM");
    void stopFleet(signal).finally(() => process.exit(130));
  });
}

main().catch(async (err) => {
  console.error(`chaos-seeds: ${(err as Error).stack ?? String(err)}`);
  await stopFleet("the runner failed");
  process.exitCode = 2;
});
