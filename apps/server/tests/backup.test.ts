import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RULES_VERSION } from "@richman/game-core";
import { PROTOCOL_VERSION, ROOM_STATE } from "@richman/shared";
import type { GameEvent } from "@richman/shared";
import { FileRoomStore, validateSnapshot } from "../src/storage/file-store.js";
import type { RoomSnapshot } from "../src/storage/types.js";
import {
  cleanupData,
  createBackup,
  listBackups,
  pruneBackups,
  restoreRoom,
  verifyBackup,
} from "../src/storage/backup.js";
import { command, diskHarness } from "./persistence-harness.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "apps/server/src/storage/backup-cli.ts");
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "richman-backup-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeSnapshot(
  code: string,
  savedAt = 1234,
  names: [string, string] = ["甲", "乙"],
): RoomSnapshot {
  const tokens = ["a".repeat(64), "b".repeat(64)];
  const recoveries = ["c".repeat(64), "d".repeat(64)];
  const players = names.map((nickname, index) => ({
    playerId: "p" + String(index + 1),
    seatId: index + 1,
    nickname,
    ready: true,
    online: true,
    tokenDigest: tokens[index]!,
  }));
  const sessions = players.map((player, index) => ({
    roomCode: code,
    playerId: player.playerId,
    seatId: player.seatId,
    tokenDigest: tokens[index]!,
    recoveryDigest: recoveries[index]!,
    connectionEpoch: 0,
  }));
  return {
    schemaVersion: 1,
    rulesVersion: RULES_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    savedAt,
    roomCode: code,
    hostId: "p1",
    roomState: ROOM_STATE.LOBBY,
    paused: false,
    gameId: null,
    usedGameIds: [],
    players,
    sessions,
    game: null,
    commands: [],
    lastEvents: [],
  };
}

async function commitFixture(
  root: string,
  code: string,
  snapshot = makeSnapshot(code),
  events: readonly GameEvent[] = [],
): Promise<void> {
  await new FileRoomStore(root).commitRoom(code, snapshot, events);
}

function makeEvent(seq: number): GameEvent {
  return { seq, type: "TEST_EVENT", at: "2026-11-08T00:00:00.000Z", payload: {} };
}

async function updateManifestEntryHash(backupDir: string, code: string): Promise<void> {
  const manifestPath = path.join(backupDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    rooms: Array<{ code: string; snapshotBytes: number; snapshotSha256: string }>;
  };
  const entry = manifest.rooms.find(room => room.code === code)!;
  const bytes = await readFile(path.join(backupDir, "rooms", code, "snapshot.json"));
  entry.snapshotBytes = bytes.length;
  entry.snapshotSha256 = sha256(bytes);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stdoutJson(stdout: string): Record<string, any> {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, any>;
}

it("T1 create_writes_manifest_and_snapshot: manifest 字段与 sha256 正确、快照逐字节复制", async () => {
  const data = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(data, "0042", makeSnapshot("0042", 1234));
  const sourceBytes = await readFile(path.join(data, "rooms", "0042", "snapshot.json"));
  const now = new Date("2026-11-08T01:02:03.000Z");
  const manifest = await createBackup({ root: data, outDir: out, now });
  expect(manifest.backupFormatVersion).toBe(1);
  expect(manifest.createdAt).toBe(now.toISOString());
  expect(manifest.sourceRoot).toBe(path.resolve(data));
  expect(manifest.roomCount).toBe(1);
  expect(manifest.skipped).toEqual([]);
  const entry = manifest.rooms[0]!;
  expect(entry).toMatchObject({
    code: "0042",
    savedAt: "1234",
    gameId: null,
    paused: false,
    eventSeq: null,
  });
  const copied = await readFile(path.join(out, "rooms", "0042", "snapshot.json"));
  expect(copied.equals(sourceBytes)).toBe(true);
  expect(entry.snapshotBytes).toBe(sourceBytes.length);
  expect(entry.snapshotSha256).toBe(sha256(sourceBytes));
  expect(entry.audit).toBeNull();
});

it("T2 create_with_audit_copies_events: 审计文件逐字节复制，未开启时 audit=null 且不生成文件", async () => {
  const data = await tempDir();
  const withAuditOut = path.join(await tempDir(), "backup-with");
  const withoutAuditOut = path.join(await tempDir(), "backup-without");
  await commitFixture(data, "0042", makeSnapshot("0042"), [makeEvent(1)]);
  const sourceAudit = await readFile(path.join(data, "rooms", "0042", "events.ndjson"));
  const withAudit = await createBackup({ root: data, outDir: withAuditOut, withAudit: true });
  expect(withAudit.rooms[0]!.audit).toEqual({
    file: "events.ndjson",
    bytes: sourceAudit.length,
    sha256: sha256(sourceAudit),
  });
  const copiedAudit = await readFile(path.join(withAuditOut, "rooms", "0042", "events.ndjson"));
  expect(copiedAudit.equals(sourceAudit)).toBe(true);
  const withoutAudit = await createBackup({
    root: data,
    outDir: withoutAuditOut,
    withAudit: false,
  });
  expect(withoutAudit.rooms[0]!.audit).toBeNull();
  expect(existsSync(path.join(withoutAuditOut, "rooms", "0042", "events.ndjson"))).toBe(false);
});

it("T3 create_refuses_non_empty_out: 输出目录非空时 BACKUP_OUT_EXISTS 且原内容不变", async () => {
  const data = await tempDir();
  const out = await tempDir();
  await writeFile(path.join(out, "keep.txt"), "unchanged", "utf8");
  await commitFixture(data, "0042");
  await expect(createBackup({ root: data, outDir: out })).rejects.toMatchObject({
    code: "BACKUP_OUT_EXISTS",
  });
  expect(await readFile(path.join(out, "keep.txt"), "utf8")).toBe("unchanged");
});

it("T4 create_empty_room_set: 没有房间时 BACKUP_EMPTY 且清理新建输出目录", async () => {
  const data = await tempDir();
  const out = path.join(await tempDir(), "nested", "backup");
  await expect(createBackup({ root: data, outDir: out })).rejects.toMatchObject({
    code: "BACKUP_EMPTY",
  });
  expect(existsSync(out)).toBe(false);
});

it("T5 create_skips_corrupt_room: 坏房间进 skipped 不中断，好房间正常备份", async () => {
  const data = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(data, "0042", makeSnapshot("0042"));
  await mkdir(path.join(data, "rooms", "0099"), { recursive: true });
  await writeFile(path.join(data, "rooms", "0099", "snapshot.json"), "{broken", "utf8");
  const manifest = await createBackup({ root: data, outDir: out });
  expect(manifest.rooms.map(room => room.code)).toEqual(["0042"]);
  expect(manifest.skipped).toHaveLength(1);
  expect(manifest.skipped[0]!.code).toBe("0099");
  expect(manifest.skipped[0]!.reason.length).toBeGreaterThan(0);
  expect(existsSync(path.join(out, "rooms", "0099"))).toBe(false);
});

it("T6 verify_detects_hash_tamper: 改快照一个字节后 ok=false 且 problems 提到 sha256", async () => {
  const data = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(data, "0042");
  await createBackup({ root: data, outDir: out });
  const snapshotPath = path.join(out, "rooms", "0042", "snapshot.json");
  const bytes = await readFile(snapshotPath);
  bytes[bytes.length - 1] = 0x20;
  await writeFile(snapshotPath, bytes);
  const verification = await verifyBackup(out);
  expect(verification.ok).toBe(false);
  expect(verification.manifest).not.toBeNull();
  expect(verification.problems.join("\n")).toMatch(/sha256/i);
});

it("T7 verify_detects_invalid_snapshot: 哈希正确但金额非法时 problems 提到 validateSnapshot", async () => {
  const harness = await diskHarness();
  const out = path.join(await tempDir(), "backup");
  try {
    const { code } = await harness.start();
    await createBackup({ root: harness.dir, outDir: out });
    const snapshotPath = path.join(out, "rooms", code, "snapshot.json");
    const saved = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      game: { players: Array<{ cents: unknown }> };
    };
    saved.game.players[0]!.cents = "not-a-number";
    await writeFile(snapshotPath, JSON.stringify(saved, null, 2) + "\n", "utf8");
    await updateManifestEntryHash(out, code);
    const verification = await verifyBackup(out);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join("\n")).toMatch(/validateSnapshot/);
  } finally {
    await harness.close();
  }
});

it("T8 restore_into_empty_root: 恢复字节相同，loadAll 得到一个暂停且离线的房间", async () => {
  const data = await tempDir();
  const out = path.join(await tempDir(), "backup");
  const target = await tempDir();
  await commitFixture(data, "0042");
  await createBackup({ root: data, outDir: out });
  const result = await restoreRoom({ backupDir: out, root: target, code: "0042" });
  expect(result.keptPath).toBeNull();
  const restoredBytes = await readFile(path.join(target, "rooms", "0042", "snapshot.json"));
  const backupBytes = await readFile(path.join(out, "rooms", "0042", "snapshot.json"));
  expect(restoredBytes.equals(backupBytes)).toBe(true);
  expect(existsSync(path.join(target, "rooms", "0042", "snapshot.bak.json"))).toBe(false);
  const loaded = await new FileRoomStore(target).loadAll();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]!.paused).toBe(true);
  expect(loaded[0]!.players.every(player => !player.online)).toBe(true);
});

it("T9 restore_refuses_existing_without_force: 目标存在时 RESTORE_TARGET_EXISTS 且字节不变", async () => {
  const source = await tempDir();
  const target = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(source, "0042", makeSnapshot("0042", 1234, ["新甲", "新乙"]));
  await createBackup({ root: source, outDir: out });
  await commitFixture(target, "0042", makeSnapshot("0042", 999, ["旧甲", "旧乙"]));
  const targetPath = path.join(target, "rooms", "0042", "snapshot.json");
  const before = await readFile(targetPath);
  await expect(restoreRoom({ backupDir: out, root: target, code: "0042" })).rejects.toMatchObject({
    code: "RESTORE_TARGET_EXISTS",
  });
  expect((await readFile(targetPath)).equals(before)).toBe(true);
  expect((await readdir(path.join(target, "rooms"))).some(name => name.startsWith("restore-keep-"))).toBe(false);
});

it("T10 restore_force_keeps_original: force 保留旧档到 restore-keep-*，新快照生效", async () => {
  const source = await tempDir();
  const target = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(source, "0042", makeSnapshot("0042", 1234, ["新甲", "新乙"]));
  await createBackup({ root: source, outDir: out });
  await commitFixture(target, "0042", makeSnapshot("0042", 999, ["旧甲", "旧乙"]));
  const targetPath = path.join(target, "rooms", "0042", "snapshot.json");
  const oldBytes = await readFile(targetPath);
  const result = await restoreRoom({
    backupDir: out,
    root: target,
    code: "0042",
    force: true,
    now: new Date("2026-11-08T12:34:56.000Z"),
  });
  expect(result.keptPath).not.toBeNull();
  expect(path.basename(result.keptPath!)).toMatch(/^restore-keep-\d{8}-\d{6}-0042$/);
  expect((await readFile(path.join(result.keptPath!, "snapshot.json"))).equals(oldBytes)).toBe(true);
  expect((await readFile(targetPath)).equals(await readFile(path.join(out, "rooms", "0042", "snapshot.json")))).toBe(true);
  const loaded = await new FileRoomStore(target).loadAll();
  expect(loaded[0]!.players[0]!.nickname).toBe("新甲");
});

