import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../server/src/http.js";
import type { StartedServer } from "../../server/src/http.js";
import { RichmanClient } from "../src/net/client.js";
import type { ConnectionStatus } from "../src/net/client.js";

const STATIC_DIR = "D:/nonexistent-static-dir";
const storage = new Map<string, string>();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installBrowser(port: number): void {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value);
      },
      removeItem: (key: string): void => {
        storage.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", host: "127.0.0.1:" + String(port) },
      setTimeout: (callback: () => void, ms: number): number =>
        setTimeout(callback, ms) as unknown as number,
      clearTimeout: (handle: number): void =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    },
  });
}

describe("M2 resume 失败收口", () => {
  let server: StartedServer | null = null;

  beforeAll(() => {
    installBrowser(1);
  });

  afterAll(async () => {
    if (server !== null) await server.close();
    server = null;
  });

  it("服务端重启丢房间后重连 resume 失败：报 code+message、清会话、停止重连", async () => {
    storage.clear();
    const first = await startServer({ host: "127.0.0.1", port: 0, staticDir: STATIC_DIR });
    installBrowser(first.port);
    server = first;
    const roomCode = first.manager.createRoom();

    const statusesA: ConnectionStatus[] = [];
    const failure = deferred<{ code: string; message: string }>();
    const joinedA = deferred<void>();
    const joinedB = deferred<void>();
    const readyRoom = deferred<void>();
    const startedGame = deferred<void>();

    const a = new RichmanClient(roomCode, "甲", {
      onStatus: (status) => statusesA.push(status),
      onJoined: () => joinedA.resolve(),
      onRoom: (room) => {
        if (room.players.length === 2 && room.players.every((player) => player.ready)) readyRoom.resolve();
      },
      onStarted: () => startedGame.resolve(),
      onSnapshot: () => undefined,
      onCommandResult: () => undefined,
      onServerError: (error) => failure.resolve(error),
    });
    a.connect();
    await joinedA.promise;

    const b = new RichmanClient(roomCode, "乙", {
      onStatus: () => undefined,
      onJoined: () => joinedB.resolve(),
      onRoom: () => undefined,
      onStarted: () => undefined,
      onSnapshot: () => undefined,
      onCommandResult: () => undefined,
      onServerError: () => undefined,
    });
    b.connect();
    await joinedB.promise;

    b.sendLobby({ type: "ready", ready: true });
    a.sendLobby({ type: "ready", ready: true });
    await readyRoom.promise;
    a.sendLobby({ type: "start" });
    await startedGame.promise;

    // 服务端重启：内存房间与 token 摘要全部丢失，重连后的 resume 必然失败。
    await first.close();
    server = null;
    b.dispose();
    const second = await startServer({ host: "127.0.0.1", port: first.port, staticDir: STATIC_DIR });
    server = second;

    const result = await Promise.race([
      failure.promise,
      new Promise<{ code: string; message: string }>((_, reject) =>
        setTimeout(() => reject(new Error("重连后 resume 失败未被上报")), 8000)),
    ]);
    expect(["UNAUTHORIZED", "ROOM_NOT_FOUND"]).toContain(result.code);
    expect(result.message.length).toBeGreaterThan(0);
    expect(storage.size).toBe(0);
    expect(a.hasJoined).toBe(false);

    // 失败后不得再尝试重连。
    const statusCount = statusesA.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(statusesA.slice(statusCount)).not.toContain("connecting");
    expect(statusesA).toContain("closed");

    a.dispose();
  }, 20000);
});
