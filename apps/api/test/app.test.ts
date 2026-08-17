import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

// In-process via app.request(): no port, no network, no database.
describe("B0 scaffold", () => {
  test("GET /health reports up", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", service: "api" });
  });

  test("every response carries a request id", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("a supplied request id is preserved for correlation", async () => {
    const res = await app.request("/health", {
      headers: { "x-request-id": "abc-123" },
    });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });

  test("openapi document lists the health route", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/health"]).toBeDefined();
  });

  test("unknown route answers with the error envelope, not an HTML page", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; requestId: string };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBeTruthy();
  });
});
