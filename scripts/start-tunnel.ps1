[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$DataDir = '',
    [string]$Cloudflared = '',
    [int]$TimeoutSec = 90,
    [switch]$CheckOnly
)

# RichMan 一键启动 cloudflared 临时隧道（Windows PowerShell 5.1 / pwsh 7 兼容）。
# 本文件必须保存为 UTF-8 with BOM。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$dataPath = Resolve-DataDir $DataDir
$runDir = Join-Path $dataPath 'run'
$logDir = Join-Path $dataPath 'logs'
$tunnelStatePath = Join-Path $runDir 'tunnel.json'
$healthUrl = 'http://127.0.0.1:' + [string]$Port + '/health'

$localOk = Wait-HttpHealth $healthUrl 5
$cloudflaredPath = Get-CloudflaredPath $Cloudflared

$existing = Read-RunState $tunnelStatePath
$existingRun = Get-RunStateProcess $existing 'tunnel'
$existingUrl = ''
if ($existingRun.status -eq 'running') {
    try { $existingUrl = [string]$existing.url } catch { $existingUrl = '' }
}
$alreadyRunning = ($existingRun.status -eq 'running') -and (-not [string]::IsNullOrEmpty($existingUrl))

if ($CheckOnly) {
    $allOk = $localOk -and ($cloudflaredPath -ne $null) -and (-not $alreadyRunning)
    $reason = ''
    if ($alreadyRunning) { $reason = 'ALREADY_RUNNING' }
    elseif (-not $localOk) { $reason = 'LOCAL_SERVER_DOWN' }
    elseif ($cloudflaredPath -eq $null) { $reason = 'CLOUDFLARED_NOT_FOUND' }
    $result = [ordered]@{
        ok = $allOk
        reason = $reason
        port = $Port
        localServer = [ordered]@{ ok = $localOk; url = $healthUrl }
        cloudflared = [ordered]@{ ok = ($cloudflaredPath -ne $null); path = $cloudflaredPath }
        alreadyRunning = [ordered]@{ ok = (-not $alreadyRunning); running = $alreadyRunning; url = $existingUrl }
    }
    Write-CheckJson $result
    if ($allOk) { exit 0 } else { exit 1 }
}

if (-not $localOk) {
    Write-Output '本地服务未通过健康检查。请先启动：powershell -ExecutionPolicy Bypass -File scripts/start-lan.ps1'
    exit 1
}

if ($alreadyRunning) {
    Write-Output ('隧道已在运行：' + $existingUrl)
    Write-Output '提醒：每重启隧道域名都会变；换域名后用房间码+恢复码恢复。'
    exit 0
}

if ($cloudflaredPath -eq $null) {
    Write-Output '未找到 cloudflared。请任选一种：'
    Write-Output '  1) 放到 D:\Lianjunjie\tools\cloudflared.exe'
    Write-Output '  2) 设置环境变量 RICHMAN_CLOUDFLARED 指向该 exe'
    Write-Output '  3) winget install Cloudflare.cloudflared'
    Write-Output '  下载：https://github.com/cloudflare/cloudflared/releases'
    exit 1
}

if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logOut = Join-Path $logDir ('tunnel-' + $stamp + '.log')
$logErr = Join-Path $logDir ('tunnel-' + $stamp + '-err.log')

$process = $null
$startedAtUtc = ''
try {
    $process = Start-Process -FilePath $cloudflaredPath `
        -ArgumentList @('tunnel', '--url', ('http://127.0.0.1:' + [string]$Port), '--no-autoupdate') `
        -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru

    try {
        $procInfo = Get-Process -Id $process.Id -ErrorAction Stop
        $startedAtUtc = $procInfo.StartTime.ToUniversalTime().ToString('o')
    } catch {
        $startedAtUtc = ''
    }
    if ([string]::IsNullOrWhiteSpace($startedAtUtc)) {
        throw '无法读取子进程启动时间'
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $url = ''
    while (((Get-Date) -lt $deadline) -and [string]::IsNullOrEmpty($url)) {
        foreach ($file in @($logOut, $logErr)) {
            if (-not (Test-Path -LiteralPath $file)) { continue }
            $text = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue
            if ($text -eq $null) { continue }
            $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
            if ($match.Success) {
                $url = $match.Value
                break
            }
        }
        if ([string]::IsNullOrEmpty($url)) { Start-Sleep -Milliseconds 500 }
    }
    if ([string]::IsNullOrEmpty($url)) {
        throw ('未在 ' + [string]$TimeoutSec + ' 秒内拿到 trycloudflare URL')
    }

    $state = [ordered]@{
        pid = $process.Id
        startedAtUtc = $startedAtUtc
        port = $Port
        url = $url
        log = $logOut
    }
    Write-RunState $tunnelStatePath $state
} catch {
    $message = $_.Exception.Message
    if ($process -ne $null) {
        $stoppedNow = Stop-LaunchedProcess -ProcessId $process.Id -StartedAtUtc $startedAtUtc -Kind 'tunnel'
        if (-not $stoppedNow) {
            Write-Output ('WARN：无法确认进程 ' + [string]$process.Id + ' 归属，未杀进程，请人工检查。')
        }
    }
    $tmpState = $tunnelStatePath + '.tmp'
    if (Test-Path -LiteralPath $tmpState) { Remove-Item -LiteralPath $tmpState -Force -ErrorAction SilentlyContinue }
    Write-Output ('隧道启动失败（' + $message + '），已回收本次子进程（如可确认）。')
    Write-Output ('日志：' + $logOut + ' / ' + $logErr)
    Get-Content -LiteralPath $logErr -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}

Write-Output '================================================'
Write-Output ('隧道已开启：' + $url)
Write-Output '================================================'
Write-Output ('本机端口：http://127.0.0.1:' + [string]$Port + '/')
Write-Output ('日志：' + $logOut)
Write-Output '停止命令：powershell -ExecutionPolicy Bypass -File scripts/stop.ps1'
Write-Output '提醒：每重启隧道域名都会变；换域名后用房间码+恢复码恢复。'

if (-not (Wait-HttpHealth ($url + '/health') 30)) {
    Write-Output 'WARN：隧道已开，但健康检查暂未通过，校园 DNS 可能延迟，稍后可用 status 复查。'
}
exit 0
