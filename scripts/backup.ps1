[CmdletBinding()]
param(
    [string]$DataDir = '',
    [string]$Out = '',
    [string]$Keep = '0',
    [switch]$WithAudit,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')
$root = Get-RichManRoot

function Fail-Backup {
    param([string]$Code, [string]$Message, [int]$ExitCode = 1)
    if ($Json) { Write-CheckJson ([ordered]@{ ok = $false; script = 'backup'; code = $Code; message = $Message }) }
    else { Write-Output ('备份失败 [' + $Code + ']：' + $Message) }
    exit $ExitCode
}

try {
    # 保留输入原文，避免 PowerShell 把 1.5 自动四舍五入为 int。
    $keepValue = 0
    if (-not [int]::TryParse($Keep, [ref]$keepValue) -or $keepValue -lt 0) {
        Fail-Backup 'BAD_ARGUMENT' '-Keep 必须是非负整数'
    }
    $dataPath = Resolve-DataDir $DataDir
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
        Fail-Backup 'DATA_DIR_MISSING' ('数据目录不存在：' + $dataPath)
    }
    if ([string]::IsNullOrWhiteSpace($Out)) {
        $backupRoot = Join-Path $dataPath 'backups'
        $baseName = 'richman-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        $outPath = Join-Path $backupRoot $baseName
        while (Test-Path -LiteralPath $outPath) {
            $outPath = Join-Path $backupRoot ($baseName + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        }
    } else {
        $outPath = [System.IO.Path]::GetFullPath($Out)
        if (Test-Path -LiteralPath $outPath) {
            Fail-Backup 'BACKUP_OUT_EXISTS' ('输出目录已存在，请换一个不存在的目录：' + $outPath) 2
        }
    }
    $cliPath = Join-Path $root 'apps/server/src/storage/backup-cli.ts'
    $cliArgs = @('--import', 'tsx', $cliPath, 'create', '--data', $dataPath, '--out', $outPath)
    if ($WithAudit) { $cliArgs += '--with-audit' }
    if ($keepValue -gt 0) { $cliArgs += @('--keep', [string]$keepValue) }
    $errorFile = [System.IO.Path]::GetTempFileName()
    try {
        Push-Location $root
        try {
            $nativePreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $lines = @(& node @cliArgs 2> $errorFile)
                $cliExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $nativePreference }
        }
        finally { Pop-Location }
        $diagnostics = Get-Content -LiteralPath $errorFile -Raw -Encoding UTF8
        if (-not [string]::IsNullOrWhiteSpace($diagnostics)) { [Console]::Error.Write($diagnostics) }
    } finally { Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue }
    $lastLine = @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) | Select-Object -Last 1
    $payload = ([string]$lastLine) | ConvertFrom-Json
    if ($cliExit -ne 0 -or $payload.ok -ne $true) {
        $exitCode = 1
        if ([string]$payload.code -eq 'BACKUP_OUT_EXISTS') { $exitCode = 2 }
        Fail-Backup ([string]$payload.code) ([string]$payload.message) $exitCode
    }
    $manifest = Get-Content -LiteralPath (Join-Path $outPath 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $result = [ordered]@{ ok = $true; script = 'backup'; out = $outPath; rooms = [int]$payload.rooms; skipped = @($manifest.skipped).Count; pruned = [int]$payload.pruned }
    if ($Json) { Write-CheckJson $result }
    else {
        Write-Output ('备份完成：' + $outPath)
        Write-Output ('房间：' + [string]$result.rooms + '，跳过：' + [string]$result.skipped + '，已清理旧备份：' + [string]$result.pruned)
    }
    exit 0
} catch { Fail-Backup 'INTERNAL_ERROR' $_.Exception.Message }
