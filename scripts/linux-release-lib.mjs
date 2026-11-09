// RichMan Linux 发布包公共库：目录校验、确定性 tar.gz 读写、校验和。
// 目标：在 Windows/Linux 上都能产出带正确权限位的 tar.gz，不依赖 tar.exe 的权限保留行为。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

export const PLATFORM = "linux-x64";

/** 发布包必须存在的相对路径（SHA256SUMS.txt 在生成后追加，不在此列）。 */
export const REQUIRED_FILES = [
  "VERSION",
  "build-info.json",
  "LICENSE",
  "CHANGELOG.md",
  "使用说明-Linux.txt",
  "故障排查-Linux.txt",
  "第三方素材许可.txt",
  "app/server/server.mjs",
  "app/server/backup-cli.mjs",
  "app/web/dist/index.html",
  "node/bin/node",
  "node/LICENSE.txt",
  "scripts/install.sh",
  "scripts/uninstall.sh",
  "scripts/status.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/richman.env.example",
  "systemd/richman.service",
  "licenses/node/LICENSE.txt",
  "licenses/ws/LICENSE",
  "licenses/react/LICENSE",
  "licenses/react-dom/LICENSE",
  "licenses/zod/LICENSE",
];

/** 绝不允许进入发布包的路径片段。 */
export const FORBIDDEN_PARTS = [
  "node_modules",
  ".git",
  ".github",
  ".screenshots",
  "artifacts",
  "release",
  "tests",
  "src",
  "apps",
  "packages",
  "data",
  "run",
  "logs",
];

export const FORBIDDEN_SUFFIXES = [".ps1", ".bat", ".zip", ".tmp", ".map"];

/** 相对路径 → 权限位（八进制字符串）。 */
export function modeFor(relative) {
  const normalized = relative.split(path.sep).join("/");
  if (normalized.startsWith("scripts/") && normalized.endsWith(".sh")) return "0755";
  if (normalized === "node/bin/node") return "0755";
  if (normalized.endsWith("/")) return "0755";
  return "0644";
}

export function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

export function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

/** 递归列出目录下所有文件（不含目录），返回 posix 相对路径。 */
export function walkFiles(root) {
  const out = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel);
      else throw new Error("发布目录含不支持的文件类型（符号链接等）：" + childRel);
    }
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

export function isForbidden(relative) {
  const normalized = relative.split(path.sep).join("/");
  const parts = normalized.split("/");
  for (const part of parts) {
    if (FORBIDDEN_PARTS.includes(part)) return true;
  }
  return FORBIDDEN_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

/**
 * 校验 staging 目录结构。返回 { ok, missing, forbidden, files, problems }。
 * files 为相对路径列表（含大小信息取 files，不在返回值里重复）。
 */
export function validateStaging(stagingDir, options = {}) {
  const required = options.required ?? REQUIRED_FILES;
  const problems = [];
  if (!fs.existsSync(stagingDir) || !fs.statSync(stagingDir).isDirectory()) {
    return { ok: false, missing: [...required], forbidden: [], files: [], problems: ["staging 目录不存在：" + stagingDir] };
  }
  const files = walkFiles(stagingDir);
  const present = new Set(files);
  const missing = required.filter(item => !present.has(item));
  const forbidden = files.filter(item => isForbidden(item));
  for (const item of missing) problems.push("缺少必需文件：" + item);
  for (const item of forbidden) problems.push("包含禁止文件：" + item);
  if (present.has("app/server/server.mjs") && fs.statSync(path.join(stagingDir, "app/server/server.mjs")).size <= 50 * 1024) {
    problems.push("app/server/server.mjs 小于 50KB");
  }
  if (present.has("app/server/backup-cli.mjs") && fs.statSync(path.join(stagingDir, "app/server/backup-cli.mjs")).size <= 50 * 1024) {
    problems.push("app/server/backup-cli.mjs 小于 50KB");
  }
  if (present.has("node/bin/node") && fs.statSync(path.join(stagingDir, "node/bin/node")).size < 20 * 1024 * 1024) {
    problems.push("node/bin/node 小于 20MB，可能不是真实 Linux 二进制");
  }
  return { ok: problems.length === 0, missing, forbidden, files, problems };
}

/** 生成 SHA256SUMS.txt 内容（大写十六进制、两空格、按路径字节序升序）。 */
export function formatChecksums(entries) {
  return entries
    .filter(entry => entry.name !== "SHA256SUMS.txt")
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(entry => sha256Buffer(entry.data) + "  " + entry.name)
    .join("\n") + "\n";
}

/** 解析 SHA256SUMS.txt 文本为 Map<路径, 大写哈希>。 */
export function parseChecksums(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([0-9A-Fa-f]{64})\s+\*?(.+)$/.exec(line);
    if (match === null) throw new Error("SHA256SUMS 行格式非法：" + raw);
    map.set(match[2], match[1].toUpperCase());
  }
  return map;
}