it("T11 restore_failure_keeps_target: 备份校验失败时 RESTORE_VERIFY_FAILED，目标与保留区不变", async () => {
  const source = await tempDir();
  const target = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(source, "0042", makeSnapshot("0042", 1234, ["新甲", "新乙"]));
  await createBackup({ root: source, outDir: out });
  await commitFixture(target, "0042", makeSnapshot("0042", 999, ["旧甲", "旧乙"]));
  const targetPath = path.join(target, "rooms", "0042", "snapshot.json");
  const before = await readFile(targetPath);
  const tampered = await readFile(path.join(out, "rooms", "0042", "snapshot.json"));
  tampered[tampered.length - 1] = 0x20;
  await writeFile(path.join(out, "rooms", "0042", "snapshot.json"), tampered);
  await expect(
    restoreRoom({ backupDir: out, root: target, code: "0042", force: true }),
  ).rejects.toMatchObject({ code: "RESTORE_VERIFY_FAILED" });
  expect((await readFile(targetPath)).equals(before)).toBe(true);
  expect((await readdir(path.join(target, "rooms"))).some(name => name.startsWith("restore-keep-"))).toBe(false);
});

it("T12 prune_keeps_newest: keep=2 删最旧两份，keep=0 报 PRUNE_KEEP_INVALID", async () => {
  const data = await tempDir();
  await commitFixture(data, "0042");
  const backupsRoot = await tempDir();
  for (let index = 0; index < 4; index += 1) {
    await createBackup({
      root: data,
      outDir: path.join(backupsRoot, "richman-backup-" + String(index)),
      now: new Date(Date.UTC(2026, 0, 1 + index)),
    });
  }
  const pruned = await pruneBackups({ dir: backupsRoot, keep: 2 });
  expect(pruned.removed).toEqual(["richman-backup-0", "richman-backup-1"]);
  expect(existsSync(path.join(backupsRoot, "richman-backup-0"))).toBe(false);
  expect(existsSync(path.join(backupsRoot, "richman-backup-1"))).toBe(false);
  expect(existsSync(path.join(backupsRoot, "richman-backup-2"))).toBe(true);
  expect(existsSync(path.join(backupsRoot, "richman-backup-3"))).toBe(true);
  const listing = await listBackups(backupsRoot);
  expect(listing.map(item => item.name)).toEqual(["richman-backup-3", "richman-backup-2"]);
  await expect(pruneBackups({ dir: backupsRoot, keep: 0 })).rejects.toMatchObject({
    code: "PRUNE_KEEP_INVALID",
  });
});

async function cleanupFixture(): Promise<{ root: string; now: Date }> {
  const root = await tempDir();
  const now = new Date("2026-11-08T00:00:00.000Z");
  const nowMs = now.getTime();
  const tmp = path.join(root, ".tmp");
  await mkdir(tmp, { recursive: true });
  const old = new Date(nowMs - 48 * 3600 * 1000);
  const recent = new Date(nowMs - 3600 * 1000);
  for (const name of ["old-1.json", "old-2.json", "new.json"]) {
    await writeFile(path.join(tmp, name), name, "utf8");
  }
  await utimes(path.join(tmp, "old-1.json"), old, old);
  await utimes(path.join(tmp, "old-2.json"), old, old);
  await utimes(path.join(tmp, "new.json"), recent, recent);
  const logs = path.join(root, "logs");
  await mkdir(logs, { recursive: true });
  for (let index = 0; index < 25; index += 1) {
    const file = path.join(logs, "server-" + String(index) + ".log");
    await writeFile(file, "log", "utf8");
    const at = new Date(nowMs - index * 1000);
    await utimes(file, at, at);
  }
  const backups = path.join(root, "backups");
  await mkdir(backups, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    const dir = path.join(backups, "richman-backup-" + String(index));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        backupFormatVersion: 1,
        createdAt: new Date(nowMs - index * 1000).toISOString(),
        sourceRoot: "/source",
        roomCount: 0,
        rooms: [],
        skipped: [],
      }),
      "utf8",
    );
  }
  const rooms = path.join(root, "rooms");
  await mkdir(path.join(rooms, "0042"), { recursive: true });
  await writeFile(path.join(rooms, "0042", "snapshot.json"), "keep", "utf8");
  for (let index = 0; index < 7; index += 1) {
    const name = "corrupt-" + String(nowMs - index * 1000) + "-" + String(index).padStart(4, "0") + "-x";
    await mkdir(path.join(rooms, name), { recursive: true });
  }
  return { root, now };
}

