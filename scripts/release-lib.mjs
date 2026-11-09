import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const REQUIRED = [
  "app/server/server.mjs",
  "app/server/backup-cli.mjs",
  "app/web/index.html",
  "node/node.exe",
  "node/LICENSE.txt",
  "node/VERSION",
  "scripts/richman-common.ps1",
  "scripts/start-lan.ps1",
  "scripts/start-tunnel.ps1",
  "scripts/stop.ps1",
  "scripts/status.ps1",
  "scripts/backup.ps1",
  "scripts/restore.ps1",
  "scripts/cleanup.ps1",
  "start-lan.bat",
  "start-tunnel.bat",
  "stop.bat",
  "status.bat",
  "backup.bat",
  "restore.bat",
  "cleanup.bat",
  "data/README.txt",
  "tools/README.txt",
  "VERSION",
  "build-info.json",
  "LICENSE",
  "CHANGELOG.md",
  "使用说明.txt",
  "故障排查.txt",
  "第三方素材许可.txt",
  "licenses/node/LICENSE.txt",
  "licenses/ws/LICENSE",
  "licenses/react/LICENSE",
  "licenses/react-dom/LICENSE",
  "licenses/zod/LICENSE",
  "SHA256SUMS.txt",
];

export const FORBIDDEN = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)apps\/server\/src(\/|$)/,
  /(^|\/)apps\/web\/src(\/|$)/,
  /(^|\/)packages(\/|$)/,
  /(^|\/)handoff(\/|$)/,
  /(^|\/)docs(\/|$)/,
  /(^|\/).git(\/|$)/,
  /(^|\/)data\/rooms(\/|$)/,
  /(^|\/)data\/run(\/|$)/,
  /(^|\/)data\/logs(\/|$)/,
  /(^|\/)release(\/|$)/,
  /\.ts$/i,
  /\.log$/i,
  /\.test\.mjs$/i,
  /\.map$/i,
];

export const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".node", ".zip", ".gz", ".7z", ".mp3", ".wav", ".ogg",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf",
]);

export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export const SECRET_PATTERN =
  /(?:sessionToken|recoveryCode)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}|(?:^|[^A-Za-z0-9_])token["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i;

export function parseVersionInfo(packageJsonText, httpTsText) {
  const problems = [];
  let packageVersion = null;
  let httpVersion = null;
  try {
    const parsed = JSON.parse(packageJsonText);
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      packageVersion = parsed.version.trim();
    } else {
      problems.push("package.json 缺少 version");
    }
  } catch (error) {
    problems.push("package.json 不是合法 JSON：" + String(error instanceof Error ? error.message : error));
  }
  const match = /const\s+VERSION\s*=\s*["']([^"']+)["']/.exec(httpTsText);
  if (match) httpVersion = match[1].trim();
  else problems.push("http.ts 缺少 VERSION 常量");
  if (packageVersion !== null && httpVersion !== null && packageVersion !== httpVersion) {
    problems.push("package.json 与 http.ts 版本不一致：" + packageVersion + " / " + httpVersion);
  }
  if (packageVersion !== null && !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    problems.push("版本号不是 x.y.z：" + packageVersion);
  }
  if (httpVersion !== null && !/^\d+\.\d+\.\d+$/.test(httpVersion)) {
    problems.push("http.ts 版本号不是 x.y.z：" + httpVersion);
  }
  return {
    ok: problems.length === 0,
    packageVersion,
    httpVersion,
    version: packageVersion ?? httpVersion,
    problems,
  };
}

async function listFiles(dir, base = dir, output = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFiles(full, base, output);
    } else if (entry.isFile()) {
      output.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return output;
}

/** 递归列出目录（相对路径、"/" 分隔、以 / 结尾、排序），用于发现 zip 内层空目录。*/
async function listDirs(dir, base = dir, output = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(path.relative(base, full).split(path.sep).join("/") + "/");
      await listDirs(full, base, output);
    }
  }
  return output.sort();
}

