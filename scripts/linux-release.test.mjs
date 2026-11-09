import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTarGzFromDir,
  formatChecksums,
  isForbidden,
  modeFor,
  parseChecksums,
  readTarGz,
  validateStaging,
} from "./linux-release-lib.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tempDir(label) {
  const base = os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "richman-linux-" + label + "-"));
}

function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

describe("linux-release-lib 权限与校验和", () => {
  it("shell 脚本与内置 node 可执行，其余为 0644", () => {
    expect(modeFor("scripts/install.sh")).toBe("0755");
    expect(modeFor("scripts/richman.env.example")).toBe("0644");
    expect(modeFor("node/bin/node")).toBe("0755");
    expect(modeFor("app/server/server.mjs")).toBe("0644");
    expect(modeFor("使用说明-Linux.txt")).toBe("0644");
  });

  it("校验和格式固定为“大写哈希 两空格 路径”，可解析且拒绝坏行", () => {
    const text = formatChecksums([
      { name: "b.txt", data: Buffer.from("b") },
      { name: "a.txt", data: Buffer.from("a") },
    ]);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith("  a.txt")).toBe(true);
    expect(lines[1].endsWith("  b.txt")).toBe(true);
    expect(lines[0].split("  ")[0]).toMatch(/^[0-9A-F]{64}$/);
    const parsed = parseChecksums(text);
    expect(parsed.get("a.txt")).toBe(lines[0].split("  ")[0]);
    expect(() => parseChecksums("not-a-checksum  a.txt")).toThrow(/格式非法/);
  });
});

describe("linux-release-lib tar.gz", () => {
  it("文件名、内容与权限位在 tar 往返后保持不变", () => {
    const root = tempDir("tar");
    const staging = path.join(root, "RichMan-v9.9.9-linux-x64");
    write(staging, "scripts/install.sh", "#!/usr/bin/env bash\necho hi\n");
    write(staging, "VERSION", "9.9.9\n");
    write(staging, "app/web/dist/index.html", "<!doctype html><title>RichMan</title>");
    const archive = path.join(root, "out.tar.gz");
    const built = createTarGzFromDir(staging, archive, { rootName: "RichMan-v9.9.9-linux-x64", mtime: 1700000000 });
    expect(built.files).toBe(3);
    expect(fs.existsSync(archive)).toBe(true);

    const parsed = readTarGz(archive);
    expect(parsed.rootName).toBe("RichMan-v9.9.9-linux-x64");
    const byName = new Map(parsed.files.map(item => [item.name, item]));
    const script = byName.get("RichMan-v9.9.9-linux-x64/scripts/install.sh");
    expect(script).toBeDefined();
    expect(script.mode.toString(8)).toBe("755");
    expect(script.data.toString("utf8")).toBe("#!/usr/bin/env bash\necho hi\n");
    expect(byName.get("RichMan-v9.9.9-linux-x64/VERSION").mode.toString(8)).toBe("644");
    const sums = byName.get("RichMan-v9.9.9-linux-x64/SHA256SUMS.txt");
    expect(sums).toBeDefined();
    expect(sums.data.toString("utf8")).toContain("  scripts/install.sh");
    expect(sums.data.toString("utf8")).toContain("  VERSION");
    expect(parsed.dirs).toContain("RichMan-v9.9.9-linux-x64/scripts");
  });

  it("超过 100 字节的路径用 ustar prefix 字段保存", () => {
    const root = tempDir("long");
    const staging = path.join(root, "stage");
    const longDir = "assets/" + "a".repeat(80) + "/" + "b".repeat(60);
    write(staging, longDir + "/file.txt", "long path");
    const archive = path.join(root, "long.tar.gz");
    createTarGzFromDir(staging, archive, { rootName: "RichMan-v9.9.9-linux-x64", mtime: 1700000000 });
    const parsed = readTarGz(archive);
    const names = parsed.files.map(item => item.name);
    expect(names).toContain("RichMan-v9.9.9-linux-x64/" + longDir + "/file.txt");
  });
});

