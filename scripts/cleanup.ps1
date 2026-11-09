[CmdletBinding()]
param(
    [string]$DataDir = '',
    [string]$KeepLogs = '20',
    [string]$KeepBackups = '10',
    [string]$KeepCorrupt = '5',
    [string]$TmpHours = '24',
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')
$root = Get-RichManRoot
$layout = Get-RichManLayout

function Fail-Cleanup {
    param([string]$Code, [string]$Message)
    if ($Json) { Write-CheckJson ([ordered]@{ ok = $false; script = 'cleanup'; code = $Code; message = $Message }) }
    else { Write-Output ('清理失败 [' + $Code + ']：' + $Message) }
    exit 1
}

try {
    $values = @()
    foreach ($raw in @($KeepLogs, $KeepBackups, $KeepCorrupt, $TmpHours)) {
        $value = 0
        if (-not [int]::TryParse($raw, [ref]$value) -or $value -lt 0) { Fail-Cleanup 'BAD_ARGUMENT' '保留数量和 TmpHours 必须是非负整数' }
        $values += $value
    }
    $dataPath = Resolve-DataDir $DataDir
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
        Fail-Cleanup 'DATA_DIR_MISSING' ('数据目录不存在：' + $dataPath)
    }
    $cliArgs = @()
    if ($layout.Portable) {
        $cliArgs = @($layout.BackupCli)
    } else {
        $cliArgs = @('--import', 'tsx', $layout.BackupCli)
    }
    $cliArgs += @('cleanup', '--data', $dataPath,
        '--keep-logs', [string]$values[0], '--keep-backups', [string]$values[1], '--keep-corrupt', [string]$values[2], '--tmp-hours', [string]$values[3])
    if ($DryRun) { $cliArgs += '--dry-run' }
    $errorFile = [System.IO.Path]::GetTempFileName()
    try {
        Push-Location $root
        try {
            $nativePreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $lines = @(& $layout.NodeExe @cliArgs 2> $errorFile)
                $cliExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $nativePreference }
        }
        finally { Pop-Location }
        $diagnostics = Get-Content -LiteralPath $errorFile -Raw -Encoding UTF8
        if (-not [string]::IsNullOrWhiteSpace($diagnostics)) { [Console]::Error.Write($diagnostics) }
    } finally { Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue }
    $lastLine = @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) | Select-Object -Last 1
    $payload = ([string]$lastLine) | ConvertFrom-Json
    if ($cliExit -ne 0 -or $payload.ok -ne $true) { Fail-Cleanup ([string]$payload.code) ([string]$payload.message) }
    $failed = @($payload.result.failed)
    $tmpRemoved = [int]$payload.result.tmpFilesRemoved
    if ($DryRun) { $tmpRemoved = 0 }
    $removed = [ordered]@{ tmp = $tmpRemoved; logs = @($payload.result.logsRemoved).Count; backups = @($payload.result.backupsRemoved).Count; corrupt = @($payload.result.corruptRemoved).Count }
    $ok = ($failed.Count -eq 0)
    $result = [ordered]@{ ok = $ok; script = 'cleanup'; dryRun = [bool]$DryRun; removed = $removed; wouldRemove = $payload.result.wouldRemove; failed = @($failed) }
    if ($Json) { Write-CheckJson $result }
    else {
        Write-Output ('实际删除：tmp=' + [string]$removed.tmp + '，logs=' + [string]$removed.logs + '，backups=' + [string]$removed.backups + '，corrupt=' + [string]$removed.corrupt)
        if ($DryRun) { Write-Output ('DryRun 拟删除：' + ($payload.result.wouldRemove | ConvertTo-Json -Compress)) }
        if (-not $ok) {
            Write-Output ('警告：' + [string]$failed.Count + ' 项删除失败')
            foreach ($failure in $failed | Select-Object -First 5) { Write-Output ($failure.group + ' ' + $failure.path + '：' + $failure.message) }
        }
    }
    if ($ok) { exit 0 } else { exit 1 }
} catch { Fail-Cleanup 'INTERNAL_ERROR' $_.Exception.Message }
