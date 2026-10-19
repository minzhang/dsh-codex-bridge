#Requires -Version 7.0
# Shared implementation for windows/setup.ps1. Dot-source after interop.ps1.
# This library is deliberately free of hardcoded drive letters, user SIDs,
# project test lists, saved sessions, and credentials.

Set-StrictMode -Version Latest

$script:WindowsRoot = Split-Path -Parent $PSScriptRoot
$script:PackageRoot = Split-Path -Parent $script:WindowsRoot
$script:SetupScriptPath = Join-Path $script:WindowsRoot 'setup.ps1'
$script:DshGrantMask = [uint32]0x110156
$script:FileDeleteChildMask = [uint32]0x00000040
$script:WriteOwnerMask = [uint32]0x00080000
$script:EveryoneSid = 'S-1-1-0'
$script:LowLabelSid = 'S-1-16-4096'
$script:SchemaVersion = 1

function New-SetupException {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$ExitCode = 1
    )
    $exception = [System.Exception]::new($Message)
    $exception.Data['SetupExitCode'] = $ExitCode
    return $exception
}

function Get-SetupExitCode {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$ErrorRecord)
    $exception = $ErrorRecord.Exception
    if ($null -ne $exception.Data -and $exception.Data.Contains('SetupExitCode')) {
        return [int]$exception.Data['SetupExitCode']
    }
    return 1
}

function Write-Utf8File {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
    )
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Write-JsonFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Object
    )
    $json = ConvertTo-Json -InputObject $Object -Depth 32
    Write-Utf8File -Path $Path -Text ($json + [Environment]::NewLine)
}

function Get-SetupStamp {
    return '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
}

function Test-UnderPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $normalizedPath = [IO.Path]::GetFullPath($Path)
    $normalizedRoot = [IO.Path]::GetFullPath($Root)
    if ($normalizedPath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $prefix = $normalizedRoot.TrimEnd('\')
    if (-not $prefix.EndsWith('\')) { $prefix += '\' }
    return $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsStatePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$StateDir
    )
    return (Test-UnderPath -Path $Path -Root $StateDir)
}

function Get-RepairCommand {
    param([string]$Repo)
    return 'pwsh -NoProfile -File "{0}" -Repo "{1}" -Action Repair -Apply' -f $script:SetupScriptPath, $Repo
}

function Get-VerifyCommand {
    param([string]$Repo)
    return 'pwsh -NoProfile -File "{0}" -Repo "{1}" -Action Verify' -f $script:SetupScriptPath, $Repo
}

function Get-RestoreCommand {
    param([string]$Repo, [string]$Backup)
    return 'pwsh -NoProfile -File "{0}" -Repo "{1}" -Action Restore -Backup "{2}" -Apply' -f $script:SetupScriptPath, $Repo, $Backup
}

function Get-ForbiddenRoots {
    $roots = [Collections.Generic.List[string]]::new()
    $candidates = @(
        $env:USERPROFILE,
        [Environment]::GetFolderPath('UserProfile'),
        [IO.Path]::GetTempPath(),
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramData,
        $env:WINDIR,
        (Join-Path $env:LOCALAPPDATA 'Programs')
    )
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        try {
            $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
            if ($full) { $roots.Add($full) }
        } catch {
            # A malformed optional environment root is not a usable boundary.
        }
    }
    return @($roots | Sort-Object -Unique)
}

function Assert-NotForbiddenRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    if ($full.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-SetupException -Message "$Label cannot be a drive root: $Path" -ExitCode 2)
    }

    $installRootCandidates = @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramData,
        $env:WINDIR,
        (Join-Path $env:LOCALAPPDATA 'Programs')
    )

    foreach ($forbidden in (Get-ForbiddenRoots)) {
        if ($full.Equals($forbidden, [StringComparison]::OrdinalIgnoreCase)) {
            throw (New-SetupException -Message "$Label is a protected root and cannot be used: $full" -ExitCode 2)
        }
        if (Test-UnderPath -Path $forbidden -Root $full) {
            throw (New-SetupException -Message "$Label must be a dedicated repository, but it contains the protected root '$forbidden': $full" -ExitCode 2)
        }
    }

    foreach ($candidate in $installRootCandidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $installRoot = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if (Test-UnderPath -Path $full -Root $installRoot) {
            throw (New-SetupException -Message "$Label cannot be inside an installed-program root '$installRoot': $full" -ExitCode 2)
        }
    }
}

function Resolve-DshInstall {
    [CmdletBinding()]
    param([string]$InstallDir)

    $candidate = $InstallDir
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
    }
    if (-not [IO.Directory]::Exists($candidate)) {
        throw (New-SetupException -Message ("DeepSeek Harness desktop installation not found at '{0}'. Use -InstallDir <path> for a nondefault install." -f $candidate))
    }

    $full = Get-CanonicalPath -Path $candidate
    $exe = Join-Path $full 'DeepSeek Harness.exe'
    $asar = Join-Path $full 'resources\app.asar'
    if (-not [IO.File]::Exists($exe)) {
        throw (New-SetupException -Message "DeepSeek Harness executable not found: $exe")
    }
    if (-not [IO.File]::Exists($asar)) {
        throw (New-SetupException -Message "DeepSeek Harness app.asar not found: $asar")
    }

    return [pscustomobject]@{
        Path = $full
        Exe  = $exe
        Asar = $asar
    }
}

function Assert-NodeRuntime {
    [CmdletBinding()]
    param()
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) {
        throw (New-SetupException -Message 'Node.js 22.14 or newer is required but node was not found on PATH.')
    }
    $versionText = (& $command.Source --version 2>&1 | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) {
        throw (New-SetupException -Message "Could not determine the Node.js version from $($command.Source).")
    }
    $trimmed = ([string]$versionText).Trim().TrimStart('v')
    try {
        $version = [version]$trimmed
    } catch {
        throw (New-SetupException -Message "Unrecognized Node.js version output: $versionText")
    }
    if ($version -lt [version]'22.14.0') {
        throw (New-SetupException -Message "Node.js 22.14 or newer is required; found $version at $($command.Source).")
    }
    return [pscustomobject]@{ Path = $command.Source; Version = $version.ToString() }
}

function Invoke-ElectronNode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 120,
        [string]$StdoutPath = '',
        [string]$StderrPath = ''
    )

    if ($TimeoutSeconds -lt 1) { throw (New-SetupException -Message 'TimeoutSeconds must be positive.') }
    $exe = Join-Path $InstallDir 'DeepSeek Harness.exe'
    if (-not [IO.File]::Exists($exe)) { throw (New-SetupException -Message "DeepSeek Harness executable not found: $exe") }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exe
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.WorkingDirectory = (Get-Location).Path
    $startInfo.ArgumentList.Add('--expose-internals')
    $startInfo.ArgumentList.Add($ScriptPath)
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add([string]$argument)
    }
    $startInfo.Environment['ELECTRON_RUN_AS_NODE'] = '1'
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $timedOut = $true
        try {
            $process.Kill($true)
        } catch {
            try { $process.Kill() } catch { }
        }
        [void]$process.WaitForExit(5000)
    }

    if (-not $stdoutTask.Wait(5000)) {
        throw (New-SetupException -Message "Timed out reading Electron stdout from $ScriptPath.")
    }
    if (-not $stderrTask.Wait(5000)) {
        throw (New-SetupException -Message "Timed out reading Electron stderr from $ScriptPath.")
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = if ($timedOut) { 124 } elseif ($process.HasExited) { $process.ExitCode } else { -1 }

    try {
        if ($StdoutPath) { Write-Utf8File -Path $StdoutPath -Text $stdout }
        if ($StderrPath) { Write-Utf8File -Path $StderrPath -Text $stderr }
    } finally {
        $process.Dispose()
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Stdout   = $stdout
        Stderr   = $stderr
        TimedOut = $timedOut
    }
}

