import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../src/App";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

describe("1.0.1 大厅连接状态文案", () => {
  it("T1 首次打开大厅不显示断线/重连提示", async () => {
    mounted = await mountDom(createElement(App));
    const text = mounted.text();
    expect(text).toContain("RichMan 联机大厅");
    expect(text).not.toContain("连接断开");
    expect(text).not.toContain("自动重连中");
    expect(text).not.toContain("连接中");
  });
});
