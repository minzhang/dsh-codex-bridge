#Requires -Version 7.0
<#
.SYNOPSIS
  Hand one implementation task to DeepSeek Harness (`dsh headless`) and report the result.

.DESCRIPTION
  The bridge for a two-agent workflow: an architect agent (Codex) writes a design
  document, this script turns it into one non-interactive dsh run, and the final
  message plus the working-tree diff come back for review.

  Every run writes three files under <repo>/<OutDir>:
    <stamp>-prompt.md    the exact prompt sent to dsh
    <stamp>-events.jsonl the --json event stream (session, tool_call, tool_result, final)
    <stamp>-report.md    a reviewer-oriented summary
  and one stderr log: <stamp>-stderr.log

.PARAMETER Spec
  Path to the design document. Relative paths resolve against the repository root.

.PARAMETER Task
  Extra instructions for this round (e.g. "round 2: the reviewer found X").

.PARAMETER Session
  Continue an existing dsh session id (from a previous run's report/stdout).

.PARAMETER Mode
  DSH permission mode: workspace-write (default), read-only, danger-full-access.

.PARAMETER TimeoutMinutes
  Hard wall-clock limit. On expiry the run and any dsh process it started are killed.

.PARAMETER DryRun
  Print the composed prompt and the dsh command, but do not run dsh or the
  Windows sandbox preflight.

.PARAMETER SkipWindowsPreflight
  Diagnose an unsupported Windows installation by skipping the read-only
  workspace-write sandbox preflight. This does not change the DSH permission mode.

.EXAMPLE
  pwsh -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-auth.md

.EXAMPLE
  pwsh -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-auth.md `
       -Session session-<id-from-report> `
       -Task "Reviewer feedback: keep the old error codes; add the 401 test."
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Spec,

    [string]$Task = '',
    [string]$Session = '',
    [ValidateSet('workspace-write', 'read-only', 'danger-full-access')]
    [string]$Mode = 'workspace-write',
    [string]$Repo = '',
    [string]$OutDir = '.dsh-runs',
    [int]$TimeoutMinutes = 90,
    [string]$Dsh = '',
    [switch]$DryRun,
    [switch]$SkipWindowsPreflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- helpers

function Resolve-RepoRoot {
    param([string]$Hint)

    if ($Hint) {
        $resolved = (Resolve-Path -LiteralPath $Hint).Path
        return (Get-Item -LiteralPath $resolved).FullName
    }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $top = & git rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -eq 0 -and $top) {
            return (Get-Item -LiteralPath $top.Trim()).FullName
        }
    }
    return (Get-Location).Path
}

function Resolve-Dsh {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "dsh launcher not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path -LiteralPath $fallback) { return $fallback }

    throw @'
dsh was not found on PATH. The desktop app installs a launcher at:
  %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
Open a NEW terminal (PATH changes are not visible to already-running shells), or pass -Dsh <path>.
'@
}

function Get-WorkingTreeState {
    param([string]$Root)

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git -or -not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
        return @{ IsGit = $false; Head = ''; Status = @(); DiffStat = '' }
    }
    $head = (& git -C $Root rev-parse --short HEAD 2>$null)
    $status = @(& git -C $Root status --porcelain 2>$null)
    $stat = (& git -C $Root diff --stat 2>$null) -join "`n"
    return @{ IsGit = $true; Head = "$head".Trim(); Status = $status; DiffStat = $stat }
}

function Get-TotalUsage {
    param($Events)

    $inTokens = 0; $outTokens = 0; $seen = $false
    foreach ($event in $Events) {
        if ($event.type -ne 'status' -or $event.phase -ne 'step_end') { continue }
        if (-not $event.PSObject.Properties['usage']) { continue }
        $seen = $true
        if ($event.usage.PSObject.Properties['inputTokens']) { $inTokens += [long]$event.usage.inputTokens }
        if ($event.usage.PSObject.Properties['outputTokens']) { $outTokens += [long]$event.usage.outputTokens }
    }
    if (-not $seen) { return $null }
    return @{ Input = $inTokens; Output = $outTokens }
}

function Stop-OrphanDsh {
    param([datetime]$Since, [int[]]$Preexisting)

    $victims = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $Preexisting -notcontains $_.Id -and $_.StartTime -ge $Since }
    foreach ($victim in $victims) {
        try { Stop-Process -Id $victim.Id -Force -ErrorAction Stop } catch { }
    }
    return @($victims).Count
}

# --------------------------------------------------------------------------- resolve inputs

$repoRoot = Resolve-RepoRoot -Hint $Repo
$dshPath = Resolve-Dsh -Explicit $Dsh

