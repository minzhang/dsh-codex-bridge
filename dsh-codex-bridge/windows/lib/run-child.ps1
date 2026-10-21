#Requires -Version 7.0
param([Parameter(Mandatory = $true)][string]$Invocation)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
try {
    $launch = Get-Content -LiteralPath $Invocation -Raw | ConvertFrom-Json
    Set-Location -LiteralPath $launch.cwd
    $launcherArguments = @($launch.arguments)
    & $launch.executable @launcherArguments
    if ($null -eq $LASTEXITCODE) { throw 'The DSH launcher did not return a native exit code.' }
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($launch -and $launch.failureFile) {
        [IO.File]::WriteAllText($launch.failureFile, (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
    exit 1
}
