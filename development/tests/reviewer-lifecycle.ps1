#Requires -Version 7.0
# Host-only integration acceptance. Creates and retains a disposable copied repo in a
# unique host system-temp directory; development/.state holds only an evidence pointer.
# It never repairs the containing project.
param([string]$InstallDir = '', [switch]$RequireTemporaryWriteOwner)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows host required.' }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$packageRoot = Join-Path $repoRoot 'dsh-codex-bridge'
$stateRoot = Join-Path $repoRoot 'development\.state'
$hostTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')

. (Join-Path $packageRoot 'windows\lib\interop.ps1')
$canonicalTempRoot = Get-CanonicalPath -Path $hostTempRoot
$canonicalRepoRoot = Get-CanonicalPath -Path $repoRoot
$runId = [guid]::NewGuid().ToString('N')
$reviewRoot = [IO.Path]::GetFullPath((Join-Path $canonicalTempRoot ('dsh-bridge-lifecycle-' + $runId)))
Assert-NoReparseAncestors -Path $reviewRoot

function Test-UnderRoot {
    param([string]$Path, [string]$Root)
    $normalizedPath = [IO.Path]::GetFullPath($Path)
    $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($normalizedPath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $normalizedPath.StartsWith($normalizedRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

if (-not (Test-UnderRoot -Path $reviewRoot -Root $canonicalTempRoot)) {
    throw "Lifecycle review root must be under the host temp root '$canonicalTempRoot': $reviewRoot"
}
if (Test-UnderRoot -Path $reviewRoot -Root $canonicalRepoRoot) {
    throw "Lifecycle review root must be outside the repository '$canonicalRepoRoot': $reviewRoot"
}
if (Test-Path -LiteralPath $reviewRoot) {
    throw "Refusing to reuse an existing lifecycle review root: $reviewRoot"
}

$scenario = if ($RequireTemporaryWriteOwner) { 'temporary-write-owner' } else { 'default' }
$pointerPath = Join-Path $stateRoot ('lifecycle-' + $runId + '.json')
$fixtureRepo = Join-Path $reviewRoot 'Fresh repo with spaces'
$copy = Join-Path $fixtureRepo 'dsh-codex-bridge'
$resultPath = Join-Path $reviewRoot 'result.json'

function Write-EvidencePointer {
    param([string]$Status, [string]$ErrorText = '')
    try {
        New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
        [ordered]@{
            schemaVersion = 1
            scenario = $scenario
            status = $Status
            reviewRoot = $reviewRoot
            result = $resultPath
            resultExists = Test-Path -LiteralPath $resultPath -PathType Leaf
            error = $ErrorText
            recordedUtc = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $pointerPath
        Write-Output "Evidence pointer: $pointerPath"
    } catch {
        Write-Warning "Could not write lifecycle evidence pointer ${pointerPath}: $($_.Exception.Message)"
    }
}

try {
    New-Item -ItemType Directory -Path $copy -Force | Out-Null
    foreach ($item in (Get-ChildItem -LiteralPath $packageRoot -Force)) {
        if ($item.Name -eq '.state') { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package contains a reparse point.' }
        Copy-Item -LiteralPath $item.FullName -Destination $copy -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $fixtureRepo 'src\nested') -Force | Out-Null
    $existing = Join-Path $fixtureRepo 'src\nested\existing.txt'
    [IO.File]::WriteAllText($existing, 'portable-existing-content')
    & git -C $fixtureRepo init --initial-branch=main *> (Join-Path $reviewRoot 'git-init.log')
    if ($LASTEXITCODE -ne 0) { throw 'Fixture git init failed.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    # Existing FullControl exercises preservation of an existing user grant. Medium
    # labels reproduce a pre-existing tree that a Low-integrity child cannot write.
    & icacls $fixtureRepo /grant "*${sid}:(OI)(CI)F" /Q *> (Join-Path $reviewRoot 'fixture-grant.log')
    if ($LASTEXITCODE -ne 0) { throw 'Fixture permission preparation failed.' }
    & icacls $fixtureRepo /setintegritylevel '(OI)(CI)M' /T /Q *> (Join-Path $reviewRoot 'fixture-labels.log')
    if ($LASTEXITCODE -ne 0) { throw 'Fixture integrity-label preparation failed.' }
    . (Join-Path $copy 'windows\lib\interop.ps1')
    if ($RequireTemporaryWriteOwner) {
        # Host temp commonly grants inherited FullControl. Prepare only this fresh
        # fixture's outer container so the copied repo inherits Modify. The repo
        # itself must retain an unprotected DACL, as required by the bridge.
        # Keep other principals, denies, owner and Medium labels. Snapshot afterward.
        Assert-NoReparseAncestors -Path $reviewRoot
        if (-not (Test-UnderRoot -Path $fixtureRepo -Root $reviewRoot)) {
            throw 'Permission fixture must remain inside this disposable review root.'
        }
        $fixtureAcl = Get-Acl -LiteralPath $reviewRoot
        $fixtureAcl.SetAccessRuleProtection($true, $true)
        # Persist conversion before enumerating explicit rules. The in-memory ACL
        # can still mark converted entries as inherited until it is reloaded.
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($reviewRoot), $fixtureAcl)
        $fixtureAcl = Get-Acl -LiteralPath $reviewRoot
        foreach ($rule in @($fixtureAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
            if ($rule.IdentityReference.Value -eq $sid -and
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
                $fixtureAcl.RemoveAccessRuleSpecific($rule)
            }
        }
        $fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),
            [Security.AccessControl.FileSystemRights]::Modify,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
        # Persist only the modified DACL; PowerShell Set-Acl can try to resolve
        # unrelated domain account names when it processes the full descriptor.
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($reviewRoot), $fixtureAcl)
        & icacls $fixtureRepo /remove:g "*$sid" /Q *> (Join-Path $reviewRoot 'fixture-remove-grant.log')
        if ($LASTEXITCODE -ne 0) { throw 'Fixture provisioning-grant removal failed.' }
        . (Join-Path $copy 'windows\lib\setup-lib.ps1')
        if (Test-UserHasWriteOwner -Path $fixtureRepo -Sid $sid) { throw 'Fixture still has WRITE_OWNER; temporary-rights branch would not be tested.' }
    }
    $before = @()
    foreach ($item in (@(Get-Item -LiteralPath $fixtureRepo) + @(Get-ChildItem -LiteralPath $fixtureRepo -Recurse -Force))) {
        $before += [ordered]@{ path=$item.FullName; sddl=[DshPortableAcl]::Read($item.FullName) }
    }
    $before | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $reviewRoot 'before.json')
    $setup = Join-Path $copy 'windows\setup.ps1'
    function Invoke-FixtureSetup([string]$Name, [string[]]$SetupArguments, [int]$Expected = 0) {
        $arguments = @('-NoProfile','-File',$setup,'-Repo',$fixtureRepo) + $SetupArguments
        if ($InstallDir) { $arguments += @('-InstallDir',$InstallDir) }
        $log = Join-Path $reviewRoot ($Name + '.log')
        & pwsh @arguments *> $log
        $code = $LASTEXITCODE
        if ($Expected -eq -1) {
            if ($code -eq 0) { throw "$Name unexpectedly succeeded; see $log" }
        } elseif ($code -ne $Expected) {
            Get-Content -LiteralPath $log -Tail 20 | Write-Output
            throw "$Name exited $code; expected $Expected; see $log"
        }
        Write-Output "PASS $Name (exit $code)"
    }
    Invoke-FixtureSetup 'check-before' @('-Action','Check') -1
    Invoke-FixtureSetup 'repair' @('-Action','Repair','-Apply')
    Invoke-FixtureSetup 'check-after' @('-Action','Check')
    Invoke-FixtureSetup 'verify' @('-Action','Verify')
    $ready = @($before | ForEach-Object { [ordered]@{path=$_.path;sddl=[DshPortableAcl]::Read($_.path)} })
    Invoke-FixtureSetup 'repair-again' @('-Action','Repair','-Apply')
    foreach ($entry in $ready) {
        if ([DshPortableAcl]::Read($entry.path) -ne $entry.sddl) { throw "No-op repair changed permissions: $($entry.path)" }
    }
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $copy '.state\backups') -Filter '*-acl.json')
    if ($backups.Count -ne 1) { throw "Expected one repair backup, got $($backups.Count)." }
    # A new alias after backup must be rejected before root permission propagation.
    $alias = Join-Path $reviewRoot 'outside-hardlink.txt'
    New-Item -ItemType HardLink -Path $alias -Target $existing | Out-Null
    $aliasDescriptor = [DshPortableAcl]::Read($alias)
    Invoke-FixtureSetup 'restore-refuses-new-hardlink' @('-Action','Restore','-Backup',$backups[0].FullName,'-Apply') -1
    if ([DshPortableAcl]::Read($alias) -ne $aliasDescriptor) { throw 'Refused restore changed the outside hard-link descriptor.' }
    foreach ($entry in $ready) {
        if ([DshPortableAcl]::Read($entry.path) -ne $entry.sddl) { throw "Refused restore changed permissions: $($entry.path)" }
    }
    Remove-Item -LiteralPath $alias -Force
    $outsideDirectory = Join-Path $reviewRoot 'outside-junction-target'
    New-Item -ItemType Directory -Path $outsideDirectory | Out-Null
    $outsideDescriptor = [DshPortableAcl]::Read($outsideDirectory)
    $junction = Join-Path $fixtureRepo 'new-junction'
    New-Item -ItemType Junction -Path $junction -Target $outsideDirectory | Out-Null
    Invoke-FixtureSetup 'restore-refuses-new-junction' @('-Action','Restore','-Backup',$backups[0].FullName,'-Apply') -1
    if ([DshPortableAcl]::Read($outsideDirectory) -ne $outsideDescriptor) { throw 'Refused restore changed the outside junction target.' }
    foreach ($entry in $ready) {
        if ([DshPortableAcl]::Read($entry.path) -ne $entry.sddl) { throw "Refused restore changed permissions: $($entry.path)" }
    }
    if ([IO.Path]::GetDirectoryName($junction) -ne $fixtureRepo -or -not ((Get-Item -LiteralPath $junction).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Unexpected junction cleanup target.'
    }
    Remove-Item -LiteralPath $junction -Force
    Invoke-FixtureSetup 'restore' @('-Action','Restore','-Backup',$backups[0].FullName,'-Apply')
    foreach ($entry in $before) {
        if ([DshPortableAcl]::Read($entry.path) -ne $entry.sddl) { throw "Restore descriptor mismatch: $($entry.path)" }
    }
    Invoke-FixtureSetup 'check-restored' @('-Action','Check') -1
    if ([IO.File]::ReadAllText($existing) -ne 'portable-existing-content') { throw 'Product fixture content changed.' }
    [ordered]@{pass=$true;repo=$fixtureRepo;copiedPackage=$copy;originalDescriptorsRestored=$before.Count;temporaryWriteOwnerRequired=[bool]$RequireTemporaryWriteOwner;phase='setup only'} |
        ConvertTo-Json | Set-Content -LiteralPath $resultPath
    Write-EvidencePointer -Status 'accepted'
    Write-Output "ACCEPTED: copied package repair/verify/no-op/restore. Evidence: $reviewRoot"
} catch {
    Write-EvidencePointer -Status 'failed' -ErrorText $_.Exception.Message
    Write-Output "FAILED; disposable repository and recovery evidence retained at $reviewRoot"
    throw
}
