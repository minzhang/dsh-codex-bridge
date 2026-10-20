#Requires -Version 7.0

<#
.SYNOPSIS
  Hand one implementation task to DeepSeek Harness (`dsh headless`) and report the result.

.DESCRIPTION
  The bridge for a two-agent workflow: an architect agent (Codex) writes a design
  document, this script turns it into one non-interactive dsh run, and the final
  message plus the working-tree diff come back for review.

  Every run writes a unique set of files under <repo>/<OutDir>:
    <run>-prompt.md      the exact prompt sent to dsh
    <run>-patch.yml      the per-run agent-default-model overlay passed with --patch
    <run>-events.jsonl   the --json event stream (session, tool_call, tool_result, final)
    <run>-report.md      a reviewer-oriented summary generated from the canonical result
    <run>-result.json    the canonical machine-readable result (schemaVersion 1)
    <run>-final.txt      the raw implementer final message (untrusted)
    <run>-inventory-before.json / <run>-inventory-after.json
                         file metadata captured for working-tree observations
    <run>-stderr.log     dsh stderr
  where <run> is a timestamp plus a unique suffix. The result contract separates process
  outcome, implementer claims, report validity and independent acceptance; a completed
  process is never by itself acceptance.

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

.PARAMETER MaxObjects
  Maximum object count for the Windows sandbox preflight, including nested folders
  and metadata. Default 28000; 0 explicitly disables the count cap. Any nonnegative
  Int32 is accepted; larger repositories need a larger value and proportionate
  time and memory. The value is passed to setup.ps1 -Action Check.

.PARAMETER Config
  Configuration file for this run. Relative paths resolve against the repository
  root. The implicit file is bridge.config.json beside this script; when both are
  absent, built-in defaults are used. An explicitly supplied missing file fails.

.PARAMETER ReasoningEffort
  Reasoning effort: off, low, high, or max (case-insensitive). Overrides the
  configuration file. Canonical effective values are lower-case.

.PARAMETER CodexReviewEdits
  Post-review Codex edit policy: 'Not Allow' or 'Allow' (case-insensitive).
  Overrides the configuration file. Defaults to 'Not Allow'.

.PARAMETER DryRun
  Print the resolved settings, composed prompt, generated patch, and dsh command,
  but do not run dsh or the Windows sandbox preflight.

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
    [int]$MaxObjects = 28000,
    [string]$Dsh = '',
    [string]$Config = '',
    [string]$ReasoningEffort = '',
    [string]$CodexReviewEdits = '',
    [switch]$DryRun,
    [switch]$SkipWindowsPreflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($MaxObjects -lt 0) {
    throw '-MaxObjects must be a nonnegative Int32 (0 explicitly disables the count limit).'
}

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

function Resolve-ReportHelper {
    param([string]$BridgeRoot)

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw @'
Node.js runtime not found. The bridge uses the bundled node/run-report.mjs reporting
helper (and Node 22.14+ is a documented prerequisite). Install Node.js or put node on
PATH, then re-run the bridge.
'@
    }
    $helper = Join-Path $BridgeRoot 'node\run-report.mjs'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        throw "Report helper not found: $helper"
    }
    return @{
        Node = $nodeCommand.Source
        Helper = (Resolve-Path -LiteralPath $helper).Path
    }
}

