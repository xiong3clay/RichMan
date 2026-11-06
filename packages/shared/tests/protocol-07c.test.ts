import { describe, expect, it } from "vitest";
import {
  ClientLobbyMessageSchema,
  PROTOCOL_VERSION,
  RoomDestroyedMessageSchema,
  ServerLobbyMessageSchema,
} from "../src/protocol.js";

describe("07C 销毁房间协议", () => {
  it("P1 destroy_room 通过 ClientLobbyMessageSchema 且 strict", () => {
    expect(ClientLobbyMessageSchema.parse({ type: "destroy_room" })).toEqual({ type: "destroy_room" });
    expect(ClientLobbyMessageSchema.safeParse({ type: "destroy_room", gameId: "g1" }).success).toBe(false);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("P2 room_destroyed 通过 ServerLobbyMessageSchema 且 strict", () => {
    const message = { type: "room_destroyed", roomCode: "0042", byPlayerId: "p1" };
    expect(ServerLobbyMessageSchema.parse(message)).toEqual(message);
    expect(RoomDestroyedMessageSchema.safeParse({ ...message, players: [] }).success).toBe(false);
    expect(RoomDestroyedMessageSchema.safeParse({ ...message, roomCode: "42" }).success).toBe(false);
  });

  it("P3 未知消息仍被客户端与服务端 schema 拒绝", () => {
    expect(ClientLobbyMessageSchema.safeParse({ type: "destroy_world" }).success).toBe(false);
    expect(ServerLobbyMessageSchema.safeParse({ type: "room_destroyed_v2", roomCode: "0042" }).success).toBe(false);
  });
});
