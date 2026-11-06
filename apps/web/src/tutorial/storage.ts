/** 只记录“是否看过教程”，禁止写入 token、房间码、昵称等身份数据。 */
export const TUTORIAL_SEEN_KEY = "richman.tutorial.seen.v1";

export interface TutorialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function tutorialSeen(storage: TutorialStorage | null | undefined): boolean {
  if (storage === null || storage === undefined) return false;
  try {
    return storage.getItem(TUTORIAL_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

export function markTutorialSeen(storage: TutorialStorage | null | undefined): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(TUTORIAL_SEEN_KEY, "1");
  } catch {
    // 隐私模式/配额满/被禁用：静默降级，不能阻断关闭教程。
  }
}

export function safeLocalStorage(): TutorialStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