function Invoke-ReportHelper {
    param(
        [string]$NodePath,
        [string]$HelperPath,
        [string[]]$HelperArguments
    )

    # A caller may set NODE_OPTIONS for its own child-process fixtures; the reporting
    # helper must run as plain Node, so hide that setting only for this invocation.
    $previousNodeOptions = $env:NODE_OPTIONS
    $exitCode = 1
    try {
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
        $output = @(& $NodePath $HelperPath @HelperArguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        if ($null -ne $previousNodeOptions) { $env:NODE_OPTIONS = $previousNodeOptions }
    }
    $text = @($output | ForEach-Object { [string]$_ }) -join "`n"
    return @{ ExitCode = [int]$exitCode; Output = $text }
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

function Convert-ReasoningEffortSetting {
    param([string]$Value, [string]$Label)

    $canonical = @{
        'off'  = 'off'
        'low'  = 'low'
        'high' = 'high'
        'max'  = 'max'
    }
    $candidate = $Value.Trim()
    if (-not $canonical.ContainsKey($candidate)) {
        throw "$Label must be one of: off, low, high, max."
    }
    return $canonical[$candidate]
}

function Convert-CodexReviewEditsSetting {
    param([string]$Value, [string]$Label)

    $canonical = @{
        'not allow' = 'Not Allow'
        'allow'     = 'Allow'
    }
    $candidate = $Value.Trim()
    if (-not $canonical.ContainsKey($candidate)) {
        throw "$Label must be 'Not Allow' or 'Allow'."
    }
    return $canonical[$candidate]
}

function Resolve-BridgeConfigPath {
    param(
        [bool]$Explicit,
        [string]$Path,
        [string]$RepoRoot
    )

    if ($Explicit) {
        if ([string]::IsNullOrWhiteSpace($Path)) {
            throw 'Configuration path (-Config) must not be empty.'
        }
        $candidate = if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $RepoRoot $Path }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Configuration file not found: $candidate"
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    $implicit = Join-Path $PSScriptRoot 'bridge.config.json'
    if (Test-Path -LiteralPath $implicit -PathType Leaf) {
        return (Resolve-Path -LiteralPath $implicit).Path
    }
    return ''
}

function Read-BridgeConfig {
    param([string]$Path)

    try {
        $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
    } catch {
        throw "Configuration file could not be read: $Path"
    }
    try {
        $document = ConvertFrom-Json -InputObject $raw -NoEnumerate -ErrorAction Stop
    } catch {
        throw "Configuration file is not valid JSON: $Path"
    }
    if ($null -eq $document -or $document -isnot [System.Management.Automation.PSCustomObject]) {
        throw "Configuration root must be a JSON object: $Path"
    }

    $known = @('reasoningEffort', 'codexReviewEdits')
    $properties = @($document.PSObject.Properties)
    foreach ($property in $properties) {
        if ($known -cnotcontains $property.Name) {
            throw "Configuration contains an unknown setting '$($property.Name)': $Path"
        }
    }

    $values = @{
        reasoningEffort = $null
        codexReviewEdits = $null
    }
    $effortProperty = @($properties | Where-Object { $_.Name -ceq 'reasoningEffort' } | Select-Object -First 1)
    if ($effortProperty.Count -gt 0) {
        $effortValue = $effortProperty[0].Value
        if ($null -eq $effortValue -or $effortValue -isnot [string]) {
            throw "Configuration setting 'reasoningEffort' must be a string: $Path"
        }
        $values.reasoningEffort = Convert-ReasoningEffortSetting -Value $effortValue -Label "Configuration setting 'reasoningEffort'"
    }
    $policyProperty = @($properties | Where-Object { $_.Name -ceq 'codexReviewEdits' } | Select-Object -First 1)
    if ($policyProperty.Count -gt 0) {
        $policyValue = $policyProperty[0].Value
        if ($null -eq $policyValue -or $policyValue -isnot [string]) {
            throw "Configuration setting 'codexReviewEdits' must be a string: $Path"
        }
        $values.codexReviewEdits = Convert-CodexReviewEditsSetting -Value $policyValue -Label "Configuration setting 'codexReviewEdits'"
    }

    return $values
}

# --------------------------------------------------------------------------- resolve inputs

$configWasSpecified = $PSBoundParameters.ContainsKey('Config')
$reasoningWasSpecified = $PSBoundParameters.ContainsKey('ReasoningEffort')
$reviewPolicyWasSpecified = $PSBoundParameters.ContainsKey('CodexReviewEdits')
$reasoningEffortParameter = $ReasoningEffort
$codexReviewEditsParameter = $CodexReviewEdits

$repoRoot = Resolve-RepoRoot -Hint $Repo

$builtinReasoningEffort = 'max'
$builtinCodexReviewEdits = 'Not Allow'
$configPath = Resolve-BridgeConfigPath -Explicit $configWasSpecified -Path $Config -RepoRoot $repoRoot
$configValues = @{ reasoningEffort = $null; codexReviewEdits = $null }
if ($configPath) {
    $configValues = Read-BridgeConfig -Path $configPath
}

$reasoningEffort = $builtinReasoningEffort
$reasoningEffortSource = 'built-in default'
if ($configValues.reasoningEffort) {
    $reasoningEffort = $configValues.reasoningEffort
    $reasoningEffortSource = $configPath
}
if ($reasoningWasSpecified) {
    $reasoningEffort = Convert-ReasoningEffortSetting -Value $reasoningEffortParameter -Label '-ReasoningEffort'
    $reasoningEffortSource = 'command line'
}

$codexReviewEdits = $builtinCodexReviewEdits
$codexReviewEditsSource = 'built-in default'
if ($configValues.codexReviewEdits) {
    $codexReviewEdits = $configValues.codexReviewEdits
    $codexReviewEditsSource = $configPath
}
if ($reviewPolicyWasSpecified) {
    $codexReviewEdits = Convert-CodexReviewEditsSetting -Value $codexReviewEditsParameter -Label '-CodexReviewEdits'
    $codexReviewEditsSource = 'command line'
}

$configSource = if (-not $configPath) {
    'built-in defaults'
}
elseif ($configWasSpecified) {
    "$configPath (explicit)"
}
else {
    "$configPath (implicit)"
}

$dshPath = Resolve-Dsh -Explicit $Dsh

$specPath = if ([IO.Path]::IsPathRooted($Spec)) { $Spec } else { Join-Path $repoRoot $Spec }
if (-not (Test-Path -LiteralPath $specPath -PathType Leaf)) {
    throw "Design document not found: $specPath"
}
$specPath = (Resolve-Path -LiteralPath $specPath).Path
$design = [IO.File]::ReadAllText($specPath, [Text.UTF8Encoding]::new($false))

$relativeSpec = [IO.Path]::GetRelativePath($repoRoot, $specPath)

$reportRuntime = Resolve-ReportHelper -BridgeRoot $PSScriptRoot
$helperManifest = Invoke-ReportHelper -NodePath $reportRuntime.Node -HelperPath $reportRuntime.Helper `
    -HelperArguments @('manifest', '--design', $specPath)
if ($helperManifest.ExitCode -ne 0) {
    throw "Design acceptance manifest is invalid: $($helperManifest.Output.Trim())"
}
try {
    $acceptanceManifest = $helperManifest.Output.Trim() | ConvertFrom-Json -ErrorAction Stop
}
catch {
    throw 'Design acceptance manifest could not be read from the reporting helper.'
}
if ($null -eq $acceptanceManifest -or -not $acceptanceManifest.PSObject.Properties['declared']) {
    throw 'Design acceptance manifest helper returned an unexpected result.'
}

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
        $preflight = @(& $pwshExe -NoProfile -NonInteractive -File $setupScript -Repo $repoRoot -Action Check -MaxObjects $MaxObjects 2>&1)
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

$modelConfigText = "Model selection for this invocation: provider deepseek-official, model deepseek-flash, reasoningEffort $reasoningEffort. This selection is supplied through a temporary --patch overlay; do not edit user profiles, credentials, authentication or settings."
$codexPolicyText = @'
Codex review policy for this run: <POLICY>.
Under Not Allow, Codex reviews and runs checks, records findings, and delegates production fixes and test additions to this same DSH session. Under Allow, Codex may make only small, localized fixes tied to a recorded review finding and a few focused regression/acceptance cases for that finding; Codex records what it changed and independently runs the relevant checks. Feature implementation, large refactors, dependency changes and broad test-suite work stay with DSH. Codex never weakens existing assertions or counts the same self-review as independent acceptance. This is a collaboration instruction, not an OS/security sandbox; it does not grant publication or unrelated permissions. Existing explicit user instructions take priority. Neither setting changes DSH's role or grants DSH commit/publication permission.
'@.Replace('<POLICY>', $codexReviewEdits)

$promptTemplate = @'
You are the implementation agent in a two-agent workflow. An architect agent wrote the design below; you implement it. No human is watching this run.

Repository root: <REPO>
Design document: <SPEC> (authoritative, read-only)

========== DESIGN ==========
<DESIGN>
========== END DESIGN ==========

Extra instructions for this round:
<TASK>

Run configuration:
<MODEL_CONFIG>

<CODEX_POLICY>

<WINDOWS_SANDBOX_NOTE>

Operating rules (non-negotiable):
- This is a non-interactive run. Never call ask_user_question, never wait for approval, never ask a human to confirm anything. If the design leaves a material decision open, stop and return the JSON report with status "BLOCKED" and exact questions in summary or followUps. Do not guess on product behavior.
- Work only inside the repository root. Read the existing code before changing it.
- Do not commit, do not push, do not create or switch branches, do not amend or rewrite history. Leave every change in the working tree for review.
- Do not modify the design document.
- Keep the diff focused: implement what the design requires. No opportunistic refactors, no formatting-only churn, no new dependencies unless the design names them.
- Run the acceptance checks the design names. If it names none, run the repository's own test and lint commands for the code you touched, and report exactly what you ran.

Final report format (your last message must be exactly one JSON object, with no Markdown fences):
{
  "schemaVersion": 1,
  "status": "DONE",
  "summary": "Concrete result ready for review",
  "changes": [{"path": "relative/file", "description": "What changed"}],
  "checks": [{
    "id": "A1",
    "command": "actual command",
    "cwd": ".",
    "status": "PASS",
    "exitCode": 0,
    "logPath": ".dsh-runs/checks/a1.log",
    "reason": ""
  }],
  "decisions": [],
  "followUps": []
}

JSON report rules:
- schemaVersion is numeric 1. status is DONE, BLOCKED or PARTIAL. Every key shown above is required; changes, checks, decisions and followUps may be empty arrays.
- Check status is PASS, FAIL, NOT_RUN or BLOCKED. PASS requires exitCode 0. FAIL requires a nonzero integer exitCode. NOT_RUN and BLOCKED require exitCode null and a nonempty reason. Check IDs must be unique and nonempty.
- cwd is a repository-relative directory. Paths, including logPath, must stay inside the repository. logPath is a repository-relative file or null. Save real command logs and use them; a null log is reported as NOT_PROVIDED and a missing or unsafe log is reported as MISSING or UNSAFE.
- If the design declares acceptance checks, include every declared check ID in checks with the declared command and cwd. Only surrounding whitespace may differ for a command; cwd may also use either slash style. Do not rewrite command arguments, quoted text or URLs. Include unrun or blocked checks with NOT_RUN or BLOCKED and a reason instead of omitting them. Extra checks are allowed and are marked additional. DONE with a declared check that is missing, not run, blocked, failing, or without a safe log is invalid.
- BLOCKED requires a nonempty summary or followUp describing the blocker.
- The bridge annotates source and log availability itself; do not add those fields. The bridge never runs commands from your report and never treats log existence as test evidence.
- Working-tree observations are taken by the bridge before and after the run. Do not claim causal attribution to DSH; keep your changed-file claims in changes.
- A legacy STATUS: DONE/BLOCKED/PARTIAL prose response is invalid and is retained only as raw diagnostic text.
'@

$prompt = $promptTemplate.Replace('<REPO>', $repoRoot).
    Replace('<SPEC>', $relativeSpec).
    Replace('<DESIGN>', $design.Trim()).
    Replace('<TASK>', $taskBlock).
    Replace('<MODEL_CONFIG>', $modelConfigText).
    Replace('<CODEX_POLICY>', $codexPolicyText.Trim()).
    Replace('<WINDOWS_SANDBOX_NOTE>', $windowsSandboxNote.Trim())

# --------------------------------------------------------------------------- prepare outputs

$utf8 = [Text.UTF8Encoding]::new($false)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runName = "$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$runDir = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $repoRoot $OutDir }
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
# Keep the artifact directory out of the repository's diff without editing the user's .gitignore.
$ignoreFile = Join-Path $runDir '.gitignore'
if (-not (Test-Path -LiteralPath $ignoreFile)) {
    [IO.File]::WriteAllText($ignoreFile, "*`n", $utf8)
}

$promptFile = Join-Path $runDir "$runName-prompt.md"
$streamFile = Join-Path $runDir "$runName-events.jsonl"
$errFile = Join-Path $runDir "$runName-stderr.log"
$reportFile = Join-Path $runDir "$runName-report.md"
$patchFile = Join-Path $runDir "$runName-patch.yml"
$resultFile = Join-Path $runDir "$runName-result.json"
$finalFile = Join-Path $runDir "$runName-final.txt"
$inventoryBeforeFile = Join-Path $runDir "$runName-inventory-before.json"
$inventoryAfterFile = Join-Path $runDir "$runName-inventory-after.json"
$factsFile = Join-Path $runDir "$runName-result-input.json"
$patchYaml = @(
    '- id: agent-default-model'
    '  config:'
    '    provider: deepseek-official'
    '    model: deepseek-flash'
    "    reasoningEffort: $reasoningEffort"
) -join "`n"
[IO.File]::WriteAllText($promptFile, $prompt, $utf8)
[IO.File]::WriteAllText($streamFile, '', $utf8)
[IO.File]::WriteAllText($errFile, '', $utf8)
[IO.File]::WriteAllText($patchFile, $patchYaml + "`n", $utf8)

$dshArgs = @('headless', '--patch', $patchFile, '--json')
if ($Session) { $dshArgs += @('--session-id', $Session) }
$dshArgs += '-'

$displayDsh = if ($dshPath -match '\s') { '"' + $dshPath + '"' } else { $dshPath }
$displayArgs = @($dshArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })

if ($DryRun) {
    Write-Output '# resolved configuration'
    Write-Output 'model: deepseek-official/deepseek-flash'
    Write-Output "reasoning effort: $reasoningEffort (source: $reasoningEffortSource)"
    Write-Output "codex review edits: $codexReviewEdits (source: $codexReviewEditsSource)"
    Write-Output "configuration: $configSource"
    Write-Output "preflight object limit: $MaxObjects"
    Write-Output "patch: $patchFile"
    Write-Output ''
    Write-Output "# dsh command"
    Write-Output ("{0} {1}" -f $displayDsh, ($displayArgs -join ' '))
    Write-Output ''
    Write-Output "# prompt ($promptFile)"
    Write-Output $prompt
    return
}

# --------------------------------------------------------------------------- observe before

$inventoryErrors = @()
$beforeInventoryResult = Invoke-ReportHelper -NodePath $reportRuntime.Node -HelperPath $reportRuntime.Helper `
    -HelperArguments @('inventory', '--root', $repoRoot, '--out', $inventoryBeforeFile)
if ($beforeInventoryResult.ExitCode -ne 0) {
    $inventoryErrors += "before inventory failed: $($beforeInventoryResult.Output.Trim())"
}
else {
    try {
        $beforeInventory = [IO.File]::ReadAllText($inventoryBeforeFile, $utf8) | ConvertFrom-Json -ErrorAction Stop
        if ($beforeInventory.status -eq 'OBSERVED' -and @($beforeInventory.paths).Count -gt 0) {
            Write-Warning ("Working tree already has {0} changed path(s) before this run; they will be classified as PREEXISTING_* observations, not attributed to DSH." -f @($beforeInventory.paths).Count)
        }
    }
    catch {
        $inventoryErrors += 'before inventory could not be parsed'
    }
}

$dshProcessesBefore = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$startedAt = Get-Date

# --------------------------------------------------------------------------- run dsh

$env:DSH_PERMISSION_MODE = $Mode

# dsh resolves its workspace from the process working directory, so run from the repo root.
Set-Location -LiteralPath $repoRoot

$timedOut = $false
$launchFailed = $false
$exitCode = $null
$jobState = 'Unknown'
$captureErrors = @()
$job = $null
try {
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
}
catch {
    $launchFailed = $true
    $jobState = 'Failed'
    $captureErrors += "could not start dsh process: $($_.Exception.Message)"
}

if ($job) {
    if (-not (Wait-Job -Job $job -Timeout ($TimeoutMinutes * 60))) {
        $timedOut = $true
        Stop-Job -Job $job
        [void](Stop-OrphanDsh -Since $startedAt -Preexisting $dshProcessesBefore)
        $jobState = [string]$job.State
        $exitCode = $null
    }
    else {
        $received = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
        $jobState = [string]$job.State
        foreach ($jobError in @($job.ChildJobs | ForEach-Object { $_.Error } | ForEach-Object { [string]$_ } | Where-Object { $_ })) {
            $captureErrors += $jobError
        }
        $receivedValues = @($received | Where-Object { $null -ne $_ })
        if ($receivedValues.Count -gt 0) {
            $exitCode = [int]($receivedValues | Select-Object -Last 1)
        }
        if ($null -eq $exitCode -or $jobState -eq 'Failed') {
            $launchFailed = $true
        }
    }
    Remove-Job -Job $job -Force | Out-Null
}
$completedAt = Get-Date

# --------------------------------------------------------------------------- observe after

$afterInventoryArguments = @('inventory', '--root', $repoRoot, '--out', $inventoryAfterFile)
if (Test-Path -LiteralPath $inventoryBeforeFile -PathType Leaf) {
    $afterInventoryArguments += @('--include', $inventoryBeforeFile)
}
$afterInventoryResult = Invoke-ReportHelper -NodePath $reportRuntime.Node -HelperPath $reportRuntime.Helper `
    -HelperArguments $afterInventoryArguments
