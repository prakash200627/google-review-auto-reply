import { describe, expect, it } from "vitest";
import { readJsonObjectBody } from "@/lib/http/readJsonBody";

describe("readJsonObjectBody", () => {
  it("treats empty body as empty object", async () => {
    const req = new Request("http://localhost/api", {
      method: "PATCH",
      body: "",
      headers: { "Content-Type": "application/json" },
    });
    const result = await readJsonObjectBody(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual({});
  });

  it("parses a valid object body", async () => {
    const req = new Request("http://localhost/api", {
      method: "PATCH",
      body: JSON.stringify({ name: "Cafe" }),
      headers: { "Content-Type": "application/json" },
    });
    const result = await readJsonObjectBody(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual({ name: "Cafe" });
  });

  it("returns 400 for malformed JSON", async () => {
    const req = new Request("http://localhost/api", {
      method: "PATCH",
      body: "{",
      headers: { "Content-Type": "application/json" },
    });
    const result = await readJsonObjectBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.code).toBe("invalid_json");
    }
  });

  it("returns 400 for non-object JSON", async () => {
    const req = new Request("http://localhost/api", {
      method: "PATCH",
      body: JSON.stringify(["x"]),
      headers: { "Content-Type": "application/json" },
    });
    const result = await readJsonObjectBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });
});
