/**
 * 07C 复核修复2 S-E：把 App 里“销毁房间”相关的真实回调抽成可测纯函数，
 * App 只负责把 reset 结果写进 React state；测试不再用 mock onDestroyRoom 冒充 App。
 */
import type { RichmanClient } from "./net/client";

export interface RoomDestroyedInfo {
  roomCode: string;
  byPlayerId: string;
}

export interface RoomDestroyedReset {
  roomCode: null;
  room: null;
  joined: null;
  snapshot: null;
  events: never[];
  result: null;
  serverError: null;
  lobbyError: null;
  replaced: false;
  status: "closed";
  statusDetail: null;
  entryError: string;
}

/** byPlayerId 为空 = 已加入后收到 ROOM_NOT_FOUND 的兜底；非空 = 房主销毁广播。 */
export function roomDestroyedReset(byPlayerId: string): RoomDestroyedReset {
  return {
    roomCode: null,
    room: null,
    joined: null,
    snapshot: null,
    events: [],
    result: null,
    serverError: null,
    lobbyError: null,
    replaced: false,
    status: "closed",
    statusDetail: null,
    entryError: byPlayerId === ""
      ? "房间已不存在或已被销毁，已回到首页"
      : "房主已销毁房间，所有数据已删除",
  };
}

export interface RoomDestroyedDeps {
  markLeaving(): void;
  clearSession(): void;
  disposeClient(): void;
  apply(reset: RoomDestroyedReset): void;
}

/** App handlers.onRoomDestroyed 的真实实现：先停连接，再把 reset 交给 React。 */
export function createRoomDestroyedHandler(
  deps: RoomDestroyedDeps,
): (info: RoomDestroyedInfo) => void {
  return (info) => {
    deps.markLeaving();
    deps.clearSession();
    deps.disposeClient();
    deps.apply(roomDestroyedReset(info.byPlayerId));
  };
}

/** App 传给 GameView/LobbyView 的 onDestroyRoom：必须把 boolean 原样交给上层。 */
export function requestRoomDestroy(
  client: Pick<RichmanClient, "destroyRoom"> | null | undefined,
): boolean {
  return client?.destroyRoom() ?? false;
}
