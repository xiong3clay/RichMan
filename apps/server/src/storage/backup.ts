import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { validateSnapshot } from "./file-store.js";
import type { RoomSnapshot } from "./types.js";

export type BackupErrorCode =
  | "BACKUP_OUT_EXISTS"
  | "BACKUP_OUT_INVALID"
  | "BACKUP_EMPTY"
  | "BACKUP_MANIFEST_INVALID"
  | "BACKUP_FILE_INVALID"
  | "BACKUP_HASH_MISMATCH"
  | "RESTORE_TARGET_EXISTS"
  | "RESTORE_ROOM_NOT_FOUND"
  | "RESTORE_VERIFY_FAILED"
  | "PRUNE_KEEP_INVALID"
  | "CLEANUP_BAD_ARGUMENT";

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly details?: unknown;

  constructor(code: BackupErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.details = details;
  }
}

export interface BackupRoomEntry {
  code: string;
  savedAt: string;
  gameId: string | null;
  paused: boolean;
  eventSeq: number | null;
  snapshotSha256: string;
  snapshotBytes: number;
  audit: { file: "events.ndjson"; bytes: number; sha256: string } | null;
}

export interface BackupManifest {
  backupFormatVersion: 1;
  createdAt: string;
  sourceRoot: string;
  roomCount: number;
  rooms: BackupRoomEntry[];
  skipped: { code: string; reason: string }[];
}

export interface CleanupResult {
  tmpFilesRemoved: number;
  logsRemoved: string[];
  backupsRemoved: string[];
  corruptRemoved: string[];
  failed: { group: "tmp" | "logs" | "backups" | "corrupt"; path: string; message: string }[];
  wouldRemove: { tmp: number; logs: number; backups: number; corrupt: number };
}

export interface CleanupHooks {
  removePath?: (target: string, options: { recursive: boolean }) => Promise<void>;
}

export interface RestoreHooks {
  afterWrite?: () => void | Promise<void>;
  /** 测试可注入回滚失败；生产缺省仍直接rename。 */
  rollback?: (keptPath: string, target: string) => Promise<void>;
}

const CODE_PATTERN = /^\d{4,8}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isValidRoomCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function stampUtc(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return String(date.getUTCFullYear())
    + pad(date.getUTCMonth() + 1)
    + pad(date.getUTCDate())
    + "-"
    + pad(date.getUTCHours())
    + pad(date.getUTCMinutes())
    + pad(date.getUTCSeconds());
}

