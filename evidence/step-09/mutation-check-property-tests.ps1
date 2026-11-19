param([string]$Out)
$ErrorActionPreference = "Stop"
$file = "src/fleet/stateMachine.ts"
$orig = [IO.File]::ReadAllText((Resolve-Path $file))
$mutants = @(
  @{ name = "M1 no second lookup: a single 0 decides"; from = 'if (first.kind !== "count" || first.n !== 0) return true;'; to = 'if (first.kind !== "count" || first.n !== 0 || true) return true;' },
  @{ name = "M2 T6.4 requeues an expired committing job (Step 8 mutant)"; from = '    case "committing":
      return {
        kind: "verify",'; to = '    case "committing":
      if (row.attempt < row.maxAttempts) return { kind: "requeue", label: "T6.1", to: "queued", outcome: null, error: "mutant" };
      return {
        kind: "verify",' },
  @{ name = "M3 [0, 1] read as not committed"; from = 'const decisive = counts.find((r) => r.n !== 0);'; to = 'const decisive = counts.length === 1 ? counts.find((r) => r.n !== 0) : counts[1]!.n >= 2 ? counts[1] : undefined;' },
  @{ name = "M4 a refusal after Submit is retried instead of final"; from = 'if (input.priorStatus === "business_outcome") {'; to = 'if (input.priorStatus === "business_outcome" && false) {' }
)
$lines = @()
foreach ($m in $mutants) {
  if (-not $orig.Contains($m.from)) { $lines += "$($m.name): PATTERN NOT FOUND"; continue }
  [IO.File]::WriteAllText((Resolve-Path $file), $orig.Replace($m.from, $m.to))
  try {
    $log = cmd /c "npx vitest run src/fleet/stateMachine.property.test.ts 2>&1"
    $code = $LASTEXITCODE
    $failed = ($log | Select-String -Pattern "^\s+(×|x) " | ForEach-Object { $_.Line.Trim() })
    $lines += "$($m.name): exit=$code (expect 1 = caught)"
    $lines += ($failed | ForEach-Object { "    $_" })
  } finally {
    [IO.File]::WriteAllText((Resolve-Path $file), $orig)
  }
}
$lines | Set-Content -Encoding utf8 $Out
$lines
