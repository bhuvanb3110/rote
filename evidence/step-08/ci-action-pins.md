# CI after the action pins (Step 8, reviewer decision A1)

Commit 6dc6c59 (pins) pushed with b2ab650; run https://github.com/bhuvanb3110/rote/actions/runs/43141080184

```
run: completed success head b2ab650a6d252f21e4ed309a32b0e922de839a74
job docker: success (id 130927941409)
job unit-node25: success (id 130927941737)
job test: success (id 130927941746)
```

Annotations per job (gh api repos/bhuvanb3110/rote/check-runs/<id>/annotations), after:
```
job 130927941409: 0 annotations
job 130927941737: 0 annotations
job 130927941746: 0 annotations
```

Before (run 43083173819, commit d2a98d9), every job carried:
```
warning: Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4, actions/upload-artifact@v4. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
warning: Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, docker/build-push-action@v6, docker/setup-buildx-action@v3. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
```