/** 所有备份写入都必须先落临时文件、fsync 后再 rename，避免留下半成品。 */
async function writeFileAtomic(destination: string, data: Buffer | string): Promise<void> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, "." + path.basename(destination) + "." + randomUUID() + ".tmp");
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function parseRoomEntry(value: unknown): BackupRoomEntry {
  if (!value || typeof value !== "object") {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "manifest.rooms 条目不是对象");
  }
  const room = value as Record<string, unknown>;
  if (!isValidRoomCode(room.code)) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "manifest.rooms 房间码非法");
  }
  const code = room.code;
  if (typeof room.savedAt !== "string") {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 savedAt 不是字符串");
  }
  if (room.gameId !== null && typeof room.gameId !== "string") {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 gameId 非法");
  }
  if (typeof room.paused !== "boolean") {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 paused 非法");
  }
  if (room.eventSeq !== null && !isNonNegativeInteger(room.eventSeq)) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 eventSeq 非法");
  }
  if (!isSha256(room.snapshotSha256)) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 snapshotSha256 非法");
  }
  if (!isNonNegativeInteger(room.snapshotBytes)) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 snapshotBytes 非法");
  }
  let audit: BackupRoomEntry["audit"] = null;
  if (room.audit !== null && room.audit !== undefined) {
    if (typeof room.audit !== "object") {
      throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 audit 非法");
    }
    const auditValue = room.audit as Record<string, unknown>;
    if (auditValue.file !== "events.ndjson" || !isNonNegativeInteger(auditValue.bytes) || !isSha256(auditValue.sha256)) {
      throw new BackupError("BACKUP_MANIFEST_INVALID", "房间 " + code + " 的 audit 字段非法");
    }
    audit = { file: "events.ndjson", bytes: auditValue.bytes, sha256: auditValue.sha256 };
  }
  return {
    code,
    savedAt: room.savedAt,
    gameId: room.gameId as string | null,
    paused: room.paused,
    eventSeq: room.eventSeq as number | null,
    snapshotSha256: room.snapshotSha256,
    snapshotBytes: room.snapshotBytes,
    audit,
  };
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "manifest.json 不是对象");
  }
  const raw = value as Record<string, unknown>;
  if (raw.backupFormatVersion !== 1) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "backupFormatVersion 必须为 1");
  }
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "createdAt 非法");
  }
  if (typeof raw.sourceRoot !== "string" || raw.sourceRoot.length === 0) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "sourceRoot 非法");
  }
  if (!Array.isArray(raw.rooms) || !isNonNegativeInteger(raw.roomCount)) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "rooms/roomCount 非法");
  }
  const rooms = raw.rooms.map(parseRoomEntry);
  if (raw.roomCount !== rooms.length) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "roomCount 与 rooms 数量不一致");
  }
  const seen = new Set<string>();
  for (const room of rooms) {
    if (seen.has(room.code)) {
      throw new BackupError("BACKUP_MANIFEST_INVALID", "manifest 中房间码重复：" + room.code);
    }
    seen.add(room.code);
  }
  if (!Array.isArray(raw.skipped)) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "skipped 非法");
  }
  const skipped = raw.skipped.map(item => {
    if (!item || typeof item !== "object") {
      throw new BackupError("BACKUP_MANIFEST_INVALID", "skipped 条目非法");
    }
    const entry = item as Record<string, unknown>;
    if (!isValidRoomCode(entry.code) || typeof entry.reason !== "string") {
      throw new BackupError("BACKUP_MANIFEST_INVALID", "skipped 条目字段非法");
    }
    return { code: entry.code, reason: entry.reason };
  });
  return {
    backupFormatVersion: 1,
    createdAt: raw.createdAt,
    sourceRoot: raw.sourceRoot,
    roomCount: raw.roomCount,
    rooms,
    skipped,
  };
}

/** 写入前检查根到目标的所有已存在前缀，不跟随父路径链接。 */
async function assertNoReparsePointInPath(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of ["", ...path.relative(root, resolved).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new BackupError("BACKUP_OUT_INVALID", "outDir 不能是符号链接/junction：父路径 " + current);
      }
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
  }
}

