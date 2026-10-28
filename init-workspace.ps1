<#
.SYNOPSIS
生成工作区上下文模板，保留所有已存在的文件。
.EXAMPLE
.\init-workspace.ps1 -Path 'C:\My Agent Workspace'
#>
[CmdletBinding()]
param([string]$Path)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    if (!$PSBoundParameters.ContainsKey('Path')) {
        $Path = Read-Host '请输入工作区的完整绝对路径'
    }
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw '工作区路径不能为空。'
    }

    # C:folder 和 \folder 会随当前目录/盘符变化，不能当作迁移目标。
    $drivePath = $Path -match '^[A-Za-z]:[\\/]'
    $uncPath = $Path -match '^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'
    if (!$drivePath -and !$uncPath) {
        throw '请输入完整的 Windows 绝对路径，例如 C:\AgentWorkspace 或 \\server\share\AgentWorkspace。'
    }
    if ($Path -match '^\\\\[?.][\\/]' -or $Path.IndexOfAny([IO.Path]::GetInvalidPathChars()) -ge 0) {
        throw '工作区路径格式无效。'
    }
    $workspace = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($workspace)
    if ($workspace.TrimEnd([char[]]'\/') -eq $root.TrimEnd([char[]]'\/')) {
        throw '请指定单独的工作区文件夹，不要使用盘符或共享根目录。'
    }
    if ([IO.File]::Exists($workspace)) {
        throw '指定的工作区路径是文件，请选择文件夹。'
    }

    $templateRoot = Join-Path $PSScriptRoot 'workspace-template'
    $files = @('MEMORY.md', 'README.md', 'bridge-remote-agents/registry.json', 'bridge-remote-agents/example.json', 'bridge-agent-presets/registry.json', 'bridge-agent-presets/example.json', 'bridge-agent-presets/private/profiles.json', 'bridge-agent-presets/private/credentials.json', 'bridge-capabilities/registry.json', 'bridge-capabilities/example.json', 'bridge-chat-platforms\lark.md', 'bridge-chat-platforms\discord.md')
    # 不在旧登记仍位于根目录时生成空表，以免真实配置被静默忽略。
    foreach ($legacy in @('agents.json', 'agents.example.json', 'capabilities.json', 'capabilities.example.json')) {
        if (Test-Path -LiteralPath (Join-Path $workspace $legacy)) {
            throw "检测到旧版根目录登记 $legacy；请按部署说明先迁移至 bridge-remote-agents/ 或 bridge-capabilities/，再生成骨架。"
        }
    }
    # 旧职能目录必须先迁移，不能新建空登记表遮住用户原配置。
    foreach ($legacyDirectory in @('remote-agents', 'capabilities', 'agent-presets', 'chat-platforms')) {
        if ((Test-Path -LiteralPath (Join-Path $workspace $legacyDirectory)) -and !(Test-Path -LiteralPath (Join-Path $workspace ('bridge-' + $legacyDirectory)))) {
            throw "检测到旧职能目录 $legacyDirectory；请先迁移，生成器不会覆盖或另建空表。"
        }
    }
    # 先检查父目录及完整清单，避免碰撞时只生成一部分模板。
    $directories = @('bridge-chat-platforms', 'bridge-remote-agents', 'bridge-agent-presets', 'bridge-agent-presets\private', 'bridge-capabilities', 'tmp')
    foreach ($name in $directories) {
        $directory = Join-Path $workspace $name
        if ([IO.File]::Exists($directory)) {
            throw "工作区目录已被文件占用：$directory"
        }
    }
    foreach ($name in $files) {
        $source = Join-Path $templateRoot $name
        $destination = Join-Path $workspace $name
        if (![IO.File]::Exists($source)) {
            throw "缺少模板文件：$source"
        }
        if ([IO.Directory]::Exists($destination)) {
            throw "目标文件名已被文件夹占用：$destination"
        }
    }

    $privateRoot = Join-Path $workspace 'bridge-agent-presets\private'
    $protectPrivate = ![IO.Directory]::Exists($privateRoot)
    [void][IO.Directory]::CreateDirectory($workspace)
    foreach ($name in $directories) {
        [void][IO.Directory]::CreateDirectory((Join-Path $workspace $name))
    }
    # 新建私有目录仅授予当前用户和 SYSTEM；已有目录的权限与文件保持原样。
    if ($protectPrivate) {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($identity in @($sid.Value, 'S-1-5-18')) {
            $principal = New-Object Security.Principal.SecurityIdentifier($identity)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        [IO.Directory]::SetAccessControl($privateRoot, $acl)
    }
    $created = 0
    $preserved = 0
    foreach ($name in $files) {
        $source = Join-Path $templateRoot $name
        $destination = Join-Path $workspace $name
        if ([IO.File]::Exists($destination)) {
            Write-Host "保留：$name"
            $preserved++
        } else {
            # overwrite=false：即使有其他程序同时创建文件，也不会覆盖。
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            [IO.File]::Copy($source, $destination, $false)
            Write-Host "生成：$name"
            $created++
        }
    }
    Write-Host "工作区：$workspace"
    Write-Host "完成：生成 $created 个文件，保留 $preserved 个已存在文件。"
    Write-Host '填写工作区说明、电脑登记及所需预设配置，再将桥配置的 workspace 指向此目录。'
    Write-Host '预设启动配置和凭据只在本工作区维护；桥启动后自动准备各电脑所需文件，无需逐台复制。'
    exit 0
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
