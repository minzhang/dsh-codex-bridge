#Requires -Version 7.0
# Operational state only. Business results remain in the existing canonical result.
. (Join-Path $PSScriptRoot 'interop.ps1')
if (-not ('DshBridge.OwnedRun' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'run-process.cs')
}

function Get-RunUtc { (Get-Date).ToUniversalTime().ToString('o') }

function Assert-RunPath {
    param($Context, [string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($Context.Repo.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Run state/artifacts must stay inside the repository: $full"
    }
    Assert-NoReparseAncestors -Path $full
    if ([IO.File]::Exists($full) -and (Get-FileLinkCount -Path $full) -ne 1) {
        throw "Hard-linked run state/artifacts are not supported: $full"
    }
    return $full
}

function New-RunContext {
    param([string]$Repo, [switch]$Create)
    if (-not $IsWindows) { throw 'Managed DSH execution currently requires Windows 10 or newer; other backends are not verified.' }
    $root = Get-CanonicalPath -Path $Repo
    if ($root.TrimEnd('\') -ieq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'A drive root is not a dedicated repository.' }
    $hashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant()))
    $hash = [Convert]::ToHexString($hashBytes).Substring(0, 32)
    $context = @{ Repo = $root; Control = Join-Path $root '.dsh-runs/control'; Key = $hash }
    $context.Runs = Join-Path $context.Control 'runs'
    $context.Active = Join-Path $context.Control 'active.json'
    [void](Assert-RunPath $context $context.Runs)
    if ($Create) {
        [void][IO.Directory]::CreateDirectory($context.Runs)
        $ignore = Join-Path $root '.dsh-runs/.gitignore'
        [void](Assert-RunPath $context $ignore)
        if (-not [IO.File]::Exists($ignore)) { [IO.File]::WriteAllText($ignore, ('*' + [Environment]::NewLine)) }
    }
    return $context
}

function Enter-RunGuard {
    param($Context)
    $path = Assert-RunPath $Context (Join-Path $Context.Control 'gate.lock')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if ($timer.ElapsedMilliseconds -ge 5000) { throw 'Run management is busy; retry after the current operation finishes.' }
            Start-Sleep -Milliseconds 50
        }
    } while ($true)
}

