import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";

type Message = { type: string } & Record<string, unknown>;

class TestClient {
  private readonly inbox: Message[] = [];
  private readonly waiters: Array<{
    type: string;
    check: (message: Message) => boolean;
    resolve: (message: Message) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as Message;
      const index = this.waiters.findIndex((waiter) =>
        waiter.type === message.type && waiter.check(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
  }

  next(type: string, check: (message: Message) => boolean = () => true): Promise<Message> {
    const index = this.inbox.findIndex((message) => message.type === type && check(message));
    if (index >= 0) {
      return Promise.resolve(this.inbox.splice(index, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待消息超时：" + type)), 3000);
      this.waiters.push({ type, check, resolve, timer });
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function playersOf(message: Message): Array<Record<string, unknown>> {
  return message["players"] as Array<Record<string, unknown>>;
}

let started: StartedServer;

beforeAll(async () => {
  started = await startServer({ host: "127.0.0.1", port: 0, staticDir: "D:/nonexistent-static-dir" });
});

afterAll(async () => {
  await started.close();
});

async function openClient(roomCode: string): Promise<TestClient> {
  const ws = new WebSocket("ws://127.0.0.1:" + String(started.port) + "/ws?room=" + roomCode);
  const client = new TestClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
  return client;
}

describe("M1 leave 语义", () => {
  it("房主在大厅退出：另一方收到 room，hostId 转交给剩余玩家", async () => {
    const roomCode = started.manager.createRoom();
    const host = await openClient(roomCode);
    const guest = await openClient(roomCode);

    host.send({ type: "join", nickname: "甲" });
    const hostJoined = await host.next("joined");
    expect(hostJoined["seatId"]).toBe(1);
    guest.send({ type: "join", nickname: "乙" });
    await guest.next("joined");
    await guest.next("room", (message) => playersOf(message).length === 2);

    host.send({ type: "leave" });
    const afterLeave = await guest.next("room", (message) => playersOf(message).length === 1);
    expect(afterLeave["hostId"]).toBe("p2");
    expect(playersOf(afterLeave).map((player) => player["playerId"])).toEqual(["p2"]);
    expect(started.manager.getRoom(roomCode)?.hostId).toBe("p2");

    await host.close();
    await guest.close();
  });

  it("对局中退出：只标记离线、不改对局版本，原 token 仍可 resume 回原座位", async () => {
    const roomCode = started.manager.createRoom();
    const host = await openClient(roomCode);
    const guest = await openClient(roomCode);

    host.send({ type: "join", nickname: "甲" });
    const hostJoined = await host.next("joined");
    const hostToken = String(hostJoined["sessionToken"]);
    guest.send({ type: "join", nickname: "乙" });
    await guest.next("joined");

    host.send({ type: "ready", ready: true });
    guest.send({ type: "ready", ready: true });
    await host.next("room", (message) => playersOf(message).every((player) => player["ready"] === true));
    host.send({ type: "start" });
    await host.next("started");
    await guest.next("started");

    const gameBefore = started.manager.getGame(roomCode)!;
    const versionBefore = gameBefore.version;
    host.send({ type: "leave" });
    const offline = await guest.next(
      "room",
      (message) => playersOf(message).some((player) => player["playerId"] === "p1" && player["online"] === false),
    );
    expect(offline["hostId"]).toBe("p1");
    expect(started.manager.getGame(roomCode)?.version).toBe(versionBefore);
    expect(started.manager.getGame(roomCode)?.players).toHaveLength(2);

    const resumed = await openClient(roomCode);
    resumed.send({ type: "resume", roomCode, sessionToken: hostToken });
    const resumedJoined = await resumed.next("joined");
    expect(resumedJoined["playerId"]).toBe("p1");
    expect(resumedJoined["seatId"]).toBe(1);
    expect(started.manager.getRoom(roomCode)?.players.find(
      (player) => player.playerId === "p1")?.online).toBe(true);

    await host.close();
    await guest.close();
    await resumed.close();
  });
});
