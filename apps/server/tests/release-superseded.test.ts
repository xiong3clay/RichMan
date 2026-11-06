import { describe, expect, it } from "vitest";
import { shouldReleaseSupersededOwner } from "../src/ws.js";

describe("07C S-B releaseSupersededOwner 判定", () => {
  it("四组合只有“旧 owner 存在且 non-current”需要释放", () => {
    expect(shouldReleaseSupersededOwner(true, true)).toBe(false);
    expect(shouldReleaseSupersededOwner(true, false)).toBe(true);
    expect(shouldReleaseSupersededOwner(false, true)).toBe(false);
    expect(shouldReleaseSupersededOwner(false, false)).toBe(false);
  });
});
