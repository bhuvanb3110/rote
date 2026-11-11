// Guards vitest.browser-files.ts (docs/DECISIONS.md D31): every test file that launches Chromium must
// be in the capped "browser" project, or the cap silently stops covering it and the parallel-Chromium
// flake (evidence/step-06/flakes.md) can return. A file "launches Chromium" if it calls
// chromium.launch / WebSurface.launch, uses the worker test env (which launches one), or replays
// (runReplay / invokeCapability) against the in-process mock bank.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_TEST_FILES, BROWSER_TEST_WORKERS } from "../../vitest.browser-files.js";

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
  const importsMockBank = /from "(\.\.\/)+mock-app\/app\.js"|from "\.\/app\.js"/.test(source);
  return importsMockBank && /runReplay\(|invokeCapability\(/.test(source);
}

describe("the capped browser project (vitest.browser-files.ts)", async () => {
  const all = (await Promise.all(ROOTS.map((r) => stat(r).then(() => testFiles(r), () => [])))).flat().sort();

  it("lists exactly the test files that launch Chromium", async () => {
    const launching: string[] = [];
    for (const file of all) {
      if (launchesChromium(await readFile(file, "utf8"))) launching.push(file);
    }
    expect([...BROWSER_TEST_FILES].sort()).toEqual(launching);
  });

  it("caps browser files below the unit/DB parallelism", () => {
    expect(BROWSER_TEST_WORKERS).toBeGreaterThanOrEqual(1);
    expect(BROWSER_TEST_WORKERS).toBeLessThanOrEqual(4);
  });
});
