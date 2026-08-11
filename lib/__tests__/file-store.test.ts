import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileStore } from "../file-store";
import { appendEntry, readEntries, getStatus } from "../entries";
import { authorize, clearRegistryCache, createRoom, revokeSide } from "../room-registry";
import { T0 } from "./fake-store";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "bridger-test-"));
  const path = join(dir, "bridge.json");
  return { dir, path, store: new FileStore(path) };
}

describe("FileStore", () => {
  it("survives a restart — the whole point of a local bridge", async () => {
    const { dir, path, store } = tempStore();
    try {
      clearRegistryCache();
      const { room, ownerToken, peerToken } = await createRoom(store, {
        topic: "two windows, one laptop",
        ownerLabel: "Claude",
        peerLabel: "Gemini",
        now: T0,
      });
      const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
      assert.ok(a.ok);
      await appendEntry(store, room, a.token, { type: "question", title: "still here?", body: "" }, T0);

      assert.ok(existsSync(path), "state must be on disk, not just in memory");

      // A completely fresh process would see exactly this.
      clearRegistryCache();
      const reopened = new FileStore(path);

      const again = await authorize(reopened, { presentedToken: peerToken, now: T0 });
      assert.ok(again.ok, "tokens must still authorise after a restart");
      assert.equal(again.token.side, "b");

      const entries = await readEntries(reopened, room.id);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].title, "still here?");
      assert.equal(entries[0].id, "CLA-Q-001");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees another PROCESS's revocation — the bug the live control caught", async () => {
    const { dir, path, store: server } = tempStore();
    try {
      clearRegistryCache();
      const { room, peerToken } = await createRoom(server, {
        topic: "revocation must cross process boundaries",
        ownerLabel: "JudgeMySite",
        peerLabel: "Trigvanta",
        now: T0,
      });

      // The running server has the token warm in memory.
      clearRegistryCache();
      assert.equal((await authorize(server, { presentedToken: peerToken, now: T0 })).ok, true);

      // The operator CLI is a DIFFERENT process holding its own instance.
      const cli = new FileStore(path);
      await revokeSide(cli, room, "b");

      // The server must now refuse. Before the mtime-reload fix it kept
      // serving from its startup snapshot and answered `ok` here — a
      // revocation that reported success and did nothing.
      clearRegistryCache();
      const after = await authorize(server, { presentedToken: peerToken, now: T0 });
      assert.deepEqual(
        after,
        { ok: false, reason: "revoked" },
        "a revocation written by another process must take effect",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupt file instead of refusing to start", async () => {
    const { dir, path } = tempStore();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, "{ this is not json", "utf8");
      const store = new FileStore(path);
      await store.set("k", "v");
      assert.equal(await store.get("k"), "v");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drives a full two-side round trip end to end", async () => {
    const { dir, store } = tempStore();
    try {
      clearRegistryCache();
      const { room, ownerToken, peerToken } = await createRoom(store, {
        topic: "local round trip",
        ownerLabel: "JudgeMySite",
        peerLabel: "Trigvanta",
        now: T0,
      });
      const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
      const b = await authorize(store, { presentedToken: peerToken, now: T0 });
      assert.ok(a.ok && b.ok);

      const q = await appendEntry(
        store,
        room,
        a.token,
        { type: "question", title: "does 422 refund the key?", body: "" },
        T0,
      );
      await appendEntry(
        store,
        room,
        b.token,
        {
          type: "answer",
          title: "yes",
          body: "yes, refunded",
          answers: q.id,
          checkedAgainst: "lib/external/usage-report.ts:41",
        },
        T0,
      );

      const askerView = await getStatus(store, room, a.token);
      assert.equal(askerView.unread, 1, "the answer is unread news to the asker");
      assert.equal(askerView.openQuestions.length, 0, "and it closed the question");

      const answererView = await getStatus(store, room, b.token);
      assert.equal(answererView.unread, 1, "the question is unread news to the answerer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles negative-index trims the way Redis does", async () => {
    const { dir, store } = tempStore();
    try {
      await store.rpush("L", "a", "b", "c", "d");
      await store.ltrim("L", -2, -1);
      assert.deepEqual(await store.lrange("L", 0, -1), ["c", "d"]);
      assert.equal(await store.llen("L"), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
