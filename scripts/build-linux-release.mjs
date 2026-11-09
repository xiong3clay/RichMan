#!/usr/bin/env node
// RichMan Linux 发布包构建：pnpm build → 服务端 bundle → Linux Node → staging → tar.gz → 校验。
// 不依赖 WSL 或 tar 的权限保留：tar.gz 由 linux-release-lib.mjs 按固定模式写出。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  PLATFORM,
  createTarGzFromDir,
  formatChecksums,
  sha256File,
  validateStaging,
  walkFiles,
} from "./linux-release-lib.mjs";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const DEFAULT_NODE_VERSION = "v24.21.0";

function fail(message) {
  console.error("build-linux-release 失败：" + message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { skipBuild: false, nodeVersion: DEFAULT_NODE_VERSION, outDir: "", cacheDir: "", keepStaging: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--keep-staging") options.keepStaging = true;
    else if (arg === "--node-version") options.nodeVersion = argv[++index] ?? fail("--node-version 缺少值");
    else if (arg === "--out-dir") options.outDir = argv[++index] ?? fail("--out-dir 缺少值");
    else if (arg === "--cache-dir") options.cacheDir = argv[++index] ?? fail("--cache-dir 缺少值");
    else fail("未知参数：" + arg);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(options.nodeVersion)) fail("--node-version 必须形如 v24.21.0");
  return options;
}

function run(label, command, args) {
  process.stderr.write("== " + label + " ==\n");
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) fail(label + " 无法执行：" + result.error.message);
  if (result.status !== 0) fail(label + " 失败（exit " + String(result.status) + "）");
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() : "";
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const httpText = fs.readFileSync(path.join(repoRoot, "apps/server/src/http.ts"), "utf8");
  const match = /const VERSION = "([^"]+)"/.exec(httpText);
  if (match === null) fail("apps/server/src/http.ts 缺少 VERSION 常量");
  if (pkg.version !== match[1]) fail("package.json 与 http.ts 版本不一致：" + pkg.version + " / " + match[1]);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail("版本号非法：" + pkg.version);
  return pkg.version;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

async function download(url, destination) {
  process.stderr.write("下载 " + url + "\n");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail("下载失败 HTTP " + response.status + "：" + url);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = destination + ".tmp-" + process.pid;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, destination);
}

async function ensureNodeArchive(nodeVersion, cacheDir) {
  const name = "node-" + nodeVersion + "-linux-x64";
  const archiveName = name + ".tar.xz";
  const archive = path.join(cacheDir, archiveName);
  const sumsFile = path.join(cacheDir, "SHASUMS256.txt");
  const base = "https://nodejs.org/dist/" + nodeVersion + "/";
  if (!fs.existsSync(sumsFile)) await download(base + "SHASUMS256.txt", sumsFile);
  if (!fs.existsSync(archive)) await download(base + archiveName, archive);
  const sums = fs.readFileSync(sumsFile, "utf8").split(/\r?\n/);
  const line = sums.find(item => item.trim().endsWith("  " + archiveName) || item.trim().endsWith(" *" + archiveName));
  if (line === undefined) fail("SHASUMS256.txt 中找不到 " + archiveName);
  const expected = line.trim().split(/\s+/)[0].toUpperCase();
  const actual = sha256File(archive);
  if (expected !== actual) fail("Node 压缩包 SHA256 不匹配：期望 " + expected + "，实际 " + actual);
  process.stderr.write("已校验 " + archiveName + "（" + actual + "）\n");
  return { name, archive };
}