function Invoke-DshAclHelper {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 120
    )

    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-setup-acl-' + [guid]::NewGuid().ToString('N'))
    $resultPath = Join-Path $tempDir 'result.json'
    $scriptPath = Join-Path $Context.Package 'windows\lib\dsh-acl.mjs'
    if (-not [IO.File]::Exists($scriptPath)) {
        throw (New-SetupException -Message "Package helper is missing: $scriptPath")
    }
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $run = $null
    $result = $null
    $failure = $null
    try {
        $allArguments = @($Arguments) + @('--install-dir', $Context.Install.Path, '--result', $resultPath)
        $run = Invoke-ElectronNode -InstallDir $Context.Install.Path -ScriptPath $scriptPath -Arguments $allArguments -TimeoutSeconds $TimeoutSeconds
        if ($run.TimedOut) {
            throw (New-SetupException -Message "DSH backend helper timed out after $TimeoutSeconds seconds.")
        }
        if (-not [IO.File]::Exists($resultPath)) {
            throw (New-SetupException -Message ("DSH backend helper did not write a result (exit {0}).`nstdout: {1}`nstderr: {2}" -f $run.ExitCode, $run.Stdout.Trim(), $run.Stderr.Trim()))
        }
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if (-not $result.ok) {
            $detail = if ($result.error -and $result.error.message) { $result.error.message } else { 'unknown helper failure' }
            throw (New-SetupException -Message "DSH backend helper failed: $detail")
        }
        if ($run.ExitCode -ne 0) {
            throw (New-SetupException -Message ("DSH backend helper exited {0} despite a successful result.`nstderr: {1}" -f $run.ExitCode, $run.Stderr.Trim()))
        }
    } catch {
        $failure = $_.Exception
    } finally {
        try {
            if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
        } catch {
            $cleanupError = $_.Exception
            if ($null -eq $failure) {
                $failure = New-SetupException -Message "Could not remove the temporary DSH helper directory '$tempDir': $($cleanupError.Message)"
            } else {
                $failure = New-SetupException -Message ("{0}`nAdditionally, temporary helper cleanup failed: {1}" -f $failure.Message, $cleanupError.Message)
            }
        }
    }
    if ($null -ne $failure) { throw $failure }
    return $result
}

function Invoke-DshAclInfo {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)
    return Invoke-DshAclHelper -Context $Context -Arguments @('info', '--repo', $Context.Repo) -TimeoutSeconds 60
}

function Invoke-DshAclGrant {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string[]]$ExtraDirectories = @()
    )
    $arguments = [Collections.Generic.List[string]]::new()
    $arguments.Add('grant')
    $arguments.Add('--repo')
    $arguments.Add($Context.Repo)
    $arguments.Add('--root')
    $arguments.Add($Context.Repo)
    foreach ($directory in $ExtraDirectories) {
        $arguments.Add('--extra')
        $arguments.Add($directory)
    }
    return Invoke-DshAclHelper -Context $Context -Arguments $arguments.ToArray() -TimeoutSeconds 300
}

# ---------------------------------------------------------------------------
# ACL inspection and bounded-tree traversal
# ---------------------------------------------------------------------------

function Get-SddlOwnerSid {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Sddl)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    if ($null -eq $descriptor.Owner) {
        throw 'Security descriptor has no owner.'
    }
    return $descriptor.Owner.Value
}

function Get-DaclAceList {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Sddl)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $result = [Collections.Generic.List[object]]::new()
    if ($null -eq $descriptor.DiscretionaryAcl) { return @() }
    foreach ($entry in $descriptor.DiscretionaryAcl) {
        if ($entry -isnot [Security.AccessControl.QualifiedAce]) { continue }
        $result.Add([pscustomobject]@{
            Type        = $entry.AceType
            Mask        = [uint32]([int64]$entry.AccessMask -band 0xFFFFFFFFL)
            Sid         = $entry.SecurityIdentifier.Value
            Flags       = [int]$entry.AceFlags
            IsInherited = (([int]$entry.AceFlags -band [int][Security.AccessControl.AceFlags]::Inherited) -ne 0)
        })
    }
    return @($result)
}

function Test-UserHasWriteOwnerSddl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][string]$Sid
    )
    $aces = @(Get-DaclAceList -Sddl $Sddl)
    $allow = $false
    $deny = $false
    foreach ($ace in $aces) {
        if ($ace.Sid -ne $Sid) { continue }
        if (($ace.Mask -band $script:WriteOwnerMask) -eq 0) { continue }
        if ($ace.Type -eq [Security.AccessControl.AceType]::AccessAllowed) { $allow = $true }
        if ($ace.Type -eq [Security.AccessControl.AceType]::AccessDenied) { $deny = $true }
    }
    return ($allow -and -not $deny)
}

function Test-UserHasWriteOwner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sid
    )
    return (Test-UserHasWriteOwnerSddl -Sddl (Read-SecurityDescriptor -Path $Path) -Sid $Sid)
}

function Get-MandatoryLabelAces {    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Sddl)
    $result = [Collections.Generic.List[object]]::new()
    $matches = [regex]::Matches($Sddl, '\(ML;([^;]*);([^;]*);;;([^)]*)\)')
    foreach ($match in $matches) {
        $result.Add([pscustomobject]@{
            Flags  = $match.Groups[1].Value
            Rights = $match.Groups[2].Value
            Sid    = $match.Groups[3].Value
        })
    }
    return @($result)
}

function Test-LowLabel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][bool]$IsDirectory,
        [switch]$Exact
    )
    $labels = @(Get-MandatoryLabelAces -Sddl $Sddl)
    if ($labels.Count -eq 0) { return $false }
    $exactLowCount = 0
    foreach ($label in $labels) {
        $isLow = $label.Sid -eq 'LW' -or $label.Sid -eq $script:LowLabelSid
        if (-not $isLow) { return $false }
        $rights = @($label.Rights -split ',' | ForEach-Object { $_.Trim() })
        $hasNoWriteUp = ($rights -contains 'NW') -or ($rights -contains '0x1') -or ($rights -contains '1')
        if (-not $hasNoWriteUp) { return $false }
        if ($IsDirectory -and -not ($label.Flags.Contains('OI') -and $label.Flags.Contains('CI'))) {
            return $false
        }
        if ($Exact -and $label.Flags -eq 'OICI' -and $rights.Count -eq 1 -and ($rights[0] -eq 'NW' -or $rights[0] -eq '0x1' -or $rights[0] -eq '1')) {
            $exactLowCount++
        }
    }
    if ($Exact) { return ($exactLowCount -ge 1) }
    return $true
}

function Test-CapabilityAce {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Aces,
        [Parameter(Mandatory = $true)][string]$WriteSid,
        [Parameter(Mandatory = $true)][bool]$IsDirectory,
        [switch]$Exact
    )
    $inheritanceMask = [int]([Security.AccessControl.AceFlags]::ContainerInherit -bor [Security.AccessControl.AceFlags]::ObjectInherit)
    foreach ($ace in $Aces) {
        if ($ace.Type -ne [Security.AccessControl.AceType]::AccessAllowed) { continue }
        if ($ace.Sid -ne $WriteSid) { continue }
        if ($Exact) {
            if ($ace.Mask -ne $script:DshGrantMask) { continue }
            if ($ace.Flags -ne $inheritanceMask) { continue }
            return $true
        }
        if (($ace.Mask -band $script:DshGrantMask) -ne $script:DshGrantMask) { continue }
        if ($IsDirectory -and (($ace.Flags -band $inheritanceMask) -ne $inheritanceMask)) { continue }
        return $true
    }
    return $false
}

function Test-ProtectiveDeny {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Aces,
        [switch]$Exact
    )
    $container = [int][Security.AccessControl.AceFlags]::ContainerInherit
    $object = [int][Security.AccessControl.AceFlags]::ObjectInherit
    foreach ($ace in $Aces) {
        if ($ace.Type -ne [Security.AccessControl.AceType]::AccessDenied) { continue }
        if ($ace.Sid -ne $script:EveryoneSid) { continue }
        if (($ace.Mask -band $script:FileDeleteChildMask) -eq 0) { continue }
        if ($Exact) {
            if ($ace.Mask -ne $script:FileDeleteChildMask) { continue }
            if ($ace.Flags -ne $container) { continue }
            return $true
        }
        if (($ace.Flags -band ($container -bor $object)) -ne $container) { continue }
        return $true
    }
    return $false
}

