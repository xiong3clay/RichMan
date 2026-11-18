import { afterEach, expect, it } from "vitest";
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RoomManager } from "../src/rooms/manager.js";
import { SessionRegistry, SnapshotSessionStore } from "../src/rooms/session.js";
import { FileRoomStore, validateSnapshot } from "../src/storage/file-store.js";
import type { FileStoreOptions } from "../src/storage/file-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(options: FileStoreOptions = {}, code = "0042") {
  const root = await mkdtemp(path.join(os.tmpdir(), "richman-archive-fix-"));
  roots.push(root);
  const store = new FileRoomStore(root, { warn: () => undefined, ...options });
  const manager = new RoomManager({ generateRoomCode: () => code, now: () => 1000 });
  manager.setStore(store);
  manager.createRoom(1);
  const sessions = new SessionRegistry(manager, { store: new SnapshotSessionStore(manager) });
  const joined = sessions.join(code, "archive-owner");
  manager.setReadyFor(code, joined.playerId, true);
  manager.startFor(code, joined.playerId);
  await manager.persist(code);
  const source = path.join(root, "rooms", code);
  const snapshot = await readFile(path.join(source, "snapshot.json"), "utf8");
  await writeFile(path.join(source, "events.ndjson"), "{\"archiveProbe\":true}\n");
  return { root, store, source, snapshot, code };
}

it("N7 archive_roundtrip: manifest and journal survive archive and administrator restore loads paused", async () => {
  const f = await fixture({ archiveNow: () => 1000 });
  await f.store.archiveRoom(f.code);
  expect(await f.store.loadAll()).toEqual([]);
  expect(await readdir(path.join(f.root, "archive", f.code))).toContain("archive.json");
  const manifest = JSON.parse(await readFile(path.join(f.root, "archive", f.code, "archive.json"), "utf8"));
  expect(manifest).toMatchObject({ roomCode: f.code, archivedAtMs: 1000 });
  const restored = await f.store.restoreFromArchive(f.code);
  expect(validateSnapshot(restored, f.code).game).toEqual(JSON.parse(f.snapshot).game);
  const loaded = await new FileRoomStore(f.root, { warn: () => undefined }).loadAll();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]!.paused).toBe(true);
  expect(loaded[0]!.game).toEqual(JSON.parse(f.snapshot).game);
  expect(await readFile(path.join(f.source, "events.ndjson"), "utf8")).toBe("{\"archiveProbe\":true}\n");
  expect(await readdir(path.join(f.root, "archive"))).toEqual([]);
});

it("N7 archive_EXDEV: cross-device fallback publishes a validated full copy before removing source", async () => {
  let crossings = 0;
  const f = await fixture({ archiveNow: () => 1000, archiveRename: async (from, to) => {
    if (path.basename(path.dirname(from)) === "rooms" && path.basename(path.dirname(to)) === "archive") {
      crossings += 1;
      throw Object.assign(new Error("injected cross-device boundary"), { code: "EXDEV" });
    }
    await rename(from, to);
  } });
  await f.store.archiveRoom(f.code);
  expect(crossings).toBe(1);
  expect(await readdir(path.join(f.root, "rooms"))).not.toContain(f.code);
  expect(await readFile(path.join(f.root, "archive", f.code, "snapshot.json"), "utf8")).toBe(f.snapshot);
  expect(await readFile(path.join(f.root, "archive", f.code, "events.ndjson"), "utf8")).toBe("{\"archiveProbe\":true}\n");
  expect((await f.store.restoreFromArchive(f.code)).game).toEqual(JSON.parse(f.snapshot).game);
  expect((await f.store.loadAll())[0]!.game).toEqual(JSON.parse(f.snapshot).game);
});

it("N7 archive_copy_publish_failure: failed cross-device promotion preserves the live snapshot and cleans staging", async () => {
  const f = await fixture({ archiveRename: async (from, to) => {
    if (path.basename(path.dirname(from)) === "rooms" && path.basename(path.dirname(to)) === "archive") {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    }
    if (path.basename(from).startsWith(".staging-")) throw Object.assign(new Error("publish denied"), { code: "EACCES" });
    await rename(from, to);
  } });
  await expect(f.store.archiveRoom(f.code)).rejects.toThrow("publish denied");
  expect(await readFile(path.join(f.source, "snapshot.json"), "utf8")).toBe(f.snapshot);
  expect(await readdir(path.join(f.root, "archive"))).toEqual([]);
  expect((await new FileRoomStore(f.root, { warn: () => undefined }).loadAll())[0]!.game).toEqual(JSON.parse(f.snapshot).game);
});

it("N7 archive_collision: an existing archive is retained and a second generation gets a distinct directory", async () => {
  const f = await fixture({ archiveNow: () => 1000 });
  await f.store.archiveRoom(f.code);
  await f.store.restoreFromArchive(f.code);
  await f.store.archiveRoom(f.code);
  const firstArchive = path.join(f.root, "archive", f.code);
  const first = await readFile(path.join(firstArchive, "snapshot.json"), "utf8");
  const manager = new RoomManager({ generateRoomCode: () => f.code, now: () => 2000 });
  const room = manager.createRoom(1);
  await f.store.commitRoom(room, manager.exportRoom(room)!, []);
  await f.store.archiveRoom(f.code);
  const generations = await readdir(path.join(f.root, "archive"));
  expect(generations).toHaveLength(2);
  expect(await readFile(path.join(firstArchive, "snapshot.json"), "utf8")).toBe(first);
  expect(await f.store.loadAll()).toEqual([]);
});

it("N7 archive_retention: thirty days expires an archive while the preceding millisecond remains restorable", async () => {
  const day = 24 * 60 * 60 * 1000;
  const f = await fixture({ archiveNow: () => 1000 });
  await f.store.archiveRoom(f.code);
  await f.store.cleanupArchives(1000 + 30 * day - 1);
  expect(await readdir(path.join(f.root, "archive"))).toEqual([f.code]);
  await f.store.cleanupArchives(1000 + 30 * day);
  expect(await readdir(path.join(f.root, "archive"))).toEqual([]);
});

it("N7 archive_capacity: FIFO limits prune the oldest archive and preserve the new restorable generation", async () => {
  let now = 1000;
  const f = await fixture({ archiveNow: () => now, archivePolicy: { maxCount: 1 } });
  await f.store.archiveRoom(f.code);
  const manager = new RoomManager({ generateRoomCode: () => "7506", now: () => 2000 });
  const room = manager.createRoom(1);
  await f.store.commitRoom(room, manager.exportRoom(room)!, []);
  now = 2000;
  await f.store.archiveRoom(room);
  expect(await readdir(path.join(f.root, "archive"))).toEqual([room]);
  expect((await f.store.restoreFromArchive(room)).roomCode).toBe(room);
  expect((await f.store.loadAll()).map(s => s.roomCode)).toEqual([room]);
});

it("N7 restore_validation: a corrupted archive or occupied live room cannot replace a good archive/live snapshot", async () => {
  const f = await fixture();
  await f.store.archiveRoom(f.code);
  const archived = path.join(f.root, "archive", f.code, "snapshot.json");
  await writeFile(archived, "{}");
  await expect(f.store.restoreFromArchive(f.code)).rejects.toThrow();
  expect(await readFile(archived, "utf8")).toBe("{}");
  expect(await readdir(path.join(f.root, "rooms"))).not.toContain(f.code);
  await expect(f.store.restoreFromArchive("../rooms/0042")).rejects.toThrow();
  await writeFile(archived, f.snapshot);
  const manager = new RoomManager({ generateRoomCode: () => f.code });
  manager.createRoom(1);
  await f.store.commitRoom(f.code, manager.exportRoom(f.code)!, []);
  const live = await readFile(path.join(f.source, "snapshot.json"), "utf8");
  await expect(f.store.restoreFromArchive(f.code)).rejects.toThrow();
  expect(await readFile(path.join(f.source, "snapshot.json"), "utf8")).toBe(live);
  expect(await readFile(archived, "utf8")).toBe(f.snapshot);
});

it("N7 archive_single_item_capacity: metadata overhead cannot cause the only newly archived copy to be deleted", async () => {
  const f = await fixture();
  f.store.options.archivePolicy = {
    maxBytes: Buffer.byteLength(f.snapshot) + Buffer.byteLength("{\"archiveProbe\":true}\n") + 1,
  };
  await expect(f.store.archiveRoom(f.code)).rejects.toThrow("容量");
  expect(await readFile(path.join(f.source, "snapshot.json"), "utf8")).toBe(f.snapshot);
  expect(await readdir(path.join(f.root, "archive")).catch(() => [])).toEqual([]);
});

