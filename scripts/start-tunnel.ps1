[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$DataDir = '',
    [string]$Cloudflared = '',
    [int]$TimeoutSec = 90,
    [switch]$NoDownload,
    [switch]$NoBrowser,
    [switch]$CheckOnly
)

# RichMan 一键开启公网临时隧道（双击 start-tunnel.bat 即可，无需先启动服务）。
# 流程：本地服务未运行则自动启动（等价 start-lan）→ 缺 cloudflared 自动下载
#       → 起 cloudflared 临时隧道 → 打印并复制公网地址、打开浏览器。
# 兼容 Windows PowerShell 5.1 / pwsh 7；本文件必须保存为 UTF-8 with BOM。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$layout = Get-RichManLayout
$dataPath = Resolve-DataDir $DataDir
$runDir = Join-Path $dataPath 'run'
$logDir = Join-Path $dataPath 'logs'
$tunnelStatePath = Join-Path $runDir 'tunnel.json'
$serverStatePath = Join-Path $runDir 'server.json'
$healthUrl = 'http://127.0.0.1:' + [string]$Port + '/health'
$cloudflaredPath = Get-CloudflaredPath $Cloudflared

function Show-CloudflaredHelp {
    Write-Output '未找到 cloudflared.exe。任选一种：'
    if ($layout.Portable) {
        Write-Output ('  0) 直接重新双击 start-tunnel.bat，让它自动下载到 ' + (Join-Path $layout.Root 'tools/cloudflared.exe'))
        Write-Output ('  1) 手动放到 ' + (Join-Path $layout.Root 'tools/cloudflared.exe'))
    } else {
        Write-Output '  0) 去掉 -NoDownload 重新运行，它会自动下载到 tools/cloudflared.exe'
        Write-Output ('  1) 手动放到 ' + (Join-Path $layout.Root 'tools/cloudflared.exe'))
    }
    Write-Output '  2) 设置环境变量 RICHMAN_CLOUDFLARED 指向该 exe'
    Write-Output '  3) winget install Cloudflare.cloudflared'
    Write-Output '  下载：https://github.com/cloudflare/cloudflared/releases'
}

