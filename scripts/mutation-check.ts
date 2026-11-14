// The mutation check (step-09 reviewer addition 6; docs/plans/step-10.md section 7; D54): every planted bug
// below must turn the tests that guard it red. Each mutant is a patch in scripts/mutations/. For each one:
//   1. `git apply --check`: a patch that no longer applies FAILS the check ("update the mutant"), so the
//      mutants cannot silently rot as the code moves;
//   2. refuse if a file it touches has uncommitted changes (the revert check below must be exact);
//   3. apply it, run its test files (vitest, JSON report), and expect a non-zero exit with at least one
//      named test failing ("caught");
//   4. `git apply -R`, then `git diff --exit-code` on every touched file: the tree is exactly as before.
// Writes <out>/report.md and <out>/check.txt (RESULT: PASS only if every mutant was caught and reverted
// cleanly) and one JSON report per mutant. Exit 1 on FAIL.
//
//   npm run mutation-check [-- --only 01,07] [--out evidence/mutation-check]
//
// The model-vs-real test needs Postgres (docker compose up -d postgres; CI: a postgres:17 service). No
// browser is needed. Never run it with uncommitted changes in the mutated files.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

export interface Mutant {
  id: string;
  /** scripts/mutations/<patch> */
  patch: string;
  /** Which step planted it, and what the bug is. */
  what: string;
  /** The test files that must catch it. */
  tests: string[];
}

