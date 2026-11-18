/** Archive maintenance settings are server operations limits, measured per data root. */
export const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ARCHIVE_MAX_COUNT = 100;
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;

/** 失败归档副本 / 暂存 / 恢复残留目录的最短保留时间；超过后清理。 */
export const ARCHIVE_RESIDUE_TTL_MS = 60 * 60_000;

/** 同一归档连续读取失败多少次后隔离到 archive/.quarantine/。 */
export const ARCHIVE_QUARANTINE_FAILURES = 3;

export interface ArchivePolicy {
  retentionMs: number;
  maxCount: number;
  maxBytes: number;
}

export const DEFAULT_ARCHIVE_POLICY: Readonly<ArchivePolicy> = {
  retentionMs: ARCHIVE_RETENTION_MS,
  maxCount: ARCHIVE_MAX_COUNT,
  maxBytes: ARCHIVE_MAX_BYTES,
};
