import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { ClientLobbyMessageSchema, SERVER_DEFAULTS } from "@richman/shared";
import type { LobbyErrorCode, ServerLobbyMessage } from "@richman/shared";
import { LobbyError } from "./rooms/manager.js";
import type { RoomManager, RoomManagerEvent } from "./rooms/manager.js";

const WS_PATH = "/ws";

interface Connection {
  ws: WebSocket;
  id: number;
  roomCode: string | null;
  token: string | null;
  /** 连接 URL 上的 ?room= 房间码，join 时使用；token 不通过 URL 传递。 */
  roomCodeQuery: string | null;
  /** 已被同 token 的新连接替换：不再处理消息，close 也不得把玩家标离线。 */
  replaced: boolean;
}

export interface LobbyWsRuntime {
  connections: () => number;
  close: () => Promise<void>;
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function send(conn: Connection, message: ServerLobbyMessage): void {
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(message));
  }
}

function sendError(conn: Connection, code: LobbyErrorCode, message: string): void {
  send(conn, { type: "error", code, message });
}

/**
 * 把大厅 WebSocket 挂到既有 HTTP 服务器上。
 * 只处理 /ws 升级；每个房间一个简单 Promise 队列，保证同房间消息串行。
 */
export function attachLobbyWebSocket(server: Server, manager: RoomManager): LobbyWsRuntime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: SERVER_DEFAULTS.maxMessageBytes });
  const connections = new Map<WebSocket, Connection>();
  const tokenOwners = new Map<string, WebSocket>();
  const queues = new Map<string, Promise<void>>();
  let nextConnectionId = 1;

  const queueKey = (conn: Connection): string =>
    conn.roomCode ?? conn.roomCodeQuery ?? "connection-" + String(conn.id);

  const enqueue = (key: string, task: () => void): void => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch(() => undefined);
    queues.set(key, next);
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  };

  const broadcast = (event: RoomManagerEvent): void => {
    for (const conn of connections.values()) {
      if (conn.token === null || conn.roomCode !== event.roomCode) continue;
      if (event.type === "room") {
        send(conn, {
          type: "room",
          players: event.room.players,
          hostId: event.room.hostId,
          state: event.room.state,
        });
      } else if (event.type === "started") {
        send(conn, { type: "started", gameId: event.gameId });
      } else {
        send(conn, { type: "peer_left", playerId: event.playerId });
      }
    }
  };

  const unsubscribe = manager.subscribe(broadcast);

  /** 用已有 token 加入时，把归属换到新连接并关闭旧连接；旧 close 不再标离线。 */
  const claimToken = (conn: Connection, token: string): void => {
    const previous = tokenOwners.get(token);
    if (previous !== undefined && previous !== conn.ws) {
      const previousConn = connections.get(previous);
      if (previousConn !== undefined) {
        previousConn.replaced = true;
        sendError(previousConn, "REPLACED", "这个座位已在另一个页面恢复");
      }
      previous.close();
    }
    tokenOwners.set(token, conn.ws);
  };

  const handleMessage = (conn: Connection, raw: string): void => {
    if (conn.replaced) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      sendError(conn, "INVALID_MESSAGE", "消息不是合法 JSON");
      return;
    }
    const parsed = ClientLobbyMessageSchema.safeParse(json);
    if (!parsed.success) {
      sendError(conn, "INVALID_MESSAGE", "消息格式不合法");
      return;
    }

    try {
      if (parsed.data.type === "join") {
        const roomCode = conn.roomCodeQuery;
        if (roomCode === null) {
          sendError(conn, "ROOM_NOT_FOUND", "连接缺少房间码");
          return;
        }
        const result = manager.join(roomCode, parsed.data.nickname, parsed.data.sessionToken ?? conn.token ?? undefined);
        claimToken(conn, result.sessionToken);
        conn.token = result.sessionToken;
        conn.roomCode = result.roomCode;
        send(conn, {
          type: "joined",
          playerId: result.playerId,
          seatId: result.seatId,
          sessionToken: result.sessionToken,
          roomCode: result.roomCode,
        });
        const room = manager.getRoom(result.roomCode);
        if (room !== null) {
          send(conn, { type: "room", players: room.players, hostId: room.hostId, state: room.state });
        }
        return;
      }

      if (conn.token === null) {
        sendError(conn, "NOT_JOINED", "请先加入房间");
        return;
      }
      if (parsed.data.type === "ready") {
        manager.setReady(conn.token, parsed.data.ready);
      } else if (parsed.data.type === "leave") {
        manager.leave(conn.token);
        conn.token = null;
        conn.roomCode = null;
      } else if (parsed.data.type === "start") {
        manager.start(conn.token);
      }
    } catch (error) {
      if (error instanceof LobbyError) {
        sendError(conn, error.code, error.message);
      } else {
        sendError(conn, "INVALID_MESSAGE", "请求无法处理");
      }
    }
  };

  const initConnection = (ws: WebSocket, roomCodeQuery: string | null): void => {
    const conn: Connection = {
      ws,
      id: nextConnectionId,
      roomCode: null,
      token: null,
      roomCodeQuery,
      replaced: false,
    };
    nextConnectionId += 1;
    connections.set(ws, conn);

    ws.on("message", (data) => {
      const raw = rawToString(data);
      enqueue(queueKey(conn), () => handleMessage(conn, raw));
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      connections.delete(ws);
      if (conn.token === null) return;
      // 只有当前 owner 断开才把玩家标离线；被替换的旧连接只清理连接表。
      if (tokenOwners.get(conn.token) !== ws) return;
      tokenOwners.delete(conn.token);
      try {
        manager.disconnect(conn.token);
      } catch {
        // 房间已删除时忽略。
      }
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const roomCodeQuery = url.searchParams.get("room");
    wss.handleUpgrade(req, socket, head, (ws) => {
      initConnection(ws, roomCodeQuery);
    });
  };

  server.on("upgrade", onUpgrade);

  return {
    connections: () => wss.clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        server.off("upgrade", onUpgrade);
        unsubscribe();
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
