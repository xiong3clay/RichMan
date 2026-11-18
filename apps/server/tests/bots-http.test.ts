import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedServer } from "../src/http.js";
import { startServer } from "../src/http.js";

let started: StartedServer;
let baseUrl: string;

beforeAll(async () => {
  started = await startServer({ host: "127.0.0.1", port: 0, staticDir: "D:/nonexistent-static-dir" });
  baseUrl = "http://127.0.0.1:" + started.port;
});

afterAll(async () => {
  await started.close();
});

async function create(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(baseUrl + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("POST /api/rooms 单人练习 bots 字段", () => {
  it("显式 bots=1/5 建房成功，房间人数包含 AI", async () => {
    for (const bots of [1, 5]) {
      const result = await create({ nickname: "练习", bots });
      expect(result.status).toBe(201);
      expect(result.body["ok"]).toBe(true);
      const roomCode = result.body["roomCode"] as string;
      expect(roomCode).toMatch(/^\d{4,8}$/);
      const list = (await (await fetch(baseUrl + "/api/rooms")).json()) as {
        rooms: Array<{ roomCode: string; playerCount: number }>;
      };
      expect(list.rooms.find((room) => room.roomCode === roomCode)?.playerCount).toBe(bots);
    }
  });

  it("缺省 bots 仍是 0 人房间", async () => {
    const result = await create({ nickname: "练习" });
    expect(result.status).toBe(201);
    expect(result.body["ok"]).toBe(true);
  });

  it("非法 bots 返回 400 INVALID_BOTS，不静默回落成 0", async () => {
    for (const bots of [6, 10, -1, 1.5, "2", null]) {
      const result = await create({ nickname: "练习", bots });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ ok: false, error: "INVALID_BOTS" });
    }
  });
});
