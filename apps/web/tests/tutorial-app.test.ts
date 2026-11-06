import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TUTORIAL_SEEN_KEY } from "../src/tutorial/storage";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
  };
}

function overlayCount(dom: Awaited<ReturnType<typeof mountDom>>): number {
  return dom.container.querySelectorAll(".tutorial-overlay").length;
}

describe("08A App 首次教程 gate", () => {
  it("T11/T12 未读首次自动打开，跳过后写 seen，重新挂载不再自动打开", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    mounted = await mountDom(createElement(App));
    expect(overlayCount(mounted)).toBe(1);
    expect(mounted.text()).toContain("第 1 / 5 页");

    await mounted.click("跳过教程");
    expect(overlayCount(mounted)).toBe(0);
    expect(storage.values.get(TUTORIAL_SEEN_KEY)).toBe("1");

    await mounted.cleanup();
    mounted = undefined;
    mounted = await mountDom(createElement(App));
    expect(overlayCount(mounted)).toBe(0);
  });

  it("T11 已读 storage 不自动打开；入口页可手动打开教程与规则", async () => {
    const storage = memoryStorage({ [TUTORIAL_SEEN_KEY]: "1" });
    vi.stubGlobal("localStorage", storage);
    mounted = await mountDom(createElement(App));
    expect(overlayCount(mounted)).toBe(0);

    await mounted.click("新手教程");
    expect(overlayCount(mounted)).toBe(1);
    await mounted.click("跳过教程");
    expect(overlayCount(mounted)).toBe(0);

    await mounted.click("规则说明");
    expect(mounted.container.querySelectorAll(".rules-sheet")).toHaveLength(1);
    await mounted.click("关闭规则");
    expect(mounted.container.querySelectorAll(".rules-sheet")).toHaveLength(0);
  });

  it("T13 getItem/setItem 抛异常时仍能自动打开并关闭，不崩", async () => {
    const storage = {
      getItem: (): string | null => { throw new Error("blocked"); },
      setItem: (): void => { throw new Error("quota"); },
    };
    vi.stubGlobal("localStorage", storage);
    mounted = await mountDom(createElement(App));
    expect(overlayCount(mounted)).toBe(1);
    await mounted.click("跳过教程");
    expect(overlayCount(mounted)).toBe(0);
    expect(mounted.text()).toContain("RichMan 联机大厅");
  });

  it("T13 localStorage getter 抛异常时不自动弹，手动入口仍可用", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get(): never { throw new Error("security"); },
    });
    mounted = await mountDom(createElement(App));
    expect(overlayCount(mounted)).toBe(0);
    await mounted.click("新手教程");
    expect(overlayCount(mounted)).toBe(1);
    await mounted.click("跳过教程");
    expect(overlayCount(mounted)).toBe(0);
  });

  it("T12 末页我知道了同样写入 seen 并关闭", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    mounted = await mountDom(createElement(App));
    for (let index = 0; index < 4; index += 1) await mounted.click("下一步");
    await mounted.click("我知道了");
    expect(overlayCount(mounted)).toBe(0);
    expect(storage.values.get(TUTORIAL_SEEN_KEY)).toBe("1");
  });
});
