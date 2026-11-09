[CmdletBinding()]
param()

# 单元 12B：生成 RichMan-v<version>-win-x64 发布目录与 zip。
# 本文件必须保存为 UTF-8 with BOM；兼容 Windows PowerShell 5.1。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'richman-common.ps1')
$root = Get-RichManRoot

function Log([string]$Message) { [Console]::Error.WriteLine($Message) }
function Fail([string]$Message) { throw $Message }

function Run-Native {
    param([string]$Label, [string]$File, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $File @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    foreach ($line in $lines) { Log ([string]$line) }
    if ($code -ne 0) { Fail ($Label + ' 失败（exit ' + [string]$code + '）') }
    return $lines
}

function Write-Text {
    param([string]$Path, [string]$Text, [bool]$Bom = $true)
    $encoding = New-Object System.Text.UTF8Encoding($Bom)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Write-Bat {
    param([string]$Path, [string]$ScriptName)
    $text = "@echo off`r`nchcp 65001>nul`r`ncd /d `"%~dp0`"`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\$ScriptName`" %*`r`npause`r`n"
    Write-Text $Path $text $false
}

try {
    Log '== RichMan 12B build-release =='
    $packageJsonText = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw
    $packageJson = $packageJsonText | ConvertFrom-Json
    $version = [string]$packageJson.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { Fail ('package.json version 非法：' + $version) }
    $httpText = Get-Content -LiteralPath (Join-Path $root 'apps/server/src/http.ts') -Raw
    if ($httpText -notmatch 'const VERSION = "([^"]+)"') { Fail 'http.ts 缺少 VERSION 常量' }
    $httpVersion = $Matches[1]
    if ($version -ne $httpVersion) {
        Fail ('package.json 与 http.ts 版本不一致：' + $version + ' / ' + $httpVersion)
    }
    Log ('版本：' + $version)

    Run-Native 'pnpm build' 'corepack' @('pnpm', '-s', 'build') | Out-Null
    $dist = Join-Path $root 'apps/web/dist'
    $distIndex = Join-Path $dist 'index.html'
    if (-not (Test-Path -LiteralPath $distIndex)) { Fail '缺少 apps/web/dist/index.html' }
    $mp3 = @(Get-ChildItem -LiteralPath (Join-Path $dist 'audio') -Filter '*.mp3' -File)
    $wav = @(Get-ChildItem -LiteralPath (Join-Path $dist 'audio') -Filter '*.wav' -File)
    if ($mp3.Count -lt 1) { Fail 'dist/audio 缺少 mp3' }
    if ($wav.Count -lt 4) { Fail ('dist/audio 至少需要 4 个 sfx wav，实际 ' + [string]$wav.Count) }

    $releaseRoot = Join-Path $root 'release'
    $name = 'RichMan-v' + $version + '-win-x64'
    $staging = Join-Path $releaseRoot $name
    $zip = Join-Path $releaseRoot ($name + '.zip')
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force -ErrorAction Stop }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    Run-Native 'bundle-server' 'node' @('scripts/bundle-server.mjs', '--out', (Join-Path $staging 'app/server')) | Out-Null
    Run-Native 'fetch-portable-node' 'powershell' @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $root 'scripts/fetch-portable-node.ps1'), '-Dest', (Join-Path $staging 'node')
    ) | Out-Null

    $appWeb = Join-Path $staging 'app/web'
    Copy-Item -LiteralPath $dist -Destination $appWeb -Recurse -Force -ErrorAction Stop
    $packageScripts = Join-Path $staging 'scripts'
    New-Item -ItemType Directory -Path $packageScripts -Force | Out-Null
    $scriptNames = @(
        'richman-common.ps1', 'start-lan.ps1', 'start-tunnel.ps1', 'start-fixed.ps1', 'stop.ps1',
        'status.ps1', 'backup.ps1', 'restore.ps1', 'cleanup.ps1'
    )
    foreach ($scriptName in $scriptNames) {
        Copy-Item -LiteralPath (Join-Path $root ('scripts/' + $scriptName)) -Destination (Join-Path $packageScripts $scriptName) -Force -ErrorAction Stop
    }
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $staging 'LICENSE') -Force -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $root 'CHANGELOG.md') -Destination (Join-Path $staging 'CHANGELOG.md') -Force -ErrorAction Stop

    $nodeDir = Join-Path $staging 'node'
    $nodeLicense = Join-Path $nodeDir 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeLicense)) { Fail '发布包 node/LICENSE 不存在' }
    Move-Item -LiteralPath $nodeLicense -Destination (Join-Path $nodeDir 'LICENSE.txt') -Force -ErrorAction Stop

    foreach ($directory in @('data', 'tools', 'licenses/node', 'licenses/ws', 'licenses/react', 'licenses/react-dom', 'licenses/zod')) {
        New-Item -ItemType Directory -Path (Join-Path $staging $directory) -Force | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $nodeDir 'LICENSE.txt') -Destination (Join-Path $staging 'licenses/node/LICENSE.txt') -Force -ErrorAction Stop

    $licenseScript = Join-Path $env:TEMP ('richman-license-' + [Guid]::NewGuid().ToString('N') + '.mjs')
    $licenseCode = @'
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = process.cwd();
const out = process.argv[2];
for (const moduleName of ["ws", "react", "react-dom", "zod"]) {
  const pkg = require.resolve(moduleName + "/package.json", {
    paths: [path.join(root, "apps/server"), path.join(root, "apps/web"), root],
  });
  fs.copyFileSync(path.join(path.dirname(pkg), "LICENSE"), path.join(out, moduleName, "LICENSE"));
}
'@
    try {
        Write-Text $licenseScript $licenseCode $false
        Run-Native 'licenses' 'node' @($licenseScript, (Join-Path $staging 'licenses')) | Out-Null
    } finally {
        Remove-Item -LiteralPath $licenseScript -Force -ErrorAction SilentlyContinue
    }

    Write-Text (Join-Path $staging 'data/README.txt') ((@(
        '此目录用于 RichMan 存档与日志。',
        '本发布包是全新包，不含任何存档、房间、token、恢复码或备份。',
        '首次启动后会自动生成 data/rooms、data/run、data/logs。',
        '备份包含身份摘要与私有账务，不得公开、上传或贴到聊天。'
    ) -join "`r`n") + "`r`n")
    Write-Text (Join-Path $staging 'tools/README.txt') ((@(
        '双击 start-tunnel.bat 时，若这里没有 cloudflared.exe 会自动下载（约 40MB，需联网）。',
        '也可以手动放一份到 tools/cloudflared.exe，或设置 RICHMAN_CLOUDFLARED 指向该 exe。',
        '手动下载：https://github.com/cloudflare/cloudflared/releases',
        '隧道域名每次重启都会变；换域名后用房间码+恢复码回座。'
    ) -join "`r`n") + "`r`n")

    $usage = @(
        ('RichMan ' + $version + ' 使用说明'),
        '================================',
        '',
        '一、启动',
        '1. 双击 start-lan.bat（或运行 scripts/start-lan.ps1）。',
        '2. 本机浏览器打开 http://localhost:8000/；启动窗口会打印局域网地址。',
        '3. 手机与开服电脑连同一个 Wi-Fi，访问打印的局域网地址。',
        '4. 首次启动如被 Windows 防火墙拦截，请允许入站 TCP 8000；',
        '   管理员可执行：New-NetFirewallRule -DisplayName "RichMan 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow',
        '',
        '二、公网临时隧道（可选，一次双击）',
        '1. 直接双击 start-tunnel.bat：本地服务没开会自动启动，cloudflared 缺失会自动下载。',
        '2. 窗口会打印并复制 https://<随机>.trycloudflare.com，并自动打开浏览器（-NoBrowser 可关）。',
        '3. 首次下载约 40MB，需要联网；下载失败时局域网仍可玩，可稍后重试或手动放 tools/cloudflared.exe。',
        '4. 域名每次重启都会变；换域名后用“房间码 + 恢复码”回座，旧页面 token 可能失效。',
        '',
        '三、固定公网地址（可选，需安装并登录 Tailscale）',
        '1. 安装 Tailscale 并登录，首次需在 https://login.tailscale.com/f/funnel 启用 Funnel。',
        '2. 双击 start-fixed.bat：本地服务没开会自动启动，然后打印并复制固定的 https://<设备>.<tailnet>.ts.net 地址。',
        '3. 固定地址重启不变；但电脑必须保持开机、联网且 Tailscale 已登录。',
        '4. 页面 502 表示本机服务停了：重新双击 start-fixed.bat；stop.bat 不会关闭 Funnel。',
        '',
        '四、停止 / 状态',
        '- stop.bat：只停止服务自己记录 pid 的进程；状态文件损坏/不匹配时退出码 2。',
        '- status.bat：查看本机/隧道健康；-Json 可输出一行 JSON。',
        '',
        '五、备份 / 恢复 / 清理',
        '- backup.bat：在 data/backups/ 生成备份；备份含身份摘要与私有账务，不得外传。',
        '- restore.bat：必须先 stop，脚本会拒绝在服务运行时恢复；恢复后房间是暂停态，',
        '  由房主在界面点“继续游戏”。',
        '- cleanup.bat：默认保留每类日志 20、备份 10、损坏隔离 5、.tmp 24 小时；',
        '  先加 -DryRun 查看，再正式清理。',
        '',
        '六、数据与版本',
        '- 数据都在 data/；升级/换机前先备份 data/ 或使用 backup.bat。',
        '- 版本：' + $version + '；协议版本：1；无账号系统、无自动更新。',
        '- 隧道是临时域名，不是固定公网服务；校园网客户端隔离下手机请走隧道。',
        '- 已知限制见 CHANGELOG.md；反馈问题时附 data/logs 中对应日志（先脱敏）。'
    ) -join "`r`n"
    Write-Text (Join-Path $staging '使用说明.txt') ($usage + "`r`n")

    $trouble = @(
        ('RichMan ' + $version + ' 故障排查'),
        '================================',
        '',
        '1. 端口被占用（PORT_IN_USE）',
        '   换端口：scripts/start-lan.ps1 -Port 8001；或先 stop.bat。',
        '   查占用：netstat -ano | findstr :8000',
        '',
        '2. Node 缺失（正常不应发生）',
        '   发布包自带 node/node.exe。若提示缺少，请重新解压完整 zip；',
        '   不要只复制部分文件。',
        '',
        '3. 杀毒软件拦截',
        '   node.exe 是官方未签名二进制，可能被误报；请对解压目录放行。',
        '',
        '4. 手机连不上',
        '   确认同一 Wi-Fi、防火墙放行 8000；校园网客户端隔离时改用隧道。',
        '',
        '5. 隧道未找到 / 下载失败（CLOUDFLARED_NOT_FOUND）',
        '   start-tunnel.bat 首次会自动下载；失败时检查网络后重试，或手动把 cloudflared.exe',
        '   放进 tools/，或设置 RICHMAN_CLOUDFLARED。下载失败不影响本地与局域网。',
        '',
        '6. 恢复被拒绝（SERVICE_RUNNING，退出码 2）',
        '   先运行 stop.bat，确认 status 不健康后再 restore。',
        '',
        '7. 状态文件损坏 / 进程不匹配',
        '   stop/status 退出码 2 表示需要人工确认；不要直接删 run/server.json，',
        '   先确认 pid 与启动时间，必要时人工停止后再清理状态。',
        '',
        '8. 固定地址打不开 / 502（Tailscale Funnel）',
        '   502 表示本机游戏服务没在跑：双击 start-fixed.bat 重新起服。',
        '   域名解析不到：确认 Tailscale 已登录、Funnel 已启用；等 1～2 分钟再试。',
        '   未安装 Tailscale 时固定地址不可用，局域网和 start-tunnel.bat 仍可用。',
        '',
        '9. 日志在哪',
        '   data/logs/server-*.log、data/logs/tunnel-*.log；反馈前先脱敏。'
    ) -join "`r`n"
    Write-Text (Join-Path $staging '故障排查.txt') ($trouble + "`r`n")

    $credits = Get-Content -LiteralPath (Join-Path $root 'apps/web/dist/audio/CREDITS.txt') -Raw
    $thirdParty = $credits.TrimEnd() + "`r`n`r`n" + (@(
        '运行时依赖许可（均为 MIT）',
        '==========================',
        '- Node.js：licenses/node/LICENSE.txt（官方 node-v' + ((Get-Content -LiteralPath (Join-Path $nodeDir 'VERSION') -Raw).Trim()) + ' win-x64）',
        '- ws：licenses/ws/LICENSE',
        '- react：licenses/react/LICENSE',
        '- react-dom：licenses/react-dom/LICENSE',
        '- zod：licenses/zod/LICENSE',
        '',
        '项目代码与自制 8-bit 音效：MIT，见 LICENSE。',
        '背景音乐：Kevin MacLeod，CC BY 4.0，署名与链接见上。'
    ) -join "`r`n") + "`r`n"
    Write-Text (Join-Path $staging '第三方素材许可.txt') $thirdParty

    $batScripts = @(
        @{ Name = 'start-lan.bat'; Script = 'start-lan.ps1' },
        @{ Name = 'start-tunnel.bat'; Script = 'start-tunnel.ps1' },
        @{ Name = 'start-fixed.bat'; Script = 'start-fixed.ps1' },
        @{ Name = 'stop.bat'; Script = 'stop.ps1' },
        @{ Name = 'status.bat'; Script = 'status.ps1' },
        @{ Name = 'backup.bat'; Script = 'backup.ps1' },
        @{ Name = 'restore.bat'; Script = 'restore.ps1' },
        @{ Name = 'cleanup.bat'; Script = 'cleanup.ps1' }
    )
    foreach ($bat in $batScripts) { Write-Bat (Join-Path $staging $bat.Name) $bat.Script }

    Write-Text (Join-Path $staging 'VERSION') ($version + "`n") $false
    $nodeVersion = (Get-Content -LiteralPath (Join-Path $nodeDir 'VERSION') -Raw).Trim()
    $gitCommit = ([string]((& git rev-parse HEAD) -join '')).Trim()
    $gitStatus = @(& git status --porcelain)
    $gitDirty = ($gitStatus.Count -gt 0)
    $builtAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    $buildInfo = [ordered]@{
        version = $version
        protocolVersion = 1
        nodeVersion = $nodeVersion
        builtAtUtc = $builtAtUtc
        gitCommit = $gitCommit
        gitDirty = $gitDirty
    } | ConvertTo-Json -Depth 4
    Write-Text (Join-Path $staging 'build-info.json') ($buildInfo + "`n") $false

    $sumsPath = Join-Path $staging 'SHA256SUMS.txt'
    $map = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $staging -Recurse -File)) {
        $relative = $file.FullName.Substring($staging.Length + 1).Replace('\', '/')
        if ($relative -ne 'SHA256SUMS.txt') { $map[$relative] = $file.FullName }
    }
    $paths = [string[]]@($map.Keys)
    [Array]::Sort($paths, [System.StringComparer]::Ordinal)
    $sumLines = @()
    foreach ($relative in $paths) {
        $hash = (Get-FileHash -LiteralPath $map[$relative] -Algorithm SHA256).Hash.ToUpperInvariant()
        $sumLines += ($hash + '  ' + $relative)
    }
    Write-Text $sumsPath (($sumLines -join "`n") + "`n") $false

    $files = @(Get-ChildItem -LiteralPath $staging -Recurse -File)
    $filesCount = $files.Count
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) { $bytes = 0 }

    Compress-Archive -Path $staging -DestinationPath $zip -CompressionLevel Optimal -Force -ErrorAction Stop
    $zipSha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToUpperInvariant()
    Write-Text (Join-Path $releaseRoot 'SHA256SUMS.txt') ($zipSha256 + '  ' + $name + '.zip' + "`n") $false

    Run-Native 'verify-release' 'node' @('scripts/verify-release.mjs', '--dir', $staging, '--zip', $zip) | Out-Null

    $summary = [ordered]@{
        ok = $true
        version = $version
        staging = $staging
        zip = $zip
        zipSha256 = $zipSha256
        files = [int]$filesCount
        bytes = [long]$bytes
    } | ConvertTo-Json -Compress
    $logDir = Join-Path $root 'artifacts/test-logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Write-Text (Join-Path $logDir 'release-build.txt') ($summary + "`n") $false
    Write-Output $summary
    exit 0
} catch {
    Log ('构建失败：' + $_.Exception.Message)
    exit 1
}
