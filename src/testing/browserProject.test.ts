// Guards vitest.browser-files.ts (docs/DECISIONS.md D31, D48): every test file that launches Chromium must
// be in the capped "browser" project or in the "slow" project, never in the fully parallel unit-db one,
// or the cap silently stops covering it and the parallel-Chromium flake (evidence/step-06/flakes.md) can
// return. A file "launches Chromium" if it calls chromium.launch / WebSurface.launch, uses the worker test
// env (which launches one), replays (runReplay / invokeCapability) against the in-process mock bank, or
// spawns worker child processes (src/testing/workerProcess.ts: each launches its own Chromium).
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_TEST_FILES, BROWSER_TEST_WORKERS, SLOW_TEST_FILES } from "../../vitest.browser-files.js";

const ROOTS = ["src", "mock-app", "scripts", "examples"];

async function testFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await testFiles(full)));
    else if (entry.name.endsWith(".test.ts")) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

function launchesChromium(raw: string): boolean {
  // Comments don't launch anything (webSurface.test.ts names WebSurface.launch() in one; it uses a fake Page).
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (/chromium\.launch\(|WebSurface\.launch\(|createWorkerTestEnv\(/.test(source)) return true;
  // Worker child processes from the shared spawner (fault.test.ts has its own local startWorker, for a
  // worker that refuses to start before it launches anything: not a browser).
  if (/from "(\.\.\/)+testing\/workerProcess\.js"/.test(source) && /startWorker\(|runFaultWorker\(/.test(source)) return true;
  const importsMockBank = /from "(\.\.\/)+mock-app\/app\.js"|from "\.\/app\.js"/.test(source);
  return importsMockBank && /runReplay\(|invokeCapability\(/.test(source);
}

describe("the capped browser project and the slow project (vitest.browser-files.ts)", async () => {
  const all = (await Promise.all(ROOTS.map((r) => stat(r).then(() => testFiles(r), () => [])))).flat().sort();

  it("the two lists together are exactly the test files that launch Chromium", async () => {
    const launching: string[] = [];
    for (const file of all) {
      if (launchesChromium(await readFile(file, "utf8"))) launching.push(file);
    }
    expect([...BROWSER_TEST_FILES, ...SLOW_TEST_FILES].sort()).toEqual(launching);
  });

  it("no file is in both lists, and every slow file is an integration (*.db.test.ts) file", () => {
    expect(BROWSER_TEST_FILES.filter((f) => SLOW_TEST_FILES.includes(f))).toEqual([]);
    for (const f of SLOW_TEST_FILES) expect(f).toMatch(/\.db\.test\.ts$/);
  });

  it("caps browser files below the unit/DB parallelism", () => {
    expect(BROWSER_TEST_WORKERS).toBeGreaterThanOrEqual(1);
    expect(BROWSER_TEST_WORKERS).toBeLessThanOrEqual(4);
  });
});
