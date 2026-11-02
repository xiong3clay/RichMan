import type { JoinedInfo, WireRoom } from "./net/wire";

export interface LobbyViewProps {
  room: WireRoom;
  joined: JoinedInfo | null;
  error: string | null;
  onReady: (ready: boolean) => void;
  onStart: () => void;
}

const ROOM_STATE_LABELS: Record<WireRoom["state"], string> = {
  LOBBY: "等待开始",
  PLAYING: "对局进行中",
  PAUSED: "已暂停",
  ERROR_PAUSED: "异常暂停",
  ENDED: "已结束",
};

export function LobbyView({ room, joined, error, onReady, onStart }: LobbyViewProps) {
  const me = joined === null ? undefined : room.players.find((player) => player.playerId === joined.playerId);
  const isHost = joined !== null && room.hostId === joined.playerId;
  const allReady = room.players.length > 0 && room.players.every((player) => player.ready);
  const inLobby = room.state === "LOBBY";

  let startReason: string | null = null;
  if (!isHost) startReason = "只有房主可以开始游戏";
  else if (room.players.length < 2) startReason = "至少需要 2 名玩家";
  else if (!allReady) startReason = "还有玩家未准备";

  return (
    <section className="panel lobby">
      <header className="lobby-head">
        <div>
          <p className="eyebrow">房间码</p>
          <h1 className="room-code">{joined === null ? "—" : joined.roomCode}</h1>
        </div>
        <div className="room-state">
          <span className={"badge " + (inLobby ? "badge-wait" : "badge-play")}>
            {ROOM_STATE_LABELS[room.state]}
          </span>
        </div>
      </header>

      {error !== null ? <div className="banner fail">{error}</div> : null}

      <div className="player-table">
        <div className="player-row player-head">
          <span>座位</span>
          <span>昵称</span>
          <span>准备</span>
          <span>在线</span>
        </div>
        {room.players.map((player) => (
          <div className="player-row" key={player.playerId}>
            <span>#{player.seatId}</span>
            <span>
              {player.nickname}
              {player.playerId === room.hostId ? <span className="tag">房主</span> : null}
              {joined !== null && player.playerId === joined.playerId ? <span className="tag me">我</span> : null}
            </span>
            <span>{player.ready ? "已准备" : "未准备"}</span>
            <span className={player.online ? "online" : "offline"}>{player.online ? "在线" : "离线"}</span>
          </div>
        ))}
      </div>

      <div className="lobby-actions">
        <button
          type="button"
          className="primary"
          disabled={!inLobby || me === undefined}
          onClick={() => onReady(!(me?.ready ?? false))}
        >
          {me?.ready === true ? "取消准备" : "准备"}
        </button>
        <button type="button" className="primary" disabled={!inLobby || startReason !== null} onClick={onStart}>
          开始游戏
        </button>
      </div>
      {startReason !== null ? <p className="reason">{startReason}</p> : null}
      {room.state === "PLAYING" ? <p className="hint">对局已开始，正在等待服务端快照…</p> : null}
      {joined === null ? <p className="hint">正在分配座位…</p> : null}
    </section>
  );
}
