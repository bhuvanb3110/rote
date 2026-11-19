# Interleaved before/after timing for D31: alternately runs the full suite with the pre-D31 vitest
# configuration (vitest.uncapped.config.ts: one project, default parallelism) and the committed one
# (browser project capped at 3), N times each, nothing else running. Full logs kept, cmd.exe redirect.
#
# vitest.uncapped.config.ts was deleted in Step 8 (reviewer decision A2). To reproduce the A/B, check
# out the commit the measurement was taken on first (D31 amendment):
#   git switch --detach b9bc8da
#   powershell -File scripts/ab-timing.ps1 -Out <dir outside the repo> -Rounds 3
#   git switch -
param([Parameter(Mandatory = $true)][string]$Out, [int]$Rounds = 3)
if (-not (Test-Path vitest.uncapped.config.ts)) {
  Write-Error "vitest.uncapped.config.ts is not in this checkout (deleted in Step 8). Run 'git switch --detach b9bc8da' first (D31 amendment)."
  exit 2
}
if (-not [IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location).Path $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($i in 1..$Rounds) {
  foreach ($variant in "uncapped", "capped") {
    $log = Join-Path $Out ("round{0}-{1}.txt" -f $i, $variant)
    $cfg = if ($variant -eq "uncapped") { "--config vitest.uncapped.config.ts" } else { "" }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    cmd /c "npx vitest run $cfg > `"$log`" 2>&1"
    $code = $LASTEXITCODE
    $sw.Stop()
    [IO.File]::AppendAllText($log, "exit=$code wall_seconds=$([math]::Round($sw.Elapsed.TotalSeconds, 1))`r`n", $utf8)
    "round $i $variant exit=$code wall_seconds=$([math]::Round($sw.Elapsed.TotalSeconds, 1))"
  }
}
