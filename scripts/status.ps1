param(
    [int]$Port = 8000,
    [string]$DataDir = '',
    [switch]$Json,
    [switch]$CheckOnly
)

# RichMan 运行状态（Windows PowerShell 5.1 / pwsh 7 兼容）。
# 只读：不启动、不停止、不修改状态文件。
# 本文件必须保存为 UTF-8 with BOM。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$dataPath = Resolve-DataDir $DataDir
$runDir = Join-Path $dataPath 'run'
$tunnelStatePath = Join-Path $runDir 'tunnel.json'
$healthUrl = 'http://127.0.0.1:' + [string]$Port + '/health'

$serverOk = $false
$serverReason = ''
$rooms = 0
$connections = 0
try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        $body = $response.Content | ConvertFrom-Json
        $serverOk = $true
        if ($body.rooms -ne $null) { $rooms = [int]$body.rooms }
        if ($body.connections -ne $null) { $connections = [int]$body.connections }
    } else {
        $serverReason = ('HTTP ' + [string]$response.StatusCode)
    }
} catch {
    $serverReason = $_.Exception.Message
}

$tunnelState = Read-RunState $tunnelStatePath
$tunnelUrl = ''
$tunnelProcessOk = $false
if ($tunnelState -ne $null) {
    $tunnelProcess = Get-ProcessInfo $tunnelState 'tunnel'
    if ($tunnelProcess -ne $null) {
        $tunnelProcessOk = $true
        try { $tunnelUrl = [string]$tunnelState.url } catch { $tunnelUrl = '' }
    }
}
$tunnelHealthy = $false
if (-not [string]::IsNullOrEmpty($tunnelUrl)) {
    $tunnelHealthy = Wait-HttpHealth ($tunnelUrl + '/health') 5
}

$jsonResult = [ordered]@{
    ok = $serverOk
    port = $Port
    dataDir = $dataPath
    server = [ordered]@{
        ok = $serverOk
        port = $Port
        rooms = $rooms
        connections = $connections
        reason = $serverReason
    }
    tunnel = [ordered]@{
        ok = $tunnelHealthy
        url = $tunnelUrl
        processRunning = $tunnelProcessOk
    }
}

if ($Json) {
    Write-CheckJson $jsonResult
} else {
    if ($serverOk) {
        Write-Output ('本地服务：OK  http://127.0.0.1:' + [string]$Port + '/  房间=' + [string]$rooms + '  连接=' + [string]$connections)
    } else {
        Write-Output ('本地服务：未就绪  http://127.0.0.1:' + [string]$Port + '/  原因：' + $serverReason)
    }
    if (-not [string]::IsNullOrEmpty($tunnelUrl)) {
        if ($tunnelHealthy) {
            Write-Output ('隧道：OK  ' + $tunnelUrl)
        } else {
            Write-Output ('隧道：WARN  进程在运行但健康检查未通过  ' + $tunnelUrl)
        }
        Write-Output '提醒：每重启隧道域名都会变；换域名后用房间码+恢复码恢复。'
    } else {
        Write-Output '隧道：未运行'
    }
    Write-Output ('数据目录：' + $dataPath)
}

if ($serverOk) { exit 0 } else { exit 1 }
