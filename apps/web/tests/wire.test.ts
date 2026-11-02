import { describe, expect, it } from "vitest";
import {
  isCanonicalCents,
  isNonNegativeCents,
  isPositiveCents,
  serverErrorText,
} from "../src/net/wire.js";

describe("M4 前端金额上限", () => {
  it("合法金额：0 与 10^12 分边界可接受", () => {
    expect(isCanonicalCents("0")).toBe(true);
    expect(isCanonicalCents("100")).toBe(true);
    expect(isCanonicalCents("1000000000000")).toBe(true);
    expect(isCanonicalCents("-1000000000000")).toBe(true);
  });

  it("超上限、-0、前导零与小数都被拒绝", () => {
    expect(isCanonicalCents("1000000000001")).toBe(false);
    expect(isCanonicalCents("-1000000000001")).toBe(false);
    expect(isCanonicalCents("1000000000000000")).toBe(false);
    expect(isCanonicalCents("-0")).toBe(false);
    expect(isCanonicalCents("01")).toBe(false);
    expect(isCanonicalCents("1.5")).toBe(false);
    expect(isCanonicalCents("")).toBe(false);
    expect(isCanonicalCents("+1")).toBe(false);
  });

  it("借还要求大于 0，下注允许 0 但不允许负数", () => {
    expect(isPositiveCents("100")).toBe(true);
    expect(isPositiveCents("0")).toBe(false);
    expect(isPositiveCents("-100")).toBe(false);
    expect(isPositiveCents("1000000000001")).toBe(false);
    expect(isNonNegativeCents("0")).toBe(true);
    expect(isNonNegativeCents("-100")).toBe(false);
  });
});

describe("M2 会话失效提示", () => {
  it("ROOM_NOT_FOUND 明确说明服务重启会丢内存房间", () => {
    expect(serverErrorText("ROOM_NOT_FOUND", "房间码不存在")).toContain("服务重启会丢内存房间");
  });

  it("UNAUTHORIZED 带上服务端原始 message", () => {
    expect(serverErrorText("UNAUTHORIZED", "身份凭证与房间不匹配"))
      .toContain("身份凭证与房间不匹配");
  });
});
