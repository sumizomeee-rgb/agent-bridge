# Common installed paths. Runtime configuration is only the current workspace registry.
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeConfigPath = Join-Path $bridgeRoot '.local\config.json'
$bridgeCommon = Get-Content -LiteralPath $bridgeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bridgeCommon.version -ne 4) { throw 'Run the offline workspace registry migration before starting this version.' }
function Resolve-BridgePath([string]$Value, [string]$Fallback) {
    if (!$Value) { $Value = $Fallback }
    if (!$Value) { throw 'A workspaceRoot must be configured during initialization.' }
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $bridgeRoot $Value))
}
$workspaceRoot = if ([IO.Path]::IsPathRooted($bridgeCommon.workspaceRoot)) { [IO.Path]::GetFullPath($bridgeCommon.workspaceRoot) } else { [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $bridgeConfigPath) $bridgeCommon.workspaceRoot)) }
$registryRoot = Join-Path $workspaceRoot 'bridge-registry'
$bridgeRegistry = Get-Content -LiteralPath (Join-Path $registryRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bridgeRegistry.version -ne 4) { throw 'Workspace registry version must be 4.' }
$dataDir = Join-Path $workspaceRoot 'bridge-local\host'
function Resolve-BridgeProfile([string]$Profile, [string]$Platform) {
    $registered = @($bridgeRegistry.startupControllers)
    if (!$registered.Count) { throw 'Register at least one startup controller.' }
    foreach ($controllerId in $registered) {
        if ($controllerId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') { throw 'Invalid startup controller ID.' }
        $controller = Get-Content -LiteralPath (Join-Path $registryRoot ('controllers\' + $controllerId + '\config.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
        $channel = $null
        if ($controller.channelId) {
            if ($controller.channelId -notmatch '^(feishu|discord):([A-Za-z0-9_]+)$') { throw 'Invalid controller channel reference.' }
            $channelPlatform = $Matches[1]
            $channelApplication = $Matches[2]
            $channelDirectory = if ($channelPlatform -eq 'feishu') { 'lark' } else { 'discord' }
            $channel = Get-Content -LiteralPath (Join-Path $registryRoot ('channels\' + $channelDirectory + '\bots\' + $channelApplication + '\config.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
        }
        if ((!$Profile -or $Profile -eq $controllerId -or ($channel -and $Profile -eq $channel.profile)) -and (!$Platform -or ($channel -and $channel.platform -eq $Platform))) {
            return $controllerId
        }
    }
    throw 'Selected controller/profile is not in the configured startup set or platform.'
}
