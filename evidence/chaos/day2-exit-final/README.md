# Day-2 exit: chaos at scale, the 20-seed batch (to be run)

This folder holds the builder's 20-seed run of the standard family (500 jobs, 4 workers, kills every 5–15 s,
one 45 s pause), all on ONE commit (D60: `chaos-seeds` refuses to mix commits in one folder):

```
npm run chaos-seeds -- --seeds 20 --jobs 500 --out evidence/chaos/day2-exit-final
```

`seeds.json` was copied from [`../day2-exit-after-d58/`](../day2-exit-after-d58/README.md): seeds 1–2 are the
same two seeds that failed before D58 ([`../day2-exit/`](../day2-exit/README.md)) and passed after it. The
batch keeps them and appends 18 more. **No seed has run here yet.** Until the runner has written `tally.md`, this
folder claims nothing.
