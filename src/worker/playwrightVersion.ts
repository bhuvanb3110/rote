// The browsers baked into the Playwright image match the npm package only when the versions are
// equal (docs/plans/step-06.md section 5). The image sets PLAYWRIGHT_VERSION; the worker refuses to
// start on a mismatch instead of failing later with a cryptic "Executable doesn't exist".
import { createRequire } from "node:module";

export function installedPlaywrightVersion(): string {
  return (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
}

/** Returns the installed version; throws if `expected` is set and differs. */
export function checkPlaywrightVersion(expected: string | undefined, installed = installedPlaywrightVersion()): string {
  if (expected && expected !== installed) {
    throw new Error(
      `playwright ${installed} is installed but the image was built for PLAYWRIGHT_VERSION=${expected}; ` +
        `rebuild the image with --build-arg PLAYWRIGHT_VERSION=${installed}`,
    );
  }
  return installed;
}
