import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileRoomStore } from "../src/storage/file-store.js";
import { ARCHIVE_RESIDUE_TTL_MS } from "../src/storage/archive-policy.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-archive-residue-"));
  dirs.push(dir);
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch { return false; }
}

describe("B 归档隐藏残留目录清理", () => {
  it("archive/rooms 下三类残留超过 1 小时才清理，1 分钟内的保留", async () => {
    const root = await tempRoot();
    const store = new FileRoomStore(root);
    const now = Date.now();
    const oldAt = new Date(now - 2 * 60 * 60_000);
    const targets = [
      path.join(root, "archive", ".staging-old"),
      path.join(root, "rooms", ".restore-old"),
      path.join(root, "rooms", ".archived-source-old"),
    ];
    const fresh = path.join(root, "archive", ".staging-new");
    for (const target of [...targets, fresh]) {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "leftover.bin"), "x");
    }
    for (const target of targets) await utimes(target, oldAt, oldAt);

    const result = await store.cleanupArchives(now);
    for (const target of targets) {
      expect(await exists(target)).toBe(false);
      expect(result.removed).toContain(target);
    }
    expect(await exists(fresh)).toBe(true);
    expect(result.removed).not.toContain(fresh);
    expect(ARCHIVE_RESIDUE_TTL_MS).toBe(60 * 60_000);
  });
});

describe("C 坏归档连续 3 次失败后隔离", () => {
  it("连续 3 次 cleanupArchives 后进入 .quarantine，随后不再 failed", async () => {
    const root = await tempRoot();
    const store = new FileRoomStore(root);
    const now = Date.now();
    const bad = path.join(root, "archive", "5050");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "snapshot.json"), "{ broken", "utf8");

    const first = await store.cleanupArchives(now);
    expect(first.failed.some((item) => item.path === bad)).toBe(true);
    expect(first.quarantined).toEqual([]);
    const second = await store.cleanupArchives(now);
    expect(second.failed.some((item) => item.path === bad)).toBe(true);

    const third = await store.cleanupArchives(now);
    const quarantined = path.join(root, "archive", ".quarantine", "5050");
    expect(third.quarantined).toContain(quarantined);
    expect(third.failed.some((item) => item.path === bad)).toBe(false);
    expect(await exists(quarantined)).toBe(true);
    expect(await exists(bad)).toBe(false);

    const fourth = await store.cleanupArchives(now);
    expect(fourth.failed.some((item) => item.path.includes("5050"))).toBe(false);
    expect(fourth.quarantined).toEqual([]);
    expect(await exists(quarantined)).toBe(true);
  });
});
