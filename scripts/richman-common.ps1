# RichMan 公共函数：被 start-lan / start-tunnel / stop / status dot-source。
# 兼容 Windows PowerShell 5.1 与 PowerShell 7；不使用 7 专有语法。
# 本文件必须保存为 UTF-8 with BOM。

# 被重定向捕获时也输出 UTF-8，避免 Windows PowerShell 5.1 按 OEM 编码写中文。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Get-RichManRoot {
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrEmpty($scriptDir)) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    return (Split-Path -Parent $scriptDir)
}

function Resolve-DataDir {
    param([string]$Value = '')
    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:RICHMAN_DATA_DIR)) {
        return [System.IO.Path]::GetFullPath($env:RICHMAN_DATA_DIR)
    }
    $root = Get-RichManRoot
    return [System.IO.Path]::GetFullPath((Join-Path $root 'apps/server/data'))
}

function Read-RunState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Write-RunState {
    param([string]$Path, $Object)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json = $Object | ConvertTo-Json -Compress -Depth 8
    $tmp = $Path + '.tmp'
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $json, $encoding)
    try {
        Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
    } catch {
        # Move 失败时不留半写 .tmp，再把原异常抛给调用方。
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Remove-RunState {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

function Test-PortFree {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $Port)
        return $false
    } catch [System.Net.Sockets.SocketException] {
        # 连接被拒绝 / 主机不可达：端口空闲。
        return $true
    } catch [System.InvalidOperationException] {
        # 连接状态异常：按空闲处理，避免误报占用。
        return $true
    } finally {
        try { $client.Close() } catch { }
    }
}

function Wait-HttpHealth {
    param([string]$Url, [int]$TimeoutSec = 40)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                $body = $response.Content | ConvertFrom-Json
                if ($body.ok -eq $true -and [string]$body.service -eq 'richman') { return $true }
            }
        } catch {
            # 端口未就绪 / 连接被拒 / JSON 解析失败；继续轮询，不打印堆栈。
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-CloudflaredPath {
    param([string]$Explicit = '')
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
        return $null
    }
    if (-not [string]::IsNullOrWhiteSpace($env:RICHMAN_CLOUDFLARED)) {
        if (Test-Path -LiteralPath $env:RICHMAN_CLOUDFLARED) {
            return (Resolve-Path -LiteralPath $env:RICHMAN_CLOUDFLARED).Path
        }
    }
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($command -ne $null) {
        if ($command.PSObject.Properties['Source'] -ne $null) { return $command.Source }
        if ($command.PSObject.Properties['Path'] -ne $null) { return $command.Path }
    }
    $fallback = 'D:\Lianjunjie\tools\cloudflared.exe'
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

function Get-RunStateProcess {
    param($State, [string]$Kind)
    $result = [ordered]@{ status = 'missing'; reason = '没有状态文件或状态为空'; process = $null; pid = 0 }
    if ($State -eq $null) { return $result }

    $pidValue = 0
    try { $pidValue = [int]$State.pid } catch { $pidValue = 0 }
    $result.pid = $pidValue
    if ($pidValue -le 0) {
        $result.status = 'unknown'
        $result.reason = '状态文件中的 pid 无效'
        return $result
    }

    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($process -eq $null) {
        $result.status = 'stale'
        $result.reason = '进程已退出'
        return $result
    }

    $expectedName = 'node'
    if ($Kind -eq 'tunnel') { $expectedName = 'cloudflared' }
    $actualName = $process.ProcessName.ToLowerInvariant()
    if ($actualName -ne $expectedName) {
        $result.status = 'mismatch'
        $result.reason = 'pid 现在属于 ' + $process.ProcessName + '，不是 ' + $expectedName
        return $result
    }

    $rawStart = ''
    try { $rawStart = [string]$State.startedAtUtc } catch { $rawStart = '' }
    if ([string]::IsNullOrWhiteSpace($rawStart)) {
        $result.status = 'unknown'
        $result.reason = '状态文件缺少 startedAtUtc，无法确认进程归属'
        return $result
    }

    $expectedTime = $null
    try {
        $expectedTime = [DateTime]::Parse($rawStart,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    } catch {
        $result.status = 'unknown'
        $result.reason = 'startedAtUtc 无法解析'
        return $result
    }

    $actualTime = $process.StartTime.ToUniversalTime()
    $diffSeconds = [Math]::Abs(($actualTime - $expectedTime).TotalSeconds)
    if ($diffSeconds -gt 2) {
        $rounded = [Math]::Round($diffSeconds)
        $result.status = 'mismatch'
        $result.reason = '进程启动时间与状态文件相差 ' + [string]$rounded + ' 秒，pid 可能已被复用'
        return $result
    }

    $result.status = 'running'
    $result.reason = ''
    $result.process = $process
    return $result
}

function Stop-LaunchedProcess {
    param([int]$ProcessId, [string]$StartedAtUtc = '', [string]$Kind = 'server')
    if ($ProcessId -le 0) { return $true }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($process -eq $null) { return $true }
    if (-not [string]::IsNullOrWhiteSpace($StartedAtUtc)) {
        try {
            $expectedTime = [DateTime]::Parse($StartedAtUtc,
                [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AdjustToUniversal)
            $diffSeconds = [Math]::Abs(($process.StartTime.ToUniversalTime() - $expectedTime).TotalSeconds)
            if ($diffSeconds -gt 2) { return $false }
        } catch {
            return $false
        }
    }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-LanAddresses {
    $result = @()
    $interfaces = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
    foreach ($nic in $interfaces) {
        if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
        $properties = $nic.GetIPProperties()
        foreach ($address in $properties.UnicastAddresses) {
            if ($address.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
            if ([System.Net.IPAddress]::IsLoopback($address.Address)) { continue }
            $result += $address.Address.ToString()
        }
    }
    return $result
}

function Write-CheckJson {
    param($Object)
    $json = $Object | ConvertTo-Json -Compress -Depth 8
    Write-Output $json
}
