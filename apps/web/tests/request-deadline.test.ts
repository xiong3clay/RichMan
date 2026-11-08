import { describe, expect, it } from "vitest";
import { INITIAL_UI_STATE, deriveStep } from "../src/game/steps.js";
import { isRequestExpired, requestDeadlineIso } from "../src/game/request-deadline.js";
import { requestFixture, viewFixture } from "./view-fixtures.js";

describe("10B T1 requestLender 笔数", () => {
  it("T1 两笔 incomingRequests 返回第一笔且 pendingCount=2，不改数组", () => {
    const view = viewFixture();
    const first = { ...requestFixture(), requestId: "req-a", borrowerId: "p2" };
    const second = { ...requestFixture(), requestId: "req-b", borrowerId: "p3" };
    view.finance.incomingRequests = [first, second];
    const step = deriveStep(view, INITIAL_UI_STATE);
    expect(step.kind).toBe("requestLender");
    if (step.kind === "requestLender") {
      expect(step.request.requestId).toBe("req-a");
      expect(step.pendingCount).toBe(2);
    }
    expect(view.finance.incomingRequests.map(request => request.borrowerId)).toEqual(["p2", "p3"]);
    expect(view.finance.incomingRequests).toHaveLength(2);
    expect(view.finance.incomingRequests[0]).toBe(first);
    expect(view.finance.incomingRequests[1]).toBe(second);
  });
});

describe("10B T2 requestDeadlineIso", () => {
  it("T2 有限毫秒转 ISO，NaN/Infinity/非数字返回 null", () => {
    expect(requestDeadlineIso(1)).toBe("1970-01-01T00:00:00.001Z");
    expect(requestDeadlineIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(requestDeadlineIso(Number.NaN)).toBeNull();
    expect(requestDeadlineIso(Number.POSITIVE_INFINITY)).toBeNull();
    expect(requestDeadlineIso(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(requestDeadlineIso(null)).toBeNull();
    expect(requestDeadlineIso(undefined)).toBeNull();
    expect(requestDeadlineIso("60000")).toBeNull();
    expect(() => requestDeadlineIso(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(requestDeadlineIso(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("10B T3 isRequestExpired", () => {
  it("T3 截止前/恰好等于/之后按服务端校准时间判定，客户端偏差不改变结论", () => {
    const serverNow = "2030-01-01T00:00:00.000Z";
    const serverMs = Date.parse(serverNow);
    const receivedAtMs = 1000;
    const deadline = serverMs + 5000;
    expect(isRequestExpired(deadline, serverNow, receivedAtMs, receivedAtMs)).toBe(false);
    expect(isRequestExpired(deadline, serverNow, receivedAtMs, receivedAtMs + 4999)).toBe(false);
    expect(isRequestExpired(deadline, serverNow, receivedAtMs, receivedAtMs + 5000)).toBe(true);
    expect(isRequestExpired(deadline, serverNow, receivedAtMs, receivedAtMs + 6000)).toBe(true);
    expect(isRequestExpired(serverMs - 1, serverNow, receivedAtMs, receivedAtMs)).toBe(true);
  });

  it("T3b 非法 deadline/serverNow/receivedAtMs 不抛错且返回 false", () => {
    const serverNow = "2026-11-04T00:00:00.000Z";
    expect(isRequestExpired(null, serverNow, 1000, 1000)).toBe(false);
    expect(isRequestExpired(Number.NaN, serverNow, 1000, 1000)).toBe(false);
    expect(isRequestExpired(Number.POSITIVE_INFINITY, serverNow, 1000, 1000)).toBe(false);
    expect(isRequestExpired(Date.parse(serverNow) + 5000, "not-a-date", 1000, 1000)).toBe(false);
    expect(isRequestExpired(Date.parse(serverNow) + 5000, serverNow, Number.NaN, 1000)).toBe(false);
  });
});
