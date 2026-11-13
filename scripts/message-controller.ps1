param([Parameter(ValueFromRemainingArguments=$true)][string[]]$MessageArgs)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$entry=Join-Path $root 'dist/src/remote/message-cli.js'
$pointer=Join-Path $root '.local/remote/active-release.json'
if(Test-Path -LiteralPath $pointer){
 $release=Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json
 $expected=[IO.Path]::GetFullPath((Join-Path $root ('.local/remote/releases/'+$release.id)))
 if($release.id -notmatch '^[a-f0-9]{64}$' -or [IO.Path]::GetFullPath($release.path) -ne $expected){throw 'Invalid executor release'}
 $entry=Join-Path $expected 'dist/src/remote/message-cli.js'
}
$node=Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if(!$node){
 $config=Join-Path $root '.local/remote/config.json'
 if(Test-Path -LiteralPath $config){
  $settings=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
  $node=@($settings.engines.psobject.Properties.Value.agentCommand.command | Where-Object { (Split-Path $_ -Leaf) -match '^node(\.exe)?$' -and (Test-Path -LiteralPath $_) }) | Select-Object -First 1
 }
}
if(!$node -or !(Test-Path -LiteralPath $entry)){throw 'Executor message command/runtime is not installed'}
& $node $entry @MessageArgs --root $root
exit $LASTEXITCODE
