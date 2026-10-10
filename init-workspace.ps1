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
    $files = @('AGENTS.md', 'CLAUDE.md', 'README.md', 'agents.json', 'agents.example.json')
    # 先检查完整清单，避免目录占用了文件名时只生成一部分模板。
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

    [void][IO.Directory]::CreateDirectory($workspace)
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
            [IO.File]::Copy($source, $destination, $false)
            Write-Host "生成：$name"
            $created++
        }
    }
    Write-Host "工作区：$workspace"
    Write-Host "完成：生成 $created 个文件，保留 $preserved 个已存在文件。"
    Write-Host '填写工作区说明和远端登记后，再将桥配置的 workspace 指向此目录。'
    exit 0
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
