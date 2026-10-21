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
    [int]$TimeoutMinutes = 180,
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
if ($TimeoutMinutes -lt 0) { throw '-TimeoutMinutes must be nonnegative.' }

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
        if ($script:runRecord -and $script:runContext) {
            return Invoke-RunHelper $script:runContext $script:runRecord $NodePath ([string[]]@($HelperPath) + $HelperArguments)
        }
        $output = @(& $NodePath $HelperPath @HelperArguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        if ($null -ne $previousNodeOptions) { $env:NODE_OPTIONS = $previousNodeOptions }
    }
    $text = @($output | ForEach-Object { [string]$_ }) -join "`n"
    return @{ ExitCode = [int]$exitCode; Output = $text }
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
$runContext = $null
$runRecord = $null
$ownedRun = $null
$runDiagnostic = 'Bridge exited before finalization.'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runName = "$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
try {
if (-not $DryRun) {
    . (Join-Path $PSScriptRoot 'windows/lib/run-lifecycle.ps1')
    $runContext = New-RunContext -Repo $repoRoot -Create
    $repoRoot = $runContext.Repo
    $runRecord = Start-RunRecord $runContext $runName $Spec $Session $TimeoutMinutes
}

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
            throw 'Windows preflight script is missing.'
        }
        $pwshExe = Join-Path $PSHOME 'pwsh.exe'
        if (-not (Test-Path -LiteralPath $pwshExe -PathType Leaf)) {
            $pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
            if (-not $pwshCommand) {
                Write-Output 'windows sandbox preflight: pwsh was not found.'
                throw 'PowerShell is unavailable for Windows preflight.'
            }
            $pwshExe = $pwshCommand.Source
        }
        $preflightResult = Invoke-RunHelper $runContext $runRecord $pwshExe `
            ([string[]]@('-NoProfile', '-NonInteractive', '-File', $setupScript, '-Repo', $repoRoot, '-Action', 'Check', '-MaxObjects', "$MaxObjects")) -TimeoutSeconds 600
        $preflight = @($preflightResult.Output -split '\r?\n')
        $preflightExit = $preflightResult.ExitCode
        if ($preflightExit -ne 0) {
            Write-Output 'windows sandbox preflight: NOT READY'
            foreach ($line in $preflight) { Write-Output ([string]$line) }
            Write-Output 'Fix the repository permissions with the Repair command above, then re-run the bridge.'
            throw 'Windows sandbox preflight failed; execution was not launched.'
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
$runDir = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $repoRoot $OutDir }
if ($runContext) {
    $runDir = Assert-RunPath $runContext $runDir
    if ($runDir.TrimEnd('\') -ieq $runContext.Control -or
        $runDir.StartsWith($runContext.Control + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '-OutDir cannot use the reserved .dsh-runs/control directory.'
    }
}
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
$invocationFile = Join-Path $runDir "$runName-invocation.json"
$launchFailureFile = Join-Path $runDir "$runName-launch-error.json"
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
    Write-Output "timeout minutes: $TimeoutMinutes"
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

$startedAt = Get-Date

# --------------------------------------------------------------------------- durable launch and supervision
$env:DSH_PERMISSION_MODE = $Mode
Set-Location -LiteralPath $repoRoot
$timedOut = $false
$launchFailed = $false
$interrupted = $false
$exitCode = $null
$jobState = 'Preparing'
$captureErrors = @()
$completedAt = $startedAt
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
Write-RunJson $runContext $factsFile $facts
$runRecord.artifacts = $facts.artifacts
$runRecord.factsPath = $factsFile
Save-RunRecord $runContext $runRecord
Write-RunJson $runContext $invocationFile @{ executable = $dshPath; arguments = $dshArgs; cwd = $repoRoot; failureFile = $launchFailureFile }
try {
    $pwshExecutable = Join-Path $PSHOME 'pwsh.exe'
    $childScript = Join-Path $PSScriptRoot 'windows/lib/run-child.ps1'
    $childArguments = [string[]]@('-NoProfile', '-NonInteractive', '-File', $childScript, '-Invocation', $invocationFile)
    $ownedRun = [DshBridge.OwnedRun]::new($runRecord.jobName, $pwshExecutable, $childArguments, $repoRoot, $promptFile, $streamFile, $errFile)
    $runRecord.child = @{ pid = $ownedRun.Pid; createdUtc = $ownedRun.CreatedUtc }
    $runRecord.stage = 'RUNNING'
    $runRecord.launched = $true
    Save-RunRecord $runContext $runRecord
    if ($runRecord.stop) { throw 'Execution stopped explicitly before the contained child resumed.' }
    $ownedRun.Resume()
    $jobState = 'Running'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $lastHeartbeat = -5000
    while (-not $ownedRun.Exited) {
        if ($clock.Elapsed.TotalMinutes -ge $TimeoutMinutes) {
            $timedOut = $true
            $ownedRun.Terminate()
            break
        }
        if ($clock.ElapsedMilliseconds - $lastHeartbeat -ge 2000) {
            $runRecord.heartbeatAt = Get-RunUtc
            $latestWrite = @($streamFile, $errFile) | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Sort-Object -Descending | Select-Object -First 1
            $runRecord.lastActivityAt = $latestWrite.ToString('o')
            if (-not $runRecord.observedSession) {
                try {
                    $firstEvent = Get-Content -LiteralPath $streamFile -TotalCount 1 | ConvertFrom-Json -ErrorAction Stop
                    if ($firstEvent.type -eq 'session' -and $firstEvent.sessionId) { $runRecord.observedSession = [string]$firstEvent.sessionId }
                } catch { }
            }
            Save-RunRecord $runContext $runRecord
            if ($runRecord.stop) {
                $interrupted = $true
                $captureErrors += 'Execution stopped explicitly; remaining task work is unknown.'
                $ownedRun.Terminate()
                break
            }
            if ($Session -and $runRecord.observedSession -and $Session -cne $runRecord.observedSession) {
                $interrupted = $true
                $captureErrors += 'Observed session differs from requested session; continuation was not confirmed.'
                $ownedRun.Terminate()
                break
            }
            $lastHeartbeat = $clock.ElapsedMilliseconds
        }
        Start-Sleep -Milliseconds 100
    }
    # The primary launcher ending must not leave a background writer behind.
    if ($ownedRun.ActiveCount -gt 0) { $ownedRun.Terminate() }
    $drain = [Diagnostics.Stopwatch]::StartNew()
    while ($ownedRun.ActiveCount -gt 0 -and $drain.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
    if ($ownedRun.ActiveCount -ne 0) { throw 'Owned process termination could not be confirmed.' }
    if (-not $timedOut -and -not $interrupted) { $exitCode = $ownedRun.ExitCode }
    $jobState = 'Completed'
    if ([IO.File]::Exists($launchFailureFile)) {
        $failure = Read-RunJson $runContext $launchFailureFile
        $launchFailed = $true
        $exitCode = $null
        $captureErrors += [string]$failure.error
    }
} catch {
    $launchFailed = -not $runRecord.launched
    $interrupted = [bool]$runRecord.launched
    $jobState = 'Failed'
    $captureErrors += $_.Exception.Message
    if ($ownedRun) { try { $ownedRun.Terminate() } catch { $captureErrors += $_.Exception.Message } }
} finally {
    if ($ownedRun) { $ownedRun.Dispose(); $ownedRun = $null }
}
$completedAt = Get-Date
$latestRunRecord = Read-RunRecord $runContext $runName
$runRecord.stop = $latestRunRecord.stop
if ($runRecord.stop) {
    $runRecord.stopHandled = $true
    $interrupted = $true
    $exitCode = $null
    $captureErrors += 'Execution stopped explicitly; original exit status and unreported work are unknown.'
    Save-RunRecord $runContext $runRecord
}

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

$facts.completedAt = $completedAt.ToUniversalTime().ToString('o')
$facts.exitCode = $exitCode
$facts.timedOut = $timedOut
$facts.launchFailed = $launchFailed
$facts.interrupted = $interrupted
$facts.jobState = $jobState
$facts.captureErrors = @($captureErrors)
$facts.inventoryErrors = @($inventoryErrors)
$runRecord.stage = 'FINALIZING'
$runRecord.exitKnown = $true
Write-RunJson $runContext $factsFile $facts
Save-RunRecord $runContext $runRecord

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

$finishedResult = Read-RunJson $runContext $resultFile
$runRecord.finalized = $true
$runRecord.outcome = if ($finishedResult.execution.bridgeExitCode -ne 0 -and $finishedResult.execution.status -eq 'SUCCEEDED') { 'FAILED' } else { $finishedResult.execution.status }
if ($finishedResult.sessionProvenance -eq 'EVENT') {
    $runRecord.observedSession = $finishedResult.sessionId
}
Save-RunRecord $runContext $runRecord

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

$runDiagnostic = 'Canonical result finalized; independent acceptance is pending.'

exit ([int]$finalizePayload.bridgeExitCode)

} catch {
    $runDiagnostic = $_.Exception.Message
    [Console]::Error.WriteLine($runDiagnostic)
    if ($runRecord) { Write-Output "lifecycle-run: $($runRecord.runId); inspect with dsh-run.ps1 -Action Status" }
    exit 1
} finally {
    if ($ownedRun) { $ownedRun.Dispose() }
    if ($runRecord) {
        try { Finish-RunRecord $runContext $runRecord $runDiagnostic }
        catch { [Console]::Error.WriteLine("Execution ownership retained: $($_.Exception.Message)") }
    }
}
