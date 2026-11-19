# Interleaved before/after timing for the slow project (docs/DECISIONS.md D48; step-10 reviewer
# decision 6). Alternately runs the full suite with the pre-D48 arrangement (vitest.ab-before.config.ts:
# the slow files in the capped browser project; a copy is kept here as vitest.ab-before.config.ts.txt)
# and the committed vitest.config.ts (the slow project in group 0), -Rounds times each, nothing else
# running. Each run keeps its full log and a JSON report (per-file start/end, for scripts/test-timeline.ts).
#
# Usage (from the repo root, with vitest.ab-before.config.ts restored from the .txt copy):
#   powershell -File evidence/step-10/slow-project/ab.ps1 -Out evidence/step-10/slow-project/ab -Rounds 3
param([Parameter(Mandatory = $true)][string]$Out, [int]$Rounds = 3)
if (-not (Test-Path vitest.ab-before.config.ts)) { Write-Error "vitest.ab-before.config.ts missing (copy it from the .txt next to this script)"; exit 2 }
if (-not [IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location).Path $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($i in 1..$Rounds) {
  foreach ($variant in "before", "after") {
    $log = Join-Path $Out ("round{0}-{1}.txt" -f $i, $variant)
    $json = Join-Path $Out ("round{0}-{1}.json" -f $i, $variant)
    $cfg = if ($variant -eq "before") { "--config vitest.ab-before.config.ts" } else { "" }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    cmd /c "npx vitest run $cfg --reporter=default --reporter=json --outputFile.json=`"$json`" > `"$log`" 2>&1"
    $code = $LASTEXITCODE
    $sw.Stop()
    [IO.File]::AppendAllText($log, "exit=$code wall_seconds=$([math]::Round($sw.Elapsed.TotalSeconds, 1))`r`n", $utf8)
    "round $i $variant exit=$code wall_seconds=$([math]::Round($sw.Elapsed.TotalSeconds, 1))"
  }
}
