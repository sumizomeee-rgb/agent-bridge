param(
    [Parameter(Mandatory=$true)][string]$TicketPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateSet('completed','failed','cancelled')][string]$Status = 'completed',
    [string]$Text = '',
    [string]$ResultFile = ''
)
$ErrorActionPreference = 'Stop'
$taskTicket = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskTicket.version -ne 1 -or $taskTicket.token -notmatch '^[a-f0-9]{64}$' -or $taskTicket.taskId -notmatch '^[a-f0-9-]{36}$') {
    throw 'Invalid bridge task ticket'
}
if ($ResultFile) {
    $taskStream = [IO.File]::OpenRead($ResultFile)
    try {
        $taskBytes = [byte[]]::new([Math]::Min($taskStream.Length, 16384))
        $taskRead = $taskStream.Read($taskBytes, 0, $taskBytes.Length)
        $Text = [Text.Encoding]::UTF8.GetString($taskBytes, 0, $taskRead).TrimStart([char]0xFEFF)
        if ($taskStream.Length -gt 16384) { $Text += "`n[Result truncated at 16 KiB]" }
    } finally { $taskStream.Dispose() }
} else {
    $taskBytes = [Text.Encoding]::UTF8.GetBytes($Text)
    if ($taskBytes.Length -gt 16384) { $Text = [Text.Encoding]::UTF8.GetString($taskBytes, 0, 16384) + "`n[Result truncated at 16 KiB]" }
}
$taskPayload = [ordered]@{
    version = 1
    taskId = $taskTicket.taskId
    status = $Status
    text = $Text
    completedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
$taskKey = [byte[]]::new(32)
for ($taskIndex=0; $taskIndex -lt 32; $taskIndex++) { $taskKey[$taskIndex] = [Convert]::ToByte($taskTicket.token.Substring($taskIndex * 2, 2), 16) }
$taskHmac = [Security.Cryptography.HMACSHA256]::new($taskKey)
try {
    $taskSignature = [BitConverter]::ToString($taskHmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskPayload))).Replace('-', '').ToLowerInvariant()
} finally { $taskHmac.Dispose() }
# Sign the exact payload string, avoiding PowerShell / Node JSON serialization differences.
$taskEnvelope = @{payload=$taskPayload;signature=$taskSignature} | ConvertTo-Json -Compress
$taskOutput = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskOutput)) | Out-Null
$taskTemporary = $taskOutput + '.' + [Guid]::NewGuid().ToString() + '.tmp'
[IO.File]::WriteAllText($taskTemporary, $taskEnvelope, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $taskTemporary -Destination $taskOutput -Force
@{taskId=$taskTicket.taskId;status=$Status;completionFile=$taskOutput} | ConvertTo-Json -Compress
