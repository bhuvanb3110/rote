# Day-2 exit: chaos at scale, the 20-seed batch (to be run)

This folder holds the builder's 20-seed run of the standard family (500 jobs, 4 workers, kills every 5–15 s,
one 45 s pause), all on ONE commit (D60: `chaos-seeds` refuses to mix commits in one folder):

```
npm run chaos-seeds -- --seeds 20 --jobs 500 --out evidence/chaos/day2-exit-final
```

**`seeds.json` already holds all 20 seeds.** Seeds 1–2 are copied from
[`../day2-exit-after-d58/`](../day2-exit-after-d58/README.md): the same two seeds that failed before D58
([`../day2-exit/`](../day2-exit/README.md)) and passed after it. Seeds 3–20 were drawn on 2026-11-18 with the
runner's own `drawSeed`, in its own format. Because every seed is already saved, the run starts on its resume
path and never writes this tracked file. Had the runner extended `seeds.json` itself, it would have changed a
tracked file before the first seed, and every seed would have been stamped `+dirty`.

**No seed has run here yet.** Until the runner has written `tally.md`, this folder claims nothing.