it("T13 cleanup_retention: 四类清理计数与保留数符合默认策略，不碰 rooms/<code>", async () => {
  const { root, now } = await cleanupFixture();
  const result = await cleanupData({ root, now });
  expect(result.tmpFilesRemoved).toBe(2);
  expect(result.logsRemoved).toHaveLength(5);
  expect(result.backupsRemoved).toHaveLength(2);
  expect(result.corruptRemoved).toHaveLength(2);
  expect((await readdir(path.join(root, ".tmp"))).sort()).toEqual(["new.json"]);
  expect((await readdir(path.join(root, "logs"))).filter(name => /^(server|tunnel)-.*\.log$/.test(name))).toHaveLength(20);
  expect((await readdir(path.join(root, "backups"))).filter(name => name.startsWith("richman-backup-"))).toHaveLength(10);
  expect((await readdir(path.join(root, "rooms"))).filter(name => name.startsWith("corrupt-"))).toHaveLength(5);
  expect(existsSync(path.join(root, "rooms", "0042", "snapshot.json"))).toBe(true);
});

it("T14 cleanup_dry_run: 不删除任何文件，tmp 计数与 T13 一致", async () => {
  const { root, now } = await cleanupFixture();
  const result = await cleanupData({ root, now, dryRun: true });
  expect(result.tmpFilesRemoved).toBe(2);
  expect(result.logsRemoved).toEqual([]);
  expect(result.backupsRemoved).toEqual([]);
  expect(result.corruptRemoved).toEqual([]);
  expect((await readdir(path.join(root, ".tmp"))).sort()).toEqual(["new.json", "old-1.json", "old-2.json"]);
  expect((await readdir(path.join(root, "logs"))).filter(name => /^(server|tunnel)-.*\.log$/.test(name))).toHaveLength(25);
  expect((await readdir(path.join(root, "backups"))).filter(name => name.startsWith("richman-backup-"))).toHaveLength(12);
  expect((await readdir(path.join(root, "rooms"))).filter(name => name.startsWith("corrupt-"))).toHaveLength(7);
  expect(existsSync(path.join(root, "rooms", "0042", "snapshot.json"))).toBe(true);
});

it("T15 cli_create_and_verify_json: stdout 恰好一行 JSON、create/verify 均 exit 0", async () => {
  const data = await tempDir();
  await commitFixture(data, "0042");
  const out = path.join(await tempDir(), "backup");
  const created = runCli(["create", "--data", data, "--out", out]);
  expect(created.status).toBe(0);
  const createJson = stdoutJson(created.stdout);
  expect(createJson).toMatchObject({
    ok: true,
    command: "create",
    rooms: 1,
    out: path.resolve(out),
    pruned: 0,
  });
  const verified = runCli(["verify", "--backup", out]);
  expect(verified.status).toBe(0);
  expect(stdoutJson(verified.stdout)).toMatchObject({
    ok: true,
    command: "verify",
    rooms: 1,
    problems: [],
  });
});

it("T16 cli_restore_exit_codes: 目标存在 exit 2，--force 后 exit 0", async () => {
  const source = await tempDir();
  const target = await tempDir();
  const out = path.join(await tempDir(), "backup");
  await commitFixture(source, "0042", makeSnapshot("0042", 1234, ["新甲", "新乙"]));
  await createBackup({ root: source, outDir: out });
  await commitFixture(target, "0042", makeSnapshot("0042", 999, ["旧甲", "旧乙"]));
  const refused = runCli(["restore", "--data", target, "--backup", out, "--room", "0042"]);
  expect(refused.status).toBe(2);
  expect(stdoutJson(refused.stdout)).toMatchObject({
    ok: false,
    command: "restore",
    code: "RESTORE_TARGET_EXISTS",
  });
  const forced = runCli(["restore", "--data", target, "--backup", out, "--room", "0042", "--force"]);
  expect(forced.status).toBe(0);
  expect(stdoutJson(forced.stdout)).toMatchObject({ ok: true, command: "restore", code: "0042" });
});