function Get-ReadinessIssues {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Entries,
        [Parameter(Mandatory = $true)][string]$WriteSid,
        [Parameter(Mandatory = $true)][string]$StateDir
    )
    $issues = [Collections.Generic.List[object]]::new()
    foreach ($entry in $Entries) {
        if (Test-IsStatePath -Path $entry.Path -StateDir $StateDir) { continue }
        $isRoot = ($entry.RelativePath -eq '')
        $aces = @(Get-DaclAceList -Sddl $entry.Sddl)
        if (-not (Test-LowLabel -Sddl $entry.Sddl -IsDirectory ([bool]$entry.IsDirectory) -Exact:$isRoot)) {
            $issues.Add([pscustomobject]@{
                Path         = $entry.Path
                RelativePath = $entry.RelativePath
                Kind         = 'label'
                Message      = 'missing Low no-write-up mandatory label'
            })
        }
        if (-not (Test-CapabilityAce -Aces $aces -WriteSid $WriteSid -IsDirectory ([bool]$entry.IsDirectory) -Exact:$isRoot)) {
            $issues.Add([pscustomobject]@{
                Path         = $entry.Path
                RelativePath = $entry.RelativePath
                Kind         = 'capability'
                Message      = 'missing or non-inheritable DSH workspace-write capability ACE'
            })
        }
        if ($entry.IsDirectory -and -not (Test-ProtectiveDeny -Aces $aces -Exact:$isRoot)) {
            $issues.Add([pscustomobject]@{
                Path         = $entry.Path
                RelativePath = $entry.RelativePath
                Kind         = 'deny'
                Message      = 'missing directory-only Everyone DELETE_CHILD deny'
            })
        }
    }
    return @($issues)
}

function New-TreeEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$IsDirectory
    )

    $relative = [IO.Path]::GetRelativePath($Root, $Path)
    if ($relative -eq '.') { $relative = '' }
    $sddl = Read-SecurityDescriptor -Path $Path
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    if ($null -eq $descriptor.Owner) {
        throw (New-SetupException -Message "Object has no owner and requires separate review: $Path")
    }
    $owner = $descriptor.Owner.Value
    if ($owner -ne $script:CurrentUserSid) {
        throw (New-SetupException -Message "Foreign-owned object requires separate review (owner $owner, current user $script:CurrentUserSid): $Path")
    }
    if ($null -eq $descriptor.DiscretionaryAcl) {
        throw (New-SetupException -Message "Null DACL requires separate review: $Path")
    }
    $flags = [int]$descriptor.ControlFlags
    if (($flags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) {
        throw (New-SetupException -Message "Protected DACL/inheritance requires separate review: $Path")
    }
    if (-not $IsDirectory) {
        $links = Get-FileLinkCount -Path $Path
        if ($links -gt 1) {
            throw (New-SetupException -Message "Multiply-linked file requires separate review ($links hard links): $Path")
        }
    }

    return [pscustomobject]@{
        Path         = $Path
        RelativePath = $relative
        IsDirectory  = $IsDirectory
        Sddl         = $sddl
        OwnerSid     = $owner
        ControlFlags = $flags
    }
}

function Get-TreeEntries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][int]$MaxObjects,
        [Parameter(Mandatory = $true)][string]$StateDir,
        [switch]$IncludeState
    )

    $entries = [Collections.Generic.List[object]]::new()
    $entries.Add((New-TreeEntry -Root $Root -Path $Root -IsDirectory $true))
    if ($entries.Count -gt $MaxObjects) {
        throw (New-SetupException -Message "Repository tree exceeds the $MaxObjects-object safety limit. Reduce the repository or raise -MaxObjects only after review.")
    }

    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $directory = $stack.Pop()
        $children = @([IO.Directory]::EnumerateFileSystemEntries($directory) | Sort-Object)
        foreach ($child in $children) {
            $isDirectory = [IO.Directory]::Exists($child)
            if ($isDirectory -and -not $IncludeState -and (Test-IsStatePath -Path $child -StateDir $StateDir)) {
                continue
            }
            $attributes = [IO.File]::GetAttributes($child)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw (New-SetupException -Message "Reparse point/junction is not supported (links are never followed): $child")
            }
            $entries.Add((New-TreeEntry -Root $Root -Path $child -IsDirectory $isDirectory))
            if ($entries.Count -gt $MaxObjects) {
                throw (New-SetupException -Message "Repository tree exceeds the $MaxObjects-object safety limit. Reduce the repository or raise -MaxObjects only after review.")
            }
            if ($isDirectory) { $stack.Push($child) }
        }
    }

    return @($entries | Sort-Object `
        @{ Expression = { ($_.RelativePath -split '\\').Count }; Ascending = $true },
        @{ Expression = { $_.RelativePath }; Ascending = $true })
}

function Get-OriginalAceIssues {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BeforeSddl,
        [Parameter(Mandatory = $true)][string]$AfterSddl
    )
    $before = @(Get-DaclAceList -Sddl $BeforeSddl)
    $after = @(Get-DaclAceList -Sddl $AfterSddl)
    $issues = [Collections.Generic.List[string]]::new()
    foreach ($ace in $before) {
        if ($ace.Type -eq [Security.AccessControl.AceType]::AccessDenied) {
            $normalizedFlags = $ace.Flags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)
            $found = @($after | Where-Object {
                    $_.Type -eq $ace.Type -and
                    $_.Sid -eq $ace.Sid -and
                    $_.Mask -eq $ace.Mask -and
                    (($_.Flags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)) -eq $normalizedFlags)
                })
            if ($found.Count -eq 0) {
                $issues.Add("original deny entry was not preserved: $Path (SID $($ace.Sid), mask $($ace.Mask), flags $($ace.Flags))")
            }
        } else {
            $found = @($after | Where-Object {
                    $_.Type -eq $ace.Type -and $_.Sid -eq $ace.Sid -and $_.Mask -eq $ace.Mask
                })
            if ($found.Count -eq 0) {
                $issues.Add("original allow entry was not preserved: $Path (SID $($ace.Sid), mask $($ace.Mask))")
            }
        }
    }
    return @($issues)
}

function Get-ExplicitAceKey {
    param($Ace)
    $flags = $Ace.Flags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)
    return '{0}|{1}|{2}|{3}' -f [int]$Ace.Type, $Ace.Mask, $Ace.Sid, $flags
}

function Get-InheritedAceKey {
    param($Ace)
    # The inherited marker and physical order may be recomputed by Windows.
    # OI/CI/IO/NP (and the access mask/type/SID) change access semantics and
    # must still match the restored snapshot.
    $flags = $Ace.Flags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)
    return '{0}|{1}|{2}|{3}' -f [int]$Ace.Type, $Ace.Mask, $Ace.Sid, $flags
}

function Get-MandatoryLabelKey {
    param($Label)
    # The inherited marker may be recomputed; keep OI/CI/IO/NP applicability flags.
    $flags = $Label.Flags -replace 'ID', ''
    return '{0}|{1}|{2}' -f $flags, $Label.Rights, $Label.Sid
}

function Get-RestoreStateIssues {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSddl,
        [Parameter(Mandatory = $true)][string]$ActualSddl
    )
    $issues = [Collections.Generic.List[string]]::new()
    $expectedOwner = Get-SddlOwnerSid -Sddl $ExpectedSddl
    $actualOwner = Get-SddlOwnerSid -Sddl $ActualSddl
    if ($expectedOwner -ne $actualOwner) {
        $issues.Add("owner mismatch for ${Path}: expected $expectedOwner, found $actualOwner")
    }

    $expectedAces = @(Get-DaclAceList -Sddl $ExpectedSddl)
    $actualAces = @(Get-DaclAceList -Sddl $ActualSddl)
    $protectedFlag = [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
    $expectedFlags = [int]([Security.AccessControl.RawSecurityDescriptor]::new($ExpectedSddl).ControlFlags)
    $actualFlags = [int]([Security.AccessControl.RawSecurityDescriptor]::new($ActualSddl).ControlFlags)
    if (($expectedFlags -band $protectedFlag) -ne ($actualFlags -band $protectedFlag)) {
        $issues.Add("DACL protection state differs for ${Path}: expected $(($expectedFlags -band $protectedFlag) -ne 0), found $(($actualFlags -band $protectedFlag) -ne 0)")
    }
    $expectedExplicit = @($expectedAces | Where-Object { -not $_.IsInherited } | ForEach-Object { Get-ExplicitAceKey -Ace $_ })
    $actualExplicit = @($actualAces | Where-Object { -not $_.IsInherited } | ForEach-Object { Get-ExplicitAceKey -Ace $_ })
    if (($expectedExplicit -join "`n") -ne ($actualExplicit -join "`n")) {
        $issues.Add("explicit DACL state differs for ${Path}: expected $($expectedExplicit.Count) explicit ACE(s), found $($actualExplicit.Count); a residual capability/temporary allow or a missing/extra explicit entry remains")
    }

    $expectedInherited = @($expectedAces | Where-Object { $_.IsInherited } | ForEach-Object { Get-InheritedAceKey -Ace $_ } | Sort-Object)
    $actualInherited = @($actualAces | Where-Object { $_.IsInherited } | ForEach-Object { Get-InheritedAceKey -Ace $_ } | Sort-Object)
    if (($expectedInherited -join "`n") -ne ($actualInherited -join "`n")) {
        $issues.Add("inherited DACL semantics differ for ${Path}: expected $($expectedInherited.Count) inherited ACE(s), found $($actualInherited.Count) (inherited marker/order are allowed to be recomputed; SID/mask/type/applicability flags are not)")
    }

    $expectedLabels = @(Get-MandatoryLabelAces -Sddl $ExpectedSddl | ForEach-Object { Get-MandatoryLabelKey -Label $_ } | Sort-Object)
    $actualLabels = @(Get-MandatoryLabelAces -Sddl $ActualSddl | ForEach-Object { Get-MandatoryLabelKey -Label $_ } | Sort-Object)
    if (($expectedLabels -join "`n") -ne ($actualLabels -join "`n")) {
        $issues.Add("mandatory label state differs for ${Path}: expected $($expectedLabels.Count) label ACE(s), found $($actualLabels.Count); residual Low label or missing original label")
    }

    return @($issues)
}

# ---------------------------------------------------------------------------
# Setup context and readiness
# ---------------------------------------------------------------------------

function New-SetupContext {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Action,
        [bool]$Apply = $false,
        [string]$Backup = '',
        [string]$InstallDir = '',
        [int]$MaxObjects = 10000
    )

    if ($MaxObjects -lt 1) {
        throw (New-SetupException -Message '-MaxObjects must be a positive integer.' -ExitCode 2)
    }
    if ($Action -eq 'Repair' -and -not $Apply) {
        $command = Get-RepairCommand -Repo ([IO.Path]::GetFullPath($Repo))
        throw (New-SetupException -Message "Repair requires -Apply. Re-run exactly:`n$command" -ExitCode 2)
    }
    if ($Action -eq 'Restore') {
        if ([string]::IsNullOrWhiteSpace($Backup)) {
            throw (New-SetupException -Message 'Restore requires -Backup <manifest.json> and -Apply.' -ExitCode 2)
        }
        if (-not $Apply) {
            $command = Get-RestoreCommand -Repo ([IO.Path]::GetFullPath($Repo)) -Backup ([IO.Path]::GetFullPath($Backup))
            throw (New-SetupException -Message "Restore requires -Apply. Re-run exactly:`n$command" -ExitCode 2)
        }
    }
    if ($Action -in @('Check', 'Verify') -and $Apply) {
        throw (New-SetupException -Message "-Apply is only valid with -Action Repair or -Action Restore." -ExitCode 2)
    }
    if ($Action -ne 'Restore' -and -not [string]::IsNullOrWhiteSpace($Backup)) {
        throw (New-SetupException -Message "-Backup is only valid with -Action Restore." -ExitCode 2)
    }

    $repoInput = [IO.Path]::GetFullPath($Repo)
    if (-not [IO.Directory]::Exists($repoInput)) {
        throw (New-SetupException -Message "Repository directory does not exist: $repoInput" -ExitCode 2)
    }
    $repoFull = $repoInput.TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot($repoFull).TrimEnd('\')
    if ($repoFull.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-SetupException -Message "Repository cannot be a drive root: $repoFull" -ExitCode 2)
    }

    $repoPath = Get-CanonicalPath -Path $repoInput
    $packagePath = Get-CanonicalPath -Path $script:PackageRoot
    Assert-NotForbiddenRoot -Path $repoPath -Label 'Repository'
    Assert-NotForbiddenRoot -Path $packagePath -Label 'Bridge package'

    if (-not (Test-UnderPath -Path $packagePath -Root $repoPath) -or
        $packagePath.Equals($repoPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-SetupException -Message "The bridge package must be inside the selected dedicated repository. Repo: $repoPath; package: $packagePath" -ExitCode 2)
    }

    $stateDir = Join-Path $packagePath '.state'
    $stateDirFull = [IO.Path]::GetFullPath($stateDir)
    if (-not (Test-UnderPath -Path $stateDirFull -Root $packagePath)) {
        throw (New-SetupException -Message "Package state directory is outside the package: $stateDirFull" -ExitCode 2)
    }
    if (Test-Path -LiteralPath $stateDirFull) {
        Assert-NoReparseAncestors -Path $stateDirFull
    } else {
        Assert-NoReparseAncestors -Path $packagePath
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $script:CurrentUserSid = $identity.User.Value
    $install = $null
    if ($Action -ne 'Restore') {
        $install = Resolve-DshInstall -InstallDir $InstallDir
    }

    return [pscustomobject]@{
        Repo            = $repoPath
        Package         = $packagePath
        StateDir        = $stateDirFull
        Install         = $install
        InstallDir      = $InstallDir
        Action          = $Action
        Apply           = $Apply
        Backup          = $Backup
        MaxObjects      = $MaxObjects
        UserSid         = $script:CurrentUserSid
        UserName        = $identity.Name
        Stamp           = Get-SetupStamp
        SetupScriptPath = $script:SetupScriptPath
    }
}