$specPath = if ([IO.Path]::IsPathRooted($Spec)) { $Spec } else { Join-Path $repoRoot $Spec }
if (-not (Test-Path -LiteralPath $specPath -PathType Leaf)) {
    throw "Design document not found: $specPath"
}
$specPath = (Resolve-Path -LiteralPath $specPath).Path
$design = [IO.File]::ReadAllText($specPath, [Text.UTF8Encoding]::new($false))

$relativeSpec = [IO.Path]::GetRelativePath($repoRoot, $specPath)

# --------------------------------------------------------------------------- Windows preflight

$isWindowsHost = [System.OperatingSystem]::IsWindows()
if (-not $DryRun -and $Mode -eq 'workspace-write' -and $isWindowsHost) {
    if ($SkipWindowsPreflight) {
        Write-Warning 'Windows sandbox preflight explicitly skipped (-SkipWindowsPreflight); the DSH permission mode is unchanged.'
    } else {
        $setupScript = Join-Path $PSScriptRoot 'windows\setup.ps1'
        if (-not (Test-Path -LiteralPath $setupScript -PathType Leaf)) {
            Write-Output "windows sandbox preflight: package missing at $setupScript"
            exit 1
        }
        $pwshExe = Join-Path $PSHOME 'pwsh.exe'
        if (-not (Test-Path -LiteralPath $pwshExe -PathType Leaf)) {
            $pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
            if (-not $pwshCommand) {
                Write-Output 'windows sandbox preflight: pwsh was not found.'
                exit 1
            }
            $pwshExe = $pwshCommand.Source
        }
        $preflight = @(& $pwshExe -NoProfile -NonInteractive -File $setupScript -Repo $repoRoot -Action Check 2>&1)
        $preflightExit = $LASTEXITCODE
        if ($preflightExit -ne 0) {
            Write-Output 'windows sandbox preflight: NOT READY'
            foreach ($line in $preflight) { Write-Output ([string]$line) }
            Write-Output 'Fix the repository permissions with the Repair command above, then re-run the bridge.'
            exit 1
        }
        $readyLine = @($preflight | Where-Object { ([string]$_) -match '^RESULT: READY' } | Select-Object -Last 1)
        Write-Output ('windows sandbox preflight: ' + $(if ($readyLine.Count -gt 0) { [string]$readyLine[0] } else { 'READY' }))
    }
}

# --------------------------------------------------------------------------- compose prompt

$taskBlock = if ($Task.Trim()) { $Task.Trim() } else { '(none for this round)' }
$windowsSandboxNote = ''
if ($isWindowsHost -and $Mode -eq 'workspace-write') {
    $windowsSandboxNote = @'
Windows sandbox note: use the project's full sandbox-compatible test command. If a Node worker or piped-stdio setup reports a named-pipe EPERM, that does not justify turning off DSH confinement, dropping tests, or skipping real CLI/subprocess assertions. Use the documented no-isolation or file-backed capture path and report any genuine blocker.
'@
}

$promptTemplate = @'
You are the implementation agent in a two-agent workflow. An architect agent wrote the design below; you implement it. No human is watching this run.

Repository root: <REPO>
Design document: <SPEC> (authoritative, read-only)

========== DESIGN ==========
<DESIGN>
========== END DESIGN ==========

Extra instructions for this round:
<TASK>

<WINDOWS_SANDBOX_NOTE>

Operating rules (non-negotiable):
- This is a non-interactive run. Never call ask_user_question, never wait for approval, never ask a human to confirm anything. If the design leaves a material decision open, stop and print a final report whose first line is `STATUS: BLOCKED` followed by the exact questions. Do not guess on product behavior.
- Work only inside the repository root. Read the existing code before changing it.
- Do not commit, do not push, do not create or switch branches, do not amend or rewrite history. Leave every change in the working tree for review.
- Do not modify the design document.
- Keep the diff focused: implement what the design requires. No opportunistic refactors, no formatting-only churn, no new dependencies unless the design names them.
- Run the acceptance checks the design names. If it names none, run the repository's own test and lint commands for the code you touched, and report exactly what you ran.

Final report format (your last message, plain text, no code fences):
STATUS: DONE | BLOCKED | PARTIAL
CHANGES: one line per file, "path - what changed"
CHECKS: each command you ran, pass/fail, and the one output line that proves it
DECISIONS: choices you made where the design was silent, and why
FOLLOW-UPS: what the reviewer must verify or decide next
'@

