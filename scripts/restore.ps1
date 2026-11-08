[CmdletBinding()]
param(
    [string]$DataDir = '',
    [string]$Backup = '',
    [string[]]$Room = @(),
    [switch]$All,
    [switch]$Force,
    [int]$Port = 0,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')
$root = Get-RichManRoot
$restored = @()

function Fail-Restore {
    param([string]$Code, [string]$Message, [int]$ExitCode = 1, [object[]]$Problems = @())
    $result = [ordered]@{ ok = $false; script = 'restore'; code = $Code; message = $Message; restored = @($script:restored) }
    if ($Problems.Count -gt 0) { $result.problems = @($Problems | Select-Object -First 5) }
    if ($Json) { Write-CheckJson $result }
    else {
        Write-Output ('恢复失败 [' + $Code + ']：' + $Message)
        foreach ($problem in $Problems | Select-Object -First 5) { Write-Output ([string]$problem) }
        Write-Output ('已完成房间：' + ((@($script:restored) | ForEach-Object { $_.code }) -join ', '))
    }
    exit $ExitCode
}

function Invoke-BackupCli {
    param([string[]]$Arguments)
    $errorFile = [System.IO.Path]::GetTempFileName()
    try {
        Push-Location $root
        try {
            $nativePreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $lines = @(& node --import tsx (Join-Path $root 'apps/server/src/storage/backup-cli.ts') @Arguments 2> $errorFile)
                $cliExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $nativePreference }
        } finally { Pop-Location }
        $diagnostics = Get-Content -LiteralPath $errorFile -Raw -Encoding UTF8
        if (-not [string]::IsNullOrWhiteSpace($diagnostics)) { [Console]::Error.Write($diagnostics) }
        $lastLine = @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) | Select-Object -Last 1
        return [pscustomobject]@{ exitCode = $cliExit; payload = (([string]$lastLine) | ConvertFrom-Json) }
    } finally { Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue }
}

try {
    if ([string]::IsNullOrWhiteSpace($Backup) -or -not (Test-Path -LiteralPath $Backup -PathType Container)) {
        Fail-Restore 'BAD_ARGUMENT' '-Backup 必须指向已存在的备份目录'
    }
    if (($All -and $Room.Count -gt 0) -or (-not $All -and $Room.Count -eq 0) -or $Port -lt 0 -or $Port -gt 65535) {
        Fail-Restore 'BAD_ARGUMENT' '请只指定 -All 或 -Room，-Port 必须在 0..65535 之间'
    }
    foreach ($code in $Room) {
        if ($code -notmatch '^\d{4,8}$') { Fail-Restore 'BAD_ARGUMENT' '-Room 必须是 4～8 位数字房间码' }
    }
    $dataPath = Resolve-DataDir $DataDir
    $backupPath = [System.IO.Path]::GetFullPath($Backup)
    $statePath = Join-Path $dataPath 'run/server.json'
    $state = Read-RunState $statePath
    $runInfo = Get-RunStateProcess $state 'server'
    if ((Test-Path -LiteralPath $statePath) -and $state -eq $null) { $runInfo.status = 'broken'; $runInfo.reason = 'server.json 无法解析' }
    $effectivePort = $Port
    if ($effectivePort -eq 0) {
        $effectivePort = 8000
        if ($state -ne $null) {
            $savedPort = 0
            try { $savedPort = [int]$state.port } catch { }
            if ($savedPort -gt 0 -and $savedPort -le 65535) { $effectivePort = $savedPort }
        }
    }
    # 在任何临时文件、目录或 CLI 写操作之前检查进程归属和 HTTP 身份。
    $healthRunning = $false
    try {
        $response = Invoke-WebRequest -Uri ('http://127.0.0.1:' + [string]$effectivePort + '/health') -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $health = $response.Content | ConvertFrom-Json
        $healthRunning = ($health.ok -eq $true -and [string]$health.service -eq 'richman')
    } catch { }
    if ($runInfo.status -eq 'running' -or $healthRunning) {
        Fail-Restore 'SERVICE_RUNNING' '请先运行 scripts/stop.ps1 并确认服务已退出，再进行恢复' 2
    }
    if ($runInfo.status -eq 'mismatch' -or $runInfo.status -eq 'unknown' -or $runInfo.status -eq 'broken') {
        [Console]::Error.WriteLine('WARN：' + $runInfo.reason + '；该端口未发现健康 RichMan 服务，继续校验备份。')
    }
    $verification = Invoke-BackupCli @('verify', '--backup', $backupPath)
    if ($verification.exitCode -ne 0 -or $verification.payload.ok -ne $true) {
        if ($All) {
            $invalidManifest = $null
            try { $invalidManifest = Get-Content -LiteralPath (Join-Path $backupPath 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            if ($invalidManifest -ne $null -and $invalidManifest.backupFormatVersion -ne 1) {
                Fail-Restore 'MANIFEST_INVALID' 'backupFormatVersion 必须为 1'
            }
        }
        Fail-Restore 'VERIFY_FAILED' '备份校验失败' 1 @($verification.payload.problems)
    }
    $codes = @($Room)
    if ($All) {
        $manifest = Get-Content -LiteralPath (Join-Path $backupPath 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.backupFormatVersion -ne 1) { Fail-Restore 'MANIFEST_INVALID' 'backupFormatVersion 必须为 1' }
        $codes = @($manifest.rooms | ForEach-Object { [string]$_.code })
    }
    foreach ($code in @($codes | Sort-Object -Unique)) {
        $cliArgs = @('restore', '--data', $dataPath, '--backup', $backupPath, '--room', $code)
        if ($Force) { $cliArgs += '--force' }
        $restore = Invoke-BackupCli $cliArgs
        if ($restore.exitCode -ne 0 -or $restore.payload.ok -ne $true) {
            $exitCode = 1
            $message = [string]$restore.payload.message
            if ([string]$restore.payload.code -eq 'RESTORE_TARGET_EXISTS') {
                $exitCode = 2
                $message += '；-Force 会先保留旧档到 rooms/restore-keep-*'
            }
            Fail-Restore ([string]$restore.payload.code) $message $exitCode
        }
        $restored += [ordered]@{ code = $code; keptPath = $restore.payload.kept }
    }
    if ($Json) { Write-CheckJson ([ordered]@{ ok = $true; script = 'restore'; restored = @($restored); pausedHint = $true }) }
    else {
        Write-Output ('恢复完成，共 ' + [string]$restored.Count + ' 个房间。')
        Write-Output '下一步：运行 scripts/start-lan.ps1，再进房间由房主点“继续游戏”（恢复后为暂停态）。'
    }
    exit 0
} catch { Fail-Restore 'INTERNAL_ERROR' $_.Exception.Message }
