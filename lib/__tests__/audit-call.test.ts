import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeCall } from "../audit-call";
import { writeAudit, type AuditEntry } from "../room-registry";
import { AUDIT_LOG } from "../store";
import { FakeStore } from "./fake-store";

const post = (body: unknown) =>
  new Request("https://bridger.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("describeCall — naming a call for the audit row", () => {
  it("names the TOOL for a tools/call, not the JSON-RPC verb", async () => {
    const req = post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridger_ask" } });
    assert.equal(await describeCall(req), "bridger_ask");
  });

  it("falls back to the method when there is no tool name", async () => {
    assert.equal(await describeCall(post({ jsonrpc: "2.0", id: 1, method: "tools/list" })), "tools/list");
    assert.equal(
      await describeCall(post({ jsonrpc: "2.0", id: 1, method: "tools/call" })),
      "tools/call",
      "a tools/call with no params.name must not read as a tool called 'undefined'",
    );
  });

  it("handles a JSON-RPC batch", async () => {
    const req = post([
      { method: "tools/call", params: { name: "bridger_status" } },
      { method: "tools/call", params: { name: "bridger_read" } },
    ]);
    assert.equal(await describeCall(req), "bridger_status,bridger_read");
  });

  it("does NOT consume the body — the handler still gets to read it", async () => {
    const req = post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridger_post" } });
    await describeCall(req);
    assert.equal(req.bodyUsed, false, "describeCall reads a clone or it breaks every request it logs");
    const seen = (await req.json()) as { params: { name: string } };
    assert.equal(seen.params.name, "bridger_post");
  });

  it("never throws on a body it cannot parse", async () => {
    assert.equal(await describeCall(post("{not json")), "unparsed");
    assert.equal(await describeCall(post("null")), "unknown", "a null message is still a call");
  });

  it("labels the SSE lifecycle by verb rather than pretending it is a tool", async () => {
    assert.equal(await describeCall(new Request("https://bridger.test/api/mcp")), "get");
    assert.equal(
      await describeCall(new Request("https://bridger.test/api/mcp", { method: "DELETE" })),
      "delete",
    );
  });

  it("bounds the label so a hostile batch cannot bloat every log line", async () => {
    const many = Array.from({ length: 200 }, () => ({
      method: "tools/call",
      params: { name: "bridger_status" },
    }));
    assert.ok((await describeCall(post(many))).length <= 120);
  });
});

describe("the audit log records SUCCESSES, not only denials", () => {
  it("round-trips an ok row with the identity a denial cannot carry", async () => {
    const store = new FakeStore();
    const row: AuditEntry = {
      ts: "2026-08-12T10:00:00.000Z",
      // disclosure-ok: synthetic fixture, not a room id.
      tokenId: "abc123def456",
      roomId: "room_1",
      side: "a",
      tool: "bridger_ask",
      status: "ok",
      durationMs: 42,
    };
    await writeAudit(store, row);

    const [raw] = await store.lrange(AUDIT_LOG, 0, -1);
    assert.deepEqual(JSON.parse(raw as string), row);
  });

  it("stays best-effort — a logger that is down must not fail the request", async () => {
    const store = new FakeStore();
    store.failAll();
    await writeAudit(store, {
      ts: "2026-08-12T10:00:00.000Z",
      // disclosure-ok: synthetic fixture, not a room id.
      tokenId: "abc123def456",
      roomId: "room_1",
      side: "a",
      tool: "bridger_ask",
      status: "ok",
    });
    // Reaching here without throwing IS the assertion.
    assert.ok(true);
  });
});
