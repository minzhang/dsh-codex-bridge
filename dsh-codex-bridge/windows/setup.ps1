#Requires -Version 7.0
<#
.SYNOPSIS
  Check, repair, verify, or restore the Windows DSH workspace-write ACLs for a
  dedicated repository that contains this portable bridge package.

.DESCRIPTION
  Default Action is Check, which is read-only apart from temporary helper
  diagnostics. Repair requires -Apply and preserves a metadata-only backup under
  the package's ignored .state directory. Restore is a separate action and
  requires -Backup <manifest.json> -Apply. None of the actions changes the DSH
  sandbox mode, Windows user rights, token groups, or installed runtime files.

  The package uses the installed DeepSeek Harness Electron-as-Node runtime, the
  public AclWriteGrant/workspaceWriteSid backend API in its app.asar package, and
  a small native helper for descriptor snapshots, labels, canonical paths, and
  hard-link checks.

.PARAMETER Repo
  Dedicated repository root. The bridge package must be inside this directory.

.PARAMETER Action
  Check (default), Repair, Verify, or Restore.

.PARAMETER Apply
  Required for Repair and Restore. Not valid for Check or Verify.

.PARAMETER Backup
  Metadata manifest produced by Repair, required for Restore.

.PARAMETER InstallDir
  Optional DeepSeek Harness desktop installation directory for nondefault installs.

.PARAMETER MaxObjects
  Bounded tree limit (default 10000).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,

    [ValidateSet('Check', 'Repair', 'Verify', 'Restore')]
    [string]$Action = 'Check',

    [switch]$Apply,

    [string]$Backup = '',

    [string]$InstallDir = '',

    [int]$MaxObjects = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isWindowsHost = $false
$windowsVariable = Get-Variable -Name IsWindows -ValueOnly -ErrorAction SilentlyContinue
if ($windowsVariable -is [bool]) { $isWindowsHost = $windowsVariable }
if (-not $isWindowsHost) {
    Write-Output 'ERROR: windows/setup.ps1 supports Windows only. No files were changed.'
    exit 3
}

$originalLocation = Get-Location
try {
    . (Join-Path $PSScriptRoot 'lib\interop.ps1')
    . (Join-Path $PSScriptRoot 'lib\setup-lib.ps1')

    $context = New-SetupContext -Repo $Repo -Action $Action -Apply ([bool]$Apply.IsPresent) -Backup $Backup -InstallDir $InstallDir -MaxObjects $MaxObjects
    $exitCode = Invoke-SetupAction -Context $context
    exit $exitCode
} catch {
    $exitCode = Get-SetupExitCode -ErrorRecord $_
    Write-Output "ERROR: $($_.Exception.Message)"
    exit $exitCode
} finally {
    Set-Location -LiteralPath $originalLocation
}
