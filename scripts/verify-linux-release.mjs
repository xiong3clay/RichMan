#!/usr/bin/env node
// 校验 RichMan Linux 发布包 tar.gz：结构、权限、内容、校验和、systemd/安装脚本约定。
import fs from "node:fs";
import path from "node:path";
import {
  REQUIRED_FILES,
  isForbidden,
  parseChecksums,
  readTarGz,
  sha256Buffer,
  modeFor,
} from "./linux-release-lib.mjs";

function fail(message) {
  console.error("verify-linux-release 失败：" + message);
  process.exit(1);
}

function parseArgs(argv) {
  let archive = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--archive") archive = argv[++index] ?? "";
    else fail("未知参数：" + argv[index]);
  }
  if (archive === "") fail("缺少 --archive <tar.gz>");
  return { archive: path.resolve(archive) };
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: detail ?? "" };
}

function main() {
  const { archive } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(archive)) fail("归档不存在：" + archive);
  const archiveBytes = fs.statSync(archive).size;
  const parsed = readTarGz(archive);
  const rootName = parsed.rootName ?? "";
  const byRelative = new Map();
  for (const file of parsed.files) {
    if (!file.name.startsWith(rootName + "/")) fail("条目不在根目录下：" + file.name);
    byRelative.set(file.name.slice(rootName.length + 1), file);
  }
  const names = [...byRelative.keys()];
  const text = relative => byRelative.get(relative).data.toString("utf8");
  const has = relative => byRelative.has(relative);
  const checks = [];

  checks.push(check("归档大小 > 20MB", archiveBytes > 20 * 1024 * 1024, String(archiveBytes)));
  checks.push(check("根目录名形如 RichMan-vX.Y.Z-linux-x64", /^RichMan-v\d+\.\d+\.\d+-linux-x64$/.test(rootName), rootName));

  const missing = REQUIRED_FILES.filter(item => !has(item));
  checks.push(check("必需文件齐全", missing.length === 0, missing.length === 0 ? String(REQUIRED_FILES.length) + " 项" : "缺少：" + missing.join(", ")));

  const forbidden = names.filter(item => isForbidden(item));
  checks.push(check("无禁止文件", forbidden.length === 0, forbidden.join(", ")));

  const badModes = names.filter(item => {
    const actual = "0" + byRelative.get(item).mode.toString(8);
    return actual !== modeFor(item);
  });
  checks.push(check("权限位符合约定", badModes.length === 0, badModes.slice(0, 5).join(", ")));

  const textFiles = names.filter(item => /\.(sh|service|example|txt|md|json|mjs|VERSION)$/.test(item) || item === "VERSION" || item === "SHA256SUMS.txt");
  const crlf = textFiles.filter(item => byRelative.get(item).data.includes(Buffer.from("\r\n")));
  checks.push(check("脚本/配置为 LF 换行", crlf.length === 0, crlf.slice(0, 5).join(", ")));

  const server = has("app/server/server.mjs") ? byRelative.get("app/server/server.mjs") : null;
  const serverOk = server !== null
    && server.size > 50 * 1024
    && /WebSocketServer|Sec-WebSocket-Key/.test(server.data.toString("utf8"))
    && !/(?:from\s*["']tsx["']|require\s*\(\s*["']tsx["']\s*\))/.test(server.data.toString("utf8"));
  checks.push(check("server.mjs 自包含且含 ws", serverOk, server === null ? "缺失" : String(server.size) + " 字节"));

  const backup = has("app/server/backup-cli.mjs") ? byRelative.get("app/server/backup-cli.mjs") : null;
  checks.push(check("backup-cli.mjs > 50KB", backup !== null && backup.size > 50 * 1024, backup === null ? "缺失" : String(backup.size) + " 字节"));

  const index = has("app/web/dist/index.html") ? byRelative.get("app/web/dist/index.html") : null;
  const wavCount = names.filter(item => /^app\/web\/dist\/audio\/.+\.wav$/.test(item)).length;
  checks.push(check("前端 index.html 与 ≥4 个 WAV", index !== null && wavCount >= 4, "wav=" + String(wavCount)));

  const nodeBin = has("node/bin/node") ? byRelative.get("node/bin/node") : null;
  const elf = nodeBin !== null && nodeBin.size > 20 * 1024 * 1024 && nodeBin.data[0] === 0x7f && nodeBin.data[1] === 0x45 && nodeBin.data[2] === 0x4c && nodeBin.data[3] === 0x46;
  checks.push(check("内置 Linux Node 为 ELF 且 > 20MB", elf, nodeBin === null ? "缺失" : String(nodeBin.size) + " 字节"));

  const sumsOk = (() => {
    if (!has("SHA256SUMS.txt")) return false;
    let sums;
    try {
      sums = parseChecksums(text("SHA256SUMS.txt"));
    } catch {
      return false;
    }
    const expectedNames = names.filter(item => item !== "SHA256SUMS.txt");
    if (sums.size !== expectedNames.length) return false;
    return expectedNames.every(item => sums.get(item) === sha256Buffer(byRelative.get(item).data));
  })();
  checks.push(check("SHA256SUMS 与实际内容一致", sumsOk, sumsOk ? "全部匹配" : "不一致"));

  const unitOk = (() => {
    if (!has("systemd/richman.service")) return false;
    const unit = text("systemd/richman.service");
    return /\[Unit\]/.test(unit)
      && /\[Service\]/.test(unit)
      && /\[Install\]/.test(unit)
      && /User=richman/.test(unit)
      && /EnvironmentFile=-\/etc\/richman\/richman\.env/.test(unit)
      && /ReadWritePaths=(?:@DATA_DIR@|\/var\/lib\/richman)/.test(unit)
      && /NoNewPrivileges=true/.test(unit)
      && /Restart=on-failure/.test(unit)
;
  })();
  checks.push(check("systemd unit 关键指令齐全", unitOk));

  const installOk = (() => {
    if (!has("scripts/install.sh")) return false;
    const script = text("scripts/install.sh");
    return script.startsWith("#!/usr/bin/env bash")
      && /set -euo pipefail/.test(script)
      && /id -u/.test(script)
      && /SYSTEMD_MISSING/.test(script)
      && /\/etc\/systemd\/system\/(?:richman\.service|\$SERVICE\.service)/.test(script)
      && /RICHMAN_STATIC_DIR/.test(script)
      && /\/opt\/richman/.test(script)
      && /\/var\/lib\/richman/.test(script);
  })();
  checks.push(check("install.sh 关键约定齐全", installOk));

  const failures = checks.filter(item => !item.ok);
  const report = {
    ok: failures.length === 0,
    archive,
    archiveBytes,
    rootName,
    entries: parsed.files.length,
    checks,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (failures.length > 0) {
    for (const item of failures) process.stderr.write("FAIL: " + item.name + (item.detail === "" ? "" : "（" + item.detail + "）") + "\n");
    process.exit(1);
  }
}

main();
