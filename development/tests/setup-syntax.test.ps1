#Requires -Version 7.0
# Syntax-check every PowerShell and Node script shipped by the bridge package,
# plus the maintainer tests under development/.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bridge = Join-Path $repoRoot 'dsh-codex-bridge'
$development = Join-Path $repoRoot 'development'

$powerShellFiles = [Collections.Generic.List[string]]::new()
foreach ($directory in @(
        (Join-Path $bridge 'windows'),
        (Join-Path $development 'tests')
    )) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
    foreach ($item in (Get-ChildItem -LiteralPath $directory -Recurse -File -Filter '*.ps1')) {
        $powerShellFiles.Add($item.FullName)
    }
}
$impl = Join-Path $bridge 'dsh-impl.ps1'
if (Test-Path -LiteralPath $impl) { $powerShellFiles.Add($impl) }

$errors = [Collections.Generic.List[string]]::new()
foreach ($file in ($powerShellFiles | Sort-Object -Unique)) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        $errors.Add(("{0}:{1}: {2}" -f $file, $parseError.Extent.StartLineNumber, $parseError.Message))
    }
}

$nodeFiles = [Collections.Generic.List[string]]::new()
foreach ($directory in @(
        (Join-Path $bridge 'node'),
        (Join-Path $bridge 'mcp'),
        (Join-Path $bridge 'windows\lib'),
        (Join-Path $development 'tests')
    )) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
    foreach ($item in (Get-ChildItem -LiteralPath $directory -Recurse -File | Where-Object { $_.Extension -in @('.mjs', '.cjs') })) {
        $nodeFiles.Add($item.FullName)
    }
}

$node = Get-Command node -ErrorAction Stop
foreach ($file in ($nodeFiles | Sort-Object -Unique)) {
    $output = @(& $node.Source --check $file 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $errors.Add(("{0}: {1}" -f $file, ($output -join ' ')))
    }
}

if ($errors.Count -gt 0) {
    Write-Output "FAIL: $($errors.Count) syntax error(s)"
    foreach ($errorLine in $errors) { Write-Output "  - $errorLine" }
    exit 1
}
Write-Output "PASS: parsed $($powerShellFiles.Count) PowerShell script(s) and $($nodeFiles.Count) Node script(s) without syntax errors"
