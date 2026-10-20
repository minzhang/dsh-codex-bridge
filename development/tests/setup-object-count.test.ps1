#Requires -Version 7.0
# Object-count regression tests for the 28,000 default. These use only a unique
# disposable host-temp fixture: no repository ACL repair and no mutation outside
# the verified fixture root.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridge = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dsh-codex-bridge'

$failures = [Collections.Generic.List[string]]::new()
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { $script:failures.Add($Message) }
}
function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    try {
        & $Action | Out-Null
        $script:failures.Add("$Message (did not throw)")
    } catch {
        if ($_.Exception.Message -notmatch $Pattern) {
            $script:failures.Add("$Message (wrong error: $($_.Exception.Message))")
        }
    }
}
function Assert-LimitError {
    param([scriptblock]$Action, [int]$Cap, [string]$Message)
    try {
        & $Action | Out-Null
        $script:failures.Add("$Message (did not throw)")
    } catch {
        $text = $_.Exception.Message
        if ($text -notmatch 'safety limit') {
            $script:failures.Add("$Message (missing safety-limit wording: $text)")
        }
        if ($text -notmatch [regex]::Escape("$Cap-object")) {
            $script:failures.Add("$Message (does not name active cap ${Cap}: $text)")
        }
        if ($text -notmatch [regex]::Escape('-MaxObjects 50000')) {
            $script:failures.Add("$Message (does not suggest a larger -MaxObjects: $text)")
        }
    }
}

