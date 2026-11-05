/**
 * 07A CSS 契约：jsdom 无布局引擎，360px 下“抽屉不横向滚动 / 长文本换行 / 关闭按钮 44×44”只能靠样式断言兜底。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

/** 返回该选择器所有声明的归一化内容（含基础规则与媒体查询覆盖）。 */
function blocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?:^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}", "gm");
  const matches = [...css.matchAll(pattern)];
  if (matches.length === 0) throw new Error("未找到样式规则：" + selector);
  return matches.map((match) => match[1]!.replace(/\s+/g, " ").trim());
}

function anyBlock(selector: string, ...needles: string[]): boolean {
  return blocks(selector).some((block) => needles.every((needle) => block.includes(needle)));
}

describe("07A 债务中心 360px CSS 契约", () => {
  it(".debt-drawer 不设固定最小宽度，宽度受视口约束并允许换行", () => {
    expect(
      anyBlock(".debt-drawer", "width: min(620px, 100%)", "min-width: 0", "overflow-x: hidden", "overflow-wrap: anywhere"),
    ).toBe(true);
    expect(css).not.toContain("min-width: 620px");
  });

  it(".debt-drawer 内的 player-table 不产生固定列宽溢出", () => {
    expect(anyBlock(".debt-drawer .player-row", "minmax(0, 1fr)")).toBe(true);
    expect(anyBlock(".debt-drawer .player-row", "min-width: 0")).toBe(true);
    expect(anyBlock(".debt-drawer .player-row > *", "overflow-wrap: anywhere")).toBe(true);
  });

  it("关闭按钮保持 44×44 触控区", () => {
    expect(anyBlock(".debt-close", "min-width: 44px", "min-height: 44px")).toBe(true);
  });

  it("债务行与请求文本均允许任意断行", () => {
    expect(anyBlock(".debt-row", "overflow-wrap: anywhere")).toBe(true);
    expect(anyBlock(".debt-request", "overflow-wrap: anywhere")).toBe(true);
  });
});
