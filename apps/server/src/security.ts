import type { IncomingMessage } from "node:http";

export interface SecurityLimits {
  maxConnectionsTotal: number;
  maxConnectionsPerIp: number;
  maxUnauthenticated: number;
  maxRooms: number;
  unauthTimeoutMs: number;
  wsMessagesPerSecond: number;
  commandBurst: number;
  commandPerSecond: number;
  economicBurst: number;
  economicPerSecond: number;
  createRoomBurst: number;
  createRoomPerMinute: number;
  joinBurst: number;
  joinPerMinute: number;
  resumeBurst: number;
  resumePerMinute: number;
  resumePerRoomPerMinute: number;
  allowedOrigins: readonly string[];
  trustProxy: boolean;
}

export const DEFAULT_SECURITY_LIMITS: SecurityLimits = {
  maxConnectionsTotal: 200,
  maxConnectionsPerIp: 20,
  maxUnauthenticated: 60,
  maxRooms: 50,
  unauthTimeoutMs: 60_000,
  wsMessagesPerSecond: 60,
  commandBurst: 20,
  commandPerSecond: 10,
  economicBurst: 10,
  economicPerSecond: 5,
  createRoomBurst: 10,
  createRoomPerMinute: 10,
  joinBurst: 10,
  joinPerMinute: 20,
  resumeBurst: 5,
  resumePerMinute: 10,
  resumePerRoomPerMinute: 30,
  allowedOrigins: [],
  trustProxy: false,
};

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 环境变量覆盖；任何非法值静默回退默认，绝不因配置抛错导致服务起不来。 */
export function loadSecurityLimits(env: NodeJS.ProcessEnv): SecurityLimits {
  const maxConnectionsTotal = positiveInt(env["RICHMAN_MAX_CONNECTIONS"]);
  const maxConnectionsPerIp = positiveInt(env["RICHMAN_MAX_CONNECTIONS_PER_IP"]);
  const maxRooms = positiveInt(env["RICHMAN_MAX_ROOMS"]);
  const origins = env["RICHMAN_ALLOWED_ORIGINS"];
  const allowedOrigins = origins === undefined
    ? []
    : origins.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return {
    ...DEFAULT_SECURITY_LIMITS,
    maxConnectionsTotal: maxConnectionsTotal ?? DEFAULT_SECURITY_LIMITS.maxConnectionsTotal,
    maxConnectionsPerIp: maxConnectionsPerIp ?? DEFAULT_SECURITY_LIMITS.maxConnectionsPerIp,
    maxRooms: maxRooms ?? DEFAULT_SECURITY_LIMITS.maxRooms,
    allowedOrigins,
    trustProxy: env["RICHMAN_TRUST_PROXY"] === "1",
  };
}

interface BucketState {
  tokens: number;
  last: number;
}

/** 惰性清理阈值：key 数达到 1024 时清掉 10 分钟未用的 key。 */
const PRUNE_AT_SIZE = 1024;
const PRUNE_IDLE_MS = 10 * 60_000;

/** 每 key 初始满桶；按经过毫秒线性回填，上限 capacity。时间由调用方注入。 */
export class TokenBucket {
  private readonly buckets = new Map<string, BucketState>();

  constructor(
    readonly capacity: number,
    readonly refillPerMs: number,
    private readonly now: () => number,
  ) {}

  tryTake(key: string): boolean {
    if (this.buckets.size >= PRUNE_AT_SIZE) this.prune(PRUNE_IDLE_MS);
    const time = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, last: time };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, time - bucket.last);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.last = time;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  prune(idleMs: number): void {
    const cutoff = this.now() - idleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.last < cutoff) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Origin 只防任意网页跨站建立已认证连接，不是身份认证。 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  extra: readonly string[],
): boolean {
  if (origin === undefined || origin.trim() === "") return true;
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  if (host !== undefined) {
    const originUrl = new URL(normalized);
    const hostLower = host.toLowerCase();
    if (originUrl.host.toLowerCase() === hostLower) return true;
    // URL.origin 会省略默认端口；Host 头可能显式带 :80/:443。
    const defaultPort = originUrl.protocol === "http:" ? ":80" : ":443";
    if ((originUrl.host + defaultPort).toLowerCase() === hostLower) return true;
  }
  return extra.some((item) => normalizeOrigin(item) === normalized);
}

function normalizeIp(raw: string): string {
  let value = raw.trim();
  if (value.toLowerCase().startsWith("::ffff:")) value = value.slice(7);
  if (value.includes(":")) value = value.toLowerCase();
  return value;
}

/** trustProxy 默认关闭；只有显式 RICHMAN_TRUST_PROXY=1 才读 X-Forwarded-For 第一段。 */
export function clientIp(req: IncomingMessage, limits: SecurityLimits): string {
  if (limits.trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(",").map((item) => item.trim()).find((item) => item.length > 0);
    if (first !== undefined && first !== "") return normalizeIp(first);
  }
  return normalizeIp(req.socket.remoteAddress ?? "unknown");
}

export interface ConnectionAdmission {
  ok: boolean;
  code?: "TOO_MANY_CONNECTIONS" | "TOO_MANY_UNAUTHENTICATED";
}

