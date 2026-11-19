# Runs `npm test` once and records, next to its full unfiltered log, the wall time and the peak number
# and total working set of Playwright Chromium processes (any process whose executable lives under
# ms-playwright), sampled every 500 ms. Used to choose the browser project's maxWorkers by
# measurement (docs/DECISIONS.md D31). Windows PowerShell 5.1.
#
# Usage: powershell -File scripts/measure-test-run.ps1 -Log evidence/step-07/flake-cap/<name>.txt [-VitestArgs "--project browser"]
param(
  [Parameter(Mandatory = $true)][string]$Log,
  [string]$VitestArgs = ""
)
$ErrorActionPreference = "Continue"
# Background jobs start in another directory: every path they get must be absolute.
if (-not [IO.Path]::IsPathRooted($Log)) { $Log = Join-Path (Get-Location).Path $Log }
$stopFile = [IO.Path]::GetTempFileName()
Remove-Item $stopFile
$samplesFile = "$Log.samples.csv"
$sampler = Start-Job -ArgumentList $stopFile, $samplesFile -ScriptBlock {
  param($stopFile, $samplesFile)
  "t_ms,chromium_processes,chromium_working_set_mb" | Out-File -Encoding utf8 $samplesFile
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path $stopFile)) {
    $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "*ms-playwright*" })
    $ws = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
    if (-not $ws) { $ws = 0 }
    "$($sw.ElapsedMilliseconds),$($procs.Count),$([math]::Round($ws / 1MB))" | Out-File -Append -Encoding utf8 $samplesFile
    Start-Sleep -Milliseconds 500
  }
}
$sw = [Diagnostics.Stopwatch]::StartNew()
# cmd.exe redirects, so the log is vitest's raw UTF-8 (PowerShell 5.1's *> would write UTF-16; the
# four measurement logs of D31 were written that way and re-encoded to UTF-8 afterwards, text unchanged).
if ($VitestArgs) { cmd /c "npx vitest run $VitestArgs > `"$Log`" 2>&1" } else { cmd /c "npm test > `"$Log`" 2>&1" }
$code = $LASTEXITCODE
$sw.Stop()
New-Item -ItemType File $stopFile | Out-Null
Wait-Job $sampler -Timeout 10 | Out-Null
Remove-Job $sampler -Force
Remove-Item $stopFile -ErrorAction SilentlyContinue
$rows = Import-Csv $samplesFile
$peakProcs = ($rows | Measure-Object -Property chromium_processes -Maximum).Maximum
$peakMb = ($rows | Measure-Object -Property chromium_working_set_mb -Maximum).Maximum
$summary = "exit=$code wall_seconds=$([math]::Round($sw.Elapsed.TotalSeconds,1)) peak_chromium_processes=$peakProcs peak_chromium_working_set_mb=$peakMb samples=$($rows.Count)"
$summary | Out-File -Append -Encoding utf8 $Log
$summary