it("T17 restored_game_equals_original: 真开一局、打命令、备份、删房、恢复后关键字段与摘要全部相等", async () => {
  const harness = await diskHarness();
  const out = path.join(await tempDir(), "backup");
  try {
    const { code, a, view } = await harness.start();
    a.p.send(command(view, "backup-t17"));
    const reply = await a.p.next("command_result");
    expect(reply.outcome.ok).toBe(true);
    await harness.server().manager.persist(code);
    const original = harness.server().manager.exportRoom(code)!;
    await createBackup({ root: harness.dir, outDir: out });
    await harness.store.deleteRoom(code);
    expect(existsSync(path.join(harness.dir, "rooms", code))).toBe(false);
    const result = await restoreRoom({ backupDir: out, root: harness.dir, code });
    expect(result.keptPath).toBeNull();
    const loaded = await new FileRoomStore(harness.dir).loadAll();
    expect(loaded).toHaveLength(1);
    const restored = loaded[0]!;
    expect(() => validateSnapshot(restored, code)).not.toThrow();
    expect(restored.gameId).toBe(original.gameId);
    expect(restored.game!.version).toBe(original.game!.version);
    expect(restored.game!.eventSeq).toBe(original.game!.eventSeq);
    expect(restored.game!.phase).toBe(original.game!.phase);
    expect(restored.game!.deadlineAt).toBe(original.game!.deadlineAt);
    expect(restored.game!.players.map(player => player.cents)).toEqual(
      original.game!.players.map(player => player.cents),
    );
    expect(restored.game!.bankLoans).toEqual(original.game!.bankLoans);
    expect(restored.game!.privateLoans).toEqual(original.game!.privateLoans);
    expect(restored.game!.bets).toEqual(original.game!.bets);
    expect(restored.players.map(player => player.tokenDigest)).toEqual(
      original.players.map(player => player.tokenDigest),
    );
    expect(restored.sessions.map(session => session.tokenDigest)).toEqual(
      original.sessions.map(session => session.tokenDigest),
    );
    expect(restored.sessions.map(session => session.recoveryDigest)).toEqual(
      original.sessions.map(session => session.recoveryDigest),
    );
    expect(restored.commands).toEqual(original.commands);
    expect(existsSync(path.join(harness.dir, "rooms", code, "snapshot.bak.json"))).toBe(false);
  } finally {
    await harness.close();
  }
});

it("T20 cleanup_reports_failed_removals: EACCES逐项可见且继续清理；dryRun只报告计划", async () => {
  const { root, now } = await cleanupFixture();
  const dry = await cleanupData({ root, now, dryRun: true });
  expect(dry.wouldRemove).toEqual({ tmp: 2, logs: 5, backups: 2, corrupt: 2 });
  expect(dry.logsRemoved).toEqual([]); expect(dry.backupsRemoved).toEqual([]); expect(dry.corruptRemoved).toEqual([]);
  expect(dry.failed).toEqual([]);
  const blocked = path.join(root, "logs", "server-24.log");
  const result = await cleanupData({ root, now, hooks: { removePath: async (target, options) => {
    if (target === blocked) throw Object.assign(new Error("EACCES injected deletion"), { code: "EACCES" });
    await rm(target, { recursive: options.recursive, force: true });
  } } });
  expect(result.failed).toEqual([{ group: "logs", path: blocked, message: expect.stringContaining("EACCES") }]);
  expect(result.logsRemoved).toHaveLength(4);expect(result.backupsRemoved).toHaveLength(2);expect(result.corruptRemoved).toHaveLength(2);
  expect(result.tmpFilesRemoved).toBe(2);expect(result.wouldRemove).toEqual({ tmp: 0, logs: 0, backups: 0, corrupt: 0 });
  expect(existsSync(blocked)).toBe(true);expect(existsSync(path.join(root,"logs","server-23.log"))).toBe(false);
});

