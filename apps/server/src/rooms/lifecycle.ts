/**
 * 房间生命周期常量集中定义；不要在其他文件散落魔法数。
 * 这些是服务端运维参数，不属于游戏规则，不进 RULES。
 */

/** 创建后一直没有真人入座的房间（含纯 AI 大厅）保留多久；到期直接删除。 */
export const AI_LOBBY_TTL_MS = 5 * 60_000;

/** 大厅里有真人座位但全员离线，保留多久后归档。 */
export const LOBBY_OFFLINE_ARCHIVE_MS = 30 * 60_000;

/** 开局后无在线真人暂停超过多久，归档房间（不删除）。 */
export const ROOM_PAUSE_ARCHIVE_MS = 7 * 24 * 60 * 60_000;

/** 生命周期巡检间隔。 */
export const LIFECYCLE_SWEEP_MS = 30_000;
