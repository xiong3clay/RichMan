import { describe, expect, it, vi } from "vitest";
import { notifyAndCloseDestroyedPeers, selectDestroyPeers } from "../src/ws.js";

interface FakePeer {
  name: string;
  identity: { roomCode: string } | null;
  ws: { readyState: number; close: (code?: number, reason?: string) => void };
  closeMock: ReturnType<typeof vi.fn>;
}

function peer(name: string, roomCode: string | null, readyState = 1): FakePeer {
  const closeMock = vi.fn();
  return {
    name,
    identity: roomCode === null ? null : { roomCode },
    ws: { readyState, close: closeMock as unknown as (code?: number, reason?: string) => void },
    closeMock,
  };
}

describe("07C S5 销毁连接选择与逐 peer 清理", () => {
  it("只按 identity.roomCode + OPEN 选择，不要求 current", () => {
    const list = [
      peer("current-host", "0042"),
      peer("non-current-stale", "0042"),
      peer("other-room", "0043"),
      peer("no-identity", null),
      peer("closed", "0042", 3),
    ];
    expect(selectDestroyPeers<FakePeer>(list, "0042", 1).map((item) => item.name)).toEqual([
      "current-host",
      "non-current-stale",
    ]);
  });

  it("一个 send 抛错不影响后续 peer 的 detach 与 4002 关闭", () => {
    const a = peer("a", "0042");
    const b = peer("b", "0042");
    const order: string[] = [];
    const send = vi.fn((item: FakePeer) => {
      if (item.name === "a") throw new Error("send failed");
      order.push("send-" + item.name);
    });
    const detach = vi.fn((item: FakePeer) => { order.push("detach-" + item.name); });

    notifyAndCloseDestroyedPeers(
      [a, b],
      { type: "room_destroyed", roomCode: "0042", byPlayerId: "p1" },
      send,
      detach,
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(detach.mock.calls.map(([item]) => item.name)).toEqual(["a", "b"]);
    expect(a.closeMock).toHaveBeenCalledWith(4002, "ROOM_DESTROYED");
    expect(b.closeMock).toHaveBeenCalledWith(4002, "ROOM_DESTROYED");
    expect(order).toEqual(["detach-a", "send-b", "detach-b"]);
  });
});
