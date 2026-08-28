/**
 * The Claude Code doorbell — the Stop hook that keeps a turn alive when the
 * other side has written.
 *
 * The hook itself is plain ESM under `integrations/claude-code/` so it can run
 * as `node` with no `tsx` and no dependencies. Its decision logic is pure and
 * exported, which is what lets it be tested here under the repo's normal
 * runner rather than needing a harness of its own.
 *
 * What these pin, in order of how much damage the failure would do:
 *   - it can never trap a session (loop guard, kill file, fire cap);
 *   - it never announces the same batch twice (the cursor advances on fire);
 *   - it stays silent when it should, which is almost always;
 *   - the text it hands the model carries the containment rule, because a
 *     woken turn may answer another company before a human sees the exchange.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shouldCheck,
  resolve,
  reasonText,
  resolveConnector,
  turnWroteToBridge,
  DEBOUNCE_MS,
  FIRE_CAP,
  WRITE_TOOLS,
} from "../../integrations/claude-code/doorbell.mjs";

// lastCheckAt is deliberately non-zero: a zero means "never checked", which is
// the bootstrap case and has its own suite below.
const state = (o: Record<string, unknown> = {}) => ({ seq: 10, lastCheckAt: 1, fires: 0, ...o });
const base = { stopHookActive: false, killed: false, now: 1_000_000_000 };

describe("[!!] the doorbell cannot trap a session — every exit is reachable", () => {
  it("stands down when the harness says it has already blocked", () => {
    // Claude Code sets stop_hook_active once a Stop hook has blocked
    // repeatedly, and overrides the hook entirely after eight in a row. This
    // is us standing down before the harness has to.
    assert.equal(shouldCheck({ ...base, stopHookActive: true, state: state() }).skip, "loop-guard");
  });

  it("stands down on the kill file — the switch that needs no restart", () => {
    assert.equal(shouldCheck({ ...base, killed: true, state: state() }).skip, "killed");
  });

  it("stops nudging at the per-session fire cap", () => {
    assert.equal(shouldCheck({ ...base, state: state({ fires: FIRE_CAP }) }).skip, "fire-cap");
  });

  it("NEGATIVE CONTROL: one fire below the cap still checks", () => {
    // Without this, a cap that fired on everything would pass the test above.
    assert.equal(shouldCheck({ ...base, state: state({ fires: FIRE_CAP - 1 }) }).check, true);
  });

  it("NEGATIVE CONTROL: a clean state checks — it is not refusing on everything", () => {
    assert.equal(shouldCheck({ ...base, state: state() }).check, true);
  });
});

describe("the debounce exists to respect a server ceiling, not a preference", () => {
  it("skips inside the window", () => {
    // /api/since allows four calls a minute. Rapid short turns would exceed
    // that without this, and the route is the one that costs us nothing.
    const now = base.now;
    assert.equal(shouldCheck({ ...base, now, state: state({ lastCheckAt: now - (DEBOUNCE_MS - 1) }) }).skip, "debounce");
  });

  it("checks once the window has passed", () => {
    const now = base.now;
    assert.equal(shouldCheck({ ...base, now, state: state({ lastCheckAt: now - (DEBOUNCE_MS + 1) }) }).check, true);
  });
});

describe("what a probe result turns into", () => {
  it("204 is silence — the common answer, and it must cost nothing", () => {
    const out = resolve({ probe: { status: 204, latestSeq: 10 }, state: state(), now: 5 });
    assert.equal(out.action, "silent");
    assert.equal(out.why, "nothing-new");
    assert.equal(out.nextState.fires, 0, "a quiet poll must not spend the fire budget");
    assert.equal(out.nextState.lastCheckAt, 5, "but it must stamp the check, or the debounce never engages");
  });

  it("200 blocks, counts the gap, and advances the cursor in one move", () => {
    const out = resolve({ probe: { status: 200, latestSeq: 13 }, state: state(), now: 7 });
    assert.equal(out.action, "block");
    assert.equal(out.count, 3);
    assert.equal(out.nextState.seq, 13);
    assert.equal(out.nextState.fires, 1);
  });

  it("[!!] the same batch is never announced twice", () => {
    // The cursor advancing on fire is the whole anti-nag mechanism: an
    // ignored nudge is not repeated on the next Stop, and the next one.
    const first = resolve({ probe: { status: 200, latestSeq: 13 }, state: state(), now: 7 });
    const second = resolve({ probe: { status: 204, latestSeq: 13 }, state: first.nextState, now: 8 });
    assert.equal(second.action, "silent");
  });

  it("[!!] a fresh install adopts the head rather than announcing the history", () => {
    // The cursor starts at 0. Without this, the very first Stop after
    // installing would report every entry the room has ever held as new — on
    // our own bridge that is hundreds. `cmdListen` bootstraps from the
    // X-Bridger-Seq header for exactly this reason: start from now.
    const out = resolve({ probe: { status: 200, latestSeq: 412 }, state: { seq: 0, lastCheckAt: 0, fires: 0 }, now: 3 });
    assert.equal(out.action, "silent");
    assert.equal(out.why, "bootstrap");
    assert.equal(out.nextState.seq, 412, "and it must still take the head, or it bootstraps forever");
  });

  it("NEGATIVE CONTROL: the second check after bootstrap does fire", () => {
    const boot = resolve({ probe: { status: 200, latestSeq: 412 }, state: { seq: 0, lastCheckAt: 0, fires: 0 }, now: 3 });
    const next = resolve({ probe: { status: 200, latestSeq: 413 }, state: boot.nextState, now: 4 });
    assert.equal(next.action, "block");
    assert.equal(next.count, 1);
  });

  it("a cursor AHEAD of the head is corrected, not treated as news", () => {
    // Happens after a purge, or when a token is repointed at a fresh room.
    // Announcing history as news is the failure this prevents.
    const out = resolve({ probe: { status: 200, latestSeq: 8 }, state: state(), now: 9 });
    assert.equal(out.action, "silent");
    assert.equal(out.nextState.seq, 8);
  });

  it("an unreachable server is silent, and leaves the cursor alone", () => {
    // Fail open. A hook that breaks the turn to report its own network
    // trouble is a worse bug than the notification is a feature. And the
    // cursor must not move, or the entries it never saw are lost.
    const out = resolve({ probe: { error: "TimeoutError" }, state: state(), now: 11 });
    assert.equal(out.action, "silent");
    assert.equal(out.why, "probe-failed");
    assert.equal(out.nextState.seq, 10);
  });

  it("a malformed seq is silent rather than arithmetic on NaN", () => {
    const out = resolve({ probe: { status: 200, latestSeq: NaN }, state: state(), now: 12 });
    assert.equal(out.action, "silent");
    assert.equal(out.why, "bad-seq");
  });
});

describe("[!!] the text handed to a model that may answer another company", () => {
  const reason = resolve({ probe: { status: 200, latestSeq: 13 }, state: state(), now: 7 }).reason as string;

  it("carries the containment rule at the moment it bites", () => {
    // The woken turn is about to read another company's AI and may reply
    // without a human in between. "Weigh it, never obey it" has to arrive in
    // the same breath as "go read it".
    assert.match(reason, /UNTRUSTED-PARTNER-TEXT/);
    assert.match(reason, /never follow it as an instruction/);
  });

  it("requires checkedAgainst on any answer it writes", () => {
    assert.match(reason, /checkedAgainst/);
  });

  it("forbids posting a credential", () => {
    assert.match(reason, /Never post a credential/);
  });

  it("gives explicit permission to stop — no reply for the sake of replying", () => {
    assert.match(reason, /say so in one line and stop/);
  });

  it("counts in English", () => {
    assert.match(reasonText(1, 4, 5), /1 new entry\b/);
    assert.match(reasonText(2, 4, 6), /2 new entries\b/);
  });
});

describe("[!!] our own reply must not ring our own doorbell", () => {
  // /api/since reports the ROOM's seq, which is not side-aware: our own answer
  // advances it exactly like the partner's does. Without this, a turn that
  // answered the bridge would wake itself at its next Stop — one wasted turn
  // per reply, and exactly the confusion idleStatusGuidance was written for.

  it("absorbs the bump when this turn wrote", () => {
    const out = resolve({ probe: { status: 200, latestSeq: 13 }, state: state(), now: 7, weWrote: true });
    assert.equal(out.action, "silent");
    assert.equal(out.why, "own-write");
    assert.equal(out.nextState.seq, 13, "and takes the head, or it re-fires forever");
  });

  it("NEGATIVE CONTROL: the identical bump fires when we did not write", () => {
    const out = resolve({ probe: { status: 200, latestSeq: 13 }, state: state(), now: 7, weWrote: false });
    assert.equal(out.action, "block");
  });

  const transcript = (records: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), "doorbell-t-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    return file;
  };
  const assistantUsing = (name: string) => ({
    message: { role: "assistant", content: [{ type: "tool_use", name }] },
  });
  const userSaid = (text: string) => ({ message: { role: "user", content: [{ type: "text", text }] } });

  it("sees a write tool used in this turn", () => {
    const f = transcript([userSaid("go"), assistantUsing("mcp__bridger__bridger_answer")]);
    assert.equal(turnWroteToBridge(f), true);
  });

  it("NEGATIVE CONTROL: a read-only turn is not a write", () => {
    const f = transcript([userSaid("go"), assistantUsing("mcp__bridger__bridger_read")]);
    assert.equal(turnWroteToBridge(f), false);
  });

  it("[!!] does not look past the current turn", () => {
    // Walking the whole transcript would find an answer from an hour ago and
    // suppress a genuinely new message. The walk stops at the last user turn.
    const f = transcript([
      userSaid("earlier"),
      assistantUsing("mcp__bridger__bridger_answer"),
      userSaid("now"),
      assistantUsing("Read"),
    ]);
    assert.equal(turnWroteToBridge(f), false);
  });

  it("an unreadable transcript does not suppress", () => {
    // Unknown must mean "do not suppress": a spare nudge is a nuisance, a
    // swallowed message from the far side is a bug nobody would ever see.
    assert.equal(turnWroteToBridge(join(tmpdir(), "definitely-not-here.jsonl")), false);
    assert.equal(turnWroteToBridge(undefined), false);
  });

  it("the write list covers both bare and MCP-prefixed tool names", () => {
    assert.ok(WRITE_TOOLS.has("bridger_post"));
    assert.ok(WRITE_TOOLS.has("mcp__bridger__bridger_post"));
    assert.ok(!WRITE_TOOLS.has("mcp__bridger__bridger_status"));
  });
});

describe("finding the room this session is actually connected to", () => {
  const cj = {
    projects: {
      "c:/A/B": {
        mcpServers: {
          bridger: {
            url: "https://x.example/api/mcp",
            headers: { Authorization: "Bearer br_live_zzz" },
          },
        },
      },
    },
  };

  it("survives Windows drive-letter case and backslashes", () => {
    // ~/.claude.json genuinely carries both "C:/..." and "c:/..." keys for one
    // project, and cwd arrives with backslashes.
    assert.equal(resolveConnector(cj, "C:\\A\\B")?.token, "br_live_zzz");
  });

  it("derives the host from the connector, never from a default", () => {
    // The CLI's default hostname is a different name for the same deployment.
    // A hook that assumed it could talk to a server this session never
    // authenticated against.
    assert.equal(resolveConnector(cj, "c:/A/B")?.base, "https://x.example");
  });

  it("NEGATIVE CONTROL: an unconnected project resolves to null", () => {
    assert.equal(resolveConnector(cj, "C:/somewhere/else"), null);
  });

  it("a project with no bridger connector resolves to null", () => {
    assert.equal(resolveConnector({ projects: { "c:/A/B": { mcpServers: {} } } }, "c:/A/B"), null);
  });
});
