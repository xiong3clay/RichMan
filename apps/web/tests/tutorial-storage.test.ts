import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TUTORIAL_SEEN_KEY,
  markTutorialSeen,
  safeLocalStorage,
  tutorialSeen,
} from "../src/tutorial/storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
  };
}

describe("08A 教程已读存储", () => {
  it("T3 storage 为空时 tutorialSeen=false", () => {
    expect(tutorialSeen(null)).toBe(false);
    expect(tutorialSeen(undefined)).toBe(false);
    expect(tutorialSeen(memoryStorage())).toBe(false);
  });

  it("T3 getItem 只要非 null 就算已读", () => {
    expect(tutorialSeen(memoryStorage({ [TUTORIAL_SEEN_KEY]: "1" }))).toBe(true);
    expect(tutorialSeen(memoryStorage({ [TUTORIAL_SEEN_KEY]: "0" }))).toBe(true);
  });

  it("T3 getItem 抛异常时返回 false 且不抛", () => {
    const storage = { getItem: (): string | null => { throw new Error("blocked"); }, setItem: (): void => undefined };
    expect(() => tutorialSeen(storage)).not.toThrow();
    expect(tutorialSeen(storage)).toBe(false);
  });

  it("T4 markTutorialSeen 写入固定 key 和 1", () => {
    const storage = memoryStorage();
    markTutorialSeen(storage);
    expect(storage.values.get(TUTORIAL_SEEN_KEY)).toBe("1");
    expect(storage.values.size).toBe(1);
  });

  it("T4 storage 为空或 setItem 抛异常时静默返回", () => {
    expect(() => markTutorialSeen(null)).not.toThrow();
    expect(() => markTutorialSeen(undefined)).not.toThrow();
    const storage = { getItem: (): string | null => null, setItem: (): void => { throw new Error("quota"); } };
    expect(() => markTutorialSeen(storage)).not.toThrow();
  });

  it("safeLocalStorage 返回可用对象，getter 抛异常时返回 null", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(safeLocalStorage()).toBe(storage);

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get(): TutorialStorageLike { throw new Error("blocked"); },
    });
    try {
      expect(safeLocalStorage()).toBeNull();
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

type TutorialStorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };
