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
$serverPort = 0
$serverStateExisted = $false
$serverStopped = $false

foreach ($target in $targets) {
    $state = Read-RunState $target.path
    if ($state -eq $null) { continue }
    if ($target.kind -eq 'server') {
        $serverStateExisted = $true
        try { $serverPort = [int]$state.port } catch { $serverPort = 0 }
    }
    $process = Get-ProcessInfo $state $target.kind
    if ($process -eq $null) {
        $warnings += ('状态文件 ' + $target.path + ' 的 pid 不是存活的 ' + $target.kind + ' 进程，已清理状态（未按端口杀进程）。')
        if (-not $CheckOnly) { Remove-RunState $target.path }
        continue
    }
    if ($CheckOnly) {
        $stopped += [ordered]@{ kind = $target.kind; pid = $process.Id; running = $true }
        continue
    }
    try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        $stopped += [ordered]@{ kind = $target.kind; pid = $process.Id; running = $false }
        Write-Output ('已停止 ' + $target.kind + '（pid ' + [string]$process.Id + '）。')
        Remove-RunState $target.path
        if ($target.kind -eq 'server') { $serverStopped = $true }
    } catch {
        $warnings += ('停止 ' + $target.kind + '（pid ' + [string]$process.Id + '）失败：' + $_.Exception.Message)
    }
}

if ($CheckOnly) {
    $result = [ordered]@{
        ok = $true
        checkOnly = $true
        dataDir = $dataPath
        planned = $stopped
        warnings = $warnings
    }
    Write-CheckJson $result
    exit 0
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

Write-Output '已全部停止。'
$result = [ordered]@{
    ok = $true
    stopped = $stopped
    warnings = $warnings
    dataDir = $dataPath
}
Write-CheckJson $result
exit 0
