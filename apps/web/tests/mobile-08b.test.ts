/**
 * 08B 手机适配契约：viewport/安全区/矮视口/16px 输入/44px 触控/长金额。
 * 纯读源码字符串；删掉任一关键声明都应让本文件变红。
 * T13/T14 是 smoke：只证明旧测试字符串/依赖白名单仍在，不是权威证据；
 * 权威证据是交接里 `git diff --name-only HEAD -- '*test*'` 为空 + 命令输出。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const gameView = readFileSync(fileURLToPath(new URL("../src/GameView.tsx", import.meta.url)), "utf8");

function blocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?:^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}", "gm");
  const matches = [...css.matchAll(pattern)];
  if (matches.length === 0) throw new Error("未找到样式规则：" + selector);
  return matches.map((match) => match[1]!.replace(/\s+/g, " ").trim());
}

function lastBlock(selector: string): string {
  return blocks(selector).at(-1)!;
}

/** 从指定 @media 起始字符串提取所有匹配的花括号体（支持嵌套）。 */
function mediaBodies(needle: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  while (true) {
    const start = css.indexOf(needle, from);
    if (start < 0) return bodies;
    const open = css.indexOf("{", start);
    if (open < 0) return bodies;
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(css.slice(open + 1, index));
          from = index + 1;
          break;
        }
      }
    }
  }
}

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) result.push(full);
  }
  return result;
}

