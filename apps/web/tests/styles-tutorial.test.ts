/**
 * 08A CSS 契约：jsdom 没有布局引擎，覆盖层固定/层级/44px 触控区/360px 不横向滚动只能读 CSS 兜底。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

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

describe("08A 教程/规则页 CSS 契约", () => {
  it(".tutorial-overlay 固定覆盖且 z-index 高于 sticky 的 6", () => {
    const overlay = blocks(".tutorial-overlay").find((block) => block.includes("position: fixed"));
    expect(overlay).toBeDefined();
    const zIndex = Number(overlay!.match(/z-index:\s*(\d+)/)?.[1]);
    expect(zIndex).toBeGreaterThan(6);
  });

  it("面板限高并内部滚动，360px 不设固定最小宽度", () => {
    expect(anyBlock(".tutorial-panel", "max-height: 100dvh", "min-width: 0", "max-width: 100%")).toBe(true);
    expect(anyBlock(".tutorial-body", "overflow-y: auto", "overflow-x: hidden")).toBe(true);
    expect(anyBlock(".rules-sheet", "max-height: 100dvh", "overflow-y: auto", "min-width: 0")).toBe(true);
  });

  it("翻页/关闭按钮 ≥44px，正文 15–16px、行高 1.6、长文本断行", () => {
    expect(anyBlock(".tutorial-actions button", "min-width: 44px", "min-height: 44px")).toBe(true);
    expect(anyBlock(".tutorial-head-btn", "min-width: 44px", "min-height: 44px")).toBe(true);
    expect(anyBlock(".rules-close", "min-width: 44px", "min-height: 44px")).toBe(true);
    expect(anyBlock(".tutorial-body", "font-size: 16px", "line-height: 1.6", "overflow-wrap: anywhere")).toBe(true);
    expect(anyBlock(".rules-sheet", "font-size: 15px", "line-height: 1.6", "overflow-wrap: anywhere")).toBe(true);
  });

  it("360px 媒体查询让面板占满宽度且操作区单列，不产生横向溢出", () => {
    const media = [...css.matchAll(/@media\s*\(max-width:\s*560px\)\s*\{([\s\S]*?)\n\}/g)]
      .map((match) => match[1]!)
      .find((block) => block.includes(".tutorial-panel"));
    expect(media).toBeDefined();
    expect(media).toContain("width: 100%");
    expect(media).toContain(".tutorial-actions");
    expect(media).toContain("grid-template-columns: 1fr");
  });
});