it("T18 restore_post_write_failure_rolls_back_original: 写后失败回滚旧档且无半成品/多余保留目录", async () => {
  const source=await tempDir(), target=await tempDir(), out=path.join(await tempDir(),"backup");
  await commitFixture(source,"0042",makeSnapshot("0042",1234,["新甲","新乙"]));
  await createBackup({root:source,outDir:out});await commitFixture(target,"0042",makeSnapshot("0042",999,["旧甲","旧乙"]));
  const before=await readFile(path.join(target,"rooms","0042","snapshot.json"));let afterWriteRan=false;
  await expect(restoreRoom({root:target,backupDir:out,code:"0042",force:true,hooks:{afterWrite:async()=>{
    afterWriteRan=true;
    expect((await readFile(path.join(target,"rooms","0042","snapshot.json"))).equals(before)).toBe(false);
    throw new Error("INJECTED_AFTER_WRITE");
  }}})).rejects.toMatchObject({code:"RESTORE_VERIFY_FAILED",details:{problems:["INJECTED_AFTER_WRITE"]}});
  expect(afterWriteRan).toBe(true);
  expect((await readFile(path.join(target,"rooms","0042","snapshot.json"))).equals(before)).toBe(true);
  expect(await readdir(path.join(target,"rooms"))).toEqual(["0042"]);
});

it("T19 restore_rollback_failure_details: 回滚失败保留旧档且message/details一致可诊断", async () => {
  const source=await tempDir(), target=await tempDir(), out=path.join(await tempDir(),"backup");
  await commitFixture(source,"0042");await createBackup({root:source,outDir:out});
  await commitFixture(target,"0042",makeSnapshot("0042",999,["旧甲","旧乙"]));
  const before=await readFile(path.join(target,"rooms","0042","snapshot.json"));let caught:any;
  try { await restoreRoom({root:target,backupDir:out,code:"0042",force:true,hooks:{
    afterWrite:()=>{throw new Error("INJECTED_AFTER_WRITE");},
    rollback:async()=>{throw new Error("INJECTED_ROLLBACK");},
  }}); } catch(error) { caught=error; }
  expect(caught).toMatchObject({code:"RESTORE_VERIFY_FAILED",details:{rollbackError:"INJECTED_ROLLBACK",keptPath:expect.any(String)}});
  expect(caught.message).toContain("回滚旧档失败");expect(caught.message).toContain(caught.details.rollbackError);expect(caught.message).toContain(caught.details.keptPath);
  expect((await readFile(path.join(caught.details.keptPath,"snapshot.json"))).equals(before)).toBe(true);
  expect(existsSync(path.join(target,"rooms","0042"))).toBe(false);
});

it("T21 create_refuses_symlink_out: junction输出被拒且目标零写入", async () => {
  const source=await tempDir(), junctionTarget=await tempDir(), link=path.join(await tempDir(),"out-link");
  await commitFixture(source,"0042");await symlink(junctionTarget,link,"junction");
  try {
    await expect(createBackup({root:source,outDir:link})).rejects.toMatchObject({code:"BACKUP_OUT_INVALID",message:expect.stringContaining("outDir 不能是符号链接/junction")});
    expect(await readdir(junctionTarget)).toEqual([]);
  } finally { await rmdir(link); }
});

it("T22 verify_rejects_empty_manifest: rooms空数组不可用于恢复", async () => {
  const out=await tempDir();await writeFile(path.join(out,"manifest.json"),JSON.stringify({
    backupFormatVersion:1,createdAt:new Date().toISOString(),sourceRoot:"/source",roomCount:0,rooms:[],skipped:[],
  }));
  const result=await verifyBackup(out);expect(result.ok).toBe(false);
  expect(result.problems).toContain("manifest.rooms 为空（空备份不可用于恢复）");
});

it("T23 create_refuses_parent_junction: 父路径链接拒绝且目标零写入", async () => {
  const source = await tempDir(), junctionTarget = await tempDir();
  const link = path.join(await tempDir(), "parent-link");
  await commitFixture(source, "0042");
  await symlink(junctionTarget, link, "junction");
  try {
    await expect(createBackup({ root: source, outDir: path.join(link, "child") })).rejects.toMatchObject({
      code: "BACKUP_OUT_INVALID", message: expect.stringContaining("父路径 " + link),
    });
    expect(await readdir(junctionTarget)).toEqual([]);
    expect(existsSync(path.join(junctionTarget, "child"))).toBe(false);
  } finally { await rmdir(link); }
});
