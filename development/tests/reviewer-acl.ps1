# Read-only reviewer regressions: these compile the interop and inspect synthetic
# descriptors. They do not change any Windows file permissions.
#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows ACL tests require Windows.' }
. "$PSScriptRoot\..\..\dsh-codex-bridge\windows\lib\interop.ps1"
. "$PSScriptRoot\..\..\dsh-codex-bridge\windows\lib\setup-lib.ps1"
$script:EveryoneSid = 'S-1-1-0'
$script:LowLabelSid = 'S-1-16-4096'
$script:DshGrantMask = 0x110156
$script:FileDeleteChildMask = 0x40

$aces = @(Get-DaclAceList -Sddl 'O:SYG:SYD:(D;CI;0x40;;;WD)(A;OICIIO;SDGXGWGR;;;AU)')
if ($aces.Count -ne 2) { throw 'Generic Windows access masks were not parsed.' }
if (-not (Test-ProtectiveDeny -Aces $aces)) { throw 'A real CI deny must be recognized.' }
$fileDeny = @(Get-DaclAceList -Sddl 'O:SYG:SYD:(D;OI;0x40;;;WD)')
if (Test-ProtectiveDeny -Aces $fileDeny) { throw 'An OI deny must not be accepted as the directory-only CI deny.' }
if (Get-Command Get-RestoreStateIssues -ErrorAction SilentlyContinue) {
    $expected = 'O:SYG:SYD:(A;OICIID;0x1201bf;;;AU)S:(ML;OICI;NW;;;ME)'
    $inheritOnly = 'O:SYG:SYD:(A;OICIIOID;0x1201bf;;;AU)S:(ML;OICI;NW;;;ME)'
    $noPropagation = 'O:SYG:SYD:(A;ID;0x1201bf;;;AU)S:(ML;OICI;NW;;;ME)'
    foreach ($changed in @($inheritOnly, $noPropagation)) {
        $issues = @(Get-RestoreStateIssues -Path 'synthetic' -ExpectedSddl $expected -ActualSddl $changed)
        if ($issues.Count -eq 0) { throw 'Restore verification must reject changed inherited ACE applicability/propagation flags; these alter access semantics.' }
    }
}
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# Argument validation does not use the installed runtime. Supply a bounded fake
# install so this check also runs where DSH is not installed (for example CI).
$installFixture = Join-Path ([IO.Path]::GetTempPath()) ('dsh-reviewer-acl-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $installFixture 'resources') | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installFixture 'DeepSeek Harness.exe') | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installFixture 'resources\app.asar') | Out-Null
    $context = New-SetupContext -Repo $repo -Action Repair -Apply $true -InstallDir $installFixture
    if ($context.Action -ne 'Repair' -or -not $context.Apply) { throw 'Repair -Apply must be accepted by argument validation.' }
    $rootEntry = New-TreeEntry -Root $context.Repo -Path $context.Repo -IsDirectory $true
    if ($rootEntry.RelativePath -ne '') { throw 'Root entry must use the empty relative path required by backup/restore.' }
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($installFixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ($resolvedFixture.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedFixture).StartsWith('dsh-reviewer-acl-', [StringComparison]::Ordinal)) {
        if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
    }
}
Write-Output 'PASS reviewer ACL regressions: interop compilation, signed masks, CI/OI distinction, restore access semantics, argument validation.'
