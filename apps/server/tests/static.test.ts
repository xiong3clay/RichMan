import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";

const MP3_BYTES = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

describe("静态资源与音频 Range", () => {
  let dir = "";
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  async function open(): Promise<string> {
    dir = mkdtempSync(path.join(tmpdir(), "richman-static-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>richman</title>");
    writeFileSync(path.join(dir, "bgm.mp3"), MP3_BYTES);
    started = await startServer({ host: "127.0.0.1", port: 0, staticDir: dir, dataDir: path.join(dir, "data") });
    return `http://127.0.0.1:${started.port}`;
  }

  it("mp3 返回 audio/mpeg 并支持单区间 206", async () => {
    const base = await open();
    const response = await fetch(base + "/bgm.mp3", { headers: { Range: "bytes=10-19" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(response.headers.get("content-length")).toBe("10");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(MP3_BYTES.subarray(10, 20))).toBe(true);
  });

  it("mp3 无 Range 返回 200 全量；越界 Range 返回 416", async () => {
    const base = await open();
    const full = await fetch(base + "/bgm.mp3");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mpeg");
    expect(full.headers.get("content-length")).toBe("1000");
    expect(Buffer.from(await full.arrayBuffer()).equals(MP3_BYTES)).toBe(true);

    const bad = await fetch(base + "/bgm.mp3", { headers: { Range: "bytes=2000-3000" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
  });
});
