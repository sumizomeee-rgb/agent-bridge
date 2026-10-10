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
$arguments = @((Quote-NativeArgument $entry), '--serve', '--root', (Quote-NativeArgument $resolvedRoot))
$daemonProcess = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $resolvedRoot -WindowStyle Hidden -RedirectStandardError $errorLog -PassThru -Wait
exit $daemonProcess.ExitCode