function Write-RunJson {
    param($Context, [string]$Path, $Value)
    $path = Assert-RunPath $Context $Path
    $temporary = Assert-RunPath $Context ($path + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $path, $true)
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Read-RunJson {
    param($Context, [string]$Path)
    $path = Assert-RunPath $Context $Path
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        try { return ($reader.ReadToEnd() | ConvertFrom-Json -AsHashtable -ErrorAction Stop) }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-RunRecordPath {
    param($Context, [string]$RunId)
    if ($RunId -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$') { throw 'Invalid run ID.' }
    return Assert-RunPath $Context (Join-Path $Context.Runs "$RunId.json")
}

function Read-RunRecord {
    param($Context, [string]$RunId)
    $record = Read-RunJson $Context (Get-RunRecordPath $Context $RunId)
    if ($record -isnot [Collections.IDictionary] -or
        ($record.schemaVersion -isnot [int] -and $record.schemaVersion -isnot [long]) -or $record.schemaVersion -ne 1 -or
        $record.runId -cne $RunId -or $record.repo -ine $Context.Repo -or
        $record.jobName -cne "Local\DshBridge-$($Context.Key)-$RunId" -or
        $record.stage -notin @('PREPARING','RUNNING','FINALIZING','FINISHED','INTERRUPTED','RECOVERED') -or
        $record.launched -isnot [bool] -or $record.finalized -isnot [bool] -or $record.exitKnown -isnot [bool] -or
        $record.stopHandled -isnot [bool] -or $record.artifacts -isnot [Collections.IDictionary] -or
        ($null -ne $record.factsPath -and $record.factsPath -isnot [string]) -or
        ($record.launched -and $null -eq $record.child) -or $record.owner -isnot [Collections.IDictionary] -or
        ($record.owner.pid -isnot [long] -and $record.owner.pid -isnot [int]) -or
        $record.owner.pid -le 0 -or ($record.owner.createdUtc -isnot [string] -and $record.owner.createdUtc -isnot [datetime])) {
        throw "Invalid or incompatible run record: $RunId"
    }
    [void]([datetime]$record.owner.createdUtc)
    foreach ($identity in @($record.child, $record.helper)) {
        if ($null -eq $identity) { continue }
        if ($identity -isnot [Collections.IDictionary] -or ($identity.pid -isnot [long] -and $identity.pid -isnot [int]) -or
            $identity.pid -le 0 -or ($identity.createdUtc -isnot [string] -and $identity.createdUtc -isnot [datetime])) { throw "Invalid child identity: $RunId" }
        [void]([datetime]$identity.createdUtc)
    }
    return $record
}

function Get-ProcessIdentityState {
    param($Identity)
    if ($null -eq $Identity) { return 'DEAD' }
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$Identity.pid)
        try {
            if ($process.HasExited) { return 'DEAD' }
            $actual = $process.StartTime.ToUniversalTime().Ticks
            $expected = ([datetime]$Identity.createdUtc).ToUniversalTime().Ticks
            if ($actual -eq $expected) { return 'ALIVE' }
            return 'DEAD'
        } finally { $process.Dispose() }
    } catch [ArgumentException] { return 'DEAD' }
    catch { return 'UNKNOWN' }
}

function Get-RunObservation {
    param($Context, $Record)
    $owner = Get-ProcessIdentityState $Record.owner
    $child = Get-ProcessIdentityState $Record.child
    $helper = Get-ProcessIdentityState $Record.helper
    $jobCount = $null
    $errors = @()
    try { $jobCount = [DshBridge.OwnedRun]::Inspect($Record.jobName) + [DshBridge.OwnedRun]::Inspect($Record.jobName + '-helper') }
    catch { $errors += $_.Exception.Message }
    $state = 'UNKNOWN'
    if ($owner -eq 'UNKNOWN' -or $child -eq 'UNKNOWN' -or $helper -eq 'UNKNOWN' -or $null -eq $jobCount) { $state = 'UNKNOWN' }
    elseif ($Record.stage -in @('FINISHED','RECOVERED') -and $child -eq 'DEAD' -and $helper -eq 'DEAD' -and $jobCount -eq 0) { $state = $Record.stage }
    elseif ($owner -eq 'ALIVE') { $state = 'ACTIVE' }
    elseif ($child -eq 'ALIVE' -or $helper -eq 'ALIVE' -or $jobCount -gt 0) { $state = 'ORPHANED' }
    elseif ($Record.stage -in @('FINISHED','RECOVERED')) { $state = $Record.stage }
    else { $state = 'INTERRUPTED' }
    return [ordered]@{
        runId = $Record.runId; state = $state; stage = $Record.stage
        outcome = $Record.outcome
        owner = $owner; child = $child; helper = $helper; ownedProcessCount = $jobCount
        startedAt = $Record.startedAt; heartbeatAt = $Record.heartbeatAt
        lastActivityAt = $Record.lastActivityAt
        requestedSession = $Record.requestedSession; observedSession = $Record.observedSession
        sessionProvenance = $(if ($Record.observedSession) { 'EVENT' } elseif ($Record.requestedSession) { 'REQUESTED_FALLBACK' } else { $null })
        artifacts = $Record.artifacts; diagnostic = $Record.diagnostic; errors = $errors
        recoverable = ($state -in @('INTERRUPTED','FINISHED','RECOVERED'))
    }
}

function Read-ActiveRun {
    param($Context)
    if (-not [IO.File]::Exists($Context.Active)) { return $null }
    $active = Read-RunJson $Context $Context.Active
    if ($active -isnot [Collections.IDictionary] -or $active.runId -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$') {
        throw 'Corrupt execution ownership record; preserve it and inspect before repair.'
    }
    return [string]$active.runId
}

function Get-AllRunIds {
    param($Context)
    if (-not [IO.Directory]::Exists($Context.Runs)) { return }
    $count = 0
    foreach ($path in [IO.Directory]::EnumerateFiles($Context.Runs, '*.json')) {
        if (++$count -gt 5000) { throw 'Run scan exceeds 5000 records; archive reviewed terminal evidence before continuing.' }
        [IO.Path]::GetFileNameWithoutExtension($path)
    }
}

function Start-RunRecord {
    param($Context, [string]$RunId, [string]$Design, [string]$Session, [int]$TimeoutMinutes)
    $guard = Enter-RunGuard $Context
    try {
        $active = Read-ActiveRun $Context
        if ($active) { throw "Repository is occupied by run $active. Use dsh-run.ps1 -Action Status or Scan; explicitly Recover only after the old execution has stopped." }
        foreach ($id in @(Get-AllRunIds $Context)) {
            $previous = Read-RunRecord $Context $id
            $observation = Get-RunObservation $Context $previous
            if ($observation.state -notin @('FINISHED','RECOVERED')) { throw "Unresolved run $id ($($observation.state)); use dsh-run.ps1 -Action Scan and explicit Recover before launching." }
        }
        $path = Get-RunRecordPath $Context $RunId
        if ([IO.File]::Exists($path)) { throw 'Run ID already exists.' }
        $self = [Diagnostics.Process]::GetCurrentProcess()
        try { $identity = @{ pid = $PID; createdUtc = $self.StartTime.ToUniversalTime().ToString('o') } }
        finally { $self.Dispose() }
        $record = [ordered]@{
            schemaVersion = 1; runId = $RunId; repo = $Context.Repo; design = $Design
            stage = 'PREPARING'; owner = $identity; child = $null; helper = $null
            jobName = "Local\DshBridge-$($Context.Key)-$RunId"
            startedAt = Get-RunUtc; heartbeatAt = Get-RunUtc; lastActivityAt = $null; completedAt = $null
            requestedSession = $Session; observedSession = $null; timeoutMinutes = $TimeoutMinutes
            launched = $false; finalized = $false; outcome = $null; artifacts = @{}; factsPath = $null; exitKnown = $false
            diagnostic = $null; recovery = $null; stop = $null; stopHandled = $false
        }
        Write-RunJson $Context $path $record
        Write-RunJson $Context $Context.Active @{ runId = $RunId }
        return $record
    } finally { $guard.Dispose() }
}

function Save-RunRecord {
    param($Context, $Record)
    $guard = Enter-RunGuard $Context
    try {
        if ((Read-ActiveRun $Context) -cne $Record.runId) { throw 'Run ownership changed; refusing stale update.' }
        $current = Read-RunRecord $Context $Record.runId
        $Record.stop = $current.stop
        Write-RunJson $Context (Get-RunRecordPath $Context $Record.runId) $Record
    } finally { $guard.Dispose() }
}

function Finish-RunRecord {
    param($Context, $Record, [string]$Diagnostic)
    $guard = Enter-RunGuard $Context
    try {
        if ((Read-ActiveRun $Context) -cne $Record.runId) { throw 'Run ownership changed; refusing stale release.' }
        $current = Read-RunRecord $Context $Record.runId
        $Record.stop = $current.stop
        $child = Get-ProcessIdentityState $Record.child
        $helper = Get-ProcessIdentityState $Record.helper
        $count = [DshBridge.OwnedRun]::Inspect($Record.jobName) + [DshBridge.OwnedRun]::Inspect($Record.jobName + '-helper')
        $Record.diagnostic = $Diagnostic; $Record.completedAt = Get-RunUtc
        if ($child -ne 'DEAD' -or $helper -ne 'DEAD' -or $count -ne 0) {
            $Record.stage = 'INTERRUPTED'
            $Record.diagnostic = "Owned processes not confirmed stopped; ownership retained. $Diagnostic"
            Write-RunJson $Context (Get-RunRecordPath $Context $Record.runId) $Record
            return
        }
        if ($Record.launched -and -not $Record.finalized) {
            $Record.stage = 'INTERRUPTED'
            $Record.outcome = 'FAILED'
            Write-RunJson $Context (Get-RunRecordPath $Context $Record.runId) $Record
            return
        }
        if (-not $Record.finalized) { $Record.outcome = 'LAUNCH_FAILED' }
        $Record.stage = 'FINISHED'
        Write-RunJson $Context (Get-RunRecordPath $Context $Record.runId) $Record
        [IO.File]::Delete((Assert-RunPath $Context $Context.Active))
    } finally { $guard.Dispose() }
}

function Invoke-RunHelper {
    param($Context, $Record, [string]$Executable, [string[]]$Arguments, [switch]$UnderGuard, [int]$TimeoutSeconds = 120)
    $prefix = Join-Path $Context.Control ($Record.runId + '-helper')
    $inputFile = Assert-RunPath $Context ($prefix + '-stdin.txt')
    $outputFile = Assert-RunPath $Context ($prefix + '-stdout.log')
    $errorFile = Assert-RunPath $Context ($prefix + '-stderr.log')
    [IO.File]::WriteAllText($inputFile, '')
    $ownedHelper = $null
    try {
        $ownedHelper = [DshBridge.OwnedRun]::new(($Record.jobName + '-helper'), $Executable, $Arguments, $Context.Repo, $inputFile, $outputFile, $errorFile)
        $Record.helper = @{ pid = $ownedHelper.Pid; createdUtc = $ownedHelper.CreatedUtc }
        if ($UnderGuard) { Write-RunJson $Context (Get-RunRecordPath $Context $Record.runId) $Record }
        else { Save-RunRecord $Context $Record }
        if (-not $UnderGuard -and $Record.stop -and -not $Record.stopHandled) {
            throw 'Execution stopped explicitly before the preparation/report helper resumed.'
        }
        $ownedHelper.Resume()
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $lastHeartbeat = -2000
        while (-not $ownedHelper.Exited) {
            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'Run preparation/report helper timed out.' }
            if ($timer.ElapsedMilliseconds - $lastHeartbeat -ge 2000) {
                $Record.heartbeatAt = Get-RunUtc
                if ($UnderGuard) { Write-RunJson $Context (Get-RunRecordPath $Context $Record.runId) $Record }
                else {
                    Save-RunRecord $Context $Record
                    if ($Record.stop -and -not $Record.stopHandled) { throw 'Execution stopped explicitly during preparation/finalization.' }
                }
                $lastHeartbeat = $timer.ElapsedMilliseconds
            }
            Start-Sleep -Milliseconds 50
        }
        $code = $ownedHelper.ExitCode
        if ($ownedHelper.ActiveCount -gt 0) { $ownedHelper.Terminate() }
        $wait = [Diagnostics.Stopwatch]::StartNew()
        while ($ownedHelper.ActiveCount -gt 0 -and $wait.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
        if ($ownedHelper.ActiveCount -gt 0) { throw 'Reporting helper processes have not stopped.' }
        $output = [IO.File]::ReadAllText($outputFile) + [IO.File]::ReadAllText($errorFile)
        return @{ ExitCode = $code; Output = $output.Trim() }
    } finally {
        if ($ownedHelper) { $ownedHelper.Dispose() }
    }
}
