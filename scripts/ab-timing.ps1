# Interleaved before/after timing for D31: alternately runs the full suite with the pre-D31 vitest
# configuration (vitest.uncapped.config.ts: one project, default parallelism) and the committed one
# (browser project capped at 3), N times each, nothing else running. Full logs kept, cmd.exe redirect.
#
# Usage: powershell -File scripts/ab-timing.ps1 -Out evidence/step-07/flake-cap/ab -Rounds 3
param([Parameter(Mandatory = $true)][string]$Out, [int]$Rounds = 3)
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
