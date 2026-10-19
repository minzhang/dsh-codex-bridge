#Requires -Version 7.0
# Package-level boundary tests. These are read-only for repository permissions:
# they create files/junctions/hard links only in a disposable temp fixture.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridge = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dsh-codex-bridge'
. (Join-Path $bridge 'windows\lib\interop.ps1')
. (Join-Path $bridge 'windows\lib\setup-lib.ps1')
$script:CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

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

$base = Join-Path ([IO.Path]::GetTempPath()) ('dsh-boundaries-' + [guid]::NewGuid().ToString('N'))
$junctions = [Collections.Generic.List[string]]::new()
try {
    $repo = Join-Path $base 'repo'
    $package = Join-Path $repo 'bridge'
    $stateBackups = Join-Path $package '.state\backups'
    New-Item -ItemType Directory -Force -Path $stateBackups | Out-Null
    $file = Join-Path $repo 'file.txt'
    Set-Content -LiteralPath $file -Value 'fixture' -NoNewline

    # Path containment is path-component-aware, not a string-prefix check.
    Assert-True -Condition (Test-UnderPath -Path (Join-Path $repo 'child') -Root $repo) -Message 'child should be under root'
    Assert-True -Condition (Test-UnderPath -Path $repo -Root $repo) -Message 'root should be under itself'
    Assert-True -Condition (-not (Test-UnderPath -Path ($repo + '2') -Root $repo)) -Message 'sibling prefix must not count as under root'
    Assert-True -Condition (Test-UnderPath -Path (Join-Path $repo 'child') -Root $repo.ToUpperInvariant()) -Message 'containment should be case-insensitive'
    Assert-True -Condition (Test-IsStatePath -Path (Join-Path $package '.state\backups\a.json') -StateDir (Join-Path $package '.state')) -Message '.state descendant should be recognized'
    Assert-True -Condition (-not (Test-IsStatePath -Path (Join-Path $package '.state2') -StateDir (Join-Path $package '.state'))) -Message 'sibling .state2 must not be excluded'

    # Forbidden-root checks use the actual environment but only inspect paths.
    $driveRoot = [IO.Path]::GetPathRoot($base)
    Assert-Throws -Action { Assert-NotForbiddenRoot -Path $driveRoot -Label 'Repository' } -Pattern 'drive root|protected root|dedicated' -Message 'drive root should be rejected'
    Assert-Throws -Action { Assert-NotForbiddenRoot -Path ([IO.Path]::GetTempPath()) -Label 'Repository' } -Pattern 'protected root|dedicated' -Message 'temp root should be rejected'
    Assert-Throws -Action { Assert-NotForbiddenRoot -Path $env:USERPROFILE -Label 'Repository' } -Pattern 'protected root|dedicated' -Message 'home should be rejected'

    # A valid manifest round-trips through validation.
    $rootSddl = Read-SecurityDescriptor -Path $repo
    $fileSddl = Read-SecurityDescriptor -Path $file
    $valid = [ordered]@{
        schemaVersion   = 1
        repoRoot        = $repo
        currentUserSid  = $script:CurrentUserSid
        objectCount     = 2
        objects         = @(
            [ordered]@{ relativePath = ''; path = $repo; isDirectory = $true; sddl = $rootSddl; ownerSid = $script:CurrentUserSid },
            [ordered]@{ relativePath = 'file.txt'; path = $file; isDirectory = $false; sddl = $fileSddl; ownerSid = $script:CurrentUserSid }
        )
    }
    $manifest = Join-Path $stateBackups 'valid.json'
    Write-JsonFile -Path $manifest -Object $valid
    $loaded = Read-RestoreManifest -BackupPath $manifest -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid
    Assert-True -Condition ($loaded.Entries.Count -eq 2) -Message 'valid manifest should load two objects'
    Assert-True -Condition ($loaded.Entries[0].RelativePath -eq '') -Message 'root entry should sort first'

    $badRoot = [ordered]@{
        schemaVersion  = 1
        repoRoot       = (Join-Path $base 'other-repo')
        currentUserSid = $script:CurrentUserSid
        objectCount    = 2
        objects        = $valid.objects
    }
    $badRootPath = Join-Path $stateBackups 'bad-root.json'
    Write-JsonFile -Path $badRootPath -Object $badRoot
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $badRootPath -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'different repository' -Message 'manifest root mismatch should be rejected'

    $traversal = [ordered]@{
        schemaVersion  = 1
        repoRoot       = $repo
        currentUserSid = $script:CurrentUserSid
        objectCount    = 3
        objects        = @($valid.objects) + @(
            [ordered]@{ relativePath = '..\outside.txt'; path = (Join-Path $repo '..\outside.txt'); isDirectory = $false; sddl = $fileSddl; ownerSid = $script:CurrentUserSid }
        )
    }
    $traversalPath = Join-Path $stateBackups 'traversal.json'
    Write-JsonFile -Path $traversalPath -Object $traversal
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $traversalPath -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'traversal|outside|does not match' -Message 'manifest traversal should be rejected'

    $duplicate = [ordered]@{
        schemaVersion  = 1
        repoRoot       = $repo
        currentUserSid = $script:CurrentUserSid
        objectCount    = 3
        objects        = @($valid.objects) + @($valid.objects[1])
    }
    $duplicatePath = Join-Path $stateBackups 'duplicate.json'
    Write-JsonFile -Path $duplicatePath -Object $duplicate
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $duplicatePath -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'duplicate' -Message 'duplicate manifest path should be rejected'

    $outsideManifest = Join-Path $base 'outside-manifest.json'
    Write-JsonFile -Path $outsideManifest -Object $valid
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $outsideManifest -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'must be under.*\.state' -Message 'manifest outside .state should be rejected'

    Assert-Throws -Action { Read-RestoreManifest -BackupPath $manifest -RepoRoot $repo -PackageRoot $package -MaxObjects 1 -CurrentUserSid $script:CurrentUserSid } -Pattern 'safety limit' -Message 'manifest over object limit should be rejected'

    $missingObject = [ordered]@{
        schemaVersion  = 1
        repoRoot       = $repo
        currentUserSid = $script:CurrentUserSid
        objectCount    = 2
        objects        = @(
            $valid.objects[0],
            [ordered]@{ relativePath = 'gone.txt'; path = (Join-Path $repo 'gone.txt'); isDirectory = $false; sddl = $fileSddl; ownerSid = $script:CurrentUserSid }
        )
    }
    $missingPath = Join-Path $stateBackups 'missing.json'
    Write-JsonFile -Path $missingPath -Object $missingObject
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $missingPath -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'no longer exists' -Message 'missing manifest path should be rejected'

    $foreignOwner = [ordered]@{
        schemaVersion  = 1
        repoRoot       = $repo
        currentUserSid = $script:CurrentUserSid
        objectCount    = 2
        objects        = @(
            $valid.objects[0],
            [ordered]@{ relativePath = 'file.txt'; path = $file; isDirectory = $false; sddl = $fileSddl; ownerSid = 'S-1-5-18' }
        )
    }
    $foreignPath = Join-Path $stateBackups 'foreign-owner.json'
    Write-JsonFile -Path $foreignPath -Object $foreignOwner
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $foreignPath -RepoRoot $repo -PackageRoot $package -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'foreign owner|owner field' -Message 'foreign owner in manifest should be rejected'

    # Junction handling: Get-CanonicalPath and the bounded tree must reject it.
    $junctionTarget = Join-Path $base 'junction-target'
    $junctionLink = Join-Path $repo 'junction-link'
    New-Item -ItemType Directory -Force -Path $junctionTarget | Out-Null
    New-Item -ItemType Junction -Path $junctionLink -Target $junctionTarget | Out-Null
    $junctions.Add($junctionLink)
    Assert-Throws -Action { Get-CanonicalPath -Path $junctionLink } -Pattern 'Reparse point' -Message 'canonical path should reject a junction'
    Assert-Throws -Action { Get-TreeEntries -Root $repo -MaxObjects 100 -StateDir (Join-Path $package '.state') -IncludeState:$true } -Pattern 'Reparse point' -Message 'bounded tree should reject a junction'

    # Hard-link handling: a multiply-linked file must be refused.
    $hardBase = Join-Path $base 'hardlink'
    New-Item -ItemType Directory -Force -Path $hardBase | Out-Null
    $hardOriginal = Join-Path $hardBase 'original.txt'
    Set-Content -LiteralPath $hardOriginal -Value 'hardlink' -NoNewline
    $hardLink = Join-Path $hardBase 'second.txt'
    New-Item -ItemType HardLink -Path $hardLink -Target $hardOriginal | Out-Null
    Assert-True -Condition ((Get-FileLinkCount -Path $hardOriginal) -ge 2) -Message 'hard-link count should be at least two'
    Assert-Throws -Action { Get-TreeEntries -Root $hardBase -MaxObjects 100 -StateDir (Join-Path $package '.state') -IncludeState:$true } -Pattern 'Multiply-linked file' -Message 'bounded tree should reject multiply-linked files'

    # Canonical temporary-ACE order: after explicit DSH deny, before inherited entries.
    $orderingSddl = 'O:SYG:SYD:(D;CI;DT;;;WD)(A;;FA;;;SY)(A;OICIID;0x110156;;;S-1-4-1-2)'
    $withTemp = Insert-TemporaryWriteOwnerAceInMemory -Sddl $orderingSddl -Sid $script:CurrentUserSid
    $orderedAces = @(Get-DaclAceList -Sddl $withTemp)
    $denyIndex = -1
    $tempIndex = -1
    $inheritedIndex = -1
    for ($index = 0; $index -lt $orderedAces.Count; $index++) {
        $ace = $orderedAces[$index]
        if ($denyIndex -lt 0 -and $ace.Type -eq [Security.AccessControl.AceType]::AccessDenied) { $denyIndex = $index }
        if ($tempIndex -lt 0 -and $ace.Sid -eq $script:CurrentUserSid -and $ace.Mask -eq [uint32]0x00080000) { $tempIndex = $index }
        if ($inheritedIndex -lt 0 -and $ace.IsInherited) { $inheritedIndex = $index }
    }
    Assert-True -Condition ($denyIndex -ge 0) -Message 'test descriptor should contain the DSH explicit deny'
    Assert-True -Condition ($tempIndex -gt $denyIndex) -Message 'temporary Allow must be inserted after explicit Denies'
    Assert-True -Condition ($inheritedIndex -lt 0 -or $tempIndex -lt $inheritedIndex) -Message 'temporary Allow must be inserted before inherited entries'
    $removedSddl = Remove-TemporaryWriteOwnerAceInMemory -Sddl $withTemp -Sid $script:CurrentUserSid
    $originalKeys = @(Get-DaclAceList -Sddl $orderingSddl | ForEach-Object {
            if ($_.IsInherited) { Get-InheritedAceKey -Ace $_ } else { Get-ExplicitAceKey -Ace $_ }
        })
    $removedKeys = @(Get-DaclAceList -Sddl $removedSddl | ForEach-Object {
            if ($_.IsInherited) { Get-InheritedAceKey -Ace $_ } else { Get-ExplicitAceKey -Ace $_ }
        })
    Assert-True -Condition (($originalKeys -join "`n") -eq ($removedKeys -join "`n")) -Message 'removing the temporary ACE should restore the exact original ACE sequence'

    # Restore verification: labels and explicit state are compared, while inherited
    # flag/order recomputation is allowed when the semantic entries match.
    $restoreExpected = 'O:SYG:SYD:(D;CI;DT;;;WD)(A;;FA;;;SY)(A;OICIID;0x110156;;;S-1-4-1-2)(A;OICIIOID;0x1301bf;;;AU)S:(ML;OICI;NW;;;ME)'
    Assert-True -Condition (@(Get-RestoreStateIssues -Path 'synthetic' -ExpectedSddl $restoreExpected -ActualSddl $restoreExpected).Count -eq 0) -Message 'identical restore state should verify'
    $recomputedInherited = 'O:SYG:SYD:(D;CI;DT;;;WD)(A;;FA;;;SY)(A;OICIIOID;0x1301bf;;;AU)(A;OICIID;0x110156;;;S-1-4-1-2)S:(ML;OICI;NW;;;ME)'
    Assert-True -Condition (@(Get-RestoreStateIssues -Path 'synthetic' -ExpectedSddl $restoreExpected -ActualSddl $recomputedInherited).Count -eq 0) -Message 'inherited order/marker recomputation should be allowed'
    $residualAllow = 'O:SYG:SYD:(D;CI;DT;;;WD)(A;;FA;;;SY)(A;OICI;WO;;;S-1-5-21-1-2-3-4)(A;OICIID;0x110156;;;S-1-4-1-2)(A;OICIIOID;0x1301bf;;;AU)S:(ML;OICI;NW;;;ME)'
    Assert-True -Condition (@(Get-RestoreStateIssues -Path 'synthetic' -ExpectedSddl $restoreExpected -ActualSddl $residualAllow).Count -gt 0) -Message 'residual explicit capability/temporary Allow must fail restore verification'
    $residualLowLabel = 'O:SYG:SYD:(D;CI;DT;;;WD)(A;;FA;;;SY)(A;OICIID;0x110156;;;S-1-4-1-2)(A;OICIIOID;0x1301bf;;;AU)S:(ML;OICI;NW;;;LW)'
    Assert-True -Condition (@(Get-RestoreStateIssues -Path 'synthetic' -ExpectedSddl $restoreExpected -ActualSddl $residualLowLabel).Count -gt 0) -Message 'residual/mismatched Low label must fail restore verification'

    # Restore manifest validation must reject a file that acquired a hard-link alias.
    $hardManifestRoot = Join-Path $base 'hardlink-manifest'
    $hardManifestPackage = Join-Path $hardManifestRoot 'bridge'
    $hardManifestDir = Join-Path $hardManifestPackage '.state\backups'
    New-Item -ItemType Directory -Force -Path $hardManifestDir | Out-Null
    $hardRootSddl = Read-SecurityDescriptor -Path $hardBase
    $hardFileSddl = Read-SecurityDescriptor -Path $hardOriginal
    $hardDocument = [ordered]@{
        schemaVersion  = 1
        repoRoot       = $hardBase
        currentUserSid = $script:CurrentUserSid
        objectCount    = 2
        objects        = @(
            [ordered]@{ relativePath = ''; path = $hardBase; isDirectory = $true; sddl = $hardRootSddl; ownerSid = $script:CurrentUserSid },
            [ordered]@{ relativePath = 'original.txt'; path = $hardOriginal; isDirectory = $false; sddl = $hardFileSddl; ownerSid = $script:CurrentUserSid }
        )
    }
    $hardManifestPath = Join-Path $hardManifestDir 'manifest.json'
    Write-JsonFile -Path $hardManifestPath -Object $hardDocument
    Assert-Throws -Action { Read-RestoreManifest -BackupPath $hardManifestPath -RepoRoot $hardBase -PackageRoot $hardManifestPackage -MaxObjects 100 -CurrentUserSid $script:CurrentUserSid } -Pattern 'multiply-linked' -Message 'restore manifest must reject a currently multiply-linked file'

    # The .state output boundary must reject redirected roots/subdirectories before writes.
    $stateRootPackage = Join-Path $base 'state-package'
    $stateOutside = Join-Path $base 'state-outside'
    New-Item -ItemType Directory -Force -Path $stateRootPackage, $stateOutside | Out-Null
    $stateJunction = Join-Path $stateRootPackage '.state'
    New-Item -ItemType Junction -Path $stateJunction -Target $stateOutside | Out-Null
    $junctions.Add($stateJunction)
    $stateContext = [pscustomobject]@{
        Package = $stateRootPackage
        StateDir = $stateJunction
        Repo = $repo
        Install = $null
        UserSid = $script:CurrentUserSid
        Stamp = '20260101-000000-00000000'
        MaxObjects = 100
    }
    Assert-Throws -Action { New-StateDirectories -Context $stateContext } -Pattern 'Reparse point' -Message '.state junction must be rejected before writes'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $stateOutside 'backups'))) -Message '.state junction target must not receive directories'

    $reportsPackage = Join-Path $base 'state-reports-package'
    $reportsOutside = Join-Path $base 'state-reports-outside'
    New-Item -ItemType Directory -Force -Path (Join-Path $reportsPackage '.state'), $reportsOutside | Out-Null
    $reportsJunction = Join-Path $reportsPackage '.state\reports'
    New-Item -ItemType Junction -Path $reportsJunction -Target $reportsOutside | Out-Null
    $junctions.Add($reportsJunction)
    $reportsContext = [pscustomobject]@{
        Package = $reportsPackage
        StateDir = (Join-Path $reportsPackage '.state')
        Repo = $repo
        Install = $null
        UserSid = $script:CurrentUserSid
        Stamp = '20260101-000000-00000000'
        MaxObjects = 100
    }
    Assert-Throws -Action { Write-SetupReport -Context $reportsContext -Action 'Restore' -Status 'success' -Fields ([ordered]@{ backup = 'x' }) } -Pattern 'Reparse point' -Message 'redirected reports directory must be rejected before report write'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $reportsOutside '20260101-000000-00000000-restore.json'))) -Message 'redirected reports target must not receive a report file'
} finally {
    foreach ($junction in $junctions) {
        if (Test-Path -LiteralPath $junction) {
            try { Remove-Item -LiteralPath $junction -Force } catch { }
        }
    }
    if (Test-Path -LiteralPath $base) {
        Remove-Item -LiteralPath $base -Recurse -Force
    }
}

if ($failures.Count -gt 0) {
    Write-Output "FAIL: $($failures.Count) boundary assertion(s) failed"
    foreach ($failure in $failures) { Write-Output "  - $failure" }
    exit 1
}
Write-Output 'PASS: setup path boundaries, link/hard-link rejection, .state output boundary, canonical temporary-ACE ordering, restore-state verification, and backup-manifest validation'
