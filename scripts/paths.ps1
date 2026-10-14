# Common local paths; loaded by start, stop and supervision.
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeConfigPath = Join-Path $bridgeRoot '.local\config.json'
$bridgeCommon = Get-Content -LiteralPath $bridgeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bridgeCommon.version -ne 2) { throw 'Run the offline semantic migration before starting this version.' }
function Resolve-BridgePath([string]$Value, [string]$Fallback) {
    if (!$Value) { $Value = $Fallback }
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $bridgeRoot $Value))
}
$dataDir = Resolve-BridgePath $bridgeCommon.dataDir '.local\data'
function Resolve-BridgeProfile([string]$Profile, [string]$Platform) {
    if (!$Profile) {
        if ($Platform) { $Profile = $bridgeCommon.platformProfiles.$Platform }
        else { $Profile = $bridgeCommon.startupProfile }
    }
    if ($Profile -notmatch '^(discord|feishu)/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$') { throw 'A valid startup Profile is required.' }
    if ($Platform -and !$Profile.StartsWith($Platform + '/')) { throw 'Profile and platform do not match.' }
    return $Profile
}
