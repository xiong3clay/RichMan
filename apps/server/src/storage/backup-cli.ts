import path from "node:path";
import {
  BackupError,
  cleanupData,
  createBackup,
  listBackups,
  pruneBackups,
  restoreRoom,
  verifyBackup,
} from "./backup.js";

const VALUE_FLAGS = new Set([
  "--data",
  "--out",
  "--backup",
  "--dir",
  "--room",
  "--keep",
  "--keep-logs",
  "--keep-backups",
  "--keep-corrupt",
  "--tmp-hours",
]);
const BOOLEAN_FLAGS = new Set(["--with-audit", "--force", "--dry-run"]);

class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

interface ParsedArgs {
  command: string;
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command === undefined || command.length === 0) {
    throw new CliArgumentError("缺少命令");
  }
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      throw new CliArgumentError("未知位置参数：" + argument);
    }
    const equals = argument.indexOf("=");
    if (equals >= 0) {
      const key = argument.slice(0, equals);
      const value = argument.slice(equals + 1);
      if (!VALUE_FLAGS.has(key)) throw new CliArgumentError("未知参数：" + key);
      if (value.length === 0) throw new CliArgumentError("参数缺少值：" + key);
      values.set(key, value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(argument)) {
      flags.add(argument);
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliArgumentError("参数缺少值：" + argument);
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new CliArgumentError("未知参数：" + argument);
  }
  return { command, flags, values };
}

function requiredValue(parsed: ParsedArgs, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new CliArgumentError("缺少参数 " + name);
  }
  return value;
}

function optionalInteger(parsed: ParsedArgs, name: string, fallback: number, minimum: number): number {
  const raw = parsed.values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CliArgumentError(name + " 必须是大于等于 " + String(minimum) + " 的整数");
  }
  return value;
}

function optionalHoursToMs(parsed: ParsedArgs, name: string, fallbackHours: number): number {
  const raw = parsed.values.get(name);
  if (raw === undefined) return fallbackHours * 3600 * 1000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    throw new CliArgumentError(name + " 必须是非负数");
  }
  const milliseconds = Math.round(hours * 3600 * 1000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new CliArgumentError(name + " 超出可表示范围");
  }
  return milliseconds;
}

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(command: string | null, error: unknown): number {
  const code = error instanceof BackupError
    ? error.code
    : error instanceof CliArgumentError
      ? "BAD_ARGUMENT"
      : "INTERNAL_ERROR";
  const payload: Record<string, unknown> = {
    ok: false,
    command,
    code,
    message: messageOf(error),
  };
  if (error instanceof BackupError && error.details !== undefined) {
    payload.details = error.details;
  }
  emit(payload);
  return code === "RESTORE_TARGET_EXISTS" || code === "BACKUP_OUT_EXISTS" ? 2 : 1;
}

async function run(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return failure(null, error);
  }
  try {
    switch (parsed.command) {
      case "create": {
        const data = path.resolve(requiredValue(parsed, "--data"));
        const out = path.resolve(requiredValue(parsed, "--out"));
        const keep = parsed.values.has("--keep")
          ? optionalInteger(parsed, "--keep", 1, 1)
          : null;
        const manifest = await createBackup({
          root: data,
          outDir: out,
          withAudit: parsed.flags.has("--with-audit"),
        });
        let pruned = 0;
        if (keep !== null) {
          try {
            const result = await pruneBackups({ dir: path.dirname(out), keep });
            pruned = result.removed.length;
          } catch (error) {
            process.stderr.write("警告：清理旧备份失败：" + messageOf(error) + "\n");
          }
        }
        emit({ ok: true, command: "create", rooms: manifest.roomCount, out, pruned });
        return 0;
      }
      case "verify": {
        const backup = path.resolve(requiredValue(parsed, "--backup"));
        const verification = await verifyBackup(backup);
        if (!verification.ok) {
          emit({
            ok: false,
            command: "verify",
            code: "VERIFY_FAILED",
            message: "备份校验失败",
            problems: verification.problems,
          });
          return 1;
        }
        emit({
          ok: true,
          command: "verify",
          rooms: verification.manifest?.roomCount ?? 0,
          problems: [],
        });
        return 0;
      }
      case "restore": {
        const data = path.resolve(requiredValue(parsed, "--data"));
        const backup = path.resolve(requiredValue(parsed, "--backup"));
        const room = requiredValue(parsed, "--room");
        if (!/^\d{4,8}$/.test(room)) {
          throw new CliArgumentError("--room 必须是 4～8 位数字");
        }
        const result = await restoreRoom({
          backupDir: backup,
          root: data,
          code: room,
          force: parsed.flags.has("--force"),
        });
        emit({ ok: true, command: "restore", code: room, kept: result.keptPath });
        return 0;
      }
      case "list": {
        const dir = path.resolve(requiredValue(parsed, "--dir"));
        emit({ ok: true, command: "list", backups: await listBackups(dir) });
        return 0;
      }
      case "cleanup": {
        const data = path.resolve(requiredValue(parsed, "--data"));
        const dryRun = parsed.flags.has("--dry-run");
        const result = await cleanupData({
          root: data,
          keepLogs: optionalInteger(parsed, "--keep-logs", 20, 0),
          keepBackups: optionalInteger(parsed, "--keep-backups", 10, 0),
          keepCorrupt: optionalInteger(parsed, "--keep-corrupt", 5, 0),
          tmpMaxAgeMs: optionalHoursToMs(parsed, "--tmp-hours", 24),
          dryRun,
        });
        emit({ ok: true, command: "cleanup", dryRun, result });
        return 0;
      }
      default:
        throw new CliArgumentError("未知命令：" + parsed.command);
    }
  } catch (error) {
    return failure(parsed.command, error);
  }
}

const exitCode = await run(process.argv.slice(2));
process.exitCode = exitCode;