function extractNode(archiveInfo, cacheDir, nodeDir) {
  const extractDir = path.join(cacheDir, ".extract-linux-" + process.pid);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const result = spawnSync("tar", [
    "-xf", archiveInfo.archive,
    "-C", extractDir,
    archiveInfo.name + "/bin/node",
    archiveInfo.name + "/LICENSE",
  ], { stdio: "inherit" });
  if (result.error !== undefined) fail("无法执行 tar（需要支持 xz 的 tar）：" + result.error.message);
  if (result.status !== 0) fail("解压 Node 压缩包失败");
  const source = path.join(extractDir, archiveInfo.name);
  fs.mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
  fs.copyFileSync(path.join(source, "bin/node"), path.join(nodeDir, "bin/node"));
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(nodeDir, "LICENSE.txt"));
  fs.rmSync(extractDir, { recursive: true, force: true });
}

function copyLicenses(staging) {
  const targets = ["ws", "react", "react-dom", "zod"];
  for (const name of targets) {
    let license = "";
    try {
      const pkg = require.resolve(name + "/package.json", {
        paths: [path.join(repoRoot, "apps/server"), path.join(repoRoot, "apps/web"), repoRoot],
      });
      license = path.join(path.dirname(pkg), "LICENSE");
    } catch {
      fail("找不到依赖 " + name + " 的 LICENSE");
    }
    if (!fs.existsSync(license)) fail("依赖 " + name + " 的 LICENSE 不存在：" + license);
    const target = path.join(staging, "licenses", name, "LICENSE");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(license, target);
  }
}

function gitInfo() {
  return {
    gitCommit: runCapture("git", ["rev-parse", "HEAD"]) || "unknown",
    gitDirty: runCapture("git", ["status", "--porcelain"]).length > 0,
  };
}

