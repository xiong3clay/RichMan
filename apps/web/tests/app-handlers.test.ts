import { describe, expect, it, vi } from "vitest";
import {
  createRoomDestroyedHandler,
  requestRoomDestroy,
  roomDestroyedReset,
} from "../src/app-handlers.js";
import type { RoomDestroyedReset } from "../src/app-handlers.js";

function deps() {
  const applied: RoomDestroyedReset[] = [];
  const calls: string[] = [];
  return {
    applied,
    calls,
    markLeaving: () => calls.push("markLeaving"),
    clearSession: () => calls.push("clearSession"),
    disposeClient: () => calls.push("disposeClient"),
    apply: (reset: RoomDestroyedReset) => { calls.push("apply"); applied.push(reset); },
  };
}

describe("07C 第二轮 S-E App handlers 工厂", () => {
  it("requestRoomDestroy 原样返回 boolean，null client 为 false", () => {
    expect(requestRoomDestroy(null)).toBe(false);
    expect(requestRoomDestroy(undefined)).toBe(false);
    expect(requestRoomDestroy({ destroyRoom: () => false })).toBe(false);
    expect(requestRoomDestroy({ destroyRoom: () => true })).toBe(true);
  });

  it("onRoomDestroyed(byPlayerId=xxx)：房主销毁文案并清空房间/快照", () => {
    const d = deps();
    createRoomDestroyedHandler(d)({ roomCode: "0042", byPlayerId: "p1" });
    expect(d.calls).toEqual(["markLeaving", "clearSession", "disposeClient", "apply"]);
    expect(d.applied).toHaveLength(1);
    const reset = d.applied[0]!;
    expect(reset.entryError).toBe("房主已销毁房间，所有数据已删除");
    expect(reset.roomCode).toBeNull();
    expect(reset.snapshot).toBeNull();
    expect(reset.joined).toBeNull();
    expect(reset.events).toEqual([]);
    expect(reset.status).toBe("closed");
  });

  it("onRoomDestroyed(byPlayerId=\"\")：ROOM_NOT_FOUND 兜底文案", () => {
    const d = deps();
    createRoomDestroyedHandler(d)({ roomCode: "0042", byPlayerId: "" });
    expect(d.applied[0]!.entryError).toBe("房间已不存在或已被销毁，已回到首页");
    expect(d.applied[0]!.roomCode).toBeNull();
    expect(d.applied[0]!.snapshot).toBeNull();
  });

  it("roomDestroyedReset 是纯函数：相同入参不会复用可变引用", () => {
    const first = roomDestroyedReset("p1");
    const second = roomDestroyedReset("p1");
    expect(first).not.toBe(second);
    expect(first.events).not.toBe(second.events);
  });
});
