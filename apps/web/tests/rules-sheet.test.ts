import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesSheet } from "../src/tutorial/RulesSheet";
import { RULE_SECTIONS } from "../src/tutorial/rules";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

describe("08A 规则页", () => {
  it("T8 按顺序渲染 8 节标题", async () => {
    mounted = await mountDom(createElement(RulesSheet, { onClose: vi.fn() }));
    expect(mounted.container.querySelectorAll(".rules-section")).toHaveLength(8);
    for (const section of RULE_SECTIONS) {
      expect(mounted.text()).toContain(section.title);
    }
    expect(mounted.text()).toContain("自救期间不能新借银行贷款");
    expect(mounted.text()).toContain("开奖前看不到别人的金额");
  });

  it("T8 点击关闭规则调用 onClose", async () => {
    const onClose = vi.fn();
    mounted = await mountDom(createElement(RulesSheet, { onClose }));
    await mounted.click("关闭规则");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("可注入自定义规则节", async () => {
    mounted = await mountDom(createElement(RulesSheet, {
      sections: [{ id: "only", title: "只有一节", paragraphs: ["正文"], bullets: ["要点"] }],
      onClose: vi.fn(),
    }));
    expect(mounted.container.querySelectorAll(".rules-section")).toHaveLength(1);
    expect(mounted.text()).toContain("只有一节");
  });
});