/** 判定顺序：总数 -> 单 IP -> 未认证数；release 幂等。 */
export class ConnectionGuard {
  private total = 0;
  private unauthenticated = 0;
  private readonly perIp = new Map<string, number>();
  private readonly authenticatedPerIp = new Map<string, number>();
  private readonly unauthPerIp = new Map<string, number>();

  constructor(private readonly limits: SecurityLimits) {}

  admit(ip: string): ConnectionAdmission {
    if (this.total >= this.limits.maxConnectionsTotal) return { ok: false, code: "TOO_MANY_CONNECTIONS" };
    const currentIp = this.perIp.get(ip) ?? 0;
    if (currentIp >= this.limits.maxConnectionsPerIp) return { ok: false, code: "TOO_MANY_CONNECTIONS" };
    if (this.unauthenticated >= this.limits.maxUnauthenticated) return { ok: false, code: "TOO_MANY_UNAUTHENTICATED" };
    this.total += 1;
    this.perIp.set(ip, currentIp + 1);
    this.unauthenticated += 1;
    this.unauthPerIp.set(ip, (this.unauthPerIp.get(ip) ?? 0) + 1);
    return { ok: true };
  }

  markAuthenticated(ip: string): void {
    if (this.unauthenticated <= 0) return;
    const pending = this.unauthPerIp.get(ip) ?? 0;
    if (pending <= 0) return;
    this.unauthenticated -= 1;
    this.unauthPerIp.set(ip, pending - 1);
    this.authenticatedPerIp.set(ip, (this.authenticatedPerIp.get(ip) ?? 0) + 1);
  }

  release(ip: string, authenticated: boolean): void {
    if (this.total <= 0) return;
    this.total -= 1;
    const currentIp = this.perIp.get(ip) ?? 0;
    if (currentIp <= 1) this.perIp.delete(ip);
    else this.perIp.set(ip, currentIp - 1);
    if (authenticated) {
      const count = this.authenticatedPerIp.get(ip) ?? 0;
      if (count <= 0) return;
      if (count === 1) this.authenticatedPerIp.delete(ip);
      else this.authenticatedPerIp.set(ip, count - 1);
      return;
    }
    const pending = this.unauthPerIp.get(ip) ?? 0;
    if (pending <= 0) return;
    if (pending === 1) this.unauthPerIp.delete(ip);
    else this.unauthPerIp.set(ip, pending - 1);
    if (this.unauthenticated > 0) this.unauthenticated -= 1;
  }

  stats(): { total: number; unauthenticated: number; perIp: Record<string, number> } {
    return {
      total: this.total,
      unauthenticated: this.unauthenticated,
      perIp: Object.fromEntries(this.perIp),
    };
  }
}

export const ECONOMIC_COMMANDS: readonly string[] = [
  "BORROW_BANK",
  "REPAY_BANK",
  "REQUEST_PRIVATE_LOAN",
  "ACCEPT_PRIVATE_LOAN",
  "REFUSE_PRIVATE_LOAN",
  "CANCEL_PRIVATE_LOAN",
  "REPAY_PRIVATE",
  "COLLECT_PRIVATE",
  "SUBMIT_BET",
];

export interface SecurityRuntime {
  limits: SecurityLimits;
  guard: ConnectionGuard;
  createRoomBucket: TokenBucket;
  joinBucket: TokenBucket;
  fullJoinBucket: TokenBucket;
  resumeBucket: TokenBucket;
  resumeRoomBucket: TokenBucket;
  commandBucket: TokenBucket;
  economicBucket: TokenBucket;
}

export interface SecurityOverrides {
  limits?: SecurityLimits;
  guard?: ConnectionGuard;
  createRoomBucket?: TokenBucket;
  joinBucket?: TokenBucket;
  fullJoinBucket?: TokenBucket;
  resumeBucket?: TokenBucket;
  resumeRoomBucket?: TokenBucket;
  commandBucket?: TokenBucket;
  economicBucket?: TokenBucket;
}

/** HTTP 与 WS 共用同一实例；缺省按 limits 创建。 */
export function createSecurityRuntime(
  limits: SecurityLimits,
  now: () => number,
  overrides: SecurityOverrides = {},
): SecurityRuntime {
  return {
    limits,
    guard: overrides.guard ?? new ConnectionGuard(limits),
    createRoomBucket: overrides.createRoomBucket
      ?? new TokenBucket(limits.createRoomBurst, limits.createRoomPerMinute / 60_000, now),
    joinBucket: overrides.joinBucket
      ?? new TokenBucket(limits.joinBurst, limits.joinPerMinute / 60_000, now),
    // 满房 join 独立计数：前 joinBurst 次仍返回 ROOM_FULL，之后 RATE_LIMITED。
    fullJoinBucket: overrides.fullJoinBucket
      ?? new TokenBucket(limits.joinBurst, limits.joinPerMinute / 60_000, now),
    resumeBucket: overrides.resumeBucket
      ?? new TokenBucket(limits.resumeBurst, limits.resumePerMinute / 60_000, now),
    resumeRoomBucket: overrides.resumeRoomBucket
      ?? new TokenBucket(limits.resumeBurst, limits.resumePerRoomPerMinute / 60_000, now),
    commandBucket: overrides.commandBucket
      ?? new TokenBucket(limits.commandBurst, limits.commandPerSecond / 1000, now),
    economicBucket: overrides.economicBucket
      ?? new TokenBucket(limits.economicBurst, limits.economicPerSecond / 1000, now),
  };
}
