[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$DataDir = '',
    [switch]$Build,
    [int]$TimeoutSec = 40,
    [switch]$CheckOnly
)

# RichMan 一键启动本地服务（Windows PowerShell 5.1 / pwsh 7 兼容）。
# 本文件必须保存为 UTF-8 with BOM。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$root = Get-RichManRoot
$layout = Get-RichManLayout
$dataPath = Resolve-DataDir $DataDir
$runDir = Join-Path $dataPath 'run'
$logDir = Join-Path $dataPath 'logs'
$serverStatePath = Join-Path $runDir 'server.json'
$distIndex = $layout.WebIndex
$healthUrl = 'http://127.0.0.1:' + [string]$Port + '/health'

if ($layout.Portable -and $Build) {
    Write-Output '发布包不含源码，不能构建前端'
    exit 1
}

# ---- 检查项 ----
$nodeOk = $false
$nodeVersion = ''
try {
    if (-not ($layout.Portable -and $layout.NodeExe -eq 'node')) {
        $nodeVersion = (& $layout.NodeExe --version 2>$null)
        if ($nodeVersion -ne $null) { $nodeVersion = $nodeVersion.Trim() }
        if ($nodeVersion -match '^v([0-9]+)') {
            $major = [int]$Matches[1]
            if ($major -ge 22) { $nodeOk = $true }
        }
    }
} catch {
    $nodeOk = $false
}

$webDistOk = Test-Path -LiteralPath $distIndex
$portFree = Test-PortFree $Port

$dataOk = $false
try {
    if (-not (Test-Path -LiteralPath $dataPath)) {
        New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    }
    $probe = Join-Path $dataPath ('.write-probe-' + [string](Get-Random))
    [System.IO.File]::WriteAllText($probe, 'ok', (New-Object System.Text.UTF8Encoding($false)))
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    $dataOk = $true
} catch {
    $dataOk = $false
}

$existing = Read-RunState $serverStatePath
$existingRun = Get-RunStateProcess $existing 'server'
$existingProcess = $existingRun.process
$alreadyRunning = $false
if ($existingRun.status -eq 'running') {
    $existingPort = 8000
    try { $existingPort = [int]$existing.port } catch { $existingPort = 8000 }
    $existingHealth = 'http://127.0.0.1:' + [string]$existingPort + '/health'
    if (Wait-HttpHealth $existingHealth 3) { $alreadyRunning = $true }
} elseif ($existingRun.status -eq 'mismatch' -or $existingRun.status -eq 'unknown') {
    Write-Output ('提示：server.json 与进程不匹配（' + $existingRun.reason + '），未停止进程、未删除状态。')
}

$reason = ''
if ($alreadyRunning) { $reason = 'ALREADY_RUNNING' }
elseif (-not $nodeOk) { $reason = 'NODE_MISSING_OR_OLD' }
elseif (-not $webDistOk) { $reason = 'WEB_DIST_MISSING' }
elseif (-not $portFree) { $reason = 'PORT_IN_USE' }
elseif (-not $dataOk) { $reason = 'DATA_DIR_NOT_WRITABLE' }

$allOk = (-not $alreadyRunning) -and $nodeOk -and $webDistOk -and $portFree -and $dataOk

if ($CheckOnly) {
    $result = [ordered]@{
        ok = $allOk
        reason = $reason
        port = $Port
        dataDir = $dataPath
        checks = [ordered]@{
            node = [ordered]@{ ok = $nodeOk; version = $nodeVersion }
            webDist = [ordered]@{ ok = $webDistOk; path = $distIndex }
            port = [ordered]@{ ok = $portFree; available = $portFree; port = $Port }
            dataDir = [ordered]@{ ok = $dataOk; path = $dataPath }
            alreadyRunning = [ordered]@{ ok = (-not $alreadyRunning); running = $alreadyRunning }
        }
    }
    Write-CheckJson $result
    if ($allOk) { exit 0 } else { exit 1 }
}

# ---- 正常启动流程 ----
if ($alreadyRunning) {
    $runningPort = 8000
    try { $runningPort = [int]$existing.port } catch { $runningPort = 8000 }
    Write-Output ('已在运行 http://127.0.0.1:' + [string]$runningPort + '/ ，数据目录：' + $dataPath)
    Write-Output ('停止命令：powershell -ExecutionPolicy Bypass -File scripts/stop.ps1')
    exit 0
}

