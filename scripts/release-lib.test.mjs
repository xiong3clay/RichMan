import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED, checkZipTopLevel, comparePackageDirs, parseVersionInfo, scanSecrets, validateStaging } from "./release-lib.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function walk(dir, base = dir, output = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, output);
    else if (entry.isFile()) output.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return output;
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeSums(dir, omit = []) {
  const files = (await walk(dir))
    .filter(file => file !== "SHA256SUMS.txt" && !omit.includes(file))
    .sort();
  const lines = [];
  for (const file of files) {
    lines.push(hash((await readFile(path.join(dir, file))).toString()) + "  " + file);
  }
  await writeFile(path.join(dir, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
}

async function makeFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-release-lib-"));
  dirs.push(dir);
  const version = "0.9.0";
  const nodeVersion = "v24.21.0";
  for (const relative of REQUIRED) {
    if (relative === "SHA256SUMS.txt") continue;
    const full = path.join(dir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    let content = relative;
    if (relative === "VERSION") content = version + "\n";
    else if (relative === "node/VERSION") content = nodeVersion + "\n";
    else if (relative === "build-info.json") {
      content = JSON.stringify({
        version,
        protocolVersion: 1,
        nodeVersion,
        builtAtUtc: "2026-11-09T00:00:00.000Z",
        gitCommit: "3053b05",
        gitDirty: false,
      });
    } else if (relative === "app/server/server.mjs") {
      content = 'console.log("ok")\n';
    } else if (relative.endsWith(".mjs")) {
      content = "export default 1\n";
    }
    await writeFile(full, content, "utf8");
  }
  await writeSums(dir);
  return { dir, version, nodeVersion };
}

function textOf(result) {
  return result.problems.join("\n");
}

describe("12B release-lib", () => {
  it("parse versions equal", () => {
    const info = parseVersionInfo('{"version":"0.9.0"}', 'const VERSION = "0.9.0";');
    expect(info.ok).toBe(true);
    expect(info.version).toBe("0.9.0");
  });

  it("version mismatch", () => {
    const info = parseVersionInfo('{"version":"0.9.0"}', 'const VERSION = "0.8.0";');
    expect(info.ok).toBe(false);
    expect(textOf(info)).toContain("不一致");
  });

  it("missing http VERSION", () => {
    const info = parseVersionInfo('{"version":"0.9.0"}', "export const x = 1;");
    expect(info.ok).toBe(false);
    expect(textOf(info)).toContain("VERSION");
  });

  it("missing required file", async () => {
    const fixture = await makeFixture();
    await rm(path.join(fixture.dir, "app/server/server.mjs"));
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("缺少必需文件：app/server/server.mjs");
  });

  it("forbids node_modules", async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(fixture.dir, "node_modules/x"), { recursive: true });
    await writeFile(path.join(fixture.dir, "node_modules/x/y.js"), "x", "utf8");
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("node_modules");
  });

  it("forbids data/rooms", async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(fixture.dir, "data/rooms/0042"), { recursive: true });
    await writeFile(path.join(fixture.dir, "data/rooms/0042/snapshot.json"), "{}", "utf8");
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("data/rooms");
  });

  it("SHA256SUMS missing entry", async () => {
    const fixture = await makeFixture();
    await writeSums(fixture.dir, ["app/web/index.html"]);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("SHA256SUMS 缺少：app/web/index.html");
  });

  it("SHA256SUMS bad hash", async () => {
    const fixture = await makeFixture();
    const sumsPath = path.join(fixture.dir, "SHA256SUMS.txt");
    const lines = (await readFile(sumsPath, "utf8")).split("\n");
    const index = lines.findIndex(line => line.endsWith("  app/web/index.html"));
    lines[index] = "0".repeat(64) + "  app/web/index.html";
    await writeFile(sumsPath, lines.join("\n"), "utf8");
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("SHA256 不匹配：app/web/index.html");
  });

  it("SHA256SUMS unsorted", async () => {
    const fixture = await makeFixture();
    const sumsPath = path.join(fixture.dir, "SHA256SUMS.txt");
    const lines = (await readFile(sumsPath, "utf8")).split("\n").filter(Boolean);
    await writeFile(sumsPath, lines.reverse().join("\n") + "\n", "utf8");
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("未按路径排序");
  });

  it("node/VERSION mismatch", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.dir, "node/VERSION"), "v24.18.0\n", "utf8");
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("node/VERSION 不匹配");
  });

  it("valid fixture passes", async () => {
    const fixture = await makeFixture();
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.9.0");
    expect(result.nodeVersion).toBe("v24.21.0");
    expect(result.files).toBe(REQUIRED.length);
  });

  it("T1 zip 缺 backup-cli 且 SHA256SUMS 已重算仍因 REQUIRED 变红", async () => {
    const fixture = await makeFixture();
    await rm(path.join(fixture.dir, "app/server/backup-cli.mjs"));
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("缺少必需文件：app/server/backup-cli.mjs");
  });

  it("T2 comparePackageDirs 相同目录通过", async () => {
    const left = await makeFixture();
    const right = await makeFixture();
    const result = await comparePackageDirs(left.dir, right.dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("T3 comparePackageDirs 缺文件", async () => {
    const left = await makeFixture();
    const right = await makeFixture();
    await rm(path.join(right.dir, "app/server/backup-cli.mjs"));
    const result = await comparePackageDirs(left.dir, right.dir);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("缺少文件：app/server/backup-cli.mjs");
  });

  it("T4 comparePackageDirs 多文件", async () => {
    const left = await makeFixture();
    const right = await makeFixture();
    await writeFile(path.join(right.dir, "extra.txt"), "extra", "utf8");
    const result = await comparePackageDirs(left.dir, right.dir);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("多余文件：extra.txt");
  });

  it("T5 comparePackageDirs 内容不同", async () => {
    const left = await makeFixture();
    const right = await makeFixture();
    // 与 fixture 原内容等长（18 字节），确保命中“内容不一致”而不是“大小不一致”。
    await writeFile(path.join(right.dir, "app/web/index.html"), "app/web/indexXhtml", "utf8");
    const result = await comparePackageDirs(left.dir, right.dir);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("文件内容不一致：app/web/index.html");
  });

  it("T6 scanSecrets 命中无扩展名 LICENSE 的 sessionToken", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.dir, "LICENSE"), "MIT\n{\"sessionToken\":\"ABCDEFGH12345678\"}\n", "utf8");
    const hits = await scanSecrets(fixture.dir);
    expect(hits).toContain("LICENSE");
  });

  it("T7 scanSecrets 干净 fixture 无命中", async () => {
    const fixture = await makeFixture();
    const hits = await scanSecrets(fixture.dir);
    expect(hits).toEqual([]);
  });

  it("T8 build-info.protocolVersion 非 1 变红", async () => {
    const fixture = await makeFixture();
    const file = path.join(fixture.dir, "build-info.json");
    const info = JSON.parse(await readFile(file, "utf8"));
    info.protocolVersion = 2;
    await writeFile(file, JSON.stringify(info), "utf8");
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("protocolVersion");
  });

  it("T9 build-info.gitCommit 过短变红", async () => {
    const fixture = await makeFixture();
    const file = path.join(fixture.dir, "build-info.json");
    const info = JSON.parse(await readFile(file, "utf8"));
    info.gitCommit = "abc";
    await writeFile(file, JSON.stringify(info), "utf8");
    await writeSums(fixture.dir);
    const result = await validateStaging(fixture.dir, fixture);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("gitCommit");
  });

  it("T10 zip 顶层额外文件变红", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "richman-top-extra-file-"));
    dirs.push(root);
    const expectedTop = "RichMan-v0.9.0-win-x64";
    await mkdir(path.join(root, expectedTop), { recursive: true });
    await writeFile(path.join(root, "extra.txt"), "extra", "utf8");
    const entries = await readdir(root, { withFileTypes: true });
    const result = checkZipTopLevel(entries, expectedTop);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("zip 顶层");
    expect(textOf(result)).toContain("extra.txt");
  });

  it("T11 zip 顶层额外目录变红", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "richman-top-extra-dir-"));
    dirs.push(root);
    const expectedTop = "RichMan-v0.9.0-win-x64";
    await mkdir(path.join(root, expectedTop), { recursive: true });
    await mkdir(path.join(root, "other"), { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const result = checkZipTopLevel(entries, expectedTop);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("zip 顶层");
    expect(textOf(result)).toContain("other/");
  });

  it("T12 zip 顶层只有期望目录时通过", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "richman-top-ok-"));
    dirs.push(root);
    const expectedTop = "RichMan-v0.9.0-win-x64";
    await mkdir(path.join(root, expectedTop), { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const result = checkZipTopLevel(entries, expectedTop);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("T13 comparePackageDirs 同路径不同长度报大小不一致", async () => {
    const left = await mkdtemp(path.join(os.tmpdir(), "richman-size-left-"));
    const right = await mkdtemp(path.join(os.tmpdir(), "richman-size-right-"));
    dirs.push(left, right);
    await writeFile(path.join(left, "x.txt"), "abcd", "utf8");
    await writeFile(path.join(right, "x.txt"), "abcde", "utf8");
    const result = await comparePackageDirs(left, right);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("文件大小不一致：x.txt");
  });

  it("T14 comparePackageDirs 报内层多余空目录", async () => {
    const left = await mkdtemp(path.join(os.tmpdir(), "richman-dir-left-"));
    const right = await mkdtemp(path.join(os.tmpdir(), "richman-dir-right-"));
    dirs.push(left, right);
    await mkdir(path.join(right, "empty"), { recursive: true });
    const result = await comparePackageDirs(left, right);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("多余目录：empty/");
  });

  it("T15 comparePackageDirs 报缺少目录", async () => {
    const left = await mkdtemp(path.join(os.tmpdir(), "richman-dir2-left-"));
    const right = await mkdtemp(path.join(os.tmpdir(), "richman-dir2-right-"));
    dirs.push(left, right);
    await mkdir(path.join(left, "only-expected"), { recursive: true });
    const result = await comparePackageDirs(left, right);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("缺少目录：only-expected/");
  });

  it("T16 目录一致仅文件内容不同时不产生目录误报", async () => {
    const left = await mkdtemp(path.join(os.tmpdir(), "richman-dir3-left-"));
    const right = await mkdtemp(path.join(os.tmpdir(), "richman-dir3-right-"));
    dirs.push(left, right);
    await mkdir(path.join(left, "shared"), { recursive: true });
    await mkdir(path.join(right, "shared"), { recursive: true });
    await writeFile(path.join(left, "shared/x.txt"), "abcd", "utf8");
    await writeFile(path.join(right, "shared/x.txt"), "abce", "utf8");
    const result = await comparePackageDirs(left, right);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["文件内容不一致：shared/x.txt"]);
  });
});