$prompt = $promptTemplate.Replace('<REPO>', $repoRoot).
    Replace('<SPEC>', $relativeSpec).
    Replace('<DESIGN>', $design.Trim()).
    Replace('<TASK>', $taskBlock).
    Replace('<WINDOWS_SANDBOX_NOTE>', $windowsSandboxNote.Trim())

# --------------------------------------------------------------------------- prepare outputs

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $repoRoot $OutDir }
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
# Keep the artifact directory out of the repository's diff without editing the user's .gitignore.
$ignoreFile = Join-Path $runDir '.gitignore'
if (-not (Test-Path -LiteralPath $ignoreFile)) {
    [IO.File]::WriteAllText($ignoreFile, "*`n", [Text.UTF8Encoding]::new($false))
}

$promptFile = Join-Path $runDir "$stamp-prompt.md"
$streamFile = Join-Path $runDir "$stamp-events.jsonl"
$errFile = Join-Path $runDir "$stamp-stderr.log"
$reportFile = Join-Path $runDir "$stamp-report.md"
[IO.File]::WriteAllText($promptFile, $prompt, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($streamFile, '', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($errFile, '', [Text.UTF8Encoding]::new($false))

$dshArgs = @('headless', '--json')
if ($Session) { $dshArgs += @('--session-id', $Session) }
$dshArgs += '-'

$utf8 = [Text.UTF8Encoding]::new($false)

if ($DryRun) {
    Write-Output "# dsh command"
    Write-Output ("{0} {1}" -f $dshPath, ($dshArgs -join ' '))
    Write-Output ''
    Write-Output "# prompt ($promptFile)"
    Write-Output $prompt
    return
}

$before = Get-WorkingTreeState -Root $repoRoot
if ($before.IsGit -and $before.Status.Count -gt 0) {
    Write-Warning ("Working tree already has {0} changed path(s) before this run; the run's diff will be mixed with them. HEAD {1}." -f $before.Status.Count, $before.Head)
}

$dshProcessesBefore = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$startedAt = Get-Date

# --------------------------------------------------------------------------- run dsh

$env:DSH_PERMISSION_MODE = $Mode

# dsh resolves its workspace from the process working directory, so run from the repo root.
Set-Location -LiteralPath $repoRoot

$job = Start-Job -ArgumentList $dshPath, $dshArgs, $promptFile, $streamFile, $errFile, $repoRoot -ScriptBlock {
    param($DshPath, $DshArgs, $PromptFile, $StreamFile, $ErrorFile, $RepoRoot)

    $ErrorActionPreference = 'Continue'
    Set-Location -LiteralPath $RepoRoot
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $utf8 = [Text.UTF8Encoding]::new($false)

    $prompt = [IO.File]::ReadAllText($PromptFile, $utf8)
    $prompt | & $DshPath @DshArgs 2> $ErrorFile | Set-Content -LiteralPath $StreamFile -Encoding utf8
    return $LASTEXITCODE
}

$timedOut = $false
if (-not (Wait-Job -Job $job -Timeout ($TimeoutMinutes * 60))) {
    $timedOut = $true
    Stop-Job -Job $job
    [void](Stop-OrphanDsh -Since $startedAt -Preexisting $dshProcessesBefore)
    $exitCode = 124
}
else {
    $received = Receive-Job -Job $job
    $exitCode = if ($null -ne $received) { [int]($received | Select-Object -Last 1) } else { 1 }
}
Remove-Job -Job $job -Force | Out-Null
$duration = (Get-Date) - $startedAt

# --------------------------------------------------------------------------- parse the stream

$events = @()
foreach ($line in [IO.File]::ReadAllLines($streamFile, $utf8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $events += ($line | ConvertFrom-Json -Depth 32) } catch { }
}

$sessionId = ''
$sessionEvent = $events | Where-Object { $_.type -eq 'session' } | Select-Object -First 1
if ($sessionEvent) { $sessionId = $sessionEvent.sessionId }

$finalEvent = $events | Where-Object { $_.type -eq 'final' } | Select-Object -Last 1
$finalText = if ($finalEvent) { [string]$finalEvent.text } else { '' }

$errorEvent = $events | Where-Object { $_.type -eq 'error' } | Select-Object -Last 1
$errorText = if ($errorEvent) { [string]$errorEvent.message } else { '' }

$turnEnd = $events | Where-Object { $_.type -eq 'status' -and $_.phase -eq 'turn_end' } | Select-Object -Last 1
$turnReason = ''
if ($turnEnd -and $turnEnd.PSObject.Properties['reason']) {
    $reason = $turnEnd.reason
    $turnReason = if ($reason.PSObject.Properties['kind']) { [string]$reason.kind } else { "$reason" }
    if ($reason.PSObject.Properties['error'] -and $reason.error.PSObject.Properties['message']) {
        $turnReason = "$turnReason - $($reason.error.message)"
    }
}

$toolCalls = @($events | Where-Object { $_.type -eq 'tool_call' })
$toolFailures = @($events | Where-Object { $_.type -eq 'tool_result' -and $_.status -eq 'error' })
$usage = Get-TotalUsage -Events $events

$after = Get-WorkingTreeState -Root $repoRoot
$runDirName = Split-Path -Leaf $runDir
$changed = @()
if ($after.IsGit) {
    $changed = @($after.Status | Where-Object { $_ -and ($_ -notmatch [regex]::Escape($runDirName)) })
}
else {
    $changed = @($toolCalls | ForEach-Object {
            if ($_.input.PSObject.Properties['path']) { [string]$_.input.path }
            elseif ($_.input.PSObject.Properties['file_path']) { [string]$_.input.file_path }
        } | Where-Object { $_ } | Sort-Object -Unique)
}

# Split out paths that were already dirty before the run, so the reviewer sees only this run's diff.
$beforePaths = @{}
foreach ($line in $before.Status) {
    if ($line -and $line.Length -gt 3) { $beforePaths[$line.Substring(3).Trim()] = $true }
}
$runChanged = @($changed | Where-Object { $_.Length -gt 3 -and -not $beforePaths.ContainsKey($_.Substring(3).Trim()) })

$stderrTail = @()
if (Test-Path -LiteralPath $errFile) {
    $stderrTail = @([IO.File]::ReadAllLines($errFile, $utf8) | Where-Object { $_ } | Select-Object -Last 12)
}

$status = if ($timedOut) { 'TIMEOUT' } elseif ($exitCode -eq 0) { 'COMPLETED' } elseif ($errorText) { 'ERROR' } else { 'FAILED' }

# --------------------------------------------------------------------------- report

$changeLines = if ($runChanged.Count) { ($runChanged | ForEach-Object { "- $_" }) -join "`n" } else { '(no changed paths detected)' }
$preExisting = @($changed | Where-Object { $runChanged -notcontains $_ })
$preExistingLines = if ($preExisting.Count) { ($preExisting | ForEach-Object { "- $_" }) -join "`n" } else { '(none)' }
$usageLine = if ($usage) { "{0:N0} in / {1:N0} out tokens" -f $usage.Input, $usage.Output } else { 'not reported' }
$diagnostics = if ($turnReason) { $turnReason } elseif ($errorText) { $errorText } else { '(none)' }
$stderrBlock = if ($stderrTail.Count) { ($stderrTail -join "`n") } else { '(empty)' }

$report = @"
# dsh implementation run $stamp

| field | value |
|---|---|
| status | $status |
| exit code | $exitCode |
| session | $sessionId |
| design doc | $relativeSpec |
| permission mode | $Mode |
| repo / HEAD before | $repoRoot / $($before.Head) |
| duration | $($duration.ToString('hh\:mm\:ss')) |
| tool calls | $($toolCalls.Count) ($($toolFailures.Count) failed) |
| tokens | $usageLine |
| turn end | $diagnostics |

## Changed by this run

$changeLines

## Pre-existing changes (not this run)

$preExistingLines

## Implementer report

$($finalText.Trim())

## stderr tail

``````
$stderrBlock
``````

Artifacts: ``$([IO.Path]::GetFileName($promptFile))``, ``$([IO.Path]::GetFileName($streamFile))``, ``$([IO.Path]::GetFileName($errFile))``
"@
[IO.File]::WriteAllText($reportFile, $report, $utf8)

# --------------------------------------------------------------------------- stdout for the caller

Write-Output "dsh: $status | exit $exitCode | $($duration.ToString('hh\:mm\:ss')) | $($toolCalls.Count) tool calls | mode $Mode"
if ($sessionId) { Write-Output "session: $sessionId" }
if ($runChanged.Count) { Write-Output "changed by this run: $($runChanged.Count) path(s)" }
if ($preExisting.Count) { Write-Output "pre-existing dirty: $($preExisting.Count) path(s)" }
Write-Output "report: $([IO.Path]::GetRelativePath($repoRoot, $reportFile))"
if ($status -ne 'COMPLETED' -and $diagnostics) { Write-Output "diagnostics: $diagnostics" }
Write-Output ''
Write-Output '--- implementer report ---'
Write-Output $finalText.Trim()
if (-not $finalText.Trim() -and $stderrTail.Count) {
    Write-Output '(no final text; stderr tail below)'
    Write-Output ($stderrTail -join "`n")
}

exit $exitCode
