import { createRequire } from "node:module";
import path from "node:path";
import { PROTOCOL_VERSION } from "@richman/shared";
import { startServer } from "../apps/server/src/http.js";

/**
 * 双客户端冒烟：
 * 0 端口起服务 → POST /api/rooms → 两个真实 ws 客户端加入/准备/开始 →
 * 借银行一次、结束行动一次、两人下注 → 进入第 2 轮；
 * 再用过期 expectedGameVersion 发一次行动命令，验证拒绝后会补发当前版本快照。
 * 断言：snapshot 的 schemaVersion=1、version 单调不降（除拒绝补发外不得重复）、
 * 下注结算只扣一次（双方金币变化恰好 ±100 分，合计为 0）。
 */

/** ws 是 apps/server 的依赖，从根脚本里按 server 的解析路径加载，避免新增根依赖。 */
const requireFromServer = createRequire(path.resolve(process.cwd(), "apps/server/package.json"));
const { WebSocket } = requireFromServer("ws") as { WebSocket: new (url: string) => unknown };

interface SocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

type Json = Record<string, unknown>;

interface Waiter {
  type: string;
  predicate: (message: Json) => boolean;
  resolve: (message: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("断言失败：" + message);
}

function viewOf(message: Json): Json {
  return message["view"] as Json;
}

function financeOf(view: Json): Json {
  return view["finance"] as Json;
}

function centsOf(view: Json): number {
  return Number(financeOf(view)["cents"]);
}

function loansOf(view: Json): Json[] {
  return financeOf(view)["bankLoans"] as Json[];
}

class SmokeClient {
  private socket: SocketLike | null = null;
  private readonly inbox: Json[] = [];
  private readonly waiters: Waiter[] = [];
  readonly snapshots: Json[] = [];
  constructor(private readonly url: string) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url) as SocketLike;
      this.socket = socket;
      socket.on("open", () => resolve());
      socket.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
      socket.on("message", (data) => this.onMessage(String(data)));
    });
  }

  send(message: Json): void {
    assert(this.socket !== null, "连接尚未建立");
    this.socket.send(JSON.stringify(message));
  }

  next(type: string, predicate: (message: Json) => boolean = () => true, timeoutMs = 4000): Promise<Json> {
    const index = this.inbox.findIndex((message) => message["type"] === type && predicate(message));
    if (index >= 0) {
      const [found] = this.inbox.splice(index, 1);
      assert(found !== undefined, "消息取出失败");
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("等待消息超时：" + type));
      }, timeoutMs);
      this.waiters.push({ type, predicate, resolve, reject, timer });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket === null || this.socket.readyState === 3) {
        resolve();
        return;
      }
      this.socket.on("close", () => resolve());
      this.socket.close();
    });
  }

  private onMessage(raw: string): void {
    let message: Json;
    try {
      message = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    if (message["type"] === "snapshot" && message["view"] !== undefined) {
      this.snapshots.push(message["view"] as Json);
    }
    const index = this.waiters.findIndex(
      (waiter) => waiter.type === message["type"] && waiter.predicate(message),
    );
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      assert(waiter !== undefined, "等待者取出失败");
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.inbox.push(message);
  }
}

let commandSeq = 0;
function makeCommand(
  owner: string,
  gameId: string,
  type: string,
  payload: Json,
  extra: Json = {},
): Json {
  commandSeq += 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    gameId,
    commandId: owner + "-" + String(commandSeq),
    type,
    payload,
    ...extra,
  };
}

