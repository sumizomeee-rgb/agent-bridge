param([string]$UserDirectory = [Environment]::GetFolderPath('UserProfile'), [string]$Archive)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or [Environment]::Is64BitOperatingSystem -ne $true) { throw 'This package supports Windows x64 only.' }
$version = '0.160.0'
$directory = Join-Path $UserDirectory ('.codex\bridge\runtime\' + $version)
$binary = Join-Path $directory 'bin\codex-app-server.exe'
$expected = 'B65BD931A163B9D6D281FD3BEDBA80886A289462C15328ADC9C3F89E98638331'
if ((Test-Path -LiteralPath $binary) -and (Test-Path -LiteralPath (Join-Path $directory 'verified-package.sha256'))) { return }
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$download = !$Archive
if ($download) {
    $Archive = Join-Path $directory 'package.tar.gz'
    Invoke-WebRequest -UseBasicParsing ('https://github.com/openai/codex/releases/download/rust-v' + $version + '/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz') -OutFile $Archive
}
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $expected) { throw 'Native runtime package checksum mismatch.' }
$entries = @(& tar -tzf $Archive)
if ($LASTEXITCODE -ne 0 -or ($entries | Where-Object { $_ -match '(^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$))' -or $_ -notmatch '^(bin/|codex-path/|codex-resources/|codex-package.json$)' })) { throw 'Unexpected native package entries.' }
& tar -xzf $Archive -C $directory
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $binary)) { throw 'Native runtime extraction failed.' }
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne '5CBC46199B17ECB509B58400D65E0DE3F9E4D7AA049423024A6DA0C62B3FA526') { throw 'Native app-server checksum mismatch.' }
[IO.File]::WriteAllText((Join-Path $directory 'verified-package.sha256'), $expected)
if ($download) { Remove-Item -LiteralPath $Archive }
