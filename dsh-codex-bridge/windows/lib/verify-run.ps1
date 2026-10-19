#Requires -Version 7.0
# Runs INSIDE the installed DSH workspace-write runner. It creates only its own
# disposable probe files in the repository and its own Node fixture in the DSH
# private temp, removes them, and never writes setup logs under .state.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Package,
    [Parameter(Mandatory = $true)][string]$OutsideFile,
    [Parameter(Mandatory = $true)][string]$NodeTest,
    [string]$NodeExe = '',
    [string]$NodeVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-AccessDenied {
    param([Parameter(Mandatory = $true)]$Exception)
    $cursor = $Exception
    while ($null -ne $cursor) {
        if ($cursor -is [UnauthorizedAccessException]) { return $true }
        if ($cursor -is [IO.IOException] -and $cursor.HResult -eq -2147024891) { return $true }
        if ($cursor.Message -match 'Access is denied|denied|EPERM|EACCES') { return $true }
        $cursor = $cursor.InnerException
    }
    return $false
}

function Add-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Pass,
        [string]$Detail = ''
    )
    $script:Checks.Add([ordered]@{ name = $Name; pass = $Pass; detail = $Detail })
    $state = if ($Pass) { 'PASS' } else { 'FAIL' }
    Write-Output ("[{0}] {1}: {2}" -f $state, $Name, $Detail)
}

$repoFull = [IO.Path]::GetFullPath($Repo)
$packageFull = [IO.Path]::GetFullPath($Package)
$outsideFull = [IO.Path]::GetFullPath($OutsideFile)
$nodeTestFull = [IO.Path]::GetFullPath($NodeTest)

if (-not [IO.Directory]::Exists($repoFull)) { throw "Repo is not a directory: $repoFull" }
if (-not [IO.Directory]::Exists($packageFull)) { throw "Package is not a directory: $packageFull" }
if (-not [IO.File]::Exists($outsideFull)) { throw "Outside sentinel is not a file: $outsideFull" }
if (-not [IO.File]::Exists($nodeTestFull)) { throw "Node fixture is not a file: $nodeTestFull" }
if ($outsideFull.StartsWith($repoFull.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Outside sentinel must be outside Repo: $outsideFull"
}
if (-not $nodeTestFull.StartsWith($packageFull.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Node fixture must be inside the package: $nodeTestFull"
}
$nested = Join-Path $packageFull 'windows'
if (-not [IO.Directory]::Exists($nested)) { throw "Expected existing nested directory: $nested" }

if (-not $NodeExe) {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) { throw 'node was not found on PATH' }
    $NodeExe = $command.Source
}
if (-not [IO.File]::Exists($NodeExe)) { throw "Node executable was not found: $NodeExe" }

$script:Checks = [Collections.Generic.List[object]]::new()
$sentinelBefore = [IO.File]::ReadAllText($outsideFull)
$allProbes = [Collections.Generic.List[string]]::new()
$cleanupFailures = [Collections.Generic.List[string]]::new()

try {
    # PowerShell outside-workspace write must be denied and must not alter the sentinel.
    $powerShellDenied = $false
    $powerShellDetail = ''
    try {
        [IO.File]::AppendAllText($outsideFull, 'UNEXPECTED-POWERSHELL')
        $powerShellDetail = 'append unexpectedly succeeded'
    } catch {
        $powerShellDenied = Test-AccessDenied -Exception $_.Exception
        $powerShellDetail = $_.Exception.GetBaseException().Message
    }
    $sentinelAfterPowerShell = [IO.File]::ReadAllText($outsideFull)
    $powerShellPass = $powerShellDenied -and ($sentinelAfterPowerShell -eq $sentinelBefore)
    Add-Check -Name 'PowerShell outside-workspace write denied' -Pass $powerShellPass -Detail $(if ($powerShellPass) { 'access denied; sentinel unchanged' } else { "denied=$powerShellDenied; $powerShellDetail" })

    # Root and an existing nested directory: create, overwrite, read, delete.
    foreach ($target in @($repoFull, $nested)) {
        $probe = Join-Path $target ('dsh-verify-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $allProbes.Add($probe)
        $probePass = $false
        $probeDetail = ''
        try {
            [IO.File]::WriteAllText($probe, 'first')
            [IO.File]::WriteAllText($probe, 'second')
            $readBack = [IO.File]::ReadAllText($probe)
            Remove-Item -LiteralPath $probe -Force
            if ($readBack -ne 'second') { throw 'read-back mismatch' }
            if (Test-Path -LiteralPath $probe) { throw 'probe still exists after delete' }
            $probePass = $true
            $probeDetail = 'create/overwrite/read/delete passed'
        } catch {
            $probeDetail = $_.Exception.Message
        } finally {
            if (Test-Path -LiteralPath $probe) {
                try { Remove-Item -LiteralPath $probe -Force } catch { $cleanupFailures.Add("probe cleanup failed for ${probe}: $($_.Exception.Message)") }
            }
        }
        Add-Check -Name ("confined write probe: {0}" -f $target) -Pass $probePass -Detail $probeDetail
    }

    # Real Node child with file-backed capture; its outside write must be denied.
    $env:DSH_VERIFY_SENTINEL = $outsideFull
    $env:DSH_VERIFY_NODE_VERSION = $NodeVersion
    & $NodeExe --test --experimental-test-isolation=none $nodeTestFull
    $nodeExit = $LASTEXITCODE
    $nodePass = ($nodeExit -eq 0)
    Add-Check -Name 'Node file-backed capture and child confinement' -Pass $nodePass -Detail ("node --test exit {0}" -f $nodeExit)
} catch {
    Add-Check -Name 'verify harness' -Pass $false -Detail $_.Exception.Message
} finally {
    foreach ($probe in $allProbes) {
        if (Test-Path -LiteralPath $probe) {
            try { Remove-Item -LiteralPath $probe -Force } catch { $cleanupFailures.Add("probe cleanup failed for ${probe}: $($_.Exception.Message)") }
        }
    }
}

$probeCleanupPass = ($cleanupFailures.Count -eq 0)
Add-Check -Name 'probe cleanup' -Pass $probeCleanupPass -Detail $(if ($probeCleanupPass) { 'all disposable probe files removed' } else { ($cleanupFailures -join '; ') })

$sentinelAfter = [IO.File]::ReadAllText($outsideFull)
$sentinelPass = ($sentinelAfter -eq $sentinelBefore)
Add-Check -Name 'outside sentinel unchanged after all probes' -Pass $sentinelPass -Detail $(if ($sentinelPass) { 'content unchanged' } else { 'CONTENT CHANGED' })

$ok = $true
foreach ($check in $script:Checks) {
    if (-not $check.pass) { $ok = $false }
}
$summary = [ordered]@{
    ok              = $ok
    mode            = 'workspace-write'
    repo            = $repoFull
    package         = $packageFull
    nodeVersion     = $NodeVersion
    projectTestsRun = $false
    timestampUtc    = (Get-Date).ToUniversalTime().ToString('o')
    checks          = @($script:Checks)
}
Write-Output ('VERIFY_RESULT: ' + ($summary | ConvertTo-Json -Compress -Depth 8))
if (-not $ok) {
    exit 1
}
exit 0