function writeOctal(buffer, offset, width, value) {
  const text = Math.floor(value).toString(8).padStart(width - 1, "0");
  buffer.write(text + "\0", offset, width, "ascii");
}

function padTo512(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

/** 拆分超过 100 字节的路径到 prefix 字段（ustar）。 */
function splitName(name) {
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes <= 100) return { name, prefix: "" };
  const parts = name.split("/");
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join("/");
    const rest = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(rest, "utf8") <= 100) {
      return { name: rest, prefix };
    }
  }
  throw new Error("路径过长，无法写入 ustar 头：" + name);
}

function tarHeader(entry) {
  const header = Buffer.alloc(512, 0);
  const name = entry.type === "dir" ? entry.name.replace(/\/?$/, "/") : entry.name;
  const split = splitName(name);
  let nameBytes = Buffer.from(split.name, "utf8");
  if (nameBytes.length > 100) throw new Error("文件名超过 100 字节：" + split.name);
  nameBytes.copy(header, 0);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  const size = entry.type === "dir" ? 0 : entry.data.length;
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, entry.mtime);
  header.fill(0x20, 148, 156);
  header.write(entry.type === "dir" ? "5" : "0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  if (split.prefix !== "") {
    const prefixBytes = Buffer.from(split.prefix, "utf8");
    if (prefixBytes.length > 155) throw new Error("前缀超过 155 字节：" + split.prefix);
    prefixBytes.copy(header, 345);
  }
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += header[index];
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/** 把 staging 目录写成确定性的 tar.gz。目录项自动补齐，权限按 modeFor 设置。 */
export function createTarGzFromDir(stagingDir, outFile, options = {}) {
  const mtime = options.mtime ?? Math.floor(Date.now() / 1000);
  const rootName = options.rootName;
  if (typeof rootName !== "string" || rootName.length === 0) throw new Error("rootName 不能为空");
  const files = walkFiles(stagingDir).filter(file => file !== "SHA256SUMS.txt");
  const dirs = new Set([rootName]);
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(rootName + "/" + parts.slice(0, index).join("/"));
    }
  }
  const entries = [];
  for (const dir of [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    entries.push({ name: dir, type: "dir", mode: 0o755, mtime, data: Buffer.alloc(0) });
  }
  let totalBytes = 0;
  const checksumEntries = [];
  for (const file of files) {
    const data = fs.readFileSync(path.join(stagingDir, file));
    totalBytes += data.length;
    const name = rootName + "/" + file;
    const mode = parseInt(modeFor(file), 8);
    entries.push({ name, type: "file", mode, mtime, data });
    checksumEntries.push({ name: file, data });
  }
  const checksums = formatChecksums(checksumEntries);
  const checksumData = Buffer.from(checksums, "utf8");
  entries.push({
    name: rootName + "/SHA256SUMS.txt",
    type: "file",
    mode: 0o644,
    mtime,
    data: checksumData,
  });
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const chunks = [];
  for (const entry of entries) {
    const header = tarHeader(entry);
    chunks.push(header);
    if (entry.type === "file") {
      chunks.push(entry.data);
      const padding = padTo512(entry.data.length);
      if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(chunks);
  const gz = zlib.gzipSync(tar, { level: 9 });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, gz);
  return {
    outFile,
    rootName,
    files: files.length,
    entries: entries.filter(entry => entry.type === "file").length,
    filesBytes: totalBytes,
    tarBytes: tar.length,
    gzBytes: gz.length,
    checksums,
  };
}

/** 读取 tar.gz，返回 { rootName, files: [{name, mode, size, data}], dirs: string[] }。 */
export function readTarGz(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const files = [];
  const dirs = [];
  let offset = 0;
  let rootName = null;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const nameField = readString(header, 0, 100);
    const prefixField = readString(header, 345, 155);
    const name = prefixField === "" ? nameField : prefixField + "/" + nameField;
    const modeText = readString(header, 100, 8).trim();
    const sizeText = readString(header, 124, 12).trim();
    const type = readString(header, 156, 1);
    const size = sizeText === "" ? 0 : parseInt(sizeText, 8);
    const mode = parseInt(modeText === "" ? "0" : modeText, 8);
    if (rootName === null) rootName = name.split("/")[0];
    if (type === "5" || name.endsWith("/")) {
      dirs.push(name.replace(/\/$/, ""));
    } else {
      const start = offset + 512;
      const data = raw.subarray(start, start + size);
      files.push({ name: name.replace(/\/$/, ""), mode, size, data });
    }
    offset += 512 + size + padTo512(size);
  }
  return { rootName, files, dirs };
}

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}
