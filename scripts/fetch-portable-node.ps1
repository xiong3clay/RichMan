[CmdletBinding()]
param(
    [string]$Version = 'v24.21.0',
    [string]$CacheDir = '',
    [string]$ZipPath = '',
    [string]$Sha256 = '',
    [string]$Dest = ''
)

# 下载/校验官方 Windows x64 便携 Node，只取 node.exe 与 LICENSE。
# 本文件必须保存为 UTF-8 with BOM；不使用 PowerShell 7 专有语法。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')

$root = Get-RichManRoot
if ([string]::IsNullOrWhiteSpace($CacheDir)) { $CacheDir = Join-Path $root 'artifacts/node-cache' }
if ([string]::IsNullOrWhiteSpace($Dest)) { $Dest = Join-Path $root 'node' }
$CacheDir = [System.IO.Path]::GetFullPath($CacheDir)
$Dest = [System.IO.Path]::GetFullPath($Dest)

function Normalize-Hash {
    param([string]$Value)
    $hash = $Value.Trim().ToUpperInvariant()
    if ($hash -notmatch '^[0-9A-F]{64}$') { throw '-Sha256 必须是 64 位十六进制字符串' }
    return $hash
}

function Read-ShaFromShasums {
    param([string]$Path, [string]$FileName)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $parts = @($line.Trim() -split '\s+')
        if ($parts.Count -lt 2) { continue }
        if ($parts[0] -notmatch '^[0-9A-Fa-f]{64}$') { continue }
        $name = $parts[1].TrimStart('*')
        if ($name -eq $FileName) { return $parts[0].ToUpperInvariant() }
    }
    return $null
}

function Extract-ZipEntry {
    param($Entry, [string]$Destination)
    $sourceStream = $Entry.Open()
    try {
        $targetStream = [System.IO.File]::Open($Destination,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None)
        try { $sourceStream.CopyTo($targetStream) } finally { $targetStream.Dispose() }
    } finally {
        $sourceStream.Dispose()
    }
}

function Download-File {
    param([string]$Url, [string]$Destination)
    $temp = $Destination + '.tmp-' + [Guid]::NewGuid().ToString('N')
    try {
        try {
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
        } catch { }
        Invoke-WebRequest -Uri $Url -OutFile $temp -UseBasicParsing -TimeoutSec 300
        Move-Item -LiteralPath $temp -Destination $Destination -Force
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-FetchPortableNode {
    if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
        throw '-Version 必须形如 v24.21.0'
    }
    $zipName = 'node-' + $Version + '-win-x64.zip'
    $baseUrl = 'https://nodejs.org/dist/' + $Version + '/'
    $zipUrl = $baseUrl + $zipName
    $sumsUrl = $baseUrl + 'SHASUMS256.txt'
    $explicitHash = $null
    if (-not [string]::IsNullOrWhiteSpace($Sha256)) { $explicitHash = Normalize-Hash $Sha256 }

    $zipFile = $null
    $sumsFile = $null
    $cacheHit = $false
    if (-not [string]::IsNullOrWhiteSpace($ZipPath)) {
        $resolved = Resolve-Path -LiteralPath $ZipPath -ErrorAction Stop
        $zipFile = $resolved.Path
        $sameDirSums = Join-Path (Split-Path -Parent $zipFile) 'SHASUMS256.txt'
        $cacheSums = Join-Path $CacheDir 'SHASUMS256.txt'
        if (Test-Path -LiteralPath $sameDirSums) { $sumsFile = $sameDirSums }
        elseif (Test-Path -LiteralPath $cacheSums) { $sumsFile = $cacheSums }
        $cacheHit = $true
    } else {
        if (-not (Test-Path -LiteralPath $CacheDir)) {
            New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
        }
        $cacheZip = Join-Path $CacheDir $zipName
        $cacheSums = Join-Path $CacheDir 'SHASUMS256.txt'
        if (Test-Path -LiteralPath $cacheZip) {
            $zipFile = $cacheZip
            $cacheHit = $true
        } else {
            Write-Output ('下载 ' + $zipUrl)
            Download-File $zipUrl $cacheZip
            $zipFile = $cacheZip
        }
        if (Test-Path -LiteralPath $cacheSums) {
            $sumsFile = $cacheSums
        } elseif ($explicitHash -eq $null) {
            Write-Output ('下载 ' + $sumsUrl)
            Download-File $sumsUrl $cacheSums
            $sumsFile = $cacheSums
        }
    }

    $expected = $explicitHash
    if ($null -ne $sumsFile) {
        $sumHash = Read-ShaFromShasums $sumsFile $zipName
        if ($null -eq $sumHash) { throw ('SHASUMS256.txt 中找不到 ' + $zipName) }
        if ($expected -ne $null -and $sumHash -ne $expected) {
            throw ('显式 -Sha256 与 SHASUMS256.txt 不一致：' + $expected + ' / ' + $sumHash)
        }
        $expected = $sumHash
    }
    if ($expected -eq $null) {
        throw '必须提供 -Sha256 或可读取的 SHASUMS256.txt；不提供跳过校验的开关'
    }
    $actual = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actual -ne $expected) {
        throw ('SHA256 不匹配：期望 ' + $expected + '，实际 ' + $actual)
    }
    Write-Output ('已校验 SHA256：' + $actual)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipFile)
    $tempDir = Join-Path $CacheDir ('.extract-' + [Guid]::NewGuid().ToString('N'))
    try {
        $nodeEntry = $null
        $licenseEntry = $null
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -match '^[^/]+/node\.exe$') { $nodeEntry = $entry }
            elseif ($entry.FullName -match '^[^/]+/LICENSE$') { $licenseEntry = $entry }
        }
        if ($null -eq $nodeEntry) { throw 'zip 中找不到 node.exe' }
        if ($null -eq $licenseEntry) { throw 'zip 中找不到 LICENSE' }
        if (-not (Test-Path -LiteralPath $tempDir)) {
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
        }
        Extract-ZipEntry $nodeEntry (Join-Path $tempDir 'node.exe')
        Extract-ZipEntry $licenseEntry (Join-Path $tempDir 'LICENSE')
        if (-not (Test-Path -LiteralPath $Dest)) {
            New-Item -ItemType Directory -Path $Dest -Force | Out-Null
        }
        Copy-Item -LiteralPath (Join-Path $tempDir 'node.exe') -Destination (Join-Path $Dest 'node.exe') -Force
        Copy-Item -LiteralPath (Join-Path $tempDir 'LICENSE') -Destination (Join-Path $Dest 'LICENSE') -Force
    } finally {
        $archive.Dispose()
        if (Test-Path -LiteralPath $tempDir) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $versionText = $Version + [Environment]::NewLine
    [System.IO.File]::WriteAllText((Join-Path $Dest 'VERSION'), $versionText, (New-Object System.Text.UTF8Encoding($false)))
    $nodeExe = Join-Path $Dest 'node.exe'
    $reported = (& $nodeExe --version).Trim()
    if ($reported -ne $Version) {
        throw ('node.exe --version 返回 ' + $reported + '，期望 ' + $Version)
    }
    Write-Output ('便携 Node 已准备：' + $Dest)
    Write-Output ('版本：' + $reported)
    if ($cacheHit) { Write-Output '缓存：命中（未重新下载）' }
}

try {
    Invoke-FetchPortableNode
    exit 0
} catch {
    Write-Output ('便携 Node 获取失败：' + $_.Exception.Message)
    Write-Output ('可手动把 node-' + $Version + '-win-x64.zip 和 SHASUMS256.txt 放进 ' + $CacheDir + ' 后重跑。')
    exit 1
}