function New-StateDirectories {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    $package = [IO.Path]::GetFullPath($Context.Package)
    $state = [IO.Path]::GetFullPath($Context.StateDir)
    if (-not ([IO.Path]::GetDirectoryName($state)).Equals($package.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-SetupException -Message "Package .state must be a direct child of the package root: $state")
    }
    Assert-NoReparseAncestors -Path $package

    $paths = [Collections.Generic.List[string]]::new()
    foreach ($relative in @('', 'backups', 'reports', 'logs')) {
        $path = if ($relative) { Join-Path $state $relative } else { $state }
        if (Test-Path -LiteralPath $path) {
            if (-not [IO.Directory]::Exists($path)) {
                throw (New-SetupException -Message "Package state output path is not a directory: $path")
            }
            Assert-NoReparseAncestors -Path $path
        }
        $paths.Add($path)
    }

    foreach ($path in $paths) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
        Assert-NoReparseAncestors -Path $path
    }
}

function Get-ReadinessScopeNote {
    return 'Root grant propagation can affect descendant ACLs across the entire snapshotted tree, including metadata and dependency directories. The package .state diagnostics are excluded from readiness enumeration; when present they are included in the repair snapshot. Objects created after the snapshot (including new reports and logs) are not covered by rollback.'
}

function Get-SetupCheck {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    $info = Invoke-DshAclInfo -Context $Context
    $Context | Add-Member -NotePropertyName InstallVersion -NotePropertyValue $info.version -Force
    if (Test-Path -LiteralPath $Context.StateDir) {
        if (-not [IO.Directory]::Exists($Context.StateDir)) {
            throw (New-SetupException -Message "Package .state path is not a directory: $($Context.StateDir)")
        }
        Assert-NoReparseAncestors -Path $Context.StateDir
    }
    $entries = @(Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$false)
    $issues = @(Get-ReadinessIssues -Entries $entries -WriteSid $info.writeSid -StateDir $Context.StateDir)
    return [pscustomobject]@{
        Info    = $info
        Entries = $entries
        Issues  = $issues
        Ready   = ($issues.Count -eq 0)
    }
}

function Invoke-CheckAction {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    $check = $null
    try {
        $check = Get-SetupCheck -Context $Context
    } catch {
        $message = $_.Exception.Message
        Write-Host 'DSH Windows sandbox check'
        Write-Host "repo: $($Context.Repo)"
        Write-Host 'RESULT: NOT READY (safety or installation issue)'
        Write-Host "detail: $message"
        Write-Host 'Automatic repair was not attempted. Resolve the safety/installation issue first; if it is unsupported layout or an unsafe ACL, review it separately.'
        return 1
    }

    Write-Host 'DSH Windows sandbox check'
    Write-Host "repo: $($Context.Repo)"
    Write-Host "package: $($Context.Package)"
    Write-Host "installed backend: $($check.Info.version)"
    if (-not $check.Info.versionMatchesKnownTested) {
        Write-Host "warning: known-tested backend is $($check.Info.knownTestedVersion); this run validated the installed layout and exports."
    }
    Write-Host "workspace SID: $($check.Info.writeSid)"
    Write-Host "objects checked: $($check.Entries.Count) (.state diagnostics excluded)"
    Write-Host ('scope: ' + (Get-ReadinessScopeNote))

    if ($check.Ready) {
        Write-Host 'RESULT: READY'
        Write-Host 'No permission changes were made.'
        return 0
    }

    Write-Host "RESULT: NOT READY ($($check.Issues.Count) permission issue(s))"
    $limit = [Math]::Min(25, $check.Issues.Count)
    for ($index = 0; $index -lt $limit; $index++) {
        $issue = $check.Issues[$index]
        $relative = if ($issue.RelativePath) { $issue.RelativePath } else { '.' }
        Write-Host ("  - [{0}] {1}: {2}" -f $issue.Kind, $relative, $issue.Message)
    }
    if ($check.Issues.Count -gt $limit) {
        Write-Host "  ... and $($check.Issues.Count - $limit) more issue(s)"
    }
    Write-Host 'Repair:'
    Write-Host ('  ' + (Get-RepairCommand -Repo $Context.Repo))
    return 1
}

