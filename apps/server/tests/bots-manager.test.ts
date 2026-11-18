import { describe, expect, it } from "vitest";
import { BOTS_MAX, BOT_PERSONALITIES, DEFAULT_BOT_PERSONALITY, RULES } from "@richman/shared";
import { LobbyError, RoomManager } from "../src/rooms/manager.js";
import { validateSnapshot } from "../src/storage/file-store.js";

function manager(rng: () => number = () => 0): RoomManager {
  let next = 0;
  return new RoomManager({
    generateRoomCode: () => "10" + String(next++).padStart(2, "0"),
    generateGameId: () => "g-" + String(next++),
    generateToken: () => "token-" + String(next++),
    rng,
    now: () => 0,
  });
}

function sequenceRng(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("RoomManager 单人练习 AI 座位", () => {
  it("BOTS_MAX=5 且小于 RULES.playerMax；0/1/5 合法，6 与非法值返回 INVALID_BOTS", () => {
    expect(BOTS_MAX).toBe(5);
    expect(BOTS_MAX).toBeLessThan(RULES.playerMax);
    const m = manager();
    expect(m.getRoom(m.createRoom())?.players).toEqual([]);
    expect(m.getRoom(m.createRoom(1))?.players).toHaveLength(1);
    expect(m.getRoom(m.createRoom(BOTS_MAX))?.players).toHaveLength(BOTS_MAX);

    for (const invalid of [BOTS_MAX + 1, 10, -1, 1.5, Number.NaN]) {
      expect(() => m.createRoom(invalid)).toThrow(LobbyError);
      try {
        m.createRoom(invalid);
      } catch (error) {
        expect((error as LobbyError).code).toBe("INVALID_BOTS");
      }
    }
  });

  it("AI 自动准备并计入开局名单，昵称冻结进玩家席位", () => {
    const m = manager();
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    expect(human.seatId).toBe(2);
    // 只有人类未准备时不能开局。
    expect(() => m.startFor(code, human.playerId)).toThrow(LobbyError);

    m.setReadyFor(code, human.playerId, true);
    const gameId = m.startFor(code, human.playerId);
    expect(gameId).toBeTruthy();
    const game = m.getGame(code)!;
    expect(game.players.map((player) => [player.playerId, player.seatId, player.nickname])).toEqual([
      ["p1", 1, "AI 挑战者1"],
      ["p2", 2, "人类"],
    ]);
  });

  it("AI 断线/离开都是 no-op，永远在线且保留座位", () => {
    const m = manager();
    const code = m.createRoom(1);
    const human = m.join(code, "人类");

    expect(m.disconnectFor(code, "p1")).toBe("p1");
    expect(m.getRoom(code)?.players.find((player) => player.playerId === "p1")?.online).toBe(true);

    expect(m.leaveFor(code, "p1")).toBe("p1");
    expect(m.getRoom(code)?.players.map((player) => player.playerId)).toEqual(["p1", "p2"]);
    expect(m.getRoom(code)?.hostId).toBe(human.playerId);
  });

  it("人类离开只剩 AI 时回收房间，不留僵尸房", () => {
    const m = manager();
    const code = m.createRoom(2);
    const human = m.join(code, "人类");
    m.leaveFor(code, human.playerId);
    expect(m.getRoom(code)).toBeNull();
  });

  it("房间视图只给 AI 座位标记 isBot 与人格，人类保持旧消息形状", () => {
    const m = manager(() => 0.2);
    const code = m.createRoom(1);
    m.join(code, "人类");
    const players = m.getRoom(code)!.players;
    expect(players[0]).toMatchObject({
      isBot: true,
      botPersonality: BOT_PERSONALITIES[Math.floor(0.2 * BOT_PERSONALITIES.length)],
    });
    expect(players[1]).not.toHaveProperty("isBot");
    expect(players[1]).not.toHaveProperty("botPersonality");
    expect(players[1]).toMatchObject({ ready: false, online: true });
  });

  it("AI 占满 BOTS_MAX 后仍可坐满 10 人房间，第 11 人被拒", () => {
    const m = manager();
    const code = m.createRoom(BOTS_MAX);
    for (let index = 0; index < RULES.playerMax - BOTS_MAX; index += 1) {
      m.join(code, "人类" + String(index + 1));
    }
    expect(m.getRoom(code)?.players).toHaveLength(RULES.playerMax);
    expect(() => m.join(code, "第 11 人")).toThrow(LobbyError);
  });
});

describe("AI 人格抽取与 rematch", () => {
  it("同 seed 可复现，5 个 AI 能抽到多种人格且都合法", () => {
    const values = [0.05, 0.25, 0.45, 0.65, 0.85];
    const first = manager(sequenceRng(values));
    const firstCode = first.createRoom(BOTS_MAX);
    const firstPersonalities = first.getRoom(firstCode)!.players.map((player) => player.botPersonality);

    const second = manager(sequenceRng(values));
    const secondCode = second.createRoom(BOTS_MAX);
    const secondPersonalities = second.getRoom(secondCode)!.players.map((player) => player.botPersonality);

    expect(secondPersonalities).toEqual(firstPersonalities);
    expect(firstPersonalities).toHaveLength(BOTS_MAX);
    expect(new Set(firstPersonalities).size).toBeGreaterThan(1);
    for (const personality of firstPersonalities) {
      expect(BOT_PERSONALITIES).toContain(personality!);
    }
  });

  it("rematch 重新抽取人格，同一局内保持不变", () => {
    const m = manager(sequenceRng([0, 0.5]));
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    m.setReadyFor(code, human.playerId, true);
    m.startFor(code, human.playerId);
    expect(m.getRoom(code)?.players[0]?.botPersonality).toBe(BOT_PERSONALITIES[0]);

    // 测试里直接把当前局置为 GAME_OVER，满足 rematch 的前置条件。
    m.getGame(code)!.phase = "GAME_OVER";
    m.rematchFor(code, human.playerId);
    expect(m.getRoom(code)?.players[0]?.botPersonality).toBe(BOT_PERSONALITIES[2]);
  });

  it("恢复旧快照时缺失人格默认 PASSIVE；非法值不能写入", () => {
    const m = manager();
    const code = m.createRoom(1);
    const snapshot = m.exportRoom(code)!;
    delete snapshot.players[0]!.botPersonality;
    const restored = new RoomManager();
    restored.restoreRoom(snapshot);
    expect(restored.getRoom(code)?.players[0]?.botPersonality).toBe(DEFAULT_BOT_PERSONALITY);

    const invalid = m.exportRoom(code)!;
    invalid.players[0]!.botPersonality = "NOT_A_PERSONALITY" as never;
    expect(() => validateSnapshot(invalid, code)).toThrow("座位结构无效");
  });

  it("P2-10 篡改快照：AI 数量超限、AI playerId 与座位不符、生命周期字段非法都应拒绝", () => {
    const m = manager();
    const code = m.createRoom(BOTS_MAX);
    const tooMany = m.exportRoom(code)!;
    tooMany.players.push({
      playerId: "p6", seatId: 6, nickname: "AI 挑战者6", ready: true, online: true,
      tokenDigest: "bot-6", isBot: true, botPersonality: "PASSIVE",
    });
    expect(() => validateSnapshot(tooMany, code)).toThrow("AI 座位数量超限");

    const badId = m.exportRoom(code)!;
    badId.players[0]!.playerId = "p9";
    expect(() => validateSnapshot(badId, code)).toThrow("座位结构无效");

    const badTime = m.exportRoom(code)!;
    badTime.createdAtMs = -1;
    expect(() => validateSnapshot(badTime, code)).toThrow("生命周期字段无效");
  });
});