function Wait-TunnelDns {
    param([string]$Url, [int]$TimeoutSec = 30)
    $hostName = ''
    try { $hostName = ([Uri]$Url).Host } catch { return $false }
    if ([string]::IsNullOrWhiteSpace($hostName)) { return $false }
    Write-Output ('正在确认域名解析：' + $hostName + '（最多 ' + [string]$TimeoutSec + ' 秒）……')
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $addresses = [System.Net.Dns]::GetHostAddresses($hostName)
            if ($addresses -ne $null -and $addresses.Length -gt 0) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Show-TunnelBanner {
    param([string]$Url)
    Write-Output ''
    Write-Output '================================================'
    Write-Output ('公网地址：' + $Url)
    Write-Output '================================================'
    $copied = $false
    try {
        Set-Clipboard -Value $Url -ErrorAction Stop
        $copied = $true
    } catch {
        $copied = $false
    }
    if ($copied) {
        Write-Output '已复制到剪贴板。'
    } else {
        Write-Output '剪贴板不可用，请手动复制上面的地址。'
    }
    if (-not $NoBrowser) {
        if (Wait-TunnelDns -Url $Url -TimeoutSec 30) {
            try {
                Start-Process -FilePath $Url -ErrorAction Stop | Out-Null
                Write-Output '已用默认浏览器打开。'
            } catch {
                Write-Output '打开浏览器失败，请手动复制上面的地址。'
            }
        } else {
            Write-Output 'WARN：域名暂时还解析不到（校园 DNS 可能缓存了否定结果）。'
            Write-Output '      地址已复制到剪贴板，先不要关这个窗口：等 1～3 分钟后在浏览器里刷新即可。'
            Write-Output '      急着用可让手机开热点给电脑，或把 DNS 换成 1.1.1.1 / 223.5.5.5。'
        }
    }
    Write-Output '玩法：一台电脑建房 → 其他设备打开该地址 → 输入 4 位房间码加入。'
    Write-Output '停止：双击 stop.bat（同时停服务和隧道）。'
    Write-Output '注意：关闭本窗口不会停服务；重启隧道后域名会变，用「房间码+恢复码」回座。'
}

if ($CheckOnly) {
    $localOk = Wait-HttpHealth $healthUrl 5
    $existing = Read-RunState $tunnelStatePath
    $existingRun = Get-RunStateProcess $existing 'tunnel'
    $existingUrl = ''
    if ($existingRun.status -eq 'running') {
        try { $existingUrl = [string]$existing.url } catch { $existingUrl = '' }
    }
    $alreadyRunning = ($existingRun.status -eq 'running') -and (-not [string]::IsNullOrEmpty($existingUrl))
    $allOk = $localOk -and ($cloudflaredPath -ne $null) -and (-not $alreadyRunning)
    $reason = ''
    if ($alreadyRunning) { $reason = 'ALREADY_RUNNING' }
    elseif (-not $localOk) { $reason = 'LOCAL_SERVER_DOWN' }
    elseif ($cloudflaredPath -eq $null) { $reason = 'CLOUDFLARED_NOT_FOUND' }
    $result = [ordered]@{
        ok = $allOk
        reason = $reason
        port = $Port
        dataDir = $dataPath
        localServer = [ordered]@{ ok = $localOk; url = $healthUrl }
        cloudflared = [ordered]@{ ok = ($cloudflaredPath -ne $null); path = $cloudflaredPath }
        alreadyRunning = [ordered]@{ ok = (-not $alreadyRunning); running = $alreadyRunning; url = $existingUrl }
    }
    Write-CheckJson $result
    if ($allOk) { exit 0 } else { exit 1 }
}

# ---- 1. 本地服务：没起就自动起（等价 start-lan）----
$localOk = Wait-HttpHealth $healthUrl 3
if (-not $localOk) {
    $serverState = Read-RunState $serverStatePath
    $serverRun = Get-RunStateProcess $serverState 'server'
    if ($serverRun.status -eq 'running') {
        $adoptPort = 0
        try { $adoptPort = [int]$serverState.port } catch { $adoptPort = 0 }
        if ($adoptPort -gt 0 -and $adoptPort -ne $Port) {
            $adoptHealth = 'http://127.0.0.1:' + [string]$adoptPort + '/health'
            if (Wait-HttpHealth $adoptHealth 3) {
                Write-Output ('检测到本地服务已在端口 ' + [string]$adoptPort + ' 运行，沿用它。')
                $Port = $adoptPort
                $healthUrl = $adoptHealth
                $localOk = $true
            }
        }
    }
}
if (-not $localOk) {
    Write-Output '本地服务未运行，正在自动启动……'
    $lanExeName = 'powershell.exe'
    if ($PSVersionTable.PSEdition -eq 'Core') { $lanExeName = 'pwsh.exe' }
    $lanExe = Join-Path $PSHOME $lanExeName
    if (-not (Test-Path -LiteralPath $lanExe)) { $lanExe = $lanExeName }
    & $lanExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-lan.ps1') -Port $Port -DataDir $dataPath
    $lanCode = $LASTEXITCODE
    $localOk = Wait-HttpHealth $healthUrl 30
    if (-not $localOk) {
        Write-Output ('本地服务自动启动失败（start-lan 退出码 ' + [string]$lanCode + '）。')
        Write-Output '请单独双击 start-lan.bat 查看完整原因，或换端口：scripts/start-lan.ps1 -Port 8001。'
        exit 1
    }
}

# ---- 2. cloudflared：缺了就自动下载 ----
if ($cloudflaredPath -eq $null) {
    if ($NoDownload) {
        Show-CloudflaredHelp
        Write-Output '（本地服务已经可用，只是公网隧道没开起来；局域网仍可继续玩。）'
        exit 1
    }
    $toolsDir = Join-Path $layout.Root 'tools'
    $cfTarget = Join-Path $toolsDir 'cloudflared.exe'
    $cfTmp = $cfTarget + '.download'
    $cfUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Write-Output '未找到 cloudflared.exe，正在自动下载（仅首次，约 40MB）……'
    if (-not (Test-Path -LiteralPath $toolsDir)) {
        New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    }
    $previousProgress = $ProgressPreference
    try {
        try {
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        } catch { }
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $cfUrl -OutFile $cfTmp -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $cfTmp)) { throw '下载未生成文件' }
        $cfSize = (Get-Item -LiteralPath $cfTmp).Length
        if ($cfSize -lt 5242880) { throw ('下载文件过小（' + [string]$cfSize + ' 字节），可能被网络拦截') }
        Move-Item -LiteralPath $cfTmp -Destination $cfTarget -Force -ErrorAction Stop
        $cloudflaredPath = (Resolve-Path -LiteralPath $cfTarget).Path
        Write-Output ('已下载：' + $cloudflaredPath)
    } catch {
        Write-Output ('自动下载失败：' + $_.Exception.Message)
        if (Test-Path -LiteralPath $cfTmp) { Remove-Item -LiteralPath $cfTmp -Force -ErrorAction SilentlyContinue }
        $cloudflaredPath = $null
    } finally {
        $ProgressPreference = $previousProgress
    }
    if ($cloudflaredPath -eq $null) {
        Show-CloudflaredHelp
        Write-Output '（本地服务已经可用，只是公网隧道没开起来；局域网仍可继续玩。）'
        exit 1
    }
} else {
    Write-Output ('cloudflared：' + $cloudflaredPath)
}

# ---- 3. 已有隧道：直接给出地址 ----
$existing = Read-RunState $tunnelStatePath
$existingRun = Get-RunStateProcess $existing 'tunnel'
$existingUrl = ''
if ($existingRun.status -eq 'running') {
    try { $existingUrl = [string]$existing.url } catch { $existingUrl = '' }
}
if ($existingRun.status -eq 'running' -and (-not [string]::IsNullOrEmpty($existingUrl))) {
    $existingPort = 0
    try { $existingPort = [int]$existing.port } catch { $existingPort = 0 }
    if ($existingPort -gt 0 -and $existingPort -ne $Port) {
        Write-Output ('WARN：现有隧道指向端口 ' + [string]$existingPort + '，与当前端口 ' + [string]$Port + ' 不同。')
        Write-Output '请先双击 stop.bat，再重新双击 start-tunnel.bat。'
        exit 1
    }
    Write-Output ('隧道已在运行，沿用现有地址：' + $existingUrl)
    Show-TunnelBanner -Url $existingUrl
    exit 0
}

# ---- 4. 启动 cloudflared ----
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

Show-TunnelBanner -Url $url
Write-Output ('本机端口：http://127.0.0.1:' + [string]$Port + '/')
Write-Output ('日志：' + $logOut)

if (-not (Wait-HttpHealth ($url + '/health') 30)) {
    Write-Output 'WARN：隧道已开，但健康检查暂未通过，校园 DNS 可能延迟，稍后可用 status 复查。'
}
exit 0