if ($afterInventoryResult.ExitCode -ne 0) {
    $inventoryErrors += "after inventory failed: $($afterInventoryResult.Output.Trim())"
}

# --------------------------------------------------------------------------- canonical result

$settings = [ordered]@{
    mode = $Mode
    model = 'deepseek-official/deepseek-flash'
    reasoningEffort = $reasoningEffort
    reasoningEffortSource = $reasoningEffortSource
    codexReviewEdits = $codexReviewEdits
    codexReviewEditsSource = $codexReviewEditsSource
    configuration = $configSource
    preflightObjectLimit = $MaxObjects
    timeoutMinutes = $TimeoutMinutes
}
$facts = [ordered]@{
    schemaVersion = 1
    runId = $runName
    repoRoot = $repoRoot
    designPath = $relativeSpec
    startedAt = $startedAt.ToUniversalTime().ToString('o')
    completedAt = $completedAt.ToUniversalTime().ToString('o')
    exitCode = $(if ($null -ne $exitCode) { [int]$exitCode } else { $null })
    timedOut = $timedOut
    launchFailed = $launchFailed
    jobState = $jobState
    captureErrors = @($captureErrors)
    requestedSession = $Session
    manifest = $acceptanceManifest
    settings = $settings
    inventoryErrors = @($inventoryErrors)
    artifacts = [ordered]@{
        prompt = $promptFile
        patch = $patchFile
        events = $streamFile
        stderr = $errFile
        report = $reportFile
        result = $resultFile
        finalText = $finalFile
        inventoryBefore = $inventoryBeforeFile
        inventoryAfter = $inventoryAfterFile
    }
}
try {
    [IO.File]::WriteAllText($factsFile, ($facts | ConvertTo-Json -Depth 20), $utf8)
}
catch {
    Write-Output "result-error: could not write reporting input: $($_.Exception.Message)"
    Write-Output "artifacts: prompt $promptFile | patch $patchFile | events $streamFile | stderr $errFile"
    exit 1
}

