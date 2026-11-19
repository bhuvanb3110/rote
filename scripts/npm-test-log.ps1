# Runs `npm test` once with its full output (stdout + stderr, raw bytes, unfiltered) in -Log, then
# appends "exit=<code> wall_seconds=<s>". cmd.exe does the redirection so the log is the exact UTF-8
# that vitest wrote (PowerShell 5.1's own redirection re-encodes it as UTF-16).
#
# Usage: powershell -File scripts/npm-test-log.ps1 -Log evidence/step-07/<name>.txt
param([Parameter(Mandatory = $true)][string]$Log)
if (-not [IO.Path]::IsPathRooted($Log)) { $Log = Join-Path (Get-Location).Path $Log }
$sw = [Diagnostics.Stopwatch]::StartNew()
cmd /c "npm test > `"$Log`" 2>&1"
$code = $LASTEXITCODE
$sw.Stop()
$line = "exit=$code wall_seconds=$([math]::Round($sw.Elapsed.TotalSeconds, 1))"
[IO.File]::AppendAllText($Log, "$line`r`n", (New-Object Text.UTF8Encoding($false)))
$line