describe("08B 手机适配契约", () => {
  it("T1 viewport 含四个必需键且不禁用缩放", () => {
    const viewport = html.match(/<meta[^>]*name="viewport"[^>]*content="([^"]*)"/i)?.[1] ?? "";
    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("initial-scale=1");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("interactive-widget=resizes-content");
    expect(viewport).not.toContain("user-scalable=no");
    expect(viewport).not.toMatch(/maximum-scale/i);
  });

  it("T2 theme-color 与背景一致", () => {
    expect(html).toMatch(/<meta[^>]*name="theme-color"[^>]*content="#0f1720"/i);
  });

  it("T3 :root 四个安全区变量都存在且 env 带 0px 兜底", () => {
    const root = lastBlock(":root");
    for (const [name, inset] of [
      ["top", "safe-area-inset-top"],
      ["right", "safe-area-inset-right"],
      ["bottom", "safe-area-inset-bottom"],
      ["left", "safe-area-inset-left"],
    ] as const) {
      expect(root).toContain(`--safe-${name}: env(${inset}, 0px)`);
    }
    for (const match of css.matchAll(/env\([^)]*\)/g)) {
      expect(match[0]).toContain(", 0px)");
    }
  });

  it("T4 .game-sticky 顶部安全区，05E 四声明逐字保留", () => {
    const rule = lastBlock(".game-sticky");
    expect(rule).toContain("padding: calc(8px + var(--safe-top)) 0 4px");
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
    expect(rule).toContain("max-height: 45vh");
    expect(rule).toContain("overflow-y: auto");
  });

  it("T5 ≤560px 输入框 16px，桌面 .input 仍为 15px", () => {
    const mobile = mediaBodies("@media (max-width: 560px)").find((body) =>
      body.includes(".input") && body.includes("font-size: 16px"));
    expect(mobile).toBeDefined();
    expect(lastBlock(".input")).toContain("font-size: 15px");
  });

  it("T6 pointer:coarse 同时具备 44px 与 touch-action:manipulation", () => {
    const coarse = mediaBodies("@media (pointer: coarse)")[0];
    expect(coarse).toBeDefined();
    expect(coarse).toContain("min-height: 44px");
    expect(coarse).toContain("touch-action: manipulation");
  });

  it("T7 body 同时有 100vh 与 100dvh，且 dvh 在后", () => {
    const body = lastBlock("body");
    expect(body).toContain("min-height: 100vh");
    expect(body).toContain("min-height: 100dvh");
    expect(body.indexOf("100dvh")).toBeGreaterThan(body.indexOf("100vh"));
  });

  it("T8 长金额组同时有 tabular-nums 与 overflow-wrap:anywhere", () => {
    const block = css.match(/\.stat-value,\s*\.top-line,\s*\.game-meta,\s*\.settle-lines,\s*\.settle-line,\s*\.settle-balance,\s*\.debt-row\s*\{([^}]*)\}/);
    expect(block).not.toBeNull();
    const body = block![1]!.replace(/\s+/g, " ");
    expect(body).toContain("font-variant-numeric: tabular-nums");
    expect(body).toContain("overflow-wrap: anywhere");
  });

  it("T9 横屏矮视口用 .game-sticky.game-sticky 限高，未新增普通 .game-sticky 块", () => {
    const landscape = mediaBodies("@media (max-height: 480px) and (orientation: landscape)")[0];
    expect(landscape).toBeDefined();
    expect(landscape).toMatch(/\.game-sticky\.game-sticky\s*\{[^}]*max-height:\s*56vh/);
    expect(landscape).not.toMatch(/(?:^|\n)\s*\.game-sticky\s*\{/);
  });

  it("T10 ≤400px 收边距使用 safe-left/right", () => {
    const narrow = mediaBodies("@media (max-width: 400px)")[0];
    expect(narrow).toBeDefined();
    expect(narrow).toContain("padding-left: max(12px, var(--safe-left))");
    expect(narrow).toContain("padding-right: max(12px, var(--safe-right))");
    expect(narrow).toContain(".question");
    expect(narrow).toContain("font-size: 18px");
  });

  it("T11 教程头/操作栏使用 safe-top / safe-bottom", () => {
    expect(lastBlock(".tutorial-head")).toContain("padding-top: calc(16px + var(--safe-top))");
    expect(blocks(".tutorial-actions").some((block) =>
      block.includes("padding-bottom: calc(16px + var(--safe-bottom))"))).toBe(true);
    expect(blocks(".rules-sheet").some((block) =>
      block.includes("padding-bottom: calc(16px + var(--safe-bottom))"))).toBe(true);
  });

  it("T12 源码不出现 scrollIntoView / window.scrollTo / visualViewport", () => {
    const source = walk(fileURLToPath(new URL("../src", import.meta.url)))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toContain("scrollIntoView");
    expect(source).not.toContain("window.scrollTo");
    expect(source).not.toContain("visualViewport");
  });

  // smoke：只证明旧测试文件里的关键字符串还在，不替代真实执行旧测试。
  it("T13 旧 CSS 契约文件保持原断言", () => {
    const styles05e = readFileSync(fileURLToPath(new URL("./styles-05e.test.ts", import.meta.url)), "utf8");
    expect(styles05e).toContain('expect(rule).toContain("position: sticky")');
    expect(styles05e).toContain('expect(rule).toContain("top: 0")');
    expect(styles05e).toContain('expect(rule).toContain("max-height: 45vh")');
    expect(styles05e).toContain('expect(rule).toContain("overflow-y: auto")');
    expect(styles05e).toContain('expect(lastBlock(".banner .link")).toContain("min-width: 44px")');
    const stylesTutorial = readFileSync(fileURLToPath(new URL("./styles-tutorial.test.ts", import.meta.url)), "utf8");
    expect(stylesTutorial).toContain("max-height: 100dvh");
    expect(stylesTutorial).toContain("overflow-y: auto");
    expect(stylesTutorial).toContain("grid-template-columns: 1fr");
    expect(stylesTutorial).toContain("toBeGreaterThan(6)");
  });

  // smoke：白名单相等；权威证据是 git diff package.json/pnpm-lock.yaml 为空。
  it("T14 依赖清单与基线一致，无新增", () => {
    const root = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(root.devDependencies ?? {}).sort()).toEqual([
      "@types/node",
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "react",
      "react-dom",
      "tsx",
      "typescript",
      "vite",
      "vitest",
      "zod",
    ].sort());
    expect(root.dependencies).toBeUndefined();
    const web = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(web.dependencies ?? {}).sort()).toEqual(["@richman/game-core", "@richman/shared"]);
    expect(web.devDependencies).toBeUndefined();
  });

  it("T15 移动端金额输入保持 18px，且 .input.amount-input 在 560 块之后", () => {
    const rule = css.match(/\.input\.amount-input\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]!.replace(/\s+/g, " ")).toContain("font-size: 18px");
    const mobileInput = css.search(/@media\s*\(max-width:\s*560px\)\s*\{\s*\.input\s*,\s*select\s*,\s*textarea\s*\{/);
    expect(mobileInput).toBeGreaterThan(-1);
    expect(css.indexOf(".input.amount-input")).toBeGreaterThan(mobileInput);
    expect(css).not.toMatch(/\.amount-input\s*\{[^}]*font-size:\s*16px/);
    expect(gameView).toContain("input amount-input");
  });

  it("T16 footer/rules/overlay 安全区补齐且窄屏覆盖顺序正确", () => {
    const footer = lastBlock(".footer");
    expect(footer).toContain("calc(10px + var(--safe-bottom))");
    expect(footer).toContain("max(18px, var(--safe-right))");
    expect(footer).toContain("max(18px, var(--safe-left))");
    expect(blocks(".rules-sheet").some((block) =>
      block.includes("padding-top: calc(18px + var(--safe-top))"))).toBe(true);
    const overlaySafe = css.match(/\.tutorial-overlay\s*\{[^}]*max\(16px, var\(--safe-top\)\)/);
    expect(overlaySafe).not.toBeNull();
    const narrowOverlay = css.match(/@media\s*\(max-width:\s*560px\)\s*\{\s*\.tutorial-overlay\s*\{[^}]*padding:\s*var\(--safe-top\)\s+var\(--safe-right\)\s+var\(--safe-bottom\)\s+var\(--safe-left\)/);
    expect(narrowOverlay).not.toBeNull();
    expect(overlaySafe!.index!).toBeLessThan(narrowOverlay!.index!);
  });

  it("T17 面板 max-height 有 100vh 兜底，至少 4 对", () => {
    const pairs = [...css.matchAll(/max-height:\s*100vh;\s*max-height:\s*100dvh;/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(4);
  });

  it("T18 真实结算类名出现在 GameView，且死选择器 settle-row 已移除", () => {
    for (const className of ["settle-lines", "settle-line", "settle-balance"]) {
      expect(gameView).toContain(className);
      expect(css).toContain("." + className);
    }
    expect(css).not.toMatch(/\.settle-row\b/);
  });

  it("T19 横屏媒体块给 .wizard 留出 sticky 高度", () => {
    const landscape = mediaBodies("@media (max-height: 480px) and (orientation: landscape)")[0];
    expect(landscape).toBeDefined();
    expect(landscape).toContain(".wizard");
    expect(landscape).toContain("scroll-margin-top: calc(56vh + 8px)");
  });
});
