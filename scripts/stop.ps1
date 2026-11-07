[CmdletBinding()]
param(
    [string]$DataDir = '',
    [switch]$CheckOnly
)

# RichMan 一键停止隧道与本地服务（Windows PowerShell 5.1 / pwsh 7 兼容）。
# 只按状态文件里的 pid + 进程名白名单停止，绝不按端口杀陌生进程。
# 本文件必须保存为 UTF-8 with BOM。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$dataPath = Resolve-DataDir $DataDir
$runDir = Join-Path $dataPath 'run'
$tunnelStatePath = Join-Path $runDir 'tunnel.json'
$serverStatePath = Join-Path $runDir 'server.json'

$targets = @(
    [ordered]@{ kind = 'tunnel'; path = $tunnelStatePath },
    [ordered]@{ kind = 'server'; path = $serverStatePath }
)

$stopped = @()
$warnings = @()
$hasUnresolved = $false
$hasStopFailure = $false
$serverPort = 0
$serverStateExisted = $false
$serverStopped = $false

foreach ($target in $targets) {
    $statePath = $target.path
    if (-not (Test-Path -LiteralPath $statePath)) { continue }
    $state = Read-RunState $statePath
    if ($state -eq $null) {
        $warnings += ('状态文件存在但无法解析（可能损坏）：' + $statePath + '，未按端口杀进程，请人工检查。')
        $hasUnresolved = $true
        continue
    }
    $statePort = 0
    try { $statePort = [int]$state.port } catch { $statePort = 0 }
    if ($target.kind -eq 'server') {
        $serverStateExisted = $true
        $serverPort = $statePort
    }

    $runInfo = Get-RunStateProcess $state $target.kind
    if ($runInfo.status -eq 'stale') {
        $warnings += ('状态文件 ' + $statePath + ' 的进程已退出，已清理状态（未按端口杀进程）。')
        if (-not $CheckOnly) { Remove-RunState $statePath }
        continue
    }
    if ($runInfo.status -ne 'running') {
        $warnings += ('状态文件 ' + $statePath + ' 与进程不匹配（' + $runInfo.reason + '），未杀进程，请人工确认后删除状态文件或手动停止。')
        $hasUnresolved = $true
        continue
    }

    if ($CheckOnly) {
        $stopped += [ordered]@{ kind = $target.kind; pid = $runInfo.pid; port = $statePort; running = $true }
        continue
    }
    try {
        Stop-Process -Id $runInfo.pid -Force -ErrorAction Stop
        $stopped += [ordered]@{ kind = $target.kind; pid = $runInfo.pid; port = $statePort; running = $false }
        Write-Output ('已停止 ' + $target.kind + '（pid ' + [string]$runInfo.pid + '）。')
        Remove-RunState $statePath
        if ($target.kind -eq 'server') { $serverStopped = $true }
    } catch {
        $warnings += ('停止 ' + $target.kind + '（pid ' + [string]$runInfo.pid + '）失败：' + $_.Exception.Message)
        $hasUnresolved = $true
        $hasStopFailure = $true
    }
}

if ($CheckOnly) {
    $result = [ordered]@{
        ok = (-not $hasUnresolved)
        checkOnly = $true
        dataDir = $dataPath
        planned = $stopped
        warnings = $warnings
    }
    Write-CheckJson $result
    if ($hasUnresolved) { exit 2 } else { exit 0 }
}

if ($hasUnresolved) {
    foreach ($warning in $warnings) { Write-Output ('WARN：' + $warning) }
    $reason = 'STATE_UNRESOLVED'
    if ($hasStopFailure) { $reason = 'STOP_FAILED' }
    $result = [ordered]@{
        ok = $false
        reason = $reason
        stopped = $stopped
        warnings = $warnings
        dataDir = $dataPath
    }
    Write-CheckJson $result
    exit 2
}

if ($stopped.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Output '未在运行（没有找到 server.json / tunnel.json）。'
    $result = [ordered]@{ ok = $true; stopped = @(); warnings = @(); dataDir = $dataPath }
    Write-CheckJson $result
    exit 0
}

$portStillUsed = $false
if ($serverStateExisted -and $serverStopped -and $serverPort -gt 0) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((-not (Test-PortFree $serverPort)) -and ((Get-Date) -lt $deadline)) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-PortFree $serverPort)) {
        $portStillUsed = $true
        $warnings += ('端口 ' + [string]$serverPort + ' 仍被占用，可能有非本服务进程；未强行杀进程。')
    }
}

if ($portStillUsed) {
    Write-Output 'WARN：端口仍被占用，可能有非本服务进程。'
    $result = [ordered]@{
        ok = $false
        reason = 'PORT_STILL_OCCUPIED'
        stopped = $stopped
        warnings = $warnings
        dataDir = $dataPath
        port = $serverPort
    }
    Write-CheckJson $result
    exit 2
}

foreach ($warning in $warnings) { Write-Output ('WARN：' + $warning) }
Write-Output '已全部停止。'
$result = [ordered]@{
    ok = $true
    stopped = $stopped
    warnings = $warnings
    dataDir = $dataPath
}
Write-CheckJson $result
exit 0
