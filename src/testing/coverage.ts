// How often each path was reached by a randomized test (the property tests, model vs real), printed into the
// test log (the reviewer's request during 10b, 2026-11-18). A required path that is never reached already fails
// its test. Printing every count, and naming the WATCHED paths that were not reached, makes a path the generator
// rarely or never reaches visible on its own, the way the reconcile cap was unreached in model vs real until
// D59's prefix.
export function formatCoverage(title: string, counts: ReadonlyMap<string, number>, watched: readonly string[] = []): string {
  const keys = [...counts.keys()].sort();
  const width = Math.max(0, ...keys.map((k) => k.length));
  const lines = [`[coverage] ${title}: ${keys.length} paths reached`];
  for (const k of keys) lines.push(`  ${k.padEnd(width)}  ${counts.get(k)}`);
  const missing = watched.filter((k) => !counts.has(k));
  lines.push(missing.length === 0 ? "  every watched path was reached" : `  NOT reached (watched): ${missing.join(", ")}`);
  return lines.join("\n");
}

/**
 * Written straight to the process's stdout, not console.log: vitest's default reporter (the one `npm test`
 * uses) hides a passing test's console output, and these counts are for every run's log, passing or not.
 */
export function printCoverage(title: string, counts: ReadonlyMap<string, number>, watched: readonly string[] = []): void {
  process.stdout.write(formatCoverage(title, counts, watched) + "\n");
}
