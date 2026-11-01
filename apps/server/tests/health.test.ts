import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedServer } from "../src/http.js";
import { startServer } from "../src/http.js";
import { HealthResponseSchema } from "@richman/shared";

let started: StartedServer;
let baseUrl: string;

beforeAll(async () => {
  started = await startServer({ host: "127.0.0.1", port: 0, staticDir: "D:/nonexistent-static-dir" });
  baseUrl = "http://127.0.0.1:" + started.port;
});

afterAll(async () => {
  await started.close();
});

describe("GET /health", () => {
  it("returns the documented fields and nothing secret", async () => {
    const res = await fetch(baseUrl + "/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    const parsed = HealthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/token|recovery|nickname/i);
  });

  it("answers unknown paths with JSON 404, not a stack trace", async () => {
    const res = await fetch(baseUrl + "/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("NOT_FOUND");
  });

  it("rejects non-GET methods with 405 JSON", async () => {
    const res = await fetch(baseUrl + "/health", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("answers malformed percent-encoding with 400, not a crash", async () => {
    const res = await fetch(baseUrl + "/%zz");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("rejects a NUL byte in the pathname with 400", async () => {
    const res = await fetch(baseUrl + "/%00");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("rejects path traversal outside the static dir with 403", async () => {
    const res = await fetch(baseUrl + "/%2e%2e%2fpackage.json");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("FORBIDDEN");
  });
});