# ---------------------------------------------------------------------------
# Backup manifests and restore
# ---------------------------------------------------------------------------

function Write-AclBackup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Entries
    )

    $objects = [Collections.Generic.List[object]]::new()
    foreach ($entry in $Entries) {
        $objects.Add([ordered]@{
                relativePath = [string]$entry.RelativePath
                path         = [string]$entry.Path
                isDirectory  = [bool]$entry.IsDirectory
                sddl          = [string]$entry.Sddl
                ownerSid      = [string]$entry.OwnerSid
            })
    }
    if ($objects.Count -eq 0) {
        throw (New-SetupException -Message 'Refusing to save an empty ACL backup.')
    }
    $backupDirectory = Join-Path $Context.StateDir 'backups'
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    $backupPath = Join-Path $backupDirectory ("{0}-acl.json" -f $Context.Stamp)
    $document = [ordered]@{
        schemaVersion        = $script:SchemaVersion
        createdUtc           = (Get-Date).ToUniversalTime().ToString('o')
        repoRoot             = $Context.Repo
        packageRoot          = $Context.Package
        currentUserSid       = $Context.UserSid
        currentUserName      = $Context.UserName
        objectCount          = $objects.Count
        stateExcludedFromReadiness = $true
        scope                = (Get-ReadinessScopeNote)
        objects              = @($objects)
    }
    Write-JsonFile -Path $backupPath -Object $document
    return $backupPath
}

