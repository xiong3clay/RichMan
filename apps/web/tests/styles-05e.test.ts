/**
 * 05E 复核 should-fix 2：jsdom 没有布局引擎，05E 的“吸顶/上限/触控/换行”只能靠 CSS 契约测试兜底。
 * 删掉 position:sticky、max-height:45vh、44px 触控区或 overflow-wrap 时，这些用例必须失败。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

/** 返回该选择器最后一段声明的归一化内容（后者覆盖前者）。 */
function lastBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?:^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}", "gm");
  const matches = [...css.matchAll(pattern)];
  const last = matches.at(-1);
  if (last === undefined) throw new Error("未找到样式规则：" + selector);
  return last[1]!.replace(/\s+/g, " ").trim();
}

describe("05E 吸顶与触控的 CSS 契约", () => {
  it(".game-sticky 负责吸顶并限制总高，不会无限增高盖住操作卡", () => {
    const rule = lastBlock(".game-sticky");
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
    expect(rule).toContain("max-height: 45vh");
    expect(rule).toContain("overflow-y: auto");
  });

  it(".game-top 不再自身吸顶，避免双层 sticky 错位", () => {
    const rule = lastBlock(".game-top");
    expect(rule).toContain("flex: none");
    expect(rule).not.toContain("position: sticky");
  });

  it(".notice-shelf 限高并内部滚动，最多 4 条不会撑破吸顶区", () => {
    const rule = lastBlock(".notice-shelf");
    expect(rule).toContain("max-height: 32vh");
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("min-height: 0");
  });

  it("关闭按钮保持 44×44 触控区，长文案可断行且不撑出横向滚动", () => {
    expect(lastBlock(".banner .link")).toContain("min-width: 44px");
    expect(lastBlock(".banner .link")).toContain("min-height: 44px");
    const text = lastBlock(".banner > span");
    expect(text).toContain("overflow-wrap: anywhere");
    expect(text).toContain("min-width: 0");
  });
});
