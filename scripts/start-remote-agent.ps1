param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$resolvedRoot = [IO.Path]::GetFullPath($Root)
$entry = Join-Path $resolvedRoot 'dist\src\remote\cli.js'
$configFile = Join-Path $resolvedRoot '.local\remote\config.json'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '远端执行器尚未构建。' }
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw '远端执行器缺少登记配置。' }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '登记的 Node 运行时不存在。' }
# Register this script in an independent current-user logon task. An SSH session must not own this process.
Set-Location -LiteralPath $resolvedRoot
$logDirectory = Join-Path $resolvedRoot '.local\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$errorLog = Join-Path $logDirectory 'remote-errors.log'
function Quote-NativeArgument([string]$Value) {
    # Escape exactly for Windows CommandLineToArgvW, including trailing backslashes.
    '"' + [Regex]::Replace([Regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
# This independent logon task also supervises release changes. User data stays at Root.
while ($true) {
    $selectedEntry = $entry
    $pointer = Join-Path $resolvedRoot '.local\remote\active-release.json'
    if (Test-Path -LiteralPath $pointer) {
        $release = Get-Content -LiteralPath $pointer -Raw -Encoding UTF8 | ConvertFrom-Json
        $expected = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ('.local\remote\releases\' + $release.id)))
        if ($release.id -notmatch '^[a-f0-9]{64}$' -or [IO.Path]::GetFullPath($release.path) -ne $expected) { throw 'Invalid active executor release.' }
        $selectedEntry = Join-Path $expected 'dist\src\remote\cli.js'
        $env:BRIDGE_EXECUTOR_RELEASE = $release.id
    } else { Remove-Item Env:\BRIDGE_EXECUTOR_RELEASE -ErrorAction SilentlyContinue }
    $arguments = @((Quote-NativeArgument $selectedEntry), '--serve', '--root', (Quote-NativeArgument $resolvedRoot))
    $daemonProcess = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $resolvedRoot -WindowStyle Hidden -RedirectStandardError $errorLog -PassThru -Wait
    Start-Sleep -Seconds $(if ($daemonProcess.ExitCode -eq 0) { 1 } else { 5 })
}
