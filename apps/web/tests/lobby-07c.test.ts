import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LobbyView } from "../src/LobbyView";
import type { JoinedInfo, WireRoom } from "../src/net/wire";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

function room(): WireRoom {
  return {
    type: "room",
    hostId: "p1",
    state: "LOBBY",
    players: [
      { playerId: "p1", nickname: "甲", seatId: 1, ready: true, online: true },
      { playerId: "p2", nickname: "乙", seatId: 2, ready: true, online: true },
    ],
  };
}

function joined(playerId: string): JoinedInfo {
  return { roomCode: "0042", playerId, seatId: playerId === "p1" ? 1 : 2, sessionToken: "token-1234567890" };
}

describe("07C 大厅销毁入口", () => {
  it("只有房主看到入口；点开确认后返回关闭且不发送", async () => {
    mounted = await mountDom(createElement(LobbyView, {
      room: room(), joined: joined("p2"), error: null, onReady: () => {}, onStart: () => {},
      onDestroyRoom: vi.fn(),
    }));
    expect(mounted.text()).not.toContain("销毁房间");

    await mounted.cleanup();
    const onDestroyRoom = vi.fn();
    mounted = await mountDom(createElement(LobbyView, {
      room: room(), joined: joined("p1"), error: null, onReady: () => {}, onStart: () => {},
      onDestroyRoom,
    }));
    await mounted.click("销毁房间及数据");
    expect(mounted.text()).toContain("销毁房间及数据？");
    expect(mounted.text()).toContain("房间内所有玩家会被移出，服务器上的存档将删除，无法恢复。");
    await mounted.click("返回");
    expect(mounted.text()).not.toContain("销毁房间及数据？");
    expect(onDestroyRoom).not.toHaveBeenCalled();
  });

  it("确认销毁调用回调", async () => {
    const onDestroyRoom = vi.fn(() => true);
    mounted = await mountDom(createElement(LobbyView, {
      room: room(), joined: joined("p1"), error: null, onReady: () => {}, onStart: () => {},
      onDestroyRoom,
    }));
    await mounted.click("销毁房间及数据");
    await mounted.click("确认销毁（不可恢复）");
    expect(onDestroyRoom).toHaveBeenCalledTimes(1);
    expect(mounted.text()).not.toContain("连接未就绪，销毁请求未发送");
  });

  it("S1 大厅确认发送失败时显示本地错误，不静默", async () => {
    const onDestroyRoom = vi.fn(() => false);
    mounted = await mountDom(createElement(LobbyView, {
      room: room(), joined: joined("p1"), error: null, onReady: () => {}, onStart: () => {},
      onDestroyRoom,
    }));
    await mounted.click("销毁房间及数据");
    await mounted.click("确认销毁（不可恢复）");
    expect(onDestroyRoom).toHaveBeenCalledTimes(1);
    expect(mounted.text()).toContain("连接未就绪，销毁请求未发送");
  });
});