function composeDocs(staging, version, nodeVersion) {
  const usage = [
    "RichMan " + version + " Linux 使用说明",
    "===================================",
    "",
    "一、安装（需要 root，systemd 发行版，x86_64）",
    "  tar -xzf RichMan-v" + version + "-linux-x64.tar.gz",
    "  cd RichMan-v" + version + "-linux-x64",
    "  sudo bash scripts/install.sh",
    "  安装脚本会创建系统用户 richman，应用装到 /opt/richman，数据放 /var/lib/richman，",
    "  配置写 /etc/richman/richman.env，并注册 systemd 服务 richman。",
    "  安装完成会打印 http://<服务器IP>:8000/ ；云服务器需在安全组放行 TCP 8000。",
    "",
    "二、常用命令",
    "  systemctl status richman        # 服务状态",
    "  systemctl restart richman       # 重启（改完 env 必须重启）",
    "  journalctl -u richman -f        # 实时日志",
    "  bash scripts/status.sh          # 健康检查（JSON 加 --json）",
    "  sudo bash scripts/install.sh --port 8080   # 换端口重装（保留数据）",
    "  sudo bash scripts/uninstall.sh  # 卸载，保留数据；--purge 连数据一起删",
    "",
    "三、配置 /etc/richman/richman.env",
    "  PORT=8000",
    "  RICHMAN_DATA_DIR=/var/lib/richman",
    "  RICHMAN_STATIC_DIR=/opt/richman/app/web/dist",
    "  # 可选：RICHMAN_MAX_CONNECTIONS / RICHMAN_MAX_CONNECTIONS_PER_IP / RICHMAN_MAX_ROOMS",
    "  # 可选：RICHMAN_ALLOWED_ORIGINS=https://example.com（反向代理时）",
    "  # 可选：RICHMAN_TRUST_PROXY=1（仅当确实在可信反代后面）",
    "  改完执行 systemctl restart richman。",
    "",
    "四、备份 / 恢复 / 清理",
    "  sudo bash scripts/backup.sh                    # 备份到 /var/lib/richman/backups/",
    "  sudo bash scripts/backup.sh --out /root/bak    # 备份到指定目录",
    "  sudo bash scripts/restore.sh --backup <备份目录> --room 1234",
    "  恢复会先停服务，恢复后房间是暂停态，由房主在界面点“继续游戏”。",
    "  备份含身份摘要与私有账务，不得外传。",
    "",
    "五、数据与升级",
    "  - 数据都在 /var/lib/richman；升级前先备份。",
    "  - 升级：解压新包后 sudo bash scripts/install.sh（保留数据与配置）。",
    "  - 版本：" + version + "；协议版本：1；内置 Node " + nodeVersion + "。",
    "  - 防火墙：ufw allow 8000/tcp 或 firewall-cmd --add-port=8000/tcp --permanent。",
    "  - 公网 HTTPS：建议用 Nginx/Caddy 反代并配证书；同源部署无需额外 CORS 配置。",
    "",
    "六、不使用 systemd 的手动启动（容器/临时验证）",
    "  RICHMAN_DATA_DIR=/var/lib/richman RICHMAN_STATIC_DIR=/opt/richman/app/web/dist \\",
    "    PORT=8000 /opt/richman/node/bin/node /opt/richman/app/server/server.mjs",
  ].join("\n");
  writeText(path.join(staging, "使用说明-Linux.txt"), usage + "\n");

  const trouble = [
    "RichMan " + version + " Linux 故障排查",
    "===================================",
    "",
    "1. 安装脚本报 SYSTEMD_MISSING",
    "   容器或精简系统没有 systemd：用“使用说明-Linux.txt 六”的命令手动启动。",
    "",
    "2. 服务起不来（systemctl status richman 显示 failed）",
    "   journalctl -u richman -n 100 --no-pager 看原因；常见是端口被占、",
    "   /var/lib/richman 权限不对、RICHMAN_STATIC_DIR 指向不存在的目录。",
    "",
    "3. 端口被占用",
    "   ss -ltnp | grep :8000；换端口：sudo bash scripts/install.sh --port 8080。",
    "",
    "4. 浏览器打开是 404 或空白",
    "   检查 /opt/richman/app/web/dist/index.html 是否存在；",
    "   确认 env 里 RICHMAN_STATIC_DIR=/opt/richman/app/web/dist。",
    "",
    "5. 外网访问不了",
    "   云厂商安全组放行 TCP 8000；系统防火墙 ufw/firewalld 放行；",
    "   确认服务监听 0.0.0.0（默认即是）。",
    "",
    "6. 502 / 连接被重置（走反向代理）",
    "   确认反代转发到 http://127.0.0.1:8000，并开启 WebSocket Upgrade；",
    "   Nginx 需要 proxy_set_header Upgrade $http_upgrade 与 Connection \"upgrade\"。",
    "",
    "7. 备份恢复被拒绝",
    "   restore.sh 会先停服务；若仍报错，确认备份目录有 manifest 且属于本机数据。",
    "",
    "8. 时区/时间不对",
    "   服务端只存 UTC 毫秒时间戳，界面按浏览器本地时区显示；",
    "   服务器时区不影响对局，但日志时间可用 timedatectl set-timezone Asia/Shanghai 调整。",
  ].join("\n");
  writeText(path.join(staging, "故障排查-Linux.txt"), trouble + "\n");

  const licenses = [
    "RichMan " + version + " 第三方素材与许可",
    "===================================",
    "",
    "本项目代码：MIT，见 LICENSE。",
    "运行时 Node.js：Node.js 许可证，见 licenses/node/LICENSE.txt。",
    "ws / react / react-dom / zod：各自 MIT 许可证，见 licenses/<包名>/LICENSE。",
    "音频：apps/web/public/audio 下全部 WAV 由本项目脚本生成（scripts/make-audio.mjs），",
    "  不含第三方采样；可随项目一起分发。",
    "前端静态资源不含外部 CDN 依赖，离线可用。",
  ].join("\n");
  writeText(path.join(staging, "第三方素材许可.txt"), licenses + "\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = readVersion();
  const releaseRoot = path.join(repoRoot, "release");
  const packageName = "RichMan-v" + version + "-" + PLATFORM;
  const staging = path.join(releaseRoot, packageName);
  const archive = path.join(releaseRoot, packageName + ".tar.gz");
  const cacheDir = options.cacheDir === "" ? path.join(repoRoot, "artifacts/node-cache") : path.resolve(options.cacheDir);
  process.stderr.write("版本：" + version + "，平台：" + PLATFORM + "\n");

  if (!options.skipBuild) {
    run("pnpm build", "corepack", ["pnpm", "-s", "build"]);
  }
  const dist = path.join(repoRoot, "apps/web/dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) fail("缺少 apps/web/dist/index.html，请先构建前端");
  const audioDir = path.join(dist, "audio");
  if (!fs.existsSync(audioDir)) fail("缺少 apps/web/dist/audio");
  const wavCount = fs.readdirSync(audioDir).filter(name => name.endsWith(".wav")).length;
  if (wavCount < 4) fail("dist/audio 至少需要 4 个 sfx wav，实际 " + String(wavCount));

  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  fs.mkdirSync(staging, { recursive: true });

  run("bundle-server", "node", [path.join("scripts/bundle-server.mjs"), "--out", path.join(staging, "app/server")]);
  fs.cpSync(dist, path.join(staging, "app/web/dist"), { recursive: true });
  for (const name of ["install.sh", "uninstall.sh", "status.sh", "backup.sh", "restore.sh", "richman.env.example"]) {
    const source = path.join(repoRoot, "scripts/linux", name);
    if (!fs.existsSync(source)) fail("缺少 scripts/linux/" + name);
    fs.mkdirSync(path.join(staging, "scripts"), { recursive: true });
    fs.copyFileSync(source, path.join(staging, "scripts", name));
  }
  fs.mkdirSync(path.join(staging, "systemd"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts/linux/richman.service"), path.join(staging, "systemd", "richman.service"));
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(staging, "LICENSE"));
  fs.copyFileSync(path.join(repoRoot, "CHANGELOG.md"), path.join(staging, "CHANGELOG.md"));

  const nodeInfo = await ensureNodeArchive(options.nodeVersion, cacheDir);
  extractNode(nodeInfo, cacheDir, path.join(staging, "node"));
  fs.mkdirSync(path.join(staging, "licenses/node"), { recursive: true });
  fs.copyFileSync(path.join(staging, "node/LICENSE.txt"), path.join(staging, "licenses/node/LICENSE.txt"));
  copyLicenses(staging);
  composeDocs(staging, version, options.nodeVersion);

  writeText(path.join(staging, "VERSION"), version + "\n");
  const git = gitInfo();
  const buildInfo = {
    name: "RichMan",
    version,
    platform: PLATFORM,
    nodeVersion: options.nodeVersion,
    protocolVersion: 1,
    builtAt: new Date().toISOString(),
    gitCommit: git.gitCommit,
    gitDirty: git.gitDirty,
    builder: "scripts/build-linux-release.mjs",
  };
  writeText(path.join(staging, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n");

  const checksums = formatChecksums(walkFiles(staging).map(name => ({
    name,
    data: fs.readFileSync(path.join(staging, name)),
  })));
  writeText(path.join(staging, "SHA256SUMS.txt"), checksums);

  const preflight = validateStaging(staging);
  if (!preflight.ok) fail("staging 结构校验失败：\n" + preflight.problems.join("\n"));

  const tarResult = createTarGzFromDir(staging, archive, { rootName: packageName });
  const archiveSha = sha256File(archive);
  const verify = spawnSync("node", [path.join(scriptDir, "verify-linux-release.mjs"), "--archive", archive], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (verify.status !== 0) fail("verify-linux-release 未通过");

  process.stdout.write(JSON.stringify({
    ok: true,
    version,
    platform: PLATFORM,
    staging,
    archive,
    archiveBytes: fs.statSync(archive).size,
    archiveSha256: archiveSha,
    files: tarResult.files,
    nodeVersion: options.nodeVersion,
    gitCommit: git.gitCommit,
    gitDirty: git.gitDirty,
    archiveContainsChecksums: true,
  }, null, 2) + "\n");
}


main().catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});