export async function createBackup(opts: {
  root: string;
  outDir: string;
  roomCodes?: string[];
  withAudit?: boolean;
  now?: Date;
}): Promise<BackupManifest> {
  const root = path.resolve(opts.root);
  const outDir = path.resolve(opts.outDir);
  const roomsRoot = path.join(root, "rooms");
  const now = opts.now ?? new Date();
  await assertNoReparsePointInPath(outDir);
  let outCreated = false;
  try {
    try {
      const outStat = await lstat(outDir);
      if (outStat.isSymbolicLink()) {
        throw new BackupError("BACKUP_OUT_INVALID", "outDir 不能是符号链接/junction：" + outDir);
      }
      if (!outStat.isDirectory()) {
        throw new BackupError("BACKUP_OUT_EXISTS", "备份输出路径已存在且不是目录：" + outDir);
      }
      if ((await readdir(outDir)).length > 0) {
        throw new BackupError("BACKUP_OUT_EXISTS", "备份输出目录非空：" + outDir);
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      if (!isEnoent(error)) throw error;
      await mkdir(outDir, { recursive: true });
      outCreated = true;
    }
    if ((await lstat(outDir)).isSymbolicLink()) {
      throw new BackupError("BACKUP_OUT_INVALID", "outDir 不能是符号链接/junction：" + outDir);
    }

    let codes: string[];
    if (opts.roomCodes !== undefined) {
      codes = [...new Set(opts.roomCodes)].sort();
      for (const code of codes) {
        if (!isValidRoomCode(code)) {
          throw new BackupError("RESTORE_ROOM_NOT_FOUND", "无效房间码：" + code, { code });
        }
        let roomStat;
        try {
          roomStat = await stat(path.join(roomsRoot, code));
        } catch (error) {
          if (isEnoent(error)) {
            throw new BackupError("RESTORE_ROOM_NOT_FOUND", "备份源中不存在房间 " + code, { code });
          }
          throw error;
        }
        if (!roomStat.isDirectory()) {
          throw new BackupError("RESTORE_ROOM_NOT_FOUND", "备份源中不存在房间 " + code, { code });
        }
      }
    } else {
      let entries: Dirent[];
      try {
        entries = await readdir(roomsRoot, { withFileTypes: true });
      } catch (error) {
        if (!isEnoent(error)) throw error;
        entries = [];
      }
      codes = entries
        .filter(entry => entry.isDirectory() && isValidRoomCode(entry.name))
        .map(entry => entry.name)
        .sort();
    }

    if (codes.length === 0) {
      throw new BackupError("BACKUP_EMPTY", "没有可备份的房间");
    }

    const rooms: BackupRoomEntry[] = [];
    const skipped: { code: string; reason: string }[] = [];
    for (const code of codes) {
      let snapshotBytes: Buffer;
      let snapshot: RoomSnapshot;
      try {
        snapshotBytes = await readFile(path.join(roomsRoot, code, "snapshot.json"));
        snapshot = validateSnapshot(JSON.parse(snapshotBytes.toString("utf8")), code);
      } catch (error) {
        skipped.push({ code, reason: messageOf(error).slice(0, 200) });
        continue;
      }

      await writeFileAtomic(path.join(outDir, "rooms", code, "snapshot.json"), snapshotBytes);
      let audit: BackupRoomEntry["audit"] = null;
      if (opts.withAudit) {
        let auditBytes: Buffer | null = null;
        try {
          auditBytes = await readFile(path.join(roomsRoot, code, "events.ndjson"));
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        if (auditBytes !== null) {
          await writeFileAtomic(path.join(outDir, "rooms", code, "events.ndjson"), auditBytes);
          audit = { file: "events.ndjson", bytes: auditBytes.length, sha256: sha256(auditBytes) };
        }
      }
      rooms.push({
        code,
        savedAt: String(snapshot.savedAt),
        gameId: snapshot.gameId,
        paused: snapshot.paused,
        eventSeq: snapshot.game?.eventSeq ?? null,
        snapshotSha256: sha256(snapshotBytes),
        snapshotBytes: snapshotBytes.length,
        audit,
      });
    }

    if (rooms.length === 0) {
      throw new BackupError("BACKUP_EMPTY", "没有房间成功备份", { skipped });
    }
    skipped.sort((left, right) => left.code.localeCompare(right.code));
    const manifest: BackupManifest = {
      backupFormatVersion: 1,
      createdAt: now.toISOString(),
      sourceRoot: root,
      roomCount: rooms.length,
      rooms,
      skipped,
    };
    await writeFileAtomic(
      path.join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return manifest;
  } catch (error) {
    if (outCreated) await rm(outDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function loadBackupManifest(backupDir: string): Promise<BackupManifest> {
  const directory = path.resolve(backupDir);
  let text: string;
  try {
    text = await readFile(path.join(directory, "manifest.json"), "utf8");
  } catch (error) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "无法读取 manifest.json：" + messageOf(error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BackupError("BACKUP_MANIFEST_INVALID", "manifest.json 不是合法 JSON：" + messageOf(error));
  }
  return parseManifest(raw);
}

async function verifyRoomFiles(
  backupDir: string,
  room: BackupRoomEntry,
  problems: string[],
): Promise<void> {
  const roomDir = path.join(backupDir, "rooms", room.code);
  const snapshotPath = path.join(roomDir, "snapshot.json");
  let bytes: Buffer;
  try {
    const fileStat = await stat(snapshotPath);
    if (!fileStat.isFile()) {
      problems.push("房间 " + room.code + "：snapshot.json 不是普通文件");
      return;
    }
    bytes = await readFile(snapshotPath);
  } catch (error) {
    problems.push("房间 " + room.code + "：读取 snapshot.json 失败：" + messageOf(error));
    return;
  }
  if (bytes.length !== room.snapshotBytes) {
    problems.push(
      "房间 " + room.code + "：snapshot.json 大小不匹配（期望 "
        + String(room.snapshotBytes) + "，实际 " + String(bytes.length) + "）",
    );
  }
  if (sha256(bytes) !== room.snapshotSha256) {
    problems.push("房间 " + room.code + "：snapshot.json 的 sha256 不匹配");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    problems.push("房间 " + room.code + "：snapshot.json 不是合法 JSON：" + messageOf(error));
  }
  if (parsed !== undefined) {
    try {
      validateSnapshot(parsed, room.code);
    } catch (error) {
      problems.push("房间 " + room.code + "：validateSnapshot 失败：" + messageOf(error));
    }
  }
  if (room.audit !== null) {
    const auditPath = path.join(roomDir, "events.ndjson");
    try {
      const auditStat = await stat(auditPath);
      if (!auditStat.isFile()) {
        problems.push("房间 " + room.code + "：events.ndjson 不是普通文件");
      } else {
        const auditBytes = await readFile(auditPath);
        if (auditBytes.length !== room.audit.bytes) {
          problems.push("房间 " + room.code + "：events.ndjson 大小不匹配");
        }
        if (sha256(auditBytes) !== room.audit.sha256) {
          problems.push("房间 " + room.code + "：events.ndjson 的 sha256 不匹配");
        }
      }
    } catch (error) {
      problems.push("房间 " + room.code + "：读取 events.ndjson 失败：" + messageOf(error));
    }
  }
}

export async function verifyBackup(
  backupDir: string,
): Promise<{ ok: boolean; manifest: BackupManifest | null; problems: string[] }> {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = await loadBackupManifest(backupDir);
  } catch (error) {
    problems.push(messageOf(error));
    return { ok: false, manifest: null, problems };
  }
  if (manifest.rooms.length === 0) problems.push("manifest.rooms 为空（空备份不可用于恢复）");
  for (const room of manifest.rooms) {
    await verifyRoomFiles(path.resolve(backupDir), room, problems);
  }
  return { ok: problems.length === 0, manifest, problems };
}

export async function restoreRoom(opts: {
  backupDir: string;
  root: string;
  code: string;
  force?: boolean;
  now?: Date;
  hooks?: RestoreHooks;
}): Promise<{ code: string; keptPath: string | null }> {
  const backupDir = path.resolve(opts.backupDir);
  const root = path.resolve(opts.root);
  const code = opts.code;
  const now = opts.now ?? new Date();
  if (!isValidRoomCode(code)) {
    throw new BackupError("RESTORE_ROOM_NOT_FOUND", "无效房间码：" + code, { code });
  }
  const verification = await verifyBackup(backupDir);
  if (!verification.ok || verification.manifest === null) {
    throw new BackupError("RESTORE_VERIFY_FAILED", "备份校验失败", {
      problems: verification.problems,
    });
  }
  const entry = verification.manifest.rooms.find(room => room.code === code);
  if (!entry) {
    throw new BackupError("RESTORE_ROOM_NOT_FOUND", "备份中不存在房间 " + code, { code });
  }

  const roomsRoot = path.join(root, "rooms");
  const target = path.join(roomsRoot, code);
  await mkdir(roomsRoot, { recursive: true });
  let targetExists = false;
  try {
    await stat(target);
    targetExists = true;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  let keptPath: string | null = null;
  if (targetExists) {
    if (!opts.force) {
      throw new BackupError("RESTORE_TARGET_EXISTS", "目标房间目录已存在：" + target, { target });
    }
    keptPath = path.join(roomsRoot, "restore-keep-" + stampUtc(now) + "-" + code);
    try {
      await rename(target, keptPath);
    } catch (error) {
      throw new BackupError("RESTORE_VERIFY_FAILED", "无法保留原房间目录：" + messageOf(error), {
        target,
        keptPath,
      });
    }
  }

  try {
    const snapshotBytes = await readFile(path.join(backupDir, "rooms", code, "snapshot.json"));
    await writeFileAtomic(path.join(target, "snapshot.json"), snapshotBytes);
    if (entry.audit !== null) {
      const auditBytes = await readFile(path.join(backupDir, "rooms", code, "events.ndjson"));
      await writeFileAtomic(path.join(target, "events.ndjson"), auditBytes);
    }
    await opts.hooks?.afterWrite?.();
    const copied = await readFile(path.join(target, "snapshot.json"));
    if (copied.length !== entry.snapshotBytes || sha256(copied) !== entry.snapshotSha256) {
      throw new Error("复制后的 snapshot.json 大小或 sha256 与 manifest 不一致");
    }
    validateSnapshot(JSON.parse(copied.toString("utf8")), code);
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    if (keptPath !== null) {
      try {
        await (opts.hooks?.rollback ?? rename)(keptPath, target);
      } catch (rollbackError) {
        throw new BackupError("RESTORE_VERIFY_FAILED", "恢复失败且回滚旧档失败：" + messageOf(rollbackError) + "；旧档保留在：" + keptPath, {
          problems: [messageOf(error)],
          rollbackError: messageOf(rollbackError),
          keptPath,
          target,
        });
      }
    }
    throw new BackupError("RESTORE_VERIFY_FAILED", "恢复后复校验失败：" + messageOf(error), {
      problems: [messageOf(error)],
    });
  }
  return { code, keptPath };
}

export async function listBackups(
  dir: string,
): Promise<{ name: string; dir: string; createdAt: string; roomCount: number; ok: boolean }[]> {
  const directory = path.resolve(dir);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const result: { name: string; dir: string; createdAt: string; roomCount: number; ok: boolean }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("richman-backup-")) continue;
    const backupDir = path.join(directory, entry.name);
    try {
      const manifest = await loadBackupManifest(backupDir);
      result.push({
        name: entry.name,
        dir: backupDir,
        createdAt: manifest.createdAt,
        roomCount: manifest.roomCount,
        ok: true,
      });
    } catch {
      result.push({ name: entry.name, dir: backupDir, createdAt: "", roomCount: 0, ok: false });
    }
  }
  const timeOf = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  result.sort((left, right) => timeOf(right.createdAt) - timeOf(left.createdAt) || right.name.localeCompare(left.name));
  return result;
}

async function pruneBackupDirs(dir: string, keep: number): Promise<{ removed: string[] }> {
  const entries = await listBackups(dir);
  const removed: string[] = [];
  for (let index = entries.length - 1; index >= keep; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    await rm(entry.dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed };
}

export async function pruneBackups(opts: {
  dir: string;
  keep: number;
  now?: Date;
}): Promise<{ removed: string[] }> {
  if (!Number.isSafeInteger(opts.keep) || opts.keep < 1) {
    throw new BackupError("PRUNE_KEEP_INVALID", "keep 必须是大于等于 1 的整数", { keep: opts.keep });
  }
  return pruneBackupDirs(path.resolve(opts.dir), opts.keep);
}

function corruptStamp(name: string): number {
  const match = /^corrupt-(\d+)-/.exec(name);
  return match ? Number(match[1]) : 0;
}

export async function cleanupData(opts: {
  root: string;
  keepLogs?: number;
  keepBackups?: number;
  keepCorrupt?: number;
  tmpMaxAgeMs?: number;
  now?: Date;
  dryRun?: boolean;
  hooks?: CleanupHooks;
}): Promise<CleanupResult> {
  const keepLogs = opts.keepLogs ?? 20;
  const keepBackups = opts.keepBackups ?? 10;
  const keepCorrupt = opts.keepCorrupt ?? 5;
  const tmpMaxAgeMs = opts.tmpMaxAgeMs ?? 24 * 3600 * 1000;
  for (const [name, value] of Object.entries({ keepLogs, keepBackups, keepCorrupt, tmpMaxAgeMs })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BackupError("CLEANUP_BAD_ARGUMENT", name + " 必须是非负整数", { [name]: value });
    }
  }
  const root = path.resolve(opts.root);
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const result: CleanupResult = {
    tmpFilesRemoved: 0,
    logsRemoved: [],
    backupsRemoved: [],
    corruptRemoved: [],
    failed: [],
    wouldRemove: { tmp: 0, logs: 0, backups: 0, corrupt: 0 },
  };
  const removePath = opts.hooks?.removePath ?? (async (target: string, options: { recursive: boolean }) => {
    await rm(target, { recursive: options.recursive, force: true });
  });
  const failed = (group: CleanupResult["failed"][number]["group"], target: string, error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    result.failed.push({ group, path: target, message: (code ? code + ": " : "") + messageOf(error) });
  };

  try {
    const logsDir = path.join(root, "logs");
    let entries: Dirent[];
    try {
      entries = await readdir(logsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) entries = [];
      else throw error;
    }
    for (const prefix of ["server", "tunnel"]) {
      const files: Array<{ name: string; path: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith(prefix + "-") || !entry.name.endsWith(".log")) continue;
        try {
          const fileStat = await stat(path.join(logsDir, entry.name));
          files.push({ name: entry.name, path: path.join(logsDir, entry.name), mtimeMs: fileStat.mtimeMs });
        } catch {
          // 单个文件状态读取失败不影响其它日志。
        }
      }
      files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
      for (const file of files.slice(keepLogs)) {
        if (dryRun) { result.wouldRemove.logs += 1; continue; }
        try {
          await removePath(file.path, { recursive: false });
          result.logsRemoved.push(file.name);
        } catch (error) {
          failed("logs", file.path, error);
        }
      }
    }
  } catch {
    // 日志目录异常不影响其它清理项。
  }

  try {
    const backupsDir = path.join(root, "backups");
    const entries = await listBackups(backupsDir);
    for (let index = entries.length - 1; index >= keepBackups; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (dryRun) { result.wouldRemove.backups += 1; continue; }
      try {
        await removePath(entry.dir, { recursive: true });
        result.backupsRemoved.push(entry.name);
      } catch (error) {
        failed("backups", entry.dir, error);
      }
    }
  } catch {
    // 备份目录异常不影响其它清理项。
  }

  try {
    const roomsDir = path.join(root, "rooms");
    let entries: Dirent[];
    try {
      entries = await readdir(roomsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) entries = [];
      else throw error;
    }
    const corrupt = entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith("corrupt-"))
      .map(entry => ({ name: entry.name, stamp: corruptStamp(entry.name) }))
      .sort((left, right) => right.stamp - left.stamp || right.name.localeCompare(left.name));
    for (const entry of corrupt.slice(keepCorrupt)) {
      if (dryRun) { result.wouldRemove.corrupt += 1; continue; }
      try {
        await removePath(path.join(roomsDir, entry.name), { recursive: true });
        result.corruptRemoved.push(entry.name);
      } catch (error) {
        failed("corrupt", path.join(roomsDir, entry.name), error);
      }
    }
  } catch {
    // 房间目录异常不影响其它清理项。
  }

  try {
    const tmpDir = path.join(root, ".tmp");
    let entries: Dirent[];
    try {
      entries = await readdir(tmpDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) entries = [];
      else throw error;
    }
    const threshold = now.getTime() - tmpMaxAgeMs;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(tmpDir, entry.name);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs >= threshold) continue;
        if (dryRun) {
          result.tmpFilesRemoved += 1;
          result.wouldRemove.tmp += 1;
        } else {
          await removePath(filePath, { recursive: false });
          result.tmpFilesRemoved += 1;
        }
      } catch (error) {
        failed("tmp", filePath, error);
      }
    }
  } catch {
    // .tmp 异常不影响其它清理项。
  }

  return result;
}
