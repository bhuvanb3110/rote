// The pre-D31 configuration (one project, vitest's default parallelism), kept ONLY so the interleaved
// before/after timing in evidence/step-07/flake-cap/ab/ can be reproduced:
//   powershell -File scripts/ab-timing.ps1 -Out <dir> -Rounds 3
// `npm test` never uses it (vitest.config.ts is the default config).
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { exclude: ["**/node_modules/**", "dist/**"] } });