async function readTrim(file) {
  try {
    return (await readFile(file, "utf8")).replace(/^\uFEFF/, "").trim();
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function parseSums(text) {
  const entries = [];
  const problems = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const match = /^([0-9A-F]{64})  (.+)$/.exec(raw);
    if (!match) {
      problems.push("SHA256SUMS 行格式非法：" + raw.slice(0, 80));
      continue;
    }
    entries.push({ hash: match[1], path: match[2] });
  }
  return { entries, problems };
}

export async function validateStaging(dir, options = {}) {
  const root = path.resolve(dir);
  const problems = [];
  let files = [];
  let bytes = 0;
  try {
    files = (await listFiles(root)).sort();
    for (const relative of files) {
      bytes += (await stat(path.join(root, relative))).size;
    }
  } catch (error) {
    return {
      ok: false,
      version: null,
      nodeVersion: null,
      files: 0,
      bytes: 0,
      problems: ["无法读取 staging：" + String(error instanceof Error ? error.message : error)],
    };
  }
  const fileSet = new Set(files);

  for (const required of REQUIRED) {
    if (!fileSet.has(required)) problems.push("缺少必需文件：" + required);
  }
  for (const relative of files) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(relative)) {
        problems.push("禁止项：" + relative + "（" + pattern.toString() + "）");
        break;
      }
    }
  }

  let version = typeof options.version === "string" ? options.version : null;
  const versionFile = await readTrim(path.join(root, "VERSION"));
  if (versionFile === null) problems.push("无法读取 VERSION");
  else if (version !== null && versionFile !== version) problems.push("VERSION 不匹配：" + versionFile + " / " + version);
  else version = versionFile;

  let nodeVersion = typeof options.nodeVersion === "string" ? options.nodeVersion : null;
  const nodeVersionFile = await readTrim(path.join(root, "node/VERSION"));
  if (nodeVersionFile === null) problems.push("无法读取 node/VERSION");
  else if (nodeVersion !== null && nodeVersionFile !== nodeVersion) {
    problems.push("node/VERSION 不匹配：" + nodeVersionFile + " / " + nodeVersion);
  } else nodeVersion = nodeVersionFile;

  let buildInfo = null;
  try {
    buildInfo = JSON.parse((await readFile(path.join(root, "build-info.json"), "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    problems.push("build-info.json 不存在或不是合法 JSON");
  }
  if (buildInfo !== null) {
    if (version !== null && buildInfo.version !== version) problems.push("build-info.version 不匹配");
    if (nodeVersion !== null && buildInfo.nodeVersion !== nodeVersion) problems.push("build-info.nodeVersion 不匹配");
    if (buildInfo.protocolVersion !== 1) problems.push("build-info.protocolVersion 必须为 1");
    if (typeof buildInfo.builtAtUtc !== "string" || !Number.isFinite(Date.parse(buildInfo.builtAtUtc))) {
      problems.push("build-info.builtAtUtc 非法");
    }
    if (typeof buildInfo.gitCommit !== "string" || buildInfo.gitCommit.length < 7) {
      problems.push("build-info.gitCommit 非法");
    }
    if (typeof buildInfo.gitDirty !== "boolean") problems.push("build-info.gitDirty 非法");
  }

  const sumsPath = path.join(root, "SHA256SUMS.txt");
  let sumsText = null;
  try {
    sumsText = await readFile(sumsPath, "utf8");
  } catch {
    problems.push("无法读取 SHA256SUMS.txt");
  }
  if (sumsText !== null) {
    const parsed = parseSums(sumsText);
    problems.push(...parsed.problems);
    const covered = new Map();
    for (const entry of parsed.entries) {
      if (covered.has(entry.path)) {
        problems.push("SHA256SUMS 路径重复：" + entry.path);
      } else {
        covered.set(entry.path, entry.hash);
      }
    }
    const sortedPaths = [...covered.keys()].sort();
    const listedPaths = parsed.entries.map(entry => entry.path);
    if (listedPaths.join("\n") !== sortedPaths.join("\n")) {
      problems.push("SHA256SUMS 未按路径排序");
    }
    const coveredFiles = files.filter(relative => relative !== "SHA256SUMS.txt");
    for (const relative of coveredFiles) {
      if (!covered.has(relative)) problems.push("SHA256SUMS 缺少：" + relative);
    }
    for (const relative of covered.keys()) {
      if (!fileSet.has(relative)) problems.push("SHA256SUMS 指向不存在的文件：" + relative);
    }
    for (const [relative, expected] of covered) {
      if (!fileSet.has(relative)) continue;
      try {
        const actual = sha256(await readFile(path.join(root, relative)));
        if (actual !== expected.toUpperCase()) problems.push("SHA256 不匹配：" + relative);
      } catch {
        problems.push("无法读取 hash 文件：" + relative);
      }
    }
  }

  return {
    ok: problems.length === 0,
    version,
    nodeVersion,
    files: files.length,
    bytes,
    problems,
  };
}

/**
 * 校验 zip 解压根目录只允许一个 expectedTop 目录（M1 顶层边界）。
 * rootEntries 是 readdir(withFileTypes) 的结果；额外文件/目录、大小写变体、多个目录都会红。
 */
export function checkZipTopLevel(rootEntries, expectedTop) {
  const names = rootEntries
    .map(entry => entry.name + (entry.isDirectory() ? "/" : ""))
    .sort();
  const actual = names.length === 0 ? "（空）" : names.join(",");
  const problems = [];
  if (rootEntries.length !== 1 || !rootEntries[0].isDirectory() || rootEntries[0].name !== expectedTop) {
    problems.push("zip 顶层只允许 " + expectedTop + "/ 一个目录，实际：" + actual);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 比较两个发布目录的全部文件路径、大小与 SHA256。
 * 用于校验 zip 解压目录与 staging 完全一致（M1）。
 */
export async function comparePackageDirs(expectedDir, actualDir) {
  const expectedRoot = path.resolve(expectedDir);
  const actualRoot = path.resolve(actualDir);
  let expectedFiles = [];
  let actualFiles = [];
  try {
    expectedFiles = (await listFiles(expectedRoot)).sort();
    actualFiles = (await listFiles(actualRoot)).sort();
  } catch (error) {
    return {
      ok: false,
      files: 0,
      bytes: 0,
      problems: ["无法读取目录：" + String(error instanceof Error ? error.message : error)],
    };
  }
  const problems = [];
  let bytes = 0;
  let expectedDirs = [];
  let actualDirs = [];
  try {
    expectedDirs = await listDirs(expectedRoot);
    actualDirs = await listDirs(actualRoot);
  } catch (error) {
    problems.push("无法列举目录：" + String(error instanceof Error ? error.message : error));
  }
  const expectedDirSet = new Set(expectedDirs);
  const actualDirSet = new Set(actualDirs);
  for (const relative of actualDirs) {
    if (!expectedDirSet.has(relative)) problems.push("多余目录：" + relative);
  }
  for (const relative of expectedDirs) {
    if (!actualDirSet.has(relative)) problems.push("缺少目录：" + relative);
  }
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  for (const relative of expectedFiles) {
    if (!actualSet.has(relative)) problems.push("缺少文件：" + relative);
  }
  for (const relative of actualFiles) {
    if (!expectedSet.has(relative)) problems.push("多余文件：" + relative);
  }
  for (const relative of actualFiles) {
    if (!expectedSet.has(relative)) continue;
    const expectedPath = path.join(expectedRoot, relative);
    const actualPath = path.join(actualRoot, relative);
    const actualSize = (await stat(actualPath)).size;
    bytes += actualSize;
    const expectedSize = (await stat(expectedPath)).size;
    if (actualSize !== expectedSize) {
      problems.push("文件大小不一致：" + relative);
      continue;
    }
    const [expectedBuffer, actualBuffer] = await Promise.all([readFile(expectedPath), readFile(actualPath)]);
    if (sha256(expectedBuffer) !== sha256(actualBuffer)) {
      problems.push("文件内容不一致：" + relative);
    }
  }
  return { ok: problems.length === 0, files: actualFiles.length, bytes, problems };
}

/**
 * 扫描目录中的明文 token / 恢复码（M2）。
 * 覆盖无扩展名文本（LICENSE），跳过二进制扩展名、>2MB 文件与含 NUL 字节的文件。
 */
export async function scanSecrets(dir) {
  const root = path.resolve(dir);
  const hits = [];
  for (const relative of (await listFiles(root)).sort()) {
    if (BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    const full = path.join(root, relative);
    const info = await stat(full);
    if (info.size > MAX_SCAN_BYTES) continue;
    const buffer = await readFile(full);
    if (buffer.includes(0)) continue;
    if (SECRET_PATTERN.test(buffer.toString("utf8"))) hits.push(relative);
  }
  return hits;
}
