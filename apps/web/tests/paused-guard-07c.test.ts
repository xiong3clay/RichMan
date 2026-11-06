/**
 * 07C 第三轮 S-A：send 的 paused 守卫直接测试 + 源码契约。
 * UI 层确认卡在 paused 时由 showConfirmation 让位，因此不伪造不可达点击用例；
 * 用纯函数 + 读源码断言锁住“守卫调用存在、文案只有一处”。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAUSED_SUBMIT_NOTICE, pausedSubmitNotice } from "../src/game/paused-guard.js";

const gameViewSource = readFileSync(
  fileURLToPath(new URL("../src/GameView.tsx", import.meta.url)),
  "utf8",
);

describe("07C S-A 暂停提交守卫", () => {
  it("paused=true 返回逐字中文提示", () => {
    expect(PAUSED_SUBMIT_NOTICE).toBe("房间已暂停，继续后才能提交；本次未发送");
    expect(pausedSubmitNotice(true)).toBe(PAUSED_SUBMIT_NOTICE);
  });

  it("paused=false 返回 null", () => {
    expect(pausedSubmitNotice(false)).toBeNull();
  });

  it("GameView 源码契约：调用守卫 + setNotice(notice) + return null，且不复制文案", () => {
    expect(gameViewSource).toContain("pausedSubmitNotice(");
    expect(gameViewSource).toContain("setNotice(pausedNotice)");
    expect(gameViewSource).toContain("return null");
    // 文案必须只保留在 paused-guard.ts；GameView 不得再出现原字符串。
    expect(gameViewSource).not.toContain("房间已暂停，继续后才能提交");
  });
});