if (-not $nodeOk) {
    if ($layout.Portable) {
        Write-Output ('发布包缺少可用的 node/node.exe（需要 v22 及以上），请重新解压完整的发布包。当前：' + $nodeVersion)
    } else {
        Write-Output ('未找到可用的 node（需要 v22 及以上），请先安装 Node.js。当前：' + $nodeVersion)
    }
    exit 1
}

if (-not $portFree) {
    Write-Output ('端口 ' + [string]$Port + ' 已被占用，请换 -Port 或先 stop。')
    exit 1
}

if (-not $webDistOk) {
    if ($Build) {
        Write-Output '未找到前端构建产物，先执行 corepack pnpm -s build ...'
        & corepack pnpm -s build
        if ($LASTEXITCODE -ne 0) {
            Write-Output '前端构建失败，已中止。'
            exit 1
        }
    } else {
        Write-Output ('未找到 ' + $distIndex + '，请先 corepack pnpm -s build（或加 -Build）。')
        exit 1
    }
}

if (-not $dataOk) {
    Write-Output ('数据目录不可写：' + $dataPath)
    exit 1
}

if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logOut = Join-Path $logDir ('server-' + $stamp + '.log')
$logErr = Join-Path $logDir ('server-' + $stamp + '-err.log')

$env:PORT = [string]$Port
$env:RICHMAN_DATA_DIR = $dataPath
$startArgs = @('--import', 'tsx', '--no-warnings', 'apps/server/src/http.ts')
if ($layout.Portable) {
    $env:RICHMAN_STATIC_DIR = $layout.WebDir
    $startArgs = @($layout.ServerEntry)
}

$process = $null
$startedAtUtc = ''
try {
    $process = Start-Process -FilePath $layout.NodeExe `
        -ArgumentList $startArgs `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru

    try {
        $procInfo = Get-Process -Id $process.Id -ErrorAction Stop
        $startedAtUtc = $procInfo.StartTime.ToUniversalTime().ToString('o')
    } catch {
        $startedAtUtc = ''
    }
    if ([string]::IsNullOrWhiteSpace($startedAtUtc)) {
        throw '无法读取子进程启动时间'
    }

    if (-not (Wait-HttpHealth $healthUrl $TimeoutSec)) {
        throw '健康检查超时'
    }

    $state = [ordered]@{
        pid = $process.Id
        startedAtUtc = $startedAtUtc
        port = $Port
        logOut = $logOut
        logErr = $logErr
    }
    Write-RunState $serverStatePath $state
} catch {
    $message = $_.Exception.Message
    if ($process -ne $null) {
        $stoppedNow = Stop-LaunchedProcess -ProcessId $process.Id -StartedAtUtc $startedAtUtc -Kind 'server'
        if (-not $stoppedNow) {
            Write-Output ('WARN：无法确认进程 ' + [string]$process.Id + ' 归属，未杀进程，请人工检查。')
        }
    }
    $tmpState = $serverStatePath + '.tmp'
    if (Test-Path -LiteralPath $tmpState) { Remove-Item -LiteralPath $tmpState -Force -ErrorAction SilentlyContinue }
    Write-Output ('服务启动失败（' + $message + '），已回收本次子进程（如可确认）。')
    Write-Output ('日志：' + $logOut)
    Write-Output ('错误日志：' + $logErr)
    Get-Content -LiteralPath $logErr -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}

Write-Output ('服务已启动：http://127.0.0.1:' + [string]$Port + '/')
foreach ($ip in (Get-LanAddresses)) {
    Write-Output ('局域网：http://' + $ip + ':' + [string]$Port + '/')
}
Write-Output ('数据目录：' + $dataPath)
Write-Output ('日志：' + $logOut)
Write-Output ('错误日志：' + $logErr)
Write-Output '停止命令：powershell -ExecutionPolicy Bypass -File scripts/stop.ps1'
Write-Output ('提示：手机访问需允许防火墙入站（管理员执行 New-NetFirewallRule -DisplayName "RichMan ' + [string]$Port + '" -Direction Inbound -Protocol TCP -LocalPort ' + [string]$Port + ' -Action Allow）')
Write-Output '提示：笔记本电池策略可能让服务睡眠/退出，建议接电源或设置“接通电源时永不睡眠”。'
exit 0