$base = Join-Path ([IO.Path]::GetTempPath()) ('dsh-object-count-' + [guid]::NewGuid().ToString('N'))
$expectedDefault = 28000
$largeLimit = 50000
$fileCount28001 = 27998 # root + package directory + bulk directory make the other three objects.
try {
    $repo = Join-Path $base 'repo'
    $package = Join-Path $repo 'bridge'
    $bulk = Join-Path $repo 'bulk'
    $stateBackups = Join-Path $package '.state\backups'
    New-Item -ItemType Directory -Force -Path $package, $stateBackups, $bulk | Out-Null
    . (Join-Path $bridge 'windows\lib\interop.ps1')
    . (Join-Path $bridge 'windows\lib\setup-lib.ps1')
    $script:CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

    # The public setup script must document the same default before any full scan.
    $setupScriptPath = Join-Path $bridge 'windows\setup.ps1'
    $tokens = $null
    $parseErrors = $null
    $setupAst = [System.Management.Automation.Language.Parser]::ParseFile($setupScriptPath, [ref]$tokens, [ref]$parseErrors)
    Assert-True -Condition ($parseErrors.Count -eq 0) -Message "setup.ps1 did not parse: $($parseErrors -join '; ')"
    if ($parseErrors.Count -eq 0 -and $null -ne $setupAst.ParamBlock) {
        $maxObjectParameters = @($setupAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'MaxObjects' })
        Assert-True -Condition ($maxObjectParameters.Count -eq 1) -Message 'setup.ps1 must expose one MaxObjects parameter'
        if ($maxObjectParameters.Count -eq 1) {
            Assert-True -Condition ($maxObjectParameters[0].StaticType.FullName -eq 'System.Int32') -Message 'setup.ps1 MaxObjects must be an Int32 parameter'
            Assert-True -Condition ($maxObjectParameters[0].DefaultValue.Extent.Text -eq [string]$expectedDefault) -Message "setup.ps1 public MaxObjects default was '$($maxObjectParameters[0].DefaultValue.Extent.Text)', expected $expectedDefault"
        }
    }

    $originalPackageRoot = $script:PackageRoot
    try {
        $script:PackageRoot = $package
        $probeManifest = Join-Path $stateBackups 'default-probe.json'
        $defaultContext = New-SetupContext -Repo $repo -Action Restore -Apply $true -Backup $probeManifest
    } finally {
        $script:PackageRoot = $originalPackageRoot
    }
    $defaultMaxObjects = [int]$defaultContext.MaxObjects
    Assert-True -Condition ($defaultMaxObjects -eq $expectedDefault) -Message "New-SetupContext default MaxObjects was $defaultMaxObjects, expected $expectedDefault"
    if ($parseErrors.Count -eq 0 -and $null -ne $setupAst.ParamBlock -and @($setupAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'MaxObjects' }).Count -eq 1) {
        $publicDefault = @($setupAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'MaxObjects' })[0].DefaultValue.Extent.Text
        Assert-True -Condition ($publicDefault -eq [string]$defaultMaxObjects) -Message "setup.ps1 public default $publicDefault does not match context default $defaultMaxObjects"
    }

    for ($index = 0; $index -lt $fileCount28001; $index++) {
        $path = Join-Path $bulk ('item-{0:D5}.txt' -f $index)
        [IO.File]::WriteAllText($path, 'fixture')
    }

    # 28,001 objects: a larger explicit cap succeeds for both tree and manifest.
    $entries28001 = @(Get-TreeEntries -Root $repo -MaxObjects $largeLimit -StateDir (Join-Path $package '.state') -IncludeState:$false)
    Assert-True -Condition ($entries28001.Count -eq 28001) -Message "large-cap tree enumeration returned $($entries28001.Count), expected 28001"
    Assert-True -Condition ($entries28001.Count -gt 10000) -Message 'tree enumeration did not exceed 10,000 objects'
    Assert-True -Condition (@($entries28001 | Where-Object { -not $_.IsDirectory }).Count -eq $fileCount28001) -Message 'tree enumeration did not return every fixture file'

    $objects28001 = @($entries28001 | ForEach-Object {
            [ordered]@{
                relativePath = $_.RelativePath
                path         = $_.Path
                isDirectory  = $_.IsDirectory
                sddl         = $_.Sddl
                ownerSid     = $_.OwnerSid
            }
        })
    $manifest28001 = Join-Path $stateBackups 'objects-28001.json'
    Write-JsonFile -Path $manifest28001 -Object ([ordered]@{
            schemaVersion  = 1
            repoRoot       = $repo
            currentUserSid = $script:CurrentUserSid
            objectCount    = $objects28001.Count
            objects        = $objects28001
        })

    $loaded28001 = Read-RestoreManifest -BackupPath $manifest28001 -RepoRoot $repo -PackageRoot $package -MaxObjects $largeLimit -CurrentUserSid $script:CurrentUserSid
    Assert-True -Condition ($loaded28001.Entries.Count -eq 28001) -Message "large-cap restore-manifest loading returned $($loaded28001.Entries.Count), expected 28001"

    # Explicit zero must remain unlimited on the same 28,001-object fixture.
    $zeroEntries28001 = @(Get-TreeEntries -Root $repo -MaxObjects 0 -StateDir (Join-Path $package '.state') -IncludeState:$false)
    Assert-True -Condition ($zeroEntries28001.Count -eq 28001) -Message "explicit-zero tree enumeration returned $($zeroEntries28001.Count), expected 28001"
    Assert-True -Condition ($zeroEntries28001.Count -gt 10000) -Message 'explicit-zero tree enumeration did not exceed 10,000 objects'
    Assert-True -Condition (@($zeroEntries28001 | Where-Object { -not $_.IsDirectory }).Count -eq $fileCount28001) -Message 'explicit-zero tree enumeration did not return every fixture file'

    $zeroLoaded28001 = Read-RestoreManifest -BackupPath $manifest28001 -RepoRoot $repo -PackageRoot $package -MaxObjects 0 -CurrentUserSid $script:CurrentUserSid
    Assert-True -Condition ($zeroLoaded28001.Entries.Count -eq 28001) -Message "explicit-zero restore-manifest loading returned $($zeroLoaded28001.Entries.Count), expected 28001"
    Assert-True -Condition ($zeroLoaded28001.Entries.Count -gt 10000) -Message 'explicit-zero restore-manifest loading did not exceed 10,000 objects'
    Assert-True -Condition (@($zeroLoaded28001.Entries | Where-Object { -not $_.IsDirectory }).Count -eq $fileCount28001) -Message 'explicit-zero restore-manifest loading did not return every fixture file'

    # 28,001 objects: the real setup default must reject both paths.
    Assert-LimitError -Action {
        Get-TreeEntries -Root $repo -MaxObjects $defaultMaxObjects -StateDir (Join-Path $package '.state') -IncludeState:$false
    } -Cap $defaultMaxObjects -Message 'default tree limit should reject 28,001 objects'

    Assert-LimitError -Action {
        Read-RestoreManifest -BackupPath $manifest28001 -RepoRoot $repo -PackageRoot $package -MaxObjects $defaultMaxObjects -CurrentUserSid $script:CurrentUserSid
    } -Cap $defaultMaxObjects -Message 'default restore-manifest limit should reject 28,001 objects'

    # 28,000 objects exactly: the real setup default must succeed for both paths.
    $removedPath = Join-Path $bulk ('item-{0:D5}.txt' -f ($fileCount28001 - 1))
    Remove-Item -LiteralPath $removedPath -Force
    $fileCount28000 = $fileCount28001 - 1

    $entries28000 = @(Get-TreeEntries -Root $repo -MaxObjects $defaultMaxObjects -StateDir (Join-Path $package '.state') -IncludeState:$false)
    Assert-True -Condition ($entries28000.Count -eq 28000) -Message "default-cap tree enumeration returned $($entries28000.Count), expected 28000"
    Assert-True -Condition ($entries28000.Count -gt 10000) -Message '28,000-object tree is not above 10,000 objects'
    Assert-True -Condition (@($entries28000 | Where-Object { -not $_.IsDirectory }).Count -eq $fileCount28000) -Message '28,000-object tree did not return every fixture file'

    $objects28000 = @($entries28000 | ForEach-Object {
            [ordered]@{
                relativePath = $_.RelativePath
                path         = $_.Path
                isDirectory  = $_.IsDirectory
                sddl         = $_.Sddl
                ownerSid     = $_.OwnerSid
            }
        })
    $manifest28000 = Join-Path $stateBackups 'objects-28000.json'
    Write-JsonFile -Path $manifest28000 -Object ([ordered]@{
            schemaVersion  = 1
            repoRoot       = $repo
            currentUserSid = $script:CurrentUserSid
            objectCount    = $objects28000.Count
            objects        = $objects28000
        })

    $loaded28000 = Read-RestoreManifest -BackupPath $manifest28000 -RepoRoot $repo -PackageRoot $package -MaxObjects $defaultMaxObjects -CurrentUserSid $script:CurrentUserSid
    Assert-True -Condition ($loaded28000.Entries.Count -eq 28000) -Message "default-cap restore-manifest loading returned $($loaded28000.Entries.Count), expected 28000"

    # Zero remains an explicit unlimited opt-out, and small finite limits still reject.
    $smallRepo = Join-Path $base 'small repo'
    $smallPackage = Join-Path $smallRepo 'bridge'
    $smallBulk = Join-Path $smallRepo 'bulk'
    $smallBackups = Join-Path $smallPackage '.state\backups'
    New-Item -ItemType Directory -Force -Path $smallBackups, $smallBulk | Out-Null
    for ($index = 0; $index -lt 3; $index++) {
        [IO.File]::WriteAllText((Join-Path $smallBulk ('small-{0}.txt' -f $index)), 'fixture')
    }
    $smallEntries = @(Get-TreeEntries -Root $smallRepo -MaxObjects 0 -StateDir (Join-Path $smallPackage '.state') -IncludeState:$false)
    Assert-True -Condition ($smallEntries.Count -eq 6) -Message "explicit-zero tree enumeration returned $($smallEntries.Count), expected 6"
    $smallObjects = @($smallEntries | ForEach-Object {
            [ordered]@{
                relativePath = $_.RelativePath
                path         = $_.Path
                isDirectory  = $_.IsDirectory
                sddl         = $_.Sddl
                ownerSid     = $_.OwnerSid
            }
        })
    $smallManifest = Join-Path $smallBackups 'small.json'
    Write-JsonFile -Path $smallManifest -Object ([ordered]@{
            schemaVersion  = 1
            repoRoot       = $smallRepo
            currentUserSid = $script:CurrentUserSid
            objectCount    = $smallObjects.Count
            objects        = $smallObjects
        })
    $smallLoaded = Read-RestoreManifest -BackupPath $smallManifest -RepoRoot $smallRepo -PackageRoot $smallPackage -MaxObjects 0 -CurrentUserSid $script:CurrentUserSid
    Assert-True -Condition ($smallLoaded.Entries.Count -eq 6) -Message "explicit-zero restore-manifest loading returned $($smallLoaded.Entries.Count), expected 6"

    Assert-Throws -Action {
        Get-TreeEntries -Root $smallRepo -MaxObjects 2 -StateDir (Join-Path $smallPackage '.state') -IncludeState:$false
    } -Pattern 'safety limit' -Message 'small finite tree limit should still reject'
    Assert-Throws -Action {
        Read-RestoreManifest -BackupPath $smallManifest -RepoRoot $smallRepo -PackageRoot $smallPackage -MaxObjects 2 -CurrentUserSid $script:CurrentUserSid
    } -Pattern 'safety limit' -Message 'small finite restore-manifest limit should still reject'

    # A negative limit must fail before setup mutates the selected repository.
    $negativeRepo = Join-Path $base 'negative repo'
    $negativePackage = Join-Path $negativeRepo 'bridge'
    $negativeWindows = Join-Path $negativePackage 'windows'
    New-Item -ItemType Directory -Force -Path $negativeWindows | Out-Null
    Copy-Item -LiteralPath (Join-Path $bridge 'windows\setup.ps1') -Destination (Join-Path $negativeWindows 'setup.ps1')
    Copy-Item -LiteralPath (Join-Path $bridge 'windows\lib') -Destination $negativeWindows -Recurse
    $negativeState = Join-Path $negativePackage '.state'

    Assert-Throws -Action {
        New-SetupContext -Repo $negativeRepo -Action Check -MaxObjects -1
    } -Pattern 'must be zero.*positive integer' -Message 'negative MaxObjects should be rejected before setup context creation'
    Assert-True -Condition (-not (Test-Path -LiteralPath $negativeState)) -Message 'negative MaxObjects created .state before failing'

    $pwshExe = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $pwshExe -PathType Leaf)) {
        $pwshExe = (Get-Command pwsh -ErrorAction Stop).Source
    }
    $negativeOutput = @(& $pwshExe -NoProfile -NonInteractive -File (Join-Path $negativeWindows 'setup.ps1') -Repo $negativeRepo -Action Check -MaxObjects -1 2>&1)
    $negativeExit = $LASTEXITCODE
    Assert-True -Condition ($negativeExit -eq 2) -Message "negative MaxObjects process exit was $negativeExit, expected 2"
    Assert-True -Condition (($negativeOutput -join "`n") -match 'must be zero.*positive integer') -Message 'negative MaxObjects process did not report the expected validation error'
    Assert-True -Condition (-not (Test-Path -LiteralPath $negativeState)) -Message 'negative MaxObjects process created .state before failing'
} finally {
    if (Test-Path -LiteralPath $base) {
        $fullBase = [IO.Path]::GetFullPath($base)
        $fullTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($fullBase.StartsWith($fullTemp, [StringComparison]::OrdinalIgnoreCase) -and
            -not $fullBase.Equals($fullTemp, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $fullBase -Recurse -Force
        } else {
            $failures.Add("refusing to remove unexpected cleanup target: $fullBase")
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Output "FAIL: $($failures.Count) object-count assertion(s) failed"
    foreach ($failure in $failures) { Write-Output "  - $failure" }
    exit 1
}
Write-Output "PASS: 28,000-object default success, 28,001 default rejection with -MaxObjects guidance, 28,001 at 50000, explicit zero/unlimited, small finite-limit and pre-mutation negative-limit checks"
