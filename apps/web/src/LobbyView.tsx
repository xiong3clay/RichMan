import { useState } from "react";
import type { JoinedInfo, WireRoom } from "./net/wire";

export interface LobbyViewProps {
  room: WireRoom;
  joined: JoinedInfo | null;
  error: string | null;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  /** 07C：仅房主可见；由 App 转发 client.destroyRoom；false 表示本地发送失败。 */
  onDestroyRoom?: () => boolean;
  /** 08A：新手教程/规则说明入口；旧调用方不传时保持原样。 */
  onOpenTutorial?: () => void;
  onOpenRules?: () => void;
}

const ROOM_STATE_LABELS: Record<WireRoom["state"], string> = {
  LOBBY: "等待开始",
  PLAYING: "对局进行中",
  PAUSED: "已暂停",
  ERROR_PAUSED: "异常暂停",
  ENDED: "已结束",
};

export function LobbyView({ room, joined, error, onReady, onStart, onDestroyRoom, onOpenTutorial, onOpenRules }: LobbyViewProps) {
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);
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
      {onOpenTutorial !== undefined || onOpenRules !== undefined ? (
        <div className="row lobby-links">
          {onOpenTutorial !== undefined ? (
            <button type="button" className="link" onClick={onOpenTutorial}>新手教程</button>
          ) : null}
          {onOpenRules !== undefined ? (
            <button type="button" className="link" onClick={onOpenRules}>规则说明</button>
          ) : null}
        </div>
      ) : null}
      {startReason !== null ? <p className="reason">{startReason}</p> : null}
      {isHost ? (
        confirmDestroy ? (
          <div className="destroy-confirm">
            <p className="question">销毁房间及数据？</p>
            <p className="step-hint danger-text">
              房间内所有玩家会被移出，服务器上的存档将删除，无法恢复。
            </p>
            <div className="choice-grid">
              <button
                type="button"
                className="choice danger"
                onClick={() => {
                  const sent = onDestroyRoom?.() ?? false;
                  setDestroyError(sent ? null : "连接未就绪，销毁请求未发送");
                }}
              >
                确认销毁（不可恢复）
              </button>
              <button
                type="button"
                className="choice ghost"
                onClick={() => {
                  setConfirmDestroy(false);
                  setDestroyError(null);
                }}
              >
                返回
              </button>
            </div>
            {destroyError !== null ? <p className="reason" role="alert">{destroyError}</p> : null}
          </div>
        ) : (
          <button
            type="button"
            className="link destroy-room-entry"
            onClick={() => {
              setDestroyError(null);
              setConfirmDestroy(true);
            }}
          >
            销毁房间及数据
          </button>
        )
      ) : null}
      {room.state === "PLAYING" ? <p className="hint">对局已开始，正在等待服务端快照…</p> : null}
      {joined === null ? <p className="hint">正在分配座位…</p> : null}
    </section>
  );
}
