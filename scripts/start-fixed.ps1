[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$DataDir = '',
    [string]$Tailscale = '',
    [switch]$NoBrowser,
    [switch]$CheckOnly
)

# RichMan 固定公网地址（Tailscale Funnel）一键入口：双击 start-fixed.bat。
# 流程：本地服务没起就自动起 start-lan → 调用 tailscale funnel --bg 暴露固定地址
#       → 打印并复制地址、确认 DNS 后打开浏览器。
# 前置条件：Windows 已安装并登录 Tailscale，且 tailnet 已启用 Funnel（首次会给出启用链接）。
# 兼容 Windows PowerShell 5.1 / pwsh 7；本文件必须保存为 UTF-8 with BOM。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$layout = Get-RichManLayout
$dataPath = Resolve-DataDir $DataDir
$healthUrl = 'http://127.0.0.1:' + [string]$Port + '/health'

function Get-TailscalePath {
    param([string]$Explicit)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
        return $null
    }
    if (-not [string]::IsNullOrWhiteSpace($env:RICHMAN_TAILSCALE)) {
        if (Test-Path -LiteralPath $env:RICHMAN_TAILSCALE) { return (Resolve-Path -LiteralPath $env:RICHMAN_TAILSCALE).Path }
        return $null
    }
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe')
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe')
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    $onPath = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
    if ($onPath -ne $null) { return $onPath.Source }
    return $null
}

function Get-FunnelUrl {
    param([string]$TailscalePath)
    try {
        $raw = & $TailscalePath status --json 2>$null
        if ($LASTEXITCODE -ne 0) { return '' }
        $info = ([string]$raw) | ConvertFrom-Json
        $dnsName = [string]$info.Self.DNSName
        if ([string]::IsNullOrWhiteSpace($dnsName)) { return '' }
        return 'https://' + $dnsName.TrimEnd('.')
    } catch {
        return ''
    }
}

function Show-FixedBanner {
    param([string]$Url)
    Write-Output ''
    Write-Output '================================================'
    Write-Output ('固定公网地址：' + $Url)
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
        Write-Output '正在确认域名解析（最多 15 秒）……'
        $resolved = $false
        $hostName = ''
        try { $hostName = ([Uri]$Url).Host } catch { $hostName = '' }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline -and $hostName -ne '') {
            try {
                $addresses = [System.Net.Dns]::GetHostAddresses($hostName)
                if ($addresses -ne $null -and $addresses.Length -gt 0) { $resolved = $true; break }
            } catch { }
            Start-Sleep -Seconds 2
        }
        if ($resolved) {
            try {
                Start-Process -FilePath $Url -ErrorAction Stop | Out-Null
                Write-Output '已用默认浏览器打开。'
            } catch {
                Write-Output '打开浏览器失败，请手动复制上面的地址。'
            }
        } else {
            Write-Output 'WARN：域名暂时解析不到，地址已复制；等 1～3 分钟后在浏览器刷新。'
        }
    }
    Write-Output '玩法：一台电脑建房 → 其他设备打开该地址 → 输入 4 位房间码加入。'
    Write-Output '固定地址重启后不变；但本机电脑必须保持开机、联网且 Tailscale 已登录。'
    Write-Output '如果页面报 502：本机游戏服务停了，重新双击 start-fixed.bat 即可恢复。'
    Write-Output '停止本机服务：双击 stop.bat（不会关闭 Tailscale Funnel；再开就再双击本脚本）。'
}

if ($CheckOnly) {
    $localOk = Wait-HttpHealth $healthUrl 5
    $tsPath = Get-TailscalePath $Tailscale
    $reason = ''
    if ($tsPath -eq $null) { $reason = 'TAILSCALE_NOT_FOUND' }
    elseif (-not $localOk) { $reason = 'LOCAL_SERVER_DOWN' }
    $funnelUrl = ''
    if ($tsPath -ne $null) { $funnelUrl = Get-FunnelUrl $tsPath }
    $result = [ordered]@{
        ok = ($reason -eq '')
        reason = $reason
        port = $Port
        dataDir = $dataPath
        localServer = [ordered]@{ ok = $localOk; url = $healthUrl }
        tailscale = [ordered]@{ ok = ($tsPath -ne $null); path = $tsPath }
        funnel = [ordered]@{ url = $funnelUrl }
    }
    Write-CheckJson $result
    if ($result.ok) { exit 0 } else { exit 1 }
}

# ---- 1. 本地服务：没起就自动起（等价 start-lan）----
$localOk = Wait-HttpHealth $healthUrl 3
if (-not $localOk) {
    $serverStatePath = Join-Path $dataPath 'run/server.json'
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

# ---- 2. Tailscale ----
$tsPath = Get-TailscalePath $Tailscale
if ($tsPath -eq $null) {
    Write-Output '未找到 Tailscale（固定公网地址依赖它）。'
    Write-Output '  1) 安装：https://tailscale.com/download/windows'
    Write-Output '  2) 登录后重新双击 start-fixed.bat'
    Write-Output ('  3) 若装在自定义位置，设置环境变量 RICHMAN_TAILSCALE 指向 tailscale.exe')
    Write-Output '（本地服务已经可用；没有固定地址时，局域网仍可继续玩，或改用 start-tunnel.bat。）'
    exit 1
}
Write-Output ('Tailscale：' + $tsPath)

# ---- 3. 开启 Funnel（端口固定，重复执行是幂等的）----
Write-Output ('正在开启固定公网地址（Funnel → 本机 ' + [string]$Port + ' 端口）……')
$funnelCode = 0
try {
    & $tsPath funnel --bg $Port 2>&1 | ForEach-Object { Write-Output ([string]$_) }
    $funnelCode = $LASTEXITCODE
} catch {
    Write-Output ('Funnel 调用失败：' + $_.Exception.Message)
    $funnelCode = 1
}
if ($funnelCode -ne 0) {
    Write-Output '开启 Funnel 失败。常见原因与处理：'
    Write-Output '  - tailnet 未启用 Funnel：打开 https://login.tailscale.com/f/funnel 启用后重试'
    Write-Output '  - 未登录/离线：右键任务栏 Tailscale 图标确认已登录'
    Write-Output '  - HTTPS 证书还在签发：等 1～2 分钟再双击一次'
    Write-Output '（本地服务不受影响，可先用 start-lan.bat 局域网玩。）'
    exit 1
}

$url = Get-FunnelUrl $tsPath
if ([string]::IsNullOrWhiteSpace($url)) {
    Write-Output 'WARN：Funnel 已开启，但读不到本机 Tailscale 域名。'
    Write-Output '请在 Tailscale 托盘菜单查看设备名，或运行：tailscale status'
    exit 1
}

Show-FixedBanner -Url $url
Write-Output ('本机端口：http://127.0.0.1:' + [string]$Port + '/')
exit 0
