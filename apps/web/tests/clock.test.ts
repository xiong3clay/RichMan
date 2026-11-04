import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Countdown } from "../src/Countdown.js";
import { calibrateServerClock, countdownText } from "../src/game/clock.js";

const SERVER_NOW = "2026-11-04T12:00:00.000Z";
const DEADLINE = "2026-11-04T12:01:00.000Z";

describe("M7/T8 服务端倒计时校时", () => {
  it("客户端慢五分钟时使用正 offset，经过20秒只剩40秒", () => {
    const clock = calibrateServerClock(null, SERVER_NOW, Date.parse("2026-11-04T11:55:00.000Z"));
    expect(countdownText(DEADLINE, clock, Date.parse("2026-11-04T11:55:20.000Z"))).toBe("0:40");
  });

  it("客户端快七分钟时使用负 offset，经过25秒只剩35秒", () => {
    const clock = calibrateServerClock(null, SERVER_NOW, Date.parse("2026-11-04T12:07:00.000Z"));
    expect(countdownText(DEADLINE, clock, Date.parse("2026-11-04T12:07:25.000Z"))).toBe("0:35");
  });

  it("重复 serverNow 不重新校时，不因重复快照或重渲染延长截止", () => {
    const clock = calibrateServerClock(null, SERVER_NOW, Date.parse("2026-11-04T12:04:00.000Z"));
    const repeated = calibrateServerClock(clock, SERVER_NOW, Date.parse("2026-11-04T12:04:30.000Z"));
    expect(countdownText(DEADLINE, repeated, Date.parse("2026-11-04T12:04:30.000Z"))).toBe("0:30");
  });

  it("新 serverNow 重新校准设备时钟偏移，保留服务端截止时间", () => {
    const clock = calibrateServerClock(null, SERVER_NOW, Date.parse("2026-11-04T12:04:00.000Z"));
    const updated = calibrateServerClock(
      clock,
      "2026-11-04T12:00:20.000Z",
      Date.parse("2026-11-04T12:02:20.000Z"),
    );
    expect(countdownText(DEADLINE, updated, Date.parse("2026-11-04T12:02:30.000Z"))).toBe("0:30");
  });

  it("没有截止时间显示横线，到期后归零", () => {
    const clock = calibrateServerClock(null, SERVER_NOW, Date.parse(SERVER_NOW));
    expect(countdownText(null, clock, Date.parse(SERVER_NOW))).toBe("—");
    expect(countdownText(DEADLINE, clock, Date.parse("2026-11-04T12:01:01.000Z"))).toBe("0:00");
  });

  it("组件在无 window 的 SSR 中直接显示服务端校时后的剩余时间", () => {
    const markup = renderToStaticMarkup(
      createElement(Countdown, { deadlineAt: DEADLINE, serverNow: SERVER_NOW }),
    );
    expect(markup).toContain(">1:00</span>");
  });
});