$finalize = Invoke-ReportHelper -NodePath $reportRuntime.Node -HelperPath $reportRuntime.Helper `
    -HelperArguments @('finalize', '--input', $factsFile)
if ($finalize.ExitCode -ne 0) {
    Write-Output "result-error: reporting failed: $($finalize.Output.Trim())"
    if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
        $resultRelative = [IO.Path]::GetRelativePath($repoRoot, $resultFile) -replace '\\', '/'
        Write-Output "result: $resultRelative"
    }
    Write-Output "artifacts: prompt $promptFile | patch $patchFile | events $streamFile | stderr $errFile | report $reportFile | final $finalFile"
    exit 1
}
try {
    $finalizePayload = $finalize.Output.Trim() | ConvertFrom-Json -ErrorAction Stop
}
catch {
    Write-Output 'result-error: reporting helper returned unreadable output'
    if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
        $resultRelative = [IO.Path]::GetRelativePath($repoRoot, $resultFile) -replace '\\', '/'
        Write-Output "result: $resultRelative"
    }
    Write-Output "artifacts: prompt $promptFile | patch $patchFile | events $streamFile | stderr $errFile | report $reportFile | final $finalFile"
    exit 1
}

# --------------------------------------------------------------------------- stdout for the caller

Write-Output "repo-root: $repoRoot"
foreach ($summaryLine in @($finalizePayload.summaryLines)) {
    Write-Output ([string]$summaryLine)
}

$rawFinalText = ''
if (Test-Path -LiteralPath $finalFile -PathType Leaf) {
    $rawFinalText = [IO.File]::ReadAllText($finalFile, $utf8)
}

Write-Output ''
Write-Output '--- implementer final message (raw, untrusted; not acceptance) ---'
if ($rawFinalText.Trim()) {
    Write-Output $rawFinalText.Trim()
}
else {
    Write-Output '(no final message captured; see the result and stderr artifacts)'
}

try { Remove-Item -LiteralPath $factsFile -Force -ErrorAction SilentlyContinue } catch { }

exit ([int]$finalizePayload.bridgeExitCode)