export const MUTANTS: Mutant[] = [
  {
    id: "01",
    patch: "01-t6-requeues-committing.patch",
    what: "Step 8 / Step 9's M2: recovery requeues an expired `committing` job (a blind retry after the intent)",
    tests: ["src/fleet/stateMachine.property.test.ts", "src/fleet/stateMachine.test.ts"],
  },
  {
    id: "02",
    patch: "02-t2-revives-expired-lease.patch",
    what: "Step 8: the heartbeat (T2) extends a lease that already expired (no `lease_expires_at > now()`)",
    tests: ["src/fleet/modelVsReal.db.test.ts"],
  },
  {
    id: "03",
    patch: "03-t6-no-token-bump.patch",
    what: "Step 8: recovery (T6.1/T6.2/T6.6) does not bump the fencing token",
    tests: ["src/fleet/modelVsReal.db.test.ts"],
  },
  {
    id: "04",
    patch: "04-m1-single-zero-decides.patch",
    what: "Step 9's M1: one 0-match lookup decides (no settle, no second lookup)",
    tests: ["src/fleet/stateMachine.property.test.ts"],
  },
  {
    id: "05",
    patch: "05-m3-zero-one-not-committed.patch",
    what: "Step 9's M3: lookups [0, 1] read as not committed",
    tests: ["src/fleet/stateMachine.property.test.ts"],
  },
  {
    id: "06",
    patch: "06-m4-refusal-retried.patch",
    what: "Step 9's M4: a refusal shown after Submit is retried instead of final",
    tests: ["src/fleet/stateMachine.property.test.ts"],
  },
  {
    id: "07",
    patch: "07-reconcile-ignores-duplicates.patch",
    what: "Step 10: the reconcile pass reads 2+ matches as reconciled (the duplicate stays silent)",
    tests: ["src/fleet/stateMachine.property.test.ts", "src/fleet/stateMachine.test.ts"],
  },
  {
    id: "08",
    patch: "08-t4-requeue-without-not-before.patch",
    what: "Step 10: T4's requeue after a failure sets no not_before (retries do not back off)",
    tests: ["src/fleet/modelVsReal.db.test.ts", "src/worker/complete.db.test.ts"],
  },
];

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function git(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run("git", args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** vitest on the given files with a JSON report; resolves with the exit code and the failing tests' names. */
async function vitest(files: string[], jsonOut: string): Promise<{ code: number; failed: string[]; total: number }> {
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [VITEST, "run", ...files, "--reporter=dot", "--reporter=json", `--outputFile.json=${jsonOut}`], {
      cwd: ROOT,
      env: { ...process.env, CI: process.env.CI ?? "1" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  let failed: string[] = [];
  let total = 0;
  try {
    const report = JSON.parse(await readFile(jsonOut, "utf8")) as { testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string }> }> };
    for (const file of report.testResults) {
      total += file.assertionResults.length;
      for (const a of file.assertionResults) if (a.status === "failed") failed.push(`${path.relative(ROOT, file.name).split(path.sep).join("/")} > ${a.fullName}`);
    }
  } catch {
    failed = [];
  }
  return { code, failed, total };
}

interface Row {
  mutant: Mutant;
  verdict: "caught" | "NOT CAUGHT" | "STALE PATCH" | "DIRTY TREE" | "NOT REVERTED";
  detail: string[];
}

async function checkMutant(m: Mutant, out: string): Promise<Row> {
  const patch = path.join("scripts", "mutations", m.patch);
  const numstat = await git(["apply", "--numstat", patch]);
  const touched = numstat.out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")[2]!).filter(Boolean);
  const applies = await git(["apply", "--check", patch]);
  if (applies.code !== 0) return { mutant: m, verdict: "STALE PATCH", detail: [`git apply --check failed: update the mutant (${applies.out.trim()})`] };
  const dirty = await git(["diff", "--quiet", "--", ...touched]);
  if (dirty.code !== 0) return { mutant: m, verdict: "DIRTY TREE", detail: [`uncommitted changes in ${touched.join(", ")}: commit or stash them first`] };
  const applied = await git(["apply", patch]);
  if (applied.code !== 0) return { mutant: m, verdict: "STALE PATCH", detail: [applied.out.trim()] };
  let result: { code: number; failed: string[]; total: number };
  try {
    result = await vitest(m.tests, path.join(out, `mutant-${m.id}.json`));
  } finally {
    await git(["apply", "-R", patch]);
  }
  const clean = await git(["diff", "--exit-code", "--", ...touched]);
  if (clean.code !== 0) return { mutant: m, verdict: "NOT REVERTED", detail: [`git diff after git apply -R is not empty:`, clean.out] };
  const caught = result.code !== 0 && result.failed.length > 0;
  return {
    mutant: m,
    verdict: caught ? "caught" : "NOT CAUGHT",
    detail: [`vitest exit ${result.code}; ${result.failed.length} of ${result.total} tests failed${caught ? ":" : ""}`, ...result.failed.map((f) => `  x ${f}`)],
  };
}

async function main(): Promise<void> {
  const out = path.resolve(ROOT, argValue("out") ?? path.join("evidence", "mutation-check"));
  const only = argValue("only")?.split(",");
  const mutants = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const started = new Date();
  const lines: string[] = [`Mutation check (D54), started ${started.toISOString()}; ${mutants.length} mutants; head ${(await git(["rev-parse", "--short", "HEAD"])).out.trim()}`];
  const rows: Row[] = [];
  for (const m of mutants) {
    const t0 = Date.now();
    const row = await checkMutant(m, out);
    rows.push(row);
    const text = [`== ${m.id} ${m.patch}: ${m.what}`, `tests: ${m.tests.join(", ")}`, `verdict: ${row.verdict} (${((Date.now() - t0) / 1000).toFixed(1)} s)`, ...row.detail, ""];
    lines.push(...text);
    console.log(text.join("\n"));
  }
  const pass = rows.every((r) => r.verdict === "caught");
  const md = [
    `# Mutation check: ${started.toISOString()}`,
    "",
    "Each planted bug is a patch in `scripts/mutations/`; it must turn its tests red, and the tree must be exactly as before afterwards.",
    "",
    "| Mutant | What it plants | Tests run | Verdict | Failing tests |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.mutant.id} \`${r.mutant.patch}\` | ${r.mutant.what} | ${r.mutant.tests.map((t) => `\`${path.basename(t)}\``).join(", ")} | ${r.verdict === "caught" ? "caught" : `**${r.verdict}**`} | ${r.detail.filter((d) => d.startsWith("  x ")).length} |`),
    "",
    `Caught: ${rows.filter((r) => r.verdict === "caught").length}/${rows.length}.`,
    "",
    pass ? "RESULT: PASS" : "RESULT: FAIL",
    "",
  ].join("\n");
  await writeFile(path.join(out, "report.md"), md);
  await writeFile(path.join(out, "check.txt"), [...lines, md].join("\n"));
  console.log(md);
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
