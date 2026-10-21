#Requires -Version 7.0
<#
.SYNOPSIS
Inspect, stop or recover a recorded DSH execution without starting a model session.
#>
[CmdletBinding()]
param(
    [string]$Repo = '.',
    [ValidateSet('Status','Scan','Recover','Stop')][string]$Action = 'Status',
    [string]$RunId = '',
    [switch]$Apply,
    [string]$Reason = ''
)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'windows/lib/run-lifecycle.ps1')
    $context = New-RunContext -Repo $Repo
    $errors = @()
    $active = $null
    try { $active = Read-ActiveRun $context }
    catch { $errors += $_.Exception.Message }
    if ($Action -in @('Status','Scan')) {
        if ($Apply) { throw '-Apply is only valid with Stop or Recover.' }
        $ids = @(Get-AllRunIds $context | Sort-Object -Descending)
        if ($RunId) { $ids = @($RunId) }
        elseif ($Action -eq 'Status') {
            $ids = if ($active) { @($active) } else { @($ids | Select-Object -First 1) }
        } elseif ($active -and $active -notin $ids) { $ids = @($active) + $ids }
        $observations = @(
            foreach ($id in $ids) {
                try {
                    $item = Get-RunObservation $context (Read-RunRecord $context $id)
                    if ($Action -eq 'Status' -or $RunId -or $item.state -notin @('FINISHED','RECOVERED') -or
                        ($item.state -eq 'FINISHED' -and $item.outcome -ne 'SUCCEEDED') -or $id -eq $active) { $item }
                } catch {
                    if ($RunId) { throw }
                    @{ runId = $id; state = 'UNKNOWN'; recoverable = $false; errors = @($_.Exception.Message) }
                }
            }
        )
        [ordered]@{ schemaVersion = 1; action = $Action; repo = $context.Repo; activeRunId = $active; runs = $observations; errors = $errors } | ConvertTo-Json -Depth 35
        exit 0
    }
    if (-not $RunId) { throw "$Action requires an explicit -RunId." }
    if ($errors.Count) { throw ($errors -join '; ') }
    $record = Read-RunRecord $context $RunId
    if (-not $Apply) {
        [ordered]@{ action = $Action; applied = $false; preview = Get-RunObservation $context $record; reasonRequired = $true } | ConvertTo-Json -Depth 35
        exit 0
    }
    if (-not $Reason.Trim()) { throw "$Action -Apply requires a nonempty -Reason." }
    $guard = Enter-RunGuard $context
    try {
        $active = Read-ActiveRun $context
        if ($active -and $active -cne $RunId) { throw "A different run owns this repository: $active" }
        $record = Read-RunRecord $context $RunId
        $observation = Get-RunObservation $context $record
        if ($observation.state -eq 'UNKNOWN') { throw 'Process identity/liveness is uncertain; mutation refused.' }
        if ($Action -eq 'Stop') {
            if ($record.stage -in @('FINISHED','RECOVERED')) { throw 'This run has already ended.' }
            $record.stop = @{ at = Get-RunUtc; reason = $Reason }
            Write-RunJson $context (Get-RunRecordPath $context $RunId) $record
            $remaining = [DshBridge.OwnedRun]::Stop($record.jobName)
            $remaining += [DshBridge.OwnedRun]::Stop($record.jobName + '-helper')
            if ($remaining -ne 0) { throw 'Owned processes have not stopped; execution ownership retained.' }
            $result = @{ action = 'Stop'; applied = $true; runId = $RunId; remainingOwnedProcesses = $remaining; note = 'Stop requested. Query Status; use Recover if the launcher was interrupted.' }
        } else {
            if ($observation.state -notin @('INTERRUPTED','FINISHED','RECOVERED') -or
                ($observation.owner -eq 'ALIVE' -and $record.stage -ne 'RECOVERED')) {
                throw "Run still has a live owner or writer ($($observation.state)); recovery refused."
            }
            if ($record.stage -eq 'RECOVERED') {
                # A previous recoverer may have died after recording recovery but
                # before clearing its pointer. Complete that same release only.
                $releasePending = $active -ceq $RunId
                if ($releasePending) { [IO.File]::Delete((Assert-RunPath $context $context.Active)) }
                $result = @{ action = 'Recover'; applied = $releasePending; runId = $RunId; alreadyRecovered = $true; recovery = $record.recovery }
            } else {
                $note = 'No canonical reconstruction input was recorded; start/error evidence retained.'
                if ($record.factsPath) {
                    if ([IO.Path]::GetFileName($record.factsPath) -cne "$RunId-result-input.json") { throw 'Invalid recovery facts filename.' }
                    $facts = Read-RunJson $context $record.factsPath
                    if ($facts.runId -cne $RunId -or $facts.repoRoot -ine $context.Repo -or $facts.artifacts -isnot [Collections.IDictionary]) { throw 'Recovery facts do not match this run.' }
                    $expectedNames = @{
                        prompt = 'prompt.md'; patch = 'patch.yml'; events = 'events.jsonl'; stderr = 'stderr.log'
                        report = 'report.md'; result = 'result.json'; finalText = 'final.txt'
                        inventoryBefore = 'inventory-before.json'; inventoryAfter = 'inventory-after.json'
                    }
                    foreach ($key in $expectedNames.Keys) {
                        $path = Assert-RunPath $context ([string]$facts.artifacts[$key])
                        $expected = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($record.factsPath)) "$RunId-$($expectedNames[$key])"))
                        if ($path -ine $expected) { throw "Recovery artifact is not this run's $key file." }
                    }
                    $resultPath = Assert-RunPath $context $facts.artifacts.result
                    if ([IO.File]::Exists($resultPath)) {
                        $existing = Read-RunJson $context $resultPath
                        if ($existing.runId -cne $RunId -or $existing.schemaVersion -ne 1 -or -not $existing.execution) { throw 'Existing result is inconsistent; preserved without overwrite.' }
                        $note = 'Existing canonical result preserved without overwrite.'
                    } else {
                        if (-not $record.exitKnown) {
                            $facts.completedAt = Get-RunUtc
                            $facts.exitCode = $null
                            $facts.interrupted = [bool]$record.launched
                            $facts.launchFailed = -not $record.launched
                            $facts.timedOut = $false
                            $facts.captureErrors = @($facts.captureErrors) + @('Execution interrupted; original exit status and unreported work are unknown.')
                        }
                        $recoveredFacts = Join-Path $context.Runs "$RunId-recovery-input.tmp"
                        Write-RunJson $context $recoveredFacts $facts
                        # Only this installed helper is executed, never a record-supplied command.
                        $node = Get-Command node -ErrorAction Stop
                        $helper = Join-Path $PSScriptRoot 'node/run-report.mjs'
                        $savedNodeOptions = $env:NODE_OPTIONS
                        try {
                            $env:NODE_OPTIONS = $null
                            $finalization = Invoke-RunHelper $context $record $node.Source ([string[]]@($helper, 'finalize', '--input', $recoveredFacts)) -UnderGuard
                        } finally { $env:NODE_OPTIONS = $savedNodeOptions }
                        if ($finalization.ExitCode -ne 0) { throw "Recovery finalization failed; evidence retained: $($finalization.Output)" }
                        $note = 'Canonical result reconstructed from retained evidence; acceptance remains pending.'
                    }
                    $canonical = Read-RunJson $context $resultPath
                    $record.finalized = $true
                    $record.outcome = if ($canonical.execution.bridgeExitCode -ne 0 -and $canonical.execution.status -eq 'SUCCEEDED') { 'FAILED' } else { $canonical.execution.status }
                    if ($canonical.sessionProvenance -eq 'EVENT') { $record.observedSession = $canonical.sessionId }
                }
                $record.recovery = @{ at = Get-RunUtc; reason = $Reason; previousStage = $record.stage; note = $note }
                $record.stage = 'RECOVERED'; $record.completedAt = Get-RunUtc
                Write-RunJson $context (Get-RunRecordPath $context $RunId) $record
                if ($active -ceq $RunId) { [IO.File]::Delete((Assert-RunPath $context $context.Active)) }
                $result = @{ action = 'Recover'; applied = $true; runId = $RunId; recovery = $record.recovery; next = 'Inspect the actual diff and tests before explicitly resuming or choosing a new session.' }
            }
        }
    } finally { $guard.Dispose() }
    $result | ConvertTo-Json -Depth 35
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    @{ error = $_.Exception.Message; action = $Action; applied = $false } | ConvertTo-Json -Compress
    exit 1
}