describe("linux-release-lib staging 校验", () => {
  it("缺少必需文件与出现禁止文件都会被判失败", () => {
    const root = tempDir("stage");
    write(root, "VERSION", "1.0.0\n");
    write(root, "scripts/install.sh", "#!/usr/bin/env bash\n");
    write(root, "node_modules/leftover/index.js", "x");
    const result = validateStaging(root, {
      required: ["VERSION", "scripts/install.sh", "app/server/server.mjs"],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("app/server/server.mjs");
    expect(result.forbidden).toContain("node_modules/leftover/index.js");
    expect(result.problems.join("\n")).toContain("缺少必需文件：app/server/server.mjs");
    expect(result.problems.join("\n")).toContain("包含禁止文件：node_modules/leftover/index.js");
  });

  it("禁止清单覆盖源码、测试、Windows 脚本与压缩包", () => {
    expect(isForbidden("scripts/start-lan.ps1")).toBe(true);
    expect(isForbidden("apps/web/dist/index.html")).toBe(true);
    expect(isForbidden("packages/shared/src/index.ts")).toBe(true);
    expect(isForbidden("release/x.zip")).toBe(true);
    expect(isForbidden("data/rooms/1234/snapshot.json")).toBe(true);
    expect(isForbidden("app/web/dist/index.html")).toBe(false);
    expect(isForbidden("scripts/install.sh")).toBe(false);
  });
});

describe("Linux 部署资产约定", () => {
  const unit = fs.readFileSync(path.join(repoRoot, "scripts/linux/richman.service"), "utf8");
  const install = fs.readFileSync(path.join(repoRoot, "scripts/linux/install.sh"), "utf8");
  const uninstall = fs.readFileSync(path.join(repoRoot, "scripts/linux/uninstall.sh"), "utf8");
  const status = fs.readFileSync(path.join(repoRoot, "scripts/linux/status.sh"), "utf8");
  const envExample = fs.readFileSync(path.join(repoRoot, "scripts/linux/richman.env.example"), "utf8");
  const backup = fs.readFileSync(path.join(repoRoot, "scripts/linux/backup.sh"), "utf8");
  const restore = fs.readFileSync(path.join(repoRoot, "scripts/linux/restore.sh"), "utf8");

  it("systemd 单元用占位符生成，且带最小权限与重启策略", () => {
    expect(unit).toContain("User=richman");
    expect(unit).toContain("EnvironmentFile=-/etc/richman/richman.env");
    expect(unit).toContain("ExecStart=@NODE@ @PREFIX@/app/server/server.mjs");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("ReadWritePaths=@DATA_DIR@");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("NoNewPrivileges=true");
    // Node 启动时打印局域网地址会调用 getifaddrs，Linux 下需要 AF_NETLINK；缺了会在 systemd 沙箱里崩溃。
    expect(unit).toContain("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit.includes("\r\n")).toBe(false);
  });

  it("安装/卸载/状态脚本都有严格模式、root 检查与 systemd 兜底", () => {
    for (const script of [install, uninstall]) {
      expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
      expect(script).toContain("set -euo pipefail");
      expect(script).toContain('id -u');
      expect(script.includes("\r\n")).toBe(false);
    }
    expect(install).toContain("SYSTEMD_MISSING");
    expect(install).toContain("/etc/systemd/system/$SERVICE.service");
    expect(install).toContain("RICHMAN_STATIC_DIR=$PREFIX/app/web/dist");
    expect(install).toContain("systemctl restart");
    expect(uninstall).toContain("--purge");
    expect(status).toContain("/health");
    expect(status).toContain("--json");
  });

  it("备份/恢复脚本把备份目录传给 backup-cli", () => {
    expect(backup).toContain('create --data "$DATA_DIR" --out "$OUT"');
    expect(restore).toContain('restore --backup "$BACKUP" --data "$DATA_DIR" --room "$ROOM"');
  });

  it("环境变量示例覆盖端口、数据、静态目录与安全限额", () => {
    for (const key of ["PORT=8000", "RICHMAN_DATA_DIR=", "RICHMAN_STATIC_DIR=", "RICHMAN_MAX_ROOMS"]) {
      expect(envExample).toContain(key);
    }
  });
});
