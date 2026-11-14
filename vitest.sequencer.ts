// The test-file order (docs/DECISIONS.md D48). vitest's BaseSequencer sorts by groupOrder, then by PROJECT
// NAME ("Projects run sequential"), then by each file's last duration. With "browser" and "slow" sharing
// group 1 and one pool of 3, that queued every slow file behind every browser file: the slow files ran
// last, one after another, and the suite got about 45 s slower (evidence/step-10/slow-project/). This is
// vitest's own comparator without the project-name step, so group 1 is one longest-first queue across both
// projects, as it was when the slow files were in the browser project:
//   1. groupOrder (unit-db before browser + slow)
//   2. files with no recorded result first (vitest's rule); among those, the slow project's (they are the
//      long ones: on a fresh checkout such as CI there is no record at all), then larger files first
//   3. failed last time first, then longer last time first (vitest's rules)
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export const SLOW_PROJECT = "slow";

export class GroupDurationSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const cache = this.ctx.cache;
    // vitest's cache key: "<project>:<path from the root, forward slashes>" (it uses pathe's relative).
    const key = (s: TestSpecification) => `${s.project.name}:${relative(this.ctx.config.root, s.moduleId).replace(/\\/g, "/")}`;
    return [...files].sort((a, b) => {
      const group = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
      if (group !== 0) return group;
      const aState = cache.getFileTestResults(key(a));
      const bState = cache.getFileTestResults(key(b));
      if (!aState || !bState) {
        if (!aState && bState) return -1;
        if (aState && !bState) return 1;
        const aSlow = a.project.name === SLOW_PROJECT;
        const bSlow = b.project.name === SLOW_PROJECT;
        if (aSlow !== bSlow) return aSlow ? -1 : 1;
        const aStats = cache.getFileStats(key(a));
        const bStats = cache.getFileStats(key(b));
        if (!aStats || !bStats) return !aStats && bStats ? -1 : !bStats && aStats ? 1 : 0;
        return bStats.size - aStats.size;
      }
      if (aState.failed && !bState.failed) return -1;
      if (!aState.failed && bState.failed) return 1;
      return bState.duration - aState.duration;
    });
  }
}