function Read-RestoreManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][int]$MaxObjects,
        [Parameter(Mandatory = $true)][string]$CurrentUserSid
    )

    $backup = [IO.Path]::GetFullPath($BackupPath)
    if (-not [IO.File]::Exists($backup)) {
        throw (New-SetupException -Message "Restore manifest not found: $backup")
    }
    $stateRoot = [IO.Path]::GetFullPath((Join-Path $PackageRoot '.state'))
    if (-not (Test-UnderPath -Path $backup -Root $stateRoot)) {
        throw (New-SetupException -Message "Restore manifest must be under the package .state directory: $stateRoot")
    }
    Assert-NoReparseAncestors -Path $backup

    $raw = Get-Content -LiteralPath $backup -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw (New-SetupException -Message "Restore manifest is empty: $backup")
    }
    $document = $raw | ConvertFrom-Json
    if ($null -eq $document.PSObject.Properties['schemaVersion'] -or [int]$document.schemaVersion -ne $script:SchemaVersion) {
        throw (New-SetupException -Message "Unsupported restore manifest schema (expected $($script:SchemaVersion)): $backup")
    }
    if ($null -eq $document.PSObject.Properties['repoRoot']) {
        throw (New-SetupException -Message "Restore manifest has no repoRoot: $backup")
    }
    $manifestRoot = [IO.Path]::GetFullPath([string]$document.repoRoot)
    if (-not $manifestRoot.Equals([IO.Path]::GetFullPath($RepoRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-SetupException -Message "Restore manifest belongs to a different repository. Manifest: $manifestRoot; current: $RepoRoot")
    }
    if ($null -eq $document.PSObject.Properties['currentUserSid'] -or [string]$document.currentUserSid -ne $CurrentUserSid) {
        throw (New-SetupException -Message 'Restore manifest was created for a different Windows user SID. Refusing to restore across identities.')
    }
    $objects = @($document.objects)
    if ($objects.Count -eq 0) {
        throw (New-SetupException -Message "Restore manifest contains no objects: $backup")
    }
    if ($objects.Count -gt $MaxObjects) {
        throw (New-SetupException -Message "Restore manifest exceeds the $MaxObjects-object safety limit: $($objects.Count)")
    }
    if ($null -ne $document.PSObject.Properties['objectCount'] -and [int]$document.objectCount -ne $objects.Count) {
        throw (New-SetupException -Message "Restore manifest objectCount does not match its object list: $backup")
    }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $entries = [Collections.Generic.List[object]]::new()
    $rootEntries = 0
    foreach ($object in $objects) {
        foreach ($required in @('relativePath', 'path', 'isDirectory', 'sddl', 'ownerSid')) {
            if ($null -eq $object.PSObject.Properties[$required]) {
                throw (New-SetupException -Message "Restore manifest object is missing '$required': $backup")
            }
        }
        $relative = [string]$object.relativePath
        if ($relative -eq '.') { $relative = '' }
        if ($relative.Contains([char]0) -or $relative.Contains(':') -or [IO.Path]::IsPathRooted($relative)) {
            throw (New-SetupException -Message "Restore manifest contains an invalid relative path: '$relative'")
        }
        $segments = @($relative -split '[\\/]')
        if ($segments -contains '..' -or $segments -contains '.') {
            throw (New-SetupException -Message "Restore manifest contains a traversal segment: '$relative'")
        }
        $expected = if ($relative -eq '') { [IO.Path]::GetFullPath($RepoRoot) } else { [IO.Path]::GetFullPath((Join-Path $RepoRoot $relative)) }
        $manifestPath = [IO.Path]::GetFullPath([string]$object.path)
        if (-not $manifestPath.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
            throw (New-SetupException -Message "Restore manifest path does not match its relative path. relative='$relative'; path='$manifestPath'; expected='$expected'")
        }
        if (-not (Test-UnderPath -Path $manifestPath -Root $RepoRoot)) {
            throw (New-SetupException -Message "Restore manifest path is outside the repository: $manifestPath")
        }
        if (-not $seen.Add($manifestPath)) {
            throw (New-SetupException -Message "Restore manifest contains a duplicate path: $manifestPath")
        }
        if ($relative -eq '') { $rootEntries++ }
        Assert-NoReparseAncestors -Path $manifestPath
        $isDirectory = [bool]$object.isDirectory
        if ($isDirectory) {
            if (-not [IO.Directory]::Exists($manifestPath)) {
                throw (New-SetupException -Message "Restore manifest path no longer exists as a directory: $manifestPath")
            }
        } elseif (-not [IO.File]::Exists($manifestPath)) {
            throw (New-SetupException -Message "Restore manifest path no longer exists as a file: $manifestPath")
        } elseif ((Get-FileLinkCount -Path $manifestPath) -gt 1) {
            throw (New-SetupException -Message "Restore manifest path is now multiply-linked and requires separate review: $manifestPath")
        }

        $sddl = [string]$object.sddl
        try {
            $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
        } catch {
            throw (New-SetupException -Message "Restore manifest contains an invalid security descriptor for $manifestPath")
        }
        if ($null -eq $descriptor.Owner) {
            throw (New-SetupException -Message "Restore manifest security descriptor has no owner: $manifestPath")
        }
        if ($null -eq $descriptor.DiscretionaryAcl) {
            throw (New-SetupException -Message "Restore manifest contains a null DACL: $manifestPath")
        }
        $manifestOwner = [string]$object.ownerSid
        if ($descriptor.Owner.Value -ne $manifestOwner) {
            throw (New-SetupException -Message "Restore manifest owner field does not match its SDDL: $manifestPath")
        }
        if ($manifestOwner -ne $CurrentUserSid) {
            throw (New-SetupException -Message "Restore manifest was created for a foreign owner ($manifestOwner): $manifestPath")
        }
        $currentSddl = Read-SecurityDescriptor -Path $manifestPath
        $currentOwner = Get-SddlOwnerSid -Sddl $currentSddl
        if ($currentOwner -ne $manifestOwner) {
            throw (New-SetupException -Message "Current owner changed since the backup; restore will not rewrite ownership. Manifest owner $manifestOwner, current ${currentOwner}: $manifestPath")
        }

        $entries.Add([pscustomobject]@{
                RelativePath = $relative
                Path         = $manifestPath
                IsDirectory  = $isDirectory
                Sddl         = $sddl
                OwnerSid     = $manifestOwner
            })
    }
    if ($rootEntries -ne 1) {
        throw (New-SetupException -Message "Restore manifest must contain exactly one repository-root entry; found $rootEntries.")
    }

    return [pscustomobject]@{
        BackupPath = $backup
        Document   = $document
        Entries    = @($entries | Sort-Object `
            @{ Expression = { ($_.RelativePath -split '\\').Count }; Ascending = $true },
            @{ Expression = { $_.RelativePath }; Ascending = $true })
    }
}

function Restore-AclEntries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Entries
    )

    $failures = [Collections.Generic.List[string]]::new()
    foreach ($entry in $Entries) {
        $added = $false
        try {
            if (-not (Test-UserHasWriteOwner -Path $entry.Path -Sid $Context.UserSid)) {
                $added = Add-TemporaryWriteOwnerAce -Path $entry.Path -Sid $Context.UserSid
            }
            Write-SecurityDescriptorDaclAndLabel -Path $entry.Path -Sddl $entry.Sddl
        } catch {
            $failures.Add("restore failed for $($entry.Path): $($_.Exception.Message)")
            if ($added) {
                try {
                    [void](Remove-TemporaryWriteOwnerAce -Path $entry.Path -Sid $Context.UserSid)
                } catch {
                    $failures.Add("temporary WRITE_OWNER cleanup failed for $($entry.Path): $($_.Exception.Message)")
                }
            }
        }
    }

    foreach ($entry in $Entries) {
        try {
            $current = Read-SecurityDescriptor -Path $entry.Path
            foreach ($issue in (Get-RestoreStateIssues -Path $entry.Path -ExpectedSddl $entry.Sddl -ActualSddl $current)) {
                $failures.Add("restore verification: $issue")
            }
        } catch {
            $failures.Add("restore verification failed for $($entry.Path): $($_.Exception.Message)")
        }
    }
    return @($failures)
}

function Write-SetupReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Fields
    )

    New-StateDirectories -Context $Context
    $backendVersion = $null
    if ($Context.PSObject.Properties['InstallVersion']) { $backendVersion = $Context.InstallVersion }
    $report = [ordered]@{
        schemaVersion  = $script:SchemaVersion
        action         = $Action
        status         = $Status
        timestampUtc   = (Get-Date).ToUniversalTime().ToString('o')
        repo           = $Context.Repo
        package        = $Context.Package
        installDir     = if ($null -ne $Context.Install) { $Context.Install.Path } else { $null }
        backendVersion = $backendVersion
        userSid        = $Context.UserSid
        maxObjects     = $Context.MaxObjects
        scope          = (Get-ReadinessScopeNote)
    }
    foreach ($key in $Fields.Keys) {
        $report[$key] = $Fields[$key]
    }
    $path = Join-Path (Join-Path $Context.StateDir 'reports') ("{0}-{1}.json" -f $Context.Stamp, $Action.ToLowerInvariant())
    Write-JsonFile -Path $path -Object $report
    return $path
}

# ---------------------------------------------------------------------------
# Repair
# ---------------------------------------------------------------------------

function Invoke-RepairAction {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    $check = Get-SetupCheck -Context $Context
    $writeSid = $check.Info.writeSid
    if ($check.Ready) {
        $reportPath = Write-SetupReport -Context $Context -Action 'Repair' -Status 'ready' -Fields ([ordered]@{
                backendVersion = $check.Info.version
                writeSid       = $writeSid
                objectCount    = $check.Entries.Count
                mutations      = [ordered]@{ permissionChanges = 0 }
                excludedState  = $true
            })
        Write-Host 'DSH Windows sandbox repair'
        Write-Host "backend: $($check.Info.version)"
        Write-Host "workspace SID: $writeSid"
        Write-Host 'RESULT: READY (no permission changes were needed)'
        Write-Host "report: $reportPath"
        return 0
    }

    New-StateDirectories -Context $Context
    $snapshotEntries = @(Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$true)
    $rootBefore = @($snapshotEntries | Where-Object { $_.RelativePath -eq '' })[0].Sddl
    $backupPath = Write-AclBackup -Context $Context -Entries $snapshotEntries
    $preflightReport = Write-SetupReport -Context $Context -Action 'Repair' -Status 'preflight' -Fields ([ordered]@{
            backendVersion = $check.Info.version
            writeSid       = $writeSid
            backup         = $backupPath
            objectCount    = $snapshotEntries.Count
            excludedState  = $true
            issues         = @($check.Issues)
        })

    $mutations = [ordered]@{
        rootGrantInvoked       = $false
        extraDirectoryGrants   = @()
        labelsSet              = 0
        tempWriteOwnerAdded    = $false
        tempWriteOwnerRemoved  = $false
        rootSddlChanged        = $false
    }
    $tempState = [ordered]@{ Added = $false; Removed = $false; Error = $null }
    $mutationOccurred = $false
    $failure = $null
    $failureContext = ''

    try {
        try {
            $needsTempWriteOwner = $false
            foreach ($entry in $snapshotEntries) {
                if (Test-IsStatePath -Path $entry.Path -StateDir $Context.StateDir) { continue }
                if (-not (Test-UserHasWriteOwnerSddl -Sddl $entry.Sddl -Sid $Context.UserSid)) {
                    $needsTempWriteOwner = $true
                    break
                }
            }
            if ($needsTempWriteOwner) {
                $tempState.Added = Add-TemporaryWriteOwnerAce -Path $Context.Repo -Sid $Context.UserSid
                $mutations.tempWriteOwnerAdded = [bool]$tempState.Added
                if ($tempState.Added) { $mutationOccurred = $true }
            }

            $mutationOccurred = $true
            [void](Invoke-DshAclGrant -Context $Context -ExtraDirectories @())
            $mutations.rootGrantInvoked = $true

            $snapshotSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($entry in $snapshotEntries) { [void]$snapshotSet.Add($entry.Path) }
            $currentAll = @(Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$true)
            $current = @($currentAll | Where-Object { $snapshotSet.Contains($_.Path) })
            if ($current.Count -ne $snapshotEntries.Count) {
                throw (New-SetupException -Message "Repository tree changed during repair coverage check (expected $($snapshotEntries.Count), found $($current.Count)).")
            }

            $extraDirectories = [Collections.Generic.List[string]]::new()
            foreach ($entry in $current) {
                if (-not $entry.IsDirectory) { continue }
                if (Test-IsStatePath -Path $entry.Path -StateDir $Context.StateDir) { continue }
                $aces = @(Get-DaclAceList -Sddl $entry.Sddl)
                if (-not (Test-CapabilityAce -Aces $aces -WriteSid $writeSid -IsDirectory $true) -or
                    -not (Test-ProtectiveDeny -Aces $aces)) {
                    $extraDirectories.Add($entry.Path)
                }
            }
            if ($extraDirectories.Count -gt 0) {
                [void](Invoke-DshAclGrant -Context $Context -ExtraDirectories $extraDirectories.ToArray())
                $mutations.extraDirectoryGrants = $extraDirectories.ToArray()
                $currentAll = @(Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$true)
                $current = @($currentAll | Where-Object { $snapshotSet.Contains($_.Path) })
            }

            foreach ($entry in $current) {
                if (Test-IsStatePath -Path $entry.Path -StateDir $Context.StateDir) { continue }
                if (-not (Test-LowLabel -Sddl $entry.Sddl -IsDirectory ([bool]$entry.IsDirectory))) {
                    Write-IntegrityLabel -Path $entry.Path -IsDirectory ([bool]$entry.IsDirectory)
                    $mutations.labelsSet = [int]$mutations.labelsSet + 1
                }
            }

            if ($tempState.Added) {
                $removed = Remove-TemporaryWriteOwnerAce -Path $Context.Repo -Sid $Context.UserSid
                if (-not $removed) {
                    throw (New-SetupException -Message 'Temporary WRITE_OWNER ACE was not found when it was time to remove it.')
                }
                $tempState.Removed = $true
                $tempState.Added = $false
                $mutations.tempWriteOwnerRemoved = $true
            }

            $finalAll = @(Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$true)
            $final = @($finalAll | Where-Object { $snapshotSet.Contains($_.Path) })
            if ($final.Count -ne $snapshotEntries.Count) {
                throw (New-SetupException -Message "Repository tree changed during repair verification (expected $($snapshotEntries.Count), found $($final.Count)).")
            }
            $finalIssues = @(Get-ReadinessIssues -Entries $final -WriteSid $writeSid -StateDir $Context.StateDir)
            if ($finalIssues.Count -gt 0) {
                $first = $finalIssues[0]
                throw (New-SetupException -Message "Repair verification left $($finalIssues.Count) readiness issue(s); first: $($first.RelativePath) $($first.Message)")
            }
            $aceFailures = [Collections.Generic.List[string]]::new()
            foreach ($before in $snapshotEntries) {
                $after = @($final | Where-Object { $_.Path -eq $before.Path })[0]
                if ($null -eq $after) {
                    $aceFailures.Add("object disappeared during repair: $($before.Path)")
                    continue
                }
                if ($after.OwnerSid -ne $before.OwnerSid) {
                    $aceFailures.Add("owner changed during repair: $($before.Path)")
                }
                foreach ($issue in (Get-OriginalAceIssues -Path $before.Path -BeforeSddl $before.Sddl -AfterSddl $after.Sddl)) {
                    $aceFailures.Add($issue)
                }
            }
            if ($aceFailures.Count -gt 0) {
                throw (New-SetupException -Message "Repair verification found $($aceFailures.Count) ownership/ACE issue(s); first: $($aceFailures[0])")
            }

            $rootAfter = @($final | Where-Object { $_.RelativePath -eq '' })[0].Sddl
            $mutations.rootSddlChanged = ($rootAfter -ne $rootBefore)
        } catch {
            $failure = $_.Exception
            $failureContext = $_.InvocationInfo.PositionMessage
        } finally {
            if ($tempState.Added) {
                try {
                    $removed = Remove-TemporaryWriteOwnerAce -Path $Context.Repo -Sid $Context.UserSid
                    if (-not $removed) {
                        $tempState.Error = 'temporary WRITE_OWNER ACE was not found during finally cleanup'
                    } else {
                        $tempState.Removed = $true
                        $mutations.tempWriteOwnerRemoved = $true
                    }
                } catch {
                    $tempState.Error = $_.Exception.Message
                }
            }
        }
    } catch {
        if ($null -eq $failure) { $failure = $_.Exception }
    }

    if ($tempState.Error -and $null -eq $failure) {
        $failure = New-SetupException -Message $tempState.Error
    }

    if ($null -ne $failure) {
        $rollback = [ordered]@{
            attempted = $false
            complete  = $true
            failures  = @()
            note      = 'No permission change was applied before the failure.'
        }
        if ($mutationOccurred) {
            $rollback.attempted = $false
            $rollback.complete = $false
            $rollback.note = ''
            $rollbackSafety = $null
            try {
                [void](Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$true)
            } catch {
                $rollbackSafety = $_.Exception.Message
            }
            if ($rollbackSafety) {
                $rollback.failures = @("rollback refused because the current tree is unsafe: $rollbackSafety")
                $rollback.note = 'No restore was attempted after the current-tree safety check failed.'
            } else {
                $rollback.attempted = $true
                try {
                    $rollbackFailures = @(Restore-AclEntries -Context $Context -Entries $snapshotEntries)
                    $rollback.failures = $rollbackFailures
                    $rollback.complete = ($rollbackFailures.Count -eq 0)
                } catch {
                    $rollback.failures = @($_.Exception.Message)
                    $rollback.complete = $false
                }
            }
        }
        $reportPath = Write-SetupReport -Context $Context -Action 'Repair' -Status 'failed' -Fields ([ordered]@{
                backendVersion = $check.Info.version
                writeSid       = $writeSid
                backup         = $backupPath
                preflightReport = $preflightReport
                objectCount    = $snapshotEntries.Count
                excludedState  = $true
                error          = $failure.Message
                errorContext   = $failureContext
                mutationOccurred = $mutationOccurred
                mutations      = $mutations
                tempWriteOwnerError = $tempState.Error
                rollback       = $rollback
            })
        Write-Host 'DSH Windows sandbox repair'
        Write-Host "backend: $($check.Info.version)"
        Write-Host "RESULT: FAILED"
        Write-Host "error: $($failure.Message)"
        Write-Host "backup preserved: $backupPath"
        Write-Host "report: $reportPath"
        if (-not $mutationOccurred) {
            Write-Host 'rollback: not needed (no permission changes were applied)'
        } elseif ($rollback.complete) {
            Write-Host 'rollback: complete'
        } else {
            Write-Host 'rollback: INCOMPLETE - review every reported path before continuing'
            $limit = [Math]::Min(10, $rollback.failures.Count)
            for ($index = 0; $index -lt $limit; $index++) {
                Write-Host "  - $($rollback.failures[$index])"
            }
            if ($rollback.failures.Count -gt $limit) {
                Write-Host "  ... and $($rollback.failures.Count - $limit) more failure(s); full list in the report"
            }
        }
        Write-Host ('scope: ' + (Get-ReadinessScopeNote))
        return 1
    }

    $reportPath = Write-SetupReport -Context $Context -Action 'Repair' -Status 'success' -Fields ([ordered]@{
            backendVersion = $check.Info.version
            writeSid       = $writeSid
            backup         = $backupPath
            preflightReport = $preflightReport
            objectCount    = $snapshotEntries.Count
            excludedState  = $true
            mutations      = $mutations
            rollback       = [ordered]@{ attempted = $false; complete = $null; failures = @() }
        })
    Write-Host 'DSH Windows sandbox repair'
    Write-Host "backend: $($check.Info.version)"
    Write-Host "workspace SID: $writeSid"
    Write-Host "objects snapshotted: $($snapshotEntries.Count) (.state included in snapshot, excluded from readiness)"
    Write-Host "backup: $backupPath"
    Write-Host "report: $reportPath"
    Write-Host "root grant applied: $($mutations.rootGrantInvoked)"
    Write-Host "extra directory grants: $($mutations.extraDirectoryGrants.Count)"
    Write-Host "labels set: $($mutations.labelsSet)"
    Write-Host 'RESULT: REPAIRED AND VERIFIED'
    Write-Host ('scope: ' + (Get-ReadinessScopeNote))
    return 0
}

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

function Invoke-RestoreAction {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    New-StateDirectories -Context $Context
    $manifest = $null
    try {
        $manifest = Read-RestoreManifest -BackupPath $Context.Backup -RepoRoot $Context.Repo -PackageRoot $Context.Package -MaxObjects $Context.MaxObjects -CurrentUserSid $Context.UserSid
        # Validate the current tree before any root DACL propagation. A hard-link
        # alias or a new junction after backup makes the manifest unsafe to apply.
        [void](Get-TreeEntries -Root $Context.Repo -MaxObjects $Context.MaxObjects -StateDir $Context.StateDir -IncludeState:$true)
    } catch {
        $refusal = $_.Exception.Message
        $reportPath = $null
        try {
            $reportPath = Write-SetupReport -Context $Context -Action 'Restore' -Status 'refused' -Fields ([ordered]@{
                    backup      = $Context.Backup
                    error       = $refusal
                    failures    = @("restore refused before mutation: $refusal")
                    nonLabelSacl = 'not modified'
                })
        } catch {
            $refusal = "$refusal; refusal report could not be written: $($_.Exception.Message)"
        }
        Write-Host 'DSH Windows sandbox restore'
        Write-Host "backup: $($Context.Backup)"
        Write-Host 'RESULT: REFUSED (no permissions changed)'
        Write-Host "error: $refusal"
        if ($reportPath) { Write-Host "report: $reportPath" }
        return 1
    }

    $failures = @(Restore-AclEntries -Context $Context -Entries $manifest.Entries)
    if ($failures.Count -gt 0) {
        $reportPath = Write-SetupReport -Context $Context -Action 'Restore' -Status 'failed' -Fields ([ordered]@{
                backup      = $manifest.BackupPath
                objectCount = $manifest.Entries.Count
                failures    = $failures
                nonLabelSacl = 'not modified; label-only native APIs leave non-label SACL entries intact'
            })
        Write-Host 'DSH Windows sandbox restore'
        Write-Host "backup: $($manifest.BackupPath)"
        Write-Host 'RESULT: FAILED (restore incomplete)'
        foreach ($failure in $failures) { Write-Host "  - $failure" }
        Write-Host "report: $reportPath"
        return 1
    }

    $reportPath = Write-SetupReport -Context $Context -Action 'Restore' -Status 'success' -Fields ([ordered]@{
            backup      = $manifest.BackupPath
            objectCount = $manifest.Entries.Count
            failures    = @()
            nonLabelSacl = 'not modified; label-only native APIs leave non-label SACL entries intact'
        })
    Write-Host 'DSH Windows sandbox restore'
    Write-Host "backup: $($manifest.BackupPath)"
    Write-Host "objects restored: $($manifest.Entries.Count)"
    Write-Host "report: $reportPath"
    Write-Host 'RESULT: RESTORED'
    return 0
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

function Get-VerifyResultLine {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Stdout)
    $result = $null
    foreach ($line in ($Stdout -split "\r?\n")) {
        if ($line -match '^VERIFY_RESULT:\s*(\{.*\})\s*$') {
            try { $result = $Matches[1] | ConvertFrom-Json } catch { $result = $null }
        }
    }
    return $result
}

function Invoke-VerifyAction {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    $node = Assert-NodeRuntime
    $check = Get-SetupCheck -Context $Context
    if (-not $check.Ready) {
        Write-Host 'DSH Windows sandbox verify'
        Write-Host 'RESULT: NOT RUN (workspace is not ready)'
        Write-Host "permission issues: $($check.Issues.Count)"
        Write-Host 'Repair:'
        Write-Host ('  ' + (Get-RepairCommand -Repo $Context.Repo))
        Write-Host 'Verify never repairs missing workspace permissions.'
        return 1
    }

    $beforeRootSddl = @($check.Entries | Where-Object { $_.RelativePath -eq '' })[0].Sddl
    $verifyScript = Join-Path $Context.Package 'windows\lib\verify-run.ps1'
    $nodeTest = Join-Path $Context.Package 'windows\lib\verify-node.mjs'
    if (-not [IO.File]::Exists($verifyScript)) { throw (New-SetupException -Message "Verify helper is missing: $verifyScript") }
    if (-not [IO.File]::Exists($nodeTest)) { throw (New-SetupException -Message "Verify Node fixture is missing: $nodeTest") }

    New-StateDirectories -Context $Context
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (Test-UnderPath -Path $tempRoot -Root $Context.Repo) {
        throw (New-SetupException -Message "Ambient temp ($tempRoot) is inside the repository; cannot create an outside-workspace sentinel.")
    }
    $sentinelRoot = Join-Path $tempRoot ('dsh-windows-verify-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $sentinelRoot | Out-Null
    $sentinel = Join-Path $sentinelRoot 'outside-sentinel.txt'
    $sentinelContent = 'dsh-outside-sentinel-' + [guid]::NewGuid().ToString('N')
    Write-Utf8File -Path $sentinel -Text $sentinelContent
    Assert-NoReparseAncestors -Path $sentinel

    $stdoutLog = Join-Path (Join-Path $Context.StateDir 'logs') ("{0}-verify-runner.out.log" -f $Context.Stamp)
    $stderrLog = Join-Path (Join-Path $Context.StateDir 'logs') ("{0}-verify-runner.err.log" -f $Context.Stamp)
    $runner = Join-Path $Context.Install.Path 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js'
    $runnerArguments = @(
        '--workspace', $Context.Repo,
        '--temp', $tempRoot,
        '--mode', 'workspace-write',
        '--',
        'pwsh', '-NoProfile', '-NonInteractive', '-File', $verifyScript,
        '-Repo', $Context.Repo,
        '-Package', $Context.Package,
        '-OutsideFile', $sentinel,
        '-NodeTest', $nodeTest,
        '-NodeExe', $node.Path
    )

    $run = $null
    $verifyResult = $null
    $runError = $null
    $sentinelUnchanged = $false
    $permissionsUnchanged = $false
    $readyAfter = $false
    $cleanupError = $null
    try {
        $run = Invoke-ElectronNode -InstallDir $Context.Install.Path -ScriptPath $runner -Arguments $runnerArguments -TimeoutSeconds 300 -StdoutPath $stdoutLog -StderrPath $stderrLog
        $verifyResult = Get-VerifyResultLine -Stdout $run.Stdout
        $currentSentinel = [IO.File]::ReadAllText($sentinel)
        $sentinelUnchanged = ($currentSentinel -eq $sentinelContent)
        try {
            $afterRootSddl = Read-SecurityDescriptor -Path $Context.Repo
            $permissionsUnchanged = ($afterRootSddl -eq $beforeRootSddl)
            $afterCheck = Get-SetupCheck -Context $Context
            $readyAfter = [bool]$afterCheck.Ready
        } catch {
            $runError = $_.Exception.Message
        }
    } catch {
        $runError = $_.Exception.Message
    } finally {
        try {
            if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel -Force }
            if (Test-Path -LiteralPath $sentinelRoot) { Remove-Item -LiteralPath $sentinelRoot -Recurse -Force }
        } catch {
            $cleanupError = $_.Exception.Message
        }
    }

    $checksPassed = $false
    if ($null -ne $verifyResult -and $null -ne $verifyResult.PSObject.Properties['ok']) {
        $checksPassed = [bool]$verifyResult.ok
    }
    $ok = ($null -eq $runError) -and ($null -ne $run) -and (-not $run.TimedOut) -and ($run.ExitCode -eq 0) -and $checksPassed -and $sentinelUnchanged -and $permissionsUnchanged -and $readyAfter -and ($null -eq $cleanupError)

    $reportPath = Write-SetupReport -Context $Context -Action 'Verify' -Status ($(if ($ok) { 'success' } else { 'failed' })) -Fields ([ordered]@{
            backendVersion       = $check.Info.version
            writeSid             = $check.Info.writeSid
            nodeVersion          = $node.Version
            mode                 = 'workspace-write'
            sentinel             = $sentinel
            sentinelUnchanged    = $sentinelUnchanged
            permissionsUnchanged = $permissionsUnchanged
            readyAfter           = $readyAfter
            cleanupError         = $cleanupError
            runnerExitCode       = if ($null -ne $run) { $run.ExitCode } else { $null }
            runnerTimedOut       = if ($null -ne $run) { $run.TimedOut } else { $null }
            error                = $runError
            checks               = if ($null -ne $verifyResult) { $verifyResult.checks } else { @() }
            projectTestsRun      = $false
            stdoutLog            = $stdoutLog
            stderrLog            = $stderrLog
        })

    Write-Host 'DSH Windows sandbox verify'
    Write-Host "backend: $($check.Info.version)"
    Write-Host "workspace SID: $($check.Info.writeSid)"
    Write-Host "node: $($node.Version)"
    Write-Host 'mode: workspace-write (installed DSH runner)'
    if ($null -ne $verifyResult -and $null -ne $verifyResult.PSObject.Properties['checks']) {
        foreach ($item in @($verifyResult.checks)) {
            $state = if ($item.pass) { 'PASS' } else { 'FAIL' }
            Write-Host ("  [{0}] {1}: {2}" -f $state, $item.name, $item.detail)
        }
    }
    Write-Host "outside sentinel unchanged: $sentinelUnchanged"
    Write-Host "workspace root permissions unchanged: $permissionsUnchanged"
    Write-Host "readiness after verify: $readyAfter"
    if ($cleanupError) { Write-Host "sentinel cleanup error: $cleanupError" }
    if ($runError) { Write-Host "verify error: $runError" }
    Write-Host "full log: $stdoutLog"
    Write-Host "full stderr log: $stderrLog"
    Write-Host "report: $reportPath"
    Write-Host 'note: this is a sandbox smoke test; it does not report project tests as passed.'
    if ($ok) {
        Write-Host 'RESULT: PASS'
        return 0
    }
    Write-Host 'RESULT: FAIL'
    if ($run -and $run.Stderr) {
        Write-Host 'runner stderr tail:'
        Write-Host (($run.Stderr -split "\r?\n" | Select-Object -Last 12) -join [Environment]::NewLine)
    }
    return 1
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

function Invoke-SetupAction {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)
    switch ($Context.Action) {
        'Check' { return Invoke-CheckAction -Context $Context }
        'Repair' { return Invoke-RepairAction -Context $Context }
        'Verify' { return Invoke-VerifyAction -Context $Context }
        'Restore' { return Invoke-RestoreAction -Context $Context }
        default { throw (New-SetupException -Message "Unsupported action: $($Context.Action)" -ExitCode 2) }
    }
}

