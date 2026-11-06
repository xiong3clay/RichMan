import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TutorialOverlay } from "../src/tutorial/TutorialOverlay";
import type { TutorialPage } from "../src/tutorial/pages";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

function button(dom: Awaited<ReturnType<typeof mountDom>>, text: string) {
  return dom.container.querySelectorAll("button").find((item) => item.textContent.includes(text));
}

describe("08A 教程覆盖层", () => {
  it("T5 第 1 页显示标题、页码、上一步禁用", async () => {
    mounted = await mountDom(createElement(TutorialOverlay, { onFinish: vi.fn() }));
    expect(mounted.text()).toContain("新手教程");
    expect(mounted.text()).toContain("第 1 / 5 页");
    expect(mounted.text()).toContain("一局怎么玩");
    expect(button(mounted, "上一步")?.disabled).toBe(true);
    expect(mounted.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("T6 下一步翻到第 2 页，末页按钮变为我知道了", async () => {
    mounted = await mountDom(createElement(TutorialOverlay, { onFinish: vi.fn() }));
    await mounted.click("下一步");
    expect(mounted.text()).toContain("第 2 / 5 页");
    expect(mounted.text()).toContain("银行借钱与失信");
    for (let index = 0; index < 3; index += 1) await mounted.click("下一步");
    expect(mounted.text()).toContain("第 5 / 5 页");
    expect(mounted.text()).toContain("查账与隐私");
    expect(mounted.text()).toContain("我知道了");
    expect(button(mounted, "下一步")).toBeUndefined();
  });

  it("T7 跳过教程只调用一次 onFinish", async () => {
    const onFinish = vi.fn();
    mounted = await mountDom(createElement(TutorialOverlay, { onFinish }));
    await mounted.click("跳过教程");
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("T7 末页我知道了只调用一次 onFinish", async () => {
    const onFinish = vi.fn();
    mounted = await mountDom(createElement(TutorialOverlay, { onFinish }));
    for (let index = 0; index < 4; index += 1) await mounted.click("下一步");
    await mounted.click("我知道了");
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("checklist 渲染为列表，自定义页数同步页码", async () => {
    const pages: TutorialPage[] = [
      { id: "one", title: "自定义教程", paragraphs: ["第一段"], checklist: ["条目一", "条目二"] },
      { id: "two", title: "第二页", paragraphs: ["第二段"] },
    ];
    mounted = await mountDom(createElement(TutorialOverlay, { pages, onFinish: vi.fn() }));
    expect(mounted.text()).toContain("第 1 / 2 页");
    expect(mounted.container.querySelectorAll(".tutorial-checklist li")).toHaveLength(2);
    expect(mounted.text()).toContain("条目一");
  });
});
