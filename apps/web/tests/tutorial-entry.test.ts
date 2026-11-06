import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import { LobbyView } from "../src/LobbyView";
import type { RichmanClient } from "../src/net/client";
import type { JoinedInfo, WireRoom, WireSnapshotView } from "../src/net/wire";
import { mountDom } from "./dom-harness";
import { viewFixture } from "./view-fixtures";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

const joined: JoinedInfo = { roomCode: "0042", playerId: "p1", seatId: 1, sessionToken: "token" };
const room: WireRoom = {
  type: "room",
  state: "LOBBY",
  hostId: "p1",
  paused: false,
  players: [
    { playerId: "p1", nickname: "甲", seatId: 1, ready: false, online: true },
    { playerId: "p2", nickname: "乙", seatId: 2, ready: false, online: true },
  ],
};

function lobby(onOpenTutorial?: () => void, onOpenRules?: () => void) {
  return createElement(LobbyView, {
    room,
    joined,
    error: null,
    onReady: vi.fn(),
    onStart: vi.fn(),
    ...(onOpenTutorial === undefined ? {} : { onOpenTutorial }),
    ...(onOpenRules === undefined ? {} : { onOpenRules }),
  });
}

function fakeClient() {
  return {
    hasJoined: true,
    sendLobby: vi.fn(),
    submitBet: vi.fn(),
    endAction: vi.fn(),
    borrowBank: vi.fn(),
  };
}

function gameProps(client: ReturnType<typeof fakeClient>, view: WireSnapshotView, onOpenTutorial: () => void, onOpenRules: () => void): GameViewProps {
  return {
    roomCode: "0042",
    hostId: null,
    view,
    status: "open",
    statusDetail: null,
    result: null,
    error: null,
    events: [],
    client: client as unknown as RichmanClient,
    onOpenTutorial,
    onOpenRules,
  };
}

describe("08A 入口与危险自救文案", () => {
  it("T9 LobbyView 传入口 props 时出现两个链接并各调用一次", async () => {
    const onOpenTutorial = vi.fn();
    const onOpenRules = vi.fn();
    mounted = await mountDom(lobby(onOpenTutorial, onOpenRules));
    expect(mounted.text()).toContain("新手教程");
    expect(mounted.text()).toContain("规则说明");
    await mounted.click("新手教程");
    await mounted.click("规则说明");
    expect(onOpenTutorial).toHaveBeenCalledTimes(1);
    expect(onOpenRules).toHaveBeenCalledTimes(1);
  });

  it("T9 LobbyView 不传入口 props 时不渲染入口", async () => {
    mounted = await mountDom(lobby());
    const labels = mounted.container.querySelectorAll("button").map((button) => button.textContent);
    expect(labels.filter((label) => label === "新手教程")).toHaveLength(0);
    expect(labels.filter((label) => label === "规则说明")).toHaveLength(0);
  });

  it("T10 对局内入口调用回调且不发送任何命令", async () => {
    const client = fakeClient();
    const onOpenTutorial = vi.fn();
    const onOpenRules = vi.fn();
    mounted = await mountDom(createElement(GameView, gameProps(client, viewFixture(), onOpenTutorial, onOpenRules)));
    expect(mounted.text()).toContain("教程与规则");
    expect(mounted.text()).toContain("规则说明");
    await mounted.click("教程与规则");
    await mounted.click("规则说明");
    expect(onOpenTutorial).toHaveBeenCalledTimes(1);
    expect(onOpenRules).toHaveBeenCalledTimes(1);
    expect(client.sendLobby).toHaveBeenCalledTimes(0);
    expect(client.submitBet).toHaveBeenCalledTimes(0);
    expect(client.endAction).toHaveBeenCalledTimes(0);
    expect(client.borrowBank).toHaveBeenCalledTimes(0);
    expect(mounted.text()).toContain("是否向其他玩家借款？");
  });

  it("T15 危险自救卡不再显示可借银行，改为自救期间不能新借银行贷款", async () => {
    const client = fakeClient();
    const view = viewFixture();
    view.phase = "TAX";
    view.round = 3;
    view.me.status = "DANGER";
    view.me.cents = "-500";
    view.finance.cents = "-500";
    view.finance.receivableCents = "3000";
    view.finance.bankBorrowLimitCents = "0";
    view.finance.lenderLimits = [{ playerId: "p2", maxCents: "10000" }];
    view.deadlineAt = "2026-11-04T00:00:45.000Z";
    mounted = await mountDom(createElement(GameView, gameProps(client, view, vi.fn(), vi.fn())));
    expect(mounted.text()).toContain("自救期间不能新借银行贷款");
    expect(mounted.text()).not.toContain("可借银行");
    expect(mounted.text()).toContain("可向他人借");
    expect(mounted.text()).toContain("紧急借款");
  });
});
