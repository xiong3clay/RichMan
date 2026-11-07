[CmdletBinding()]
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
$serverStatePath = Join-Path $runDir 'server.json'
$tunnelStatePath = Join-Path $runDir 'tunnel.json'

$serverStateExists = Test-Path -LiteralPath $serverStatePath
$serverState = Read-RunState $serverStatePath
$serverStateBroken = $serverStateExists -and ($serverState -eq $null)
$serverRun = Get-RunStateProcess $serverState 'server'

if (-not $PSBoundParameters.ContainsKey('Port') -and $serverState -ne $null) {
    $statePort = 0
    try { $statePort = [int]$serverState.port } catch { $statePort = 0 }
    if ($statePort -gt 0) { $Port = $statePort }
}
$healthUrl = 'http://127.0.0.1:' + [string]$Port + '/health'

$serverOk = $false
$serverReason = ''
$rooms = 0
$connections = 0
$stateStatus = 'missing'
if ($serverStateBroken) {
    $stateStatus = 'broken'
} elseif ($serverStateExists) {
    $stateStatus = $serverRun.status
}
$stateNote = ''
if ($stateStatus -ne 'running' -and $stateStatus -ne 'missing') {
    $stateNote = $stateStatus
}
if ($stateStatus -eq 'broken') {
    $serverReason = '状态文件损坏，无法确认进程归属'
} elseif ($stateStatus -eq 'stale') {
    $serverReason = '状态文件记录的进程已退出'
} elseif ($stateStatus -eq 'mismatch' -or $stateStatus -eq 'unknown') {
    $serverReason = '状态文件与进程不匹配：' + $serverRun.reason
}

# 状态文件不可信不等于服务不健康：只要端口有效就探测 /health。
if ($Port -gt 0) {
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
            $body = $response.Content | ConvertFrom-Json
            if ($body.ok -eq $true -and [string]$body.service -eq 'richman') {
                $serverOk = $true
                $serverReason = ''
                if ($body.rooms -ne $null) { $rooms = [int]$body.rooms }
                if ($body.connections -ne $null) { $connections = [int]$body.connections }
            } elseif ($serverReason -eq '') {
                $serverReason = '健康检查返回的不是 RichMan 服务'
            }
        } elseif ($serverReason -eq '') {
            $serverReason = ('HTTP ' + [string]$response.StatusCode)
        }
    } catch {
        if ($serverReason -eq '') { $serverReason = $_.Exception.Message }
    }
}

$tunnelStateExists = Test-Path -LiteralPath $tunnelStatePath
$tunnelState = Read-RunState $tunnelStatePath
$tunnelStateBroken = $tunnelStateExists -and ($tunnelState -eq $null)
$tunnelRun = Get-RunStateProcess $tunnelState 'tunnel'
$tunnelUrl = ''
$tunnelProcessOk = $false
$tunnelHealthy = $false
$tunnelReason = ''
if ($tunnelStateBroken) {
    $tunnelReason = '状态文件损坏，无法确认进程归属'
} elseif ($tunnelStateExists -and $tunnelRun.status -ne 'running') {
    if ($tunnelRun.status -eq 'stale') {
        $tunnelReason = '状态文件记录的进程已退出'
    } else {
        $tunnelReason = '状态文件与进程不匹配：' + $tunnelRun.reason
    }
} elseif ($tunnelRun.status -eq 'running') {
    $tunnelProcessOk = $true
    try { $tunnelUrl = [string]$tunnelState.url } catch { $tunnelUrl = '' }
    if (-not [string]::IsNullOrEmpty($tunnelUrl)) {
        $tunnelHealthy = Wait-HttpHealth ($tunnelUrl + '/health') 5
    }
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
        stateNote = $stateNote
    }
    tunnel = [ordered]@{
        ok = $tunnelHealthy
        url = $tunnelUrl
        processRunning = $tunnelProcessOk
        reason = $tunnelReason
    }
}

if ($Json) {
    Write-CheckJson $jsonResult
} else {
    if ($serverOk) {
        Write-Output ('本地服务：OK  http://127.0.0.1:' + [string]$Port + '/  房间=' + [string]$rooms + '  连接=' + [string]$connections)
        if ($stateNote -ne '') {
            Write-Output '注意：状态文件已过期/损坏，进程归属无法确认，但端口上的 RichMan 服务健康。'
        }
    } else {
        Write-Output ('本地服务：未就绪  http://127.0.0.1:' + [string]$Port + '/  原因：' + $serverReason)
    }
    if ($tunnelProcessOk -and -not [string]::IsNullOrEmpty($tunnelUrl)) {
        if ($tunnelHealthy) {
            Write-Output ('隧道：OK  ' + $tunnelUrl)
        } else {
            Write-Output ('隧道：WARN  进程在运行但健康检查未通过  ' + $tunnelUrl)
        }
        Write-Output '提醒：每重启隧道域名都会变；换域名后用房间码+恢复码恢复。'
    } elseif ([string]::IsNullOrEmpty($tunnelReason)) {
        Write-Output '隧道：未运行'
    } else {
        Write-Output ('隧道：WARN  ' + $tunnelReason)
    }
    Write-Output ('数据目录：' + $dataPath)
}

if ($serverOk) { exit 0 } else { exit 1 }
