import { useEffect, useRef, useState } from "react";
import { GameView } from "./GameView";
import { LobbyView } from "./LobbyView";
import { clearSession, loadSession, RichmanClient } from "./net/client";
import type { ClientHandlers, ConnectionStatus, StoredSession } from "./net/client";
import type { JoinedInfo, WireCommandResult, WireGameEvent, WireRoom, WireSnapshotView } from "./net/wire";
import { isSessionError, lobbyErrorText, serverErrorText } from "./net/wire";

interface ServerError {
  code: string;
  message: string;
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: "连接中…",
  open: "已连接",
  closed: "连接断开，自动重连中",
  replaced: "已被另一页面接管",
};

export default function App() {
  const [nickname, setNickname] = useState(() => loadSession()?.nickname ?? "");
  const [codeInput, setCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [room, setRoom] = useState<WireRoom | null>(null);
  const [joined, setJoined] = useState<JoinedInfo | null>(null);
  const [snapshot, setSnapshot] = useState<WireSnapshotView | null>(null);
  /** 服务端过滤后的本人可见事件；只给结算卡用，不做规则判定。 */
  const [events, setEvents] = useState<WireGameEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [result, setResult] = useState<WireCommandResult | null>(null);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [replaced, setReplaced] = useState(false);
  const [busy, setBusy] = useState(false);

  const clientRef = useRef<RichmanClient | null>(null);
  /** 主动退出/换房间期间忽略旧连接上的迟到错误。 */
  const leavingRef = useRef(false);

  /**
   * 替换或关闭旧连接：已加入时先发 leave，让服务端立即处理座位；
   * 随后 dispose，迟到消息由 leavingRef 忽略。
   */
  function stopClient(joinedNow: boolean): void {
    leavingRef.current = true;
    const client = clientRef.current;
    clientRef.current = null;
    if (client === null) return;
    if (joinedNow) client.sendLobby({ type: "leave" });
    client.dispose();
  }

  function startRoom(code: string, nick: string, stored: StoredSession | null): void {
    stopClient(joined !== null);
    leavingRef.current = false;
    setNickname(nick);
    setRoomCode(code);
    setRoom(null);
    setJoined(null);
    setSnapshot(null);
    setEvents([]);
    setResult(null);
    setServerError(null);
    setEntryError(null);
    setLobbyError(null);
    setStatus("connecting");
    setStatusDetail(null);
    setReplaced(false);

    const handlers: ClientHandlers = {
      onStatus: (next, detail) => {
        setStatus(next);
        setStatusDetail(detail ?? null);
        if (next === "replaced") setReplaced(true);
      },
      onJoined: (info) => {
        setJoined(info);
        setServerError(null);
      },
      onRoom: (nextRoom) => {
        setRoom(nextRoom);
      },
      onStarted: () => {
        // started 之后等 snapshot；服务端会在同一提交内推送到所有连接。
        setSnapshot(null);
        setEvents([]);
      },
      onSnapshot: (view) => {
        setSnapshot(view);
      },
      onEvents: (list) => {
        // 只保留当前对局最近的 300 条，结算卡最多回看一轮，超出无意义。
        setEvents((current) => [...current, ...list].slice(-300));
      },
      onCommandResult: (nextResult) => {
        if (nextResult.outcome.ok) setServerError(null);
        setResult(nextResult);
      },
      onServerError: (error) => {
        if (leavingRef.current) return;
        setServerError({ code: error.code, message: error.message });
        setLobbyError(
          isSessionError(error.code) && !(clientRef.current?.hasJoined ?? false)
            ? error.code + "：" + serverErrorText(error.code, error.message)
            : lobbyErrorText(error.code, error.message),
        );
        if (error.code === "REPLACED") {
          setReplaced(true);
          return;
        }
        // 还没有 joined 就失败（加入/恢复被拒）：清掉本地会话，回到入口。
        if (!(clientRef.current?.hasJoined ?? false)) {
          clearSession();
          clientRef.current?.dispose();
          clientRef.current = null;
          setRoomCode(null);
          setRoom(null);
          setJoined(null);
          setSnapshot(null);
          setStatus("closed");
          setStatusDetail(null);
        }
      },
    };

    const client = new RichmanClient(code, nick, handlers, stored);
    clientRef.current = client;
    client.connect();
  }

  useEffect(() => {
    const stored = loadSession();
    if (stored !== null) startRoom(stored.roomCode, stored.nickname, stored);
    return () => {
      clientRef.current?.dispose();
      clientRef.current = null;
    };
    // 只在首次挂载时恢复会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(): Promise<void> {
    const nick = nickname.trim();
    if (nick === "") {
      setEntryError("请先输入昵称");
      return;
    }
    if (busy) return;
    setBusy(true);
    setEntryError(null);
    setLobbyError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: nick }),
      });
      const data = (await response.json()) as { ok?: unknown; roomCode?: unknown };
      if (!response.ok || data.ok !== true || typeof data.roomCode !== "string") {
        setEntryError("建房失败（HTTP " + String(response.status) + "）");
        return;
      }
      clearSession();
      startRoom(data.roomCode, nick, null);
    } catch {
      setEntryError("无法连接服务器，请确认服务已启动");
    } finally {
      setBusy(false);
    }
  }

  function handleJoin(): void {
    const nick = nickname.trim();
    if (nick === "") {
      setEntryError("请先输入昵称");
      return;
    }
    const code = codeInput.trim();
    if (!/^[0-9]{4,8}$/.test(code)) {
      setEntryError("房间码必须是 4～8 位数字");
      return;
    }
    const stored = loadSession();
    const sameRoom = stored !== null && stored.roomCode === code ? stored : null;
    if (sameRoom === null) clearSession();
    startRoom(code, nick, sameRoom);
  }

  function handleReady(ready: boolean): void {
    setLobbyError(null);
    clientRef.current?.sendLobby({ type: "ready", ready });
  }

  function handleStart(): void {
    setLobbyError(null);
    clientRef.current?.sendLobby({ type: "start" });
  }

  function backToLobby(): void {
    // 先判断是否在对局中：大厅退出撤销座位与会话，对局中退出保留 token 以便恢复。
    const inGame = !replaced && (snapshot !== null || room?.state === "PLAYING");
    stopClient(joined !== null);
    if (inGame) {
      setEntryError("已离开对局，座位仍为你保留；可输入原房间码恢复原座位。");
    } else {
      clearSession();
      setEntryError(null);
    }
    setRoomCode(null);
    setRoom(null);
    setJoined(null);
    setSnapshot(null);
    setEvents([]);
    setResult(null);
    setServerError(null);
    setReplaced(false);
    setStatus("closed");
    setStatusDetail(null);
    setLobbyError(null);
  }

  const statusText = status === "replaced" ? STATUS_LABELS.replaced : STATUS_LABELS[status];

  return (
    <div className="app">
      {replaced ? (
        <section className="panel replaced">
          <h1>已在另一页面恢复</h1>
          <p>这个座位已由另一个页面接管；当前页面已停止自动重连，避免两边同时操作。</p>
          <button type="button" className="primary" onClick={backToLobby}>
            返回大厅
          </button>
        </section>
      ) : snapshot !== null && roomCode !== null ? (
        <GameView
          roomCode={roomCode}
          view={snapshot}
          client={clientRef.current!}
          status={status}
          statusDetail={statusDetail}
          result={result}
          error={serverError}
          events={events}
        />
      ) : roomCode !== null && room !== null ? (
        <LobbyView room={room} joined={joined} error={lobbyError} onReady={handleReady} onStart={handleStart} />
      ) : roomCode !== null ? (
        <section className="panel">
          <h1>正在进入房间 {roomCode}</h1>
          <p className="hint">{statusDetail ?? "正在连接服务端…"}</p>
          {lobbyError !== null ? <p className="reason">{lobbyError}</p> : null}
          <button type="button" className="primary" onClick={backToLobby}>
            返回大厅
          </button>
        </section>
      ) : (
        <section className="panel entry">
          <h1>RichMan 联机大厅</h1>
          <p className="hint">两台设备打开同一地址，一台建房，另一台输入房间码加入。</p>
          <label className="field">
            <span>昵称</span>
            <input
              className="input"
              maxLength={20}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="1～20 个字符"
            />
          </label>
          <div className="row">
            <button type="button" className="primary" onClick={() => void handleCreate()} disabled={busy}>
              建房
            </button>
          </div>
          <div className="divider" />
          <label className="field">
            <span>房间码</span>
            <input
              className="input"
              inputMode="numeric"
              maxLength={8}
              value={codeInput}
              onChange={(event) => setCodeInput(event.target.value.trim())}
              placeholder="4～8 位数字"
            />
          </label>
          <div className="row">
            <button type="button" className="primary" onClick={handleJoin}>
              加入
            </button>
          </div>
          {entryError !== null ? <p className="reason">{entryError}</p> : null}
          {lobbyError !== null ? <p className="reason">{lobbyError}</p> : null}
        </section>
      )}

      <footer className="footer">
        <span className={"dot " + status}>{statusText}</span>
        {statusDetail !== null && status !== "replaced" ? <span>{statusDetail}</span> : null}
        {roomCode !== null && !replaced ? (
          <button type="button" className="link" onClick={backToLobby}>
            退出房间
          </button>
        ) : null}
      </footer>
    </div>
  );
}
