import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";
import { RoomScheduler } from "../src/rooms/scheduler.js";

type Message = Record<string, any>;

class Client {
  messages: Message[] = [];
  waiters: Array<{ predicate: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  readonly closeCode: Promise<number>;
  constructor(readonly ws: WebSocket) {
    this.closeCode = new Promise(resolve => ws.on("close", (code: number) => resolve(code)));
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as Message;
      const index = this.waiters.findIndex(w => w.predicate(m));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(m);
      else this.messages.push(m);
    });
    ws.on("error", () => undefined);
  }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  next(type: string, check: (m: Message) => boolean = () => true): Promise<Message> {
    const predicate = (m: Message): boolean => m.type === type && check(m);
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (m: Message): void => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error("消息超时: " + type));
      }, 1500);
      this.waiters.push(waiter);
    });
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function serverWithData(): Promise<{ s: StartedServer; dir: string; room: string }> {
  const dir = await mkdtemp(joinPath(tmpdir(), "richman-07c-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const s = await startServer({ host: "127.0.0.1", port: 0, dataDir: dir });
  cleanups.push(() => s.close());
  const room = await s.manager.createRoomPersisted();
  return { s, dir, room };
}

async function open(port: number, room: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
  const c = new Client(ws);
  await once(ws, "open");
  return c;
}

async function join(port: number, room: string, nickname: string): Promise<[Client, Message]> {
  const c = await open(port, room);
  c.send({ type: "join", nickname });
  return [c, await c.next("joined")];
}

function roomDir(dir: string, room: string): string {
  return joinPath(dir, "rooms", room);
}

describe("07C 房主销毁房间", () => {
  it("D1 房主销毁：目录删除、所有连接收到 room_destroyed 并被 4002 关闭", async () => {
    const { s, dir, room } = await serverWithData();
    const second = await s.manager.createRoomPersisted();
    expect(existsSync(roomDir(dir, room))).toBe(true);
    expect(existsSync(roomDir(dir, second))).toBe(true);
    const [host, hostIdentity] = await join(s.port, room, "房主");
    const [guest] = await join(s.port, room, "客人");

    host.send({ type: "destroy_room" });
    const hostNotice = await host.next("room_destroyed");
    const guestNotice = await guest.next("room_destroyed");
    expect(hostNotice).toEqual({ type: "room_destroyed", roomCode: room, byPlayerId: hostIdentity.playerId });
    expect(guestNotice.byPlayerId).toBe(hostIdentity.playerId);
    expect(await host.closeCode).toBe(4002);
    expect(await guest.closeCode).toBe(4002);
    expect(s.manager.getRoom(room)).toBeNull();
    expect(existsSync(roomDir(dir, room))).toBe(false);
    // T1：只删当前房间，第二房间目录与房间对象必须保持。
    expect(existsSync(roomDir(dir, second))).toBe(true);
    expect(s.manager.getRoom(second)).not.toBeNull();
    expect(s.manager.roomCount()).toBe(1);
  });

  it("D2 非房主销毁返回 NOT_HOST，房间与数据保持", async () => {
    const { s, dir, room } = await serverWithData();
    const [host] = await join(s.port, room, "房主");
    const [guest] = await join(s.port, room, "客人");
    guest.send({ type: "destroy_room" });
    const error = await guest.next("error");
    expect(error.code).toBe("NOT_HOST");
    expect(s.manager.getRoom(room)).not.toBeNull();
    expect(existsSync(roomDir(dir, room))).toBe(true);
    void host;
  });

  it("D3 销毁后用原房间码 join 返回 ROOM_NOT_FOUND", async () => {
    const { s, room } = await serverWithData();
    const [host] = await join(s.port, room, "房主");
    host.send({ type: "destroy_room" });
    await host.next("room_destroyed");
    await once(host.ws, "close");

    const late = await open(s.port, room);
    late.send({ type: "join", nickname: "迟到者" });
    const error = await late.next("error");
    expect(error.code).toBe("ROOM_NOT_FOUND");
    late.ws.close();
  });

  it("D4 对局中（PLAYING）销毁同样删除房间且不残留推进", async () => {
    const { s, dir, room } = await serverWithData();
    const [a, ia] = await join(s.port, room, "甲");
    const [b, ib] = await join(s.port, room, "乙");
    a.send({ type: "ready", ready: true });
    await a.next("room", (m) => m.players.find((p: Message) => p.playerId === ia.playerId)?.ready === true);
    b.send({ type: "ready", ready: true });
    await a.next("room", (m) => m.players.find((p: Message) => p.playerId === ib.playerId)?.ready === true);
    a.send({ type: "start" });
    await a.next("started");
    await a.next("snapshot");
    expect(s.manager.getGame(room)).not.toBeNull();

    const cancelSpy = vi.spyOn(RoomScheduler.prototype, "cancelRoom");
    a.send({ type: "destroy_room" });
    await a.next("room_destroyed");
    await once(a.ws, "close");
    expect(cancelSpy).toHaveBeenCalledWith(room);
    expect(s.manager.getGame(room)).toBeNull();
    expect(s.manager.getRoom(room)).toBeNull();
    expect(existsSync(roomDir(dir, room))).toBe(false);
    // T2：等过 deadline 附近也不复活目录/房间（cancelRoom 若被移除，本断言与 spy 会失败）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.manager.getRoom(room)).toBeNull();
    expect(existsSync(roomDir(dir, room))).toBe(false);
    cancelSpy.mockRestore();
  });

  it("S-D 真实 ws.destroy_room：同房三条连接全部收到通知并 4002", async () => {
    const { s, room } = await serverWithData();
    const [host, hostIdentity] = await join(s.port, room, "房主");
    const [second] = await join(s.port, room, "乙");
    const [third] = await join(s.port, room, "丙");
    host.send({ type: "destroy_room" });
    for (const client of [host, second, third]) {
      const notice = await client.next("room_destroyed");
      expect(notice.byPlayerId).toBe(hostIdentity.playerId);
      expect(await client.closeCode).toBe(4002);
    }
    expect(s.manager.getRoom(room)).toBeNull();
  });

  it("S-D 恢复码轮换后旧 socket 被 4001 关闭；bind 前窗口由 releaseSupersededOwner 兜底", async () => {
    const { s, room } = await serverWithData();
    const [host, hostIdentity] = await join(s.port, room, "房主");
    const [oldGuest, guestIdentity] = await join(s.port, room, "客人");
    const fresh = await open(s.port, room);
    fresh.send({ type: "resume", roomCode: room, recoveryCode: guestIdentity.recoveryCode });
    expect(await fresh.next("joined")).toMatchObject({ playerId: guestIdentity.playerId });

    const replaced = await oldGuest.next("error");
    expect(replaced.code).toBe("REPLACED");
    expect(await oldGuest.closeCode).toBe(4001);
    // bind 正常完成时旧 socket 会被 4001 关闭。bind 前中断的窗口分两种：
    // joined 发送失败时 releaseSupersededOwner 对 owners 中仍登记的旧 owner 执行 detach + 4001；
    // 新连接在 transact 完成前关闭时，旧 owner 已被 detach（identity 清空，且按 06 契约
    // 保留 socket 以便收到 NOT_JOINED）。因此 destroy 时不应再有带 identity 的同房
    // non-current OPEN 连接；selectDestroyPeers 仍按 identity+OPEN 选择作为兜底。
    expect(oldGuest.ws.readyState).toBe(WebSocket.CLOSED);
    expect(oldGuest.messages.filter((m) => m.type === "room_destroyed")).toHaveLength(0);

    host.send({ type: "destroy_room" });
    expect((await fresh.next("room_destroyed")).byPlayerId).toBe(hostIdentity.playerId);
    expect(await fresh.closeCode).toBe(4002);
  });

  it("D5 重复 destroy 返回 ROOM_NOT_FOUND，不崩", async () => {
    const { s, room } = await serverWithData();
    const host = s.manager.join(room, "甲");
    await s.manager.destroyRoom(room, host.playerId);
    await expect(s.manager.destroyRoom(room, host.playerId)).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(s.manager.roomCount()).toBe(0);
  });

  it("D-extra manager.destroyRoom 非房主抛 NOT_HOST，房主销毁后房间码消失", async () => {
    const { s, room } = await serverWithData();
    const host = s.manager.join(room, "甲");
    const guest = s.manager.join(room, "乙");
    await expect(s.manager.destroyRoom(room, guest.playerId)).rejects.toMatchObject({ code: "NOT_HOST" });
    await s.manager.destroyRoom(room, host.playerId);
    expect(s.manager.getRoom(room)).toBeNull();
    expect(s.manager.roomCount()).toBe(0);
  });
});