async function main(): Promise<void> {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    staticDir: path.resolve("apps/web/does-not-exist-in-smoke"),
  });
  const clients: SmokeClient[] = [];
  try {
    const base = "http://127.0.0.1:" + String(server.port);
    const created = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "甲" }),
    });
    assert(created.status === 201, "POST /api/rooms 应返回 201，实际 " + String(created.status));
    const createdBody = (await created.json()) as { ok?: unknown; roomCode?: unknown };
    assert(createdBody.ok === true, "建房响应 ok 应为 true");
    assert(typeof createdBody.roomCode === "string", "建房响应缺少 roomCode");
    const roomCode = createdBody.roomCode;
    assert(/^[0-9]{4,8}$/.test(roomCode), "房间码必须是 4～8 位数字，实际 " + roomCode);
    console.log("[smoke] 建房成功 roomCode=" + roomCode);

    const wsBase = "ws://127.0.0.1:" + String(server.port) + "/ws?room=" + roomCode;
    const a = new SmokeClient(wsBase);
    const b = new SmokeClient(wsBase);
    clients.push(a, b);
    await Promise.all([a.open(), b.open()]);

    a.send({ type: "join", nickname: "甲" });
    b.send({ type: "join", nickname: "乙" });
    const aJoined = await a.next("joined");
    const bJoined = await b.next("joined");
    assert(aJoined["seatId"] === 1, "甲应坐 1 号位");
    assert(bJoined["seatId"] === 2, "乙应坐 2 号位");
    await a.next("room", (message) => (message["players"] as Json[]).length === 2);
    await b.next("room", (message) => (message["players"] as Json[]).length === 2);
    console.log("[smoke] 两名玩家已加入：seat1=" + String(aJoined["playerId"]) + " seat2=" + String(bJoined["playerId"]));

    a.send({ type: "ready", ready: true });
    b.send({ type: "ready", ready: true });
    await a.next("room", (message) => (message["players"] as Json[]).every((player) => player["ready"] === true));
    a.send({ type: "start" });
    const started = await a.next("started");
    const startedForB = await b.next("started");
    const gameId = String(started["gameId"]);
    assert(startedForB["gameId"] === gameId, "两名玩家应收到同一个 gameId");

    const actionA = await a.next(
      "snapshot",
      (message) => viewOf(message)["phase"] === "ACTION" && viewOf(message)["currentSeatId"] === 1,
    );
    const actionView = viewOf(actionA);
    await b.next("snapshot", (message) => viewOf(message)["version"] === actionView["version"]);
    console.log("[smoke] 开局：gameId=" + gameId + " version=" + String(actionView["version"]) + " phase=ACTION seat=1");

    const centsABeforeBorrow = centsOf(actionView);
    const borrowCommand = makeCommand("a", gameId, "BORROW_BANK", { amountCents: "2500" }, {
      expectedGameVersion: actionView["version"],
    });
    a.send(borrowCommand);
    const borrowReply = await a.next("command_result", (message) => message["commandId"] === borrowCommand["commandId"]);
    assert((borrowReply["outcome"] as Json)["ok"] === true, "借银行应成功");
    const afterBorrowA = await a.next(
      "snapshot",
      (message) => viewOf(message)["version"] > (actionView["version"] as number),
    );
    const afterBorrowView = viewOf(afterBorrowA);
    assert(centsOf(afterBorrowView) === centsABeforeBorrow + 2500, "借银行后金币应增加 2500 分");
    assert(loansOf(afterBorrowView).length === 1, "借银行后应有一笔贷款");
    console.log("[smoke] 甲借银行 2500 分：" + String(centsABeforeBorrow) + " -> " + String(centsOf(afterBorrowView)));

    const bAction = await b.next(
      "snapshot",
      (message) => viewOf(message)["phase"] === "ACTION" && viewOf(message)["currentSeatId"] === 2,
    );
    const bActionView = viewOf(bAction);
    const endCommand = makeCommand("b", gameId, "END_ACTION", {}, {
      expectedGameVersion: bActionView["version"],
    });
    b.send(endCommand);
    const endReply = await b.next("command_result", (message) => message["commandId"] === endCommand["commandId"]);
    assert((endReply["outcome"] as Json)["ok"] === true, "结束行动应成功");

    const bettingA = viewOf(await a.next("snapshot", (message) => viewOf(message)["phase"] === "BETTING"));
    const bettingB = viewOf(await b.next("snapshot", (message) => viewOf(message)["phase"] === "BETTING"));
    console.log("[smoke] 双方行动结束，进入 BETTING：version=" + String(bettingA["version"]));

    const centsABeforeBet = centsOf(bettingA);
    const centsBBeforeBet = centsOf(bettingB);
    const betA = makeCommand("a", gameId, "SUBMIT_BET", { betCents: "100", guess: 1, leverage: 1 }, {
      roundId: bettingA["round"],
      phaseInstanceId: bettingA["phaseInstanceId"],
    });
    a.send(betA);
    const betAReply = await a.next("command_result", (message) => message["commandId"] === betA["commandId"]);
    assert((betAReply["outcome"] as Json)["ok"] === true, "甲下注应成功");

    const betB = makeCommand("b", gameId, "SUBMIT_BET", { betCents: "100", guess: 0, leverage: 1 }, {
      roundId: bettingB["round"],
      phaseInstanceId: bettingB["phaseInstanceId"],
    });
    b.send(betB);
    const betBReply = await b.next("command_result", (message) => message["commandId"] === betB["commandId"]);
    assert((betBReply["outcome"] as Json)["ok"] === true, "乙下注应成功");

    const nextRoundA = viewOf(await a.next(
      "snapshot",
      (message) => viewOf(message)["round"] === 2 && viewOf(message)["phase"] === "ACTION"
        && viewOf(message)["currentSeatId"] === 1,
    ));
    const nextRoundB = viewOf(await b.next("snapshot", (message) => viewOf(message)["round"] === 2));
    assert(nextRoundA["round"] === 2 && nextRoundB["round"] === 2, "下注结算后应进入第 2 轮");
    assert(nextRoundA["version"] > (bettingA["version"] as number), "进入下一轮后 version 应递增");

    const centsAAfterBet = centsOf(nextRoundA);
    const centsBAfterBet = centsOf(nextRoundB);
    const deltaA = centsAAfterBet - centsABeforeBet;
    const deltaB = centsBAfterBet - centsBBeforeBet;
    assert(deltaA === 100 || deltaA === -100, "甲的金币变化应恰好是 ±100，实际 " + String(deltaA));
    assert(deltaB === 100 || deltaB === -100, "乙的金币变化应恰好是 ±100，实际 " + String(deltaB));
    assert(deltaA + deltaB === 0, "两名玩家的金币变化应相互抵消（无重复扣款）");
    assert(loansOf(nextRoundA).length === 1, "甲不应因下注产生额外贷款");
    assert(loansOf(nextRoundB).length === 0, "乙不应因下注产生额外贷款");
    console.log(
      "[smoke] 第 2 轮结算：甲 " + String(centsAAfterBet) + "（Δ" + String(deltaA) +
      " 分），乙 " + String(centsBAfterBet) + "（Δ" + String(deltaB) + " 分）",
    );

    // M3：过期 expectedGameVersion 被拒绝后，服务端必须回推当前版本快照（不能只回 command_result）。
    const staleVersion = (nextRoundA["version"] as number) - 1;
    const staleCommand = makeCommand("a", gameId, "END_ACTION", {}, { expectedGameVersion: staleVersion });
    a.send(staleCommand);
    const staleReply = await a.next("command_result", (message) => message["commandId"] === staleCommand["commandId"]);
    const staleOutcome = staleReply["outcome"] as Json;
    assert(staleOutcome["ok"] === false, "过期版本的行动命令应被拒绝");
    assert(staleOutcome["code"] === "VERSION_CONFLICT", "过期版本应返回 VERSION_CONFLICT，实际 " + String(staleOutcome["code"]));
    const repushed = viewOf(await a.next(
      "snapshot",
      (message) => (viewOf(message)["version"] as number) === nextRoundA["version"],
    ));
    assert(repushed["version"] === nextRoundA["version"], "拒绝后应回推当前版本快照");
    console.log("[smoke] 过期命令被拒（VERSION_CONFLICT），已补发 version=" + String(repushed["version"]) + " 的快照");

    for (const [name, client] of [["甲", a], ["乙", b]] as const) {
      let lastVersion = -1;
      let duplicates = 0;
      for (const snapshot of client.snapshots) {
        assert(snapshot["schemaVersion"] === 1, name + " 的 snapshot.schemaVersion 应为 1");
        const version = snapshot["version"] as number;
        assert(
          version >= lastVersion,
          name + " 的 snapshot.version 不能倒退（发现 " + String(version) + " < " + String(lastVersion) + "）",
        );
        if (version === lastVersion) duplicates += 1;
        lastVersion = version;
      }
      // 仅 M3 的“拒绝后补发”允许一次同版本快照；正常 commit 不得重复广播。
      assert(duplicates <= 1, name + " 出现了多余的重复快照：" + String(duplicates));
      console.log("[smoke] " + name + " 收到 " + String(client.snapshots.length) + " 条快照，version 单调不降（重复 " + String(duplicates) + " 次）");
    }

    console.log("[smoke] PASS");
  } finally {
    for (const client of clients) await client.close();
    await server.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("[smoke] FAIL：" + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  },
);
