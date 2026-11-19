// Prints a vitest JSON report (`--reporter=json --outputFile.json=<file>`) as a per-file timeline: when
// each test file started and ended relative to the first one, how long it ran, and which vitest project
// it belongs to. Used to measure the `slow` project change (docs/plans/step-10.md section 6, reviewer
// decision 6; docs/DECISIONS.md D48) before and after.
//
//   npx tsx scripts/test-timeline.ts <report.json> [<report.json> ...]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BROWSER_TEST_FILES, SLOW_TEST_FILES } from "../vitest.browser-files.js";

interface FileResult {
  name: string;
  startTime: number;
  endTime: number;
  status: string;
  assertionResults: unknown[];
}

const projectOf = (rel: string) => ((SLOW_TEST_FILES as readonly string[]).includes(rel) ? "slow" : (BROWSER_TEST_FILES as readonly string[]).includes(rel) ? "browser" : "unit-db");

for (const file of process.argv.slice(2)) {
  const report = JSON.parse(await readFile(file, "utf8")) as { testResults: FileResult[]; numTotalTests: number; numFailedTests: number };
  const rows = report.testResults
    .map((r) => ({ rel: path.relative(process.cwd(), r.name).split(path.sep).join("/"), start: r.startTime, end: r.endTime, status: r.status, tests: r.assertionResults.length }))
    .sort((a, b) => a.start - b.start);
  const t0 = Math.min(...rows.map((r) => r.start));
  const last = Math.max(...rows.map((r) => r.end));
  console.log(`# ${file}: ${rows.length} files, ${report.numTotalTests} tests, ${report.numFailedTests} failed; first file start -> last file end ${((last - t0) / 1000).toFixed(1)} s`);
  console.log("| File | Project | Start (s) | End (s) | Ran (s) | Tests | Status |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(`| \`${r.rel}\` | ${projectOf(r.rel)} | ${((r.start - t0) / 1000).toFixed(1)} | ${((r.end - t0) / 1000).toFixed(1)} | ${((r.end - r.start) / 1000).toFixed(1)} | ${r.tests} | ${r.status} |`);
  }
  const byProject = new Map<string, { first: number; last: number; sum: number }>();
  for (const r of rows) {
    const p = projectOf(r.rel);
    const cur = byProject.get(p) ?? { first: Infinity, last: 0, sum: 0 };
    byProject.set(p, { first: Math.min(cur.first, r.start), last: Math.max(cur.last, r.end), sum: cur.sum + (r.end - r.start) });
  }
  console.log("");
  for (const [p, v] of byProject) {
    console.log(`- ${p}: ${((v.first - t0) / 1000).toFixed(1)} s .. ${((v.last - t0) / 1000).toFixed(1)} s (span ${((v.last - v.first) / 1000).toFixed(1)} s; summed file time ${(v.sum / 1000).toFixed(1)} s)`);
  }
  console.log("");
}