it("N7 restore_publish_failure: a failed restore leaves the archived source valid and no active half-room", async () => {
  const f = await fixture({ archiveRename: async (from, to) => {
    if (path.basename(from).startsWith(".restore-")) throw new Error("restore publish denied");
    await rename(from, to);
  } });
  await f.store.archiveRoom(f.code);
  await expect(f.store.restoreFromArchive(f.code)).rejects.toThrow("restore publish denied");
  expect(await readFile(path.join(f.root, "archive", f.code, "snapshot.json"), "utf8")).toBe(f.snapshot);
  expect(await f.store.loadAll()).toEqual([]);
  expect(await readdir(path.join(f.root, "rooms"))).toEqual([]);
});

it("N7 archive_post_publish_validation: a corrupted cross-device copy is rejected while its original stays loadable", async () => {
  const f = await fixture({ archiveRename: async (from, to) => {
    if (path.basename(path.dirname(from)) === "rooms" && path.basename(path.dirname(to)) === "archive") {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    }
    await rename(from, to);
    if (path.basename(from).startsWith(".staging-")) await writeFile(path.join(to, "snapshot.json"), "{}");
  } });
  await expect(f.store.archiveRoom(f.code)).rejects.toThrow("校验");
  expect(await readFile(path.join(f.source, "snapshot.json"), "utf8")).toBe(f.snapshot);
  expect(await readdir(path.join(f.root, "archive"))).toEqual([]);
  expect((await f.store.loadAll())[0]!.game).toEqual(JSON.parse(f.snapshot).game);
});

it("N7 legacy_archive_restore: an archive produced before manifests existed remains recoverable", async () => {
  const f = await fixture();
  await f.store.archiveRoom(f.code);
  await rm(path.join(f.root, "archive", f.code, "archive.json"));
  expect((await f.store.restoreFromArchive(f.code)).game).toEqual(JSON.parse(f.snapshot).game);
  expect((await f.store.loadAll())[0]!.roomCode).toBe(f.code);
});

it("N7 archive_warning_failure: a throwing diagnostic cannot remove the committed cross-device archive", async () => {
  const f = await fixture({ warn: () => { throw new Error("diagnostic failed"); }, archiveRename: async (from, to) => {
    if (path.basename(path.dirname(from)) === "rooms" && path.basename(path.dirname(to)) === "archive") {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    }
    await rename(from, to);
  } });
  await f.store.archiveRoom(f.code);
  expect(await readFile(path.join(f.root, "archive", f.code, "snapshot.json"), "utf8")).toBe(f.snapshot);
  expect(await readdir(path.join(f.root, "rooms"))).not.toContain(f.code);
});

it("N7 legacy_archive_retention: old archives gain a conservative manifest and enter the same thirty-day policy", async () => {
  let now = 1000;
  const f = await fixture({ archiveNow: () => now });
  await f.store.archiveRoom(f.code);
  const manifestFile = path.join(f.root, "archive", f.code, "archive.json");
  await rm(manifestFile);
  now = 2000;
  await f.store.cleanupArchives(now);
  expect(JSON.parse(await readFile(manifestFile, "utf8"))).toMatchObject({ roomCode: f.code, archivedAtMs: now });
  await f.store.cleanupArchives(now + 30 * 24 * 60 * 60_000);
  expect(await readdir(path.join(f.root, "archive"))).toEqual([]);
});

it("N7 archive_byte_capacity: total bytes prune an older generation while the newest full room remains restorable", async () => {
  let now = 1000;
  const f = await fixture({ archiveNow: () => now });
  await f.store.archiveRoom(f.code);
  const directory = path.join(f.root, "archive", f.code);
  let size = 0;
  for (const file of await readdir(directory)) size += (await lstat(path.join(directory, file))).size;
  f.store.options.archivePolicy = { maxBytes: size + 10 };
  const next = JSON.parse(f.snapshot);
  next.roomCode = "7506";
  next.sessions.forEach((session: { roomCode: string }) => { session.roomCode = "7506"; });
  await f.store.commitRoom("7506", next, []);
  now = 2000;
  await f.store.archiveRoom("7506");
  expect(await readdir(path.join(f.root, "archive"))).toEqual(["7506"]);
  expect((await f.store.restoreFromArchive("7506")).game).toEqual(next.game);
});
