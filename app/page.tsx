"use client";

/**
 * BRIDGER, FROM THE BROWSER.
 *
 * WHAT CHANGED IN S#275, and why the file grew. This page used to be one thing:
 * paste a token, watch a ledger. Erik's direction turned the browser into where
 * a room BEGINS — *"I open Bridger in the browser, click start new room, select
 * slots, and the tokens generated from that room are the connectors you paste
 * into the session you are having with your AI of choice."* So there are four
 * views now, in the order a person meets them:
 *
 *   gate    → open a room, or watch one you already have a token for
 *   create  → name it, name both parties, pick slots
 *   minted  → the token box: every connector, shown exactly once
 *   room    → the three-panel view (record / conversation / agreements)
 *
 * IT STILL WRITES NOTHING INTO THE RECORD. Erik's call, asked directly: *"The
 * chat is watch only, the communication between you and gemini is the users
 * chatting."* So the page mints and renames, and never posts an entry — there
 * is still exactly one write path into the ledger and it runs through the MCP
 * tools. A UI that could post would need its own authorship rules, and "who
 * wrote this" is the property the whole ledger rests on.
 *
 * THE TOKEN NEVER GOES IN THE URL. Pasted, held in `sessionStorage`, sent as a
 * bearer header. A token in a query string ends up in browser history, in
 * server logs, and in any screenshot of the address bar — which is exactly the
 * artefact someone would post while demoing this.
 *
 * THE BROWSER HOLDS THE *VIEWER* TOKEN. After minting, this page keeps the
 * read-only seat, not either participant token. Watching must not be able to
 * become writing just because a tab was left open on a shared screen — the same
 * reasoning that put the `viewer` role in `room-registry.ts` in the first place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openQuestionIds } from "@/lib/question-state";
import { classifyCitation, describeCitation, isUnlocated, isWideRange } from "@/lib/citation";

interface Entry {
  id: string;
  seq: number;
  type: "question" | "answer" | "decision" | "note" | "contract" | "reopen" | "signoff";
  side: "a" | "b";
  code: string;
  author: string;
  ts: string;
  title: string;
  body: string;
  answers: string | null;
  why: string | null;
  checkedAgainst: string | null;
}

interface ExportPayload {
  room: {
    id: string;
    topic: string;
    you: { side: string; label: string; code: string; joinedAt: string | null };
    peer: { side: string; label: string; code: string; joinedAt: string | null };
  };
  contract: { body: string; updatedBy: string; updatedAt: string } | null;
  entries: Entry[];
  exportedAt: string;
}

interface Slot {
  side: "a" | "b";
  label: string;
  code: string;
  token: string;
}

interface Minted {
  room: { id: string; topic: string; createdAt: string };
  slots: Slot[];
  viewerToken: string;
  endpoint: string;
  unclaimedExpiresInSeconds: number;
  note: string;
}

/**
 * How often the room view asks the server what changed.
 *
 * WAS 3000, WHICH IS EXACTLY THE LIMIT. A 3-second poll is 20 requests a
 * minute, and `RATE_LIMIT_PER_MINUTE` is 20 — so the UI ran permanently on the
 * ceiling and the first extra call (the `whoami` on mount, a second tab, a
 * clock hiccup) tipped it into `429: rate-limited`. A customer's first screen
 * said so out loud.
 *
 * 4 seconds is 15/minute against a viewer ceiling of 60. The gap is the point:
 * a poll interval that only just fits is one that fails the moment anything
 * else shares the budget.
 */
const POLL_MS = 4000;
/**
 * And when it does fail, back off instead of leaning on the door.
 *
 * The old loop kept firing at the same rate after an error, so a rate-limited
 * tab re-earned its rate limit every single minute and could never recover on
 * its own — "stalled" was permanent until someone reloaded. Doubling to a cap
 * lets a tab that hit any transient failure heal itself, and stops a hundred
 * open tabs from turning one outage into a stampede.
 */
const POLL_MAX_MS = 30000;
const STORAGE_KEY = "bridger.token";
const TREE_KEY = (roomId: string) => `bridger.tree.${roomId}`;

const TYPE_LABEL: Record<Entry["type"], string> = {
  question: "asks",
  answer: "answers",
  decision: "decides",
  note: "notes",
  contract: "contract",
  reopen: "REOPENS",
  signoff: "signs off",
};

/**
 * Never render a blank verb. `TYPE_LABEL` is typed against the union above, but
 * the data arrives as JSON from a server that may be a version ahead of this
 * page — an entry type added server-side would otherwise render as an empty
 * span with no clue that anything was missing.
 */
const verbFor = (t: string) => TYPE_LABEL[t as Entry["type"]] ?? t;
const timeOf = (iso: string) => iso.slice(11, 19);

/**
 * The tree's folders, and why they are these five.
 *
 * Erik: *"The folder tree is just a nice to have storage of things like
 * implementations agreed upon or decisions argued and conclusion reached on.
 * It's for traceability and storing."* So it is a VIEW over entry types that
 * already exist, not a second store — the durable artefacts of the room, sorted
 * by what kind of artefact they are. Nothing here is new data.
 *
 * The names are editable (Erik asked for that) and kept in `localStorage` per
 * room. Deliberately NOT server state: renaming your own folder headings is a
 * private preference, and putting it in Redis would mean one side's cosmetic
 * choice silently rewrote the other side's screen.
 */
const FOLDERS = [
  { key: "agreements", label: "Agreements", types: ["contract"] as Entry["type"][] },
  { key: "decisions", label: "Decisions", types: ["decision"] as Entry["type"][] },
  { key: "answered", label: "Answered", types: ["answer"] as Entry["type"][] },
  { key: "open", label: "Open questions", types: ["question"] as Entry["type"][] },
  { key: "notes", label: "Notes", types: ["note", "signoff", "reopen"] as Entry["type"][] },
];

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

/** A one-click copy that says it worked, because a silent copy button is a coin flip. */
function CopyButton({ value, children }: { value: string; children: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`bx-copy ${done ? "done" : ""}`}
      onClick={() => {
        copy(value);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "copied" : children}
    </button>
  );
}

// ── view: gate ───────────────────────────────────────────────────

function Gate({ onWatch, onCreate }: { onWatch: (t: string) => void; onCreate: () => void }) {
  const [draft, setDraft] = useState("");
  return (
    <main className="gate">
      <div className="gate-card">
        <h1>Bridger</h1>
        <p className="sub">A traced record between two builders&rsquo; AI sessions.</p>

        <button type="button" className="bx-primary" onClick={onCreate}>
          Open a new room
        </button>

        <div className="bx-or">
          <span>or watch one you have a token for</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (t) onWatch(t);
          }}
        >
          <label htmlFor="tok">Room token</label>
          <input
            id="tok"
            type="password"
            placeholder="br_live_…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Watch the bridge</button>
        </form>
        <p className="fine">
          Held in this tab only, sent as a bearer header. Never placed in the URL — an address bar
          ends up in history, logs, and screenshots.
        </p>
      </div>
    </main>
  );
}

// ── view: create ─────────────────────────────────────────────────

function Create({ onMinted, onCancel }: { onMinted: (m: Minted) => void; onCancel: () => void }) {
  const [topic, setTopic] = useState("");
  const [you, setYou] = useState("");
  const [them, setThem] = useState("");
  const [slots, setSlots] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setBadField(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, you, them, slots }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBadField(body.field ?? null);
        setError(body.error ?? `The server said ${res.status}.`);
        return;
      }
      onMinted(body as Minted);
    } catch {
      setError("Could not reach the bridge server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate-card bx-wide">
        <h1>Open a room</h1>
        <p className="sub">Two AI sessions, one record, and a token each.</p>

        <form onSubmit={submit}>
          <label htmlFor="topic">What is this room for?</label>
          <input
            id="topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Partner API — round 8"
            className={badField === "topic" ? "bx-bad" : ""}
            maxLength={200}
            autoFocus
          />

          <div className="bx-pair">
            <div>
              <label htmlFor="you">Your side</label>
              <input
                id="you"
                value={you}
                onChange={(e) => setYou(e.target.value)}
                placeholder="Auden (Claude Code)"
                className={badField === "ownerLabel" ? "bx-bad" : ""}
                maxLength={60}
              />
            </div>
            <div>
              <label htmlFor="them">Their side</label>
              <input
                id="them"
                value={them}
                onChange={(e) => setThem(e.target.value)}
                placeholder="Antigravity (Gemini)"
                className={badField === "ownerLabel" ? "" : badField === "peerLabel" ? "bx-bad" : ""}
                maxLength={60}
              />
            </div>
          </div>

          <label>Slots</label>
          <div className="bx-slots">
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={`bx-slot ${slots === n ? "on" : ""} ${n > 2 ? "off" : ""}`}
                disabled={n > 2}
                onClick={() => setSlots(n)}
              >
                {n}
              </button>
            ))}
          </div>
          {/*
            Not a coming-soon tease. Sides are "a" | "b" in room-registry.ts and
            two-ness is the data model: otherSide() is a boolean flip, entry ids
            are namespaced per side, and "the peer" is singular in whoami, in
            the wait cursor and in the idle brake. Saying so is more useful than
            greying the buttons out silently.
          */}
          <p className="fine">
            Three or more is a rewrite of the room model, not a bigger number here — every side is
            <code> a</code> or <code> b</code> throughout the registry.
          </p>

          {error && <div className="error">{error}</div>}

          <div className="bx-row">
            <button type="submit" className="bx-primary" disabled={busy || !topic || !you || !them}>
              {busy ? "Opening…" : "Open the room"}
            </button>
            <button type="button" className="link" onClick={onCancel}>
              back
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

// ── view: minted (the token box) ─────────────────────────────────

function TokenBox({ minted, onWatch }: { minted: Minted; onWatch: (t: string) => void }) {
  const antigravity = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            bridger: {
              serverUrl: minted.endpoint,
              headers: { Authorization: `Bearer ${minted.slots[1].token}` },
            },
          },
        },
        null,
        2,
      ),
    [minted],
  );

  const claudeCmd = `claude mcp add --transport http bridger ${minted.endpoint} --header "Authorization: Bearer ${minted.slots[1].token}"`;

  return (
    <main className="gate">
      <div className="gate-card bx-wide">
        <h1>{minted.room.topic}</h1>
        <p className="sub">
          room <code>{minted.room.id}</code> — hand one connector to each side
        </p>

        <div className="bx-tokens">
          {minted.slots.map((s) => (
            <div key={s.side} className={`bx-token ${s.side === "a" ? "sideA" : "sideB"}`}>
              <div className="bx-token-head">
                <strong>{s.label}</strong>
                <code>{s.code}</code>
              </div>
              <code className="bx-token-val">{s.token}</code>
              <CopyButton value={s.token}>copy token</CopyButton>
            </div>
          ))}
          <div className="bx-token viewer">
            <div className="bx-token-head">
              <strong>This browser</strong>
              <code>read-only</code>
            </div>
            <code className="bx-token-val">{minted.viewerToken}</code>
            <CopyButton value={minted.viewerToken}>copy token</CopyButton>
          </div>
        </div>

        <div className="bx-warn">
          {minted.note} A room nobody joins is deleted after{" "}
          {Math.round(minted.unclaimedExpiresInSeconds / 3600)} hours.
        </div>

        <details className="bx-details" open>
          <summary>How the far side connects</summary>
          <p className="fine">
            Every MCP client needs the same two facts and differs only in what it calls the endpoint
            key.
          </p>
          <div className="bx-snippet">
            <div className="bx-snippet-head">
              Claude Code <CopyButton value={claudeCmd}>copy</CopyButton>
            </div>
            <pre>{claudeCmd}</pre>
          </div>
          <div className="bx-snippet">
            <div className="bx-snippet-head">
              Antigravity — <code>~/.gemini/config/mcp_config.json</code>
              <CopyButton value={antigravity}>copy</CopyButton>
            </div>
            <pre>{antigravity}</pre>
            <p className="fine">
              Antigravity wants <code>serverUrl</code> and rejects <code>url</code> and{" "}
              <code>httpUrl</code>. It keeps three of these files on disk and two are usually empty —
              use the IDE&rsquo;s <em>View raw config</em> button to find the live one.
            </p>
          </div>
        </details>

        <button type="button" className="bx-primary" onClick={() => onWatch(minted.viewerToken)}>
          Watch this room
        </button>
      </div>
    </main>
  );
}

// ── view: room (three panels) ────────────────────────────────────

function RoomView({ token, onForget }: { token: string; onForget: () => void }) {
  const [data, setData] = useState<ExportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const lastSeq = useRef(0);
  const [flash, setFlash] = useState<number | null>(null);

  const load = useCallback(async (tok: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/export", { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(
          res.status === 401
            ? `Token rejected (${body.error ?? "unknown"}). It may have been revoked, rotated, or expired.`
            : res.status === 410
              ? "This room has been closed."
              : res.status === 429
              ? "Polling too fast — backing off and retrying automatically."
              : res.status === 503
                ? "The registry is unreachable — the server cannot read its own token store."
                : `Server said ${res.status}: ${body.error ?? ""}`,
        );
        setLive(false);
        return false;
      }
      const payload = (await res.json()) as ExportPayload;
      const newest = payload.entries.at(-1)?.seq ?? 0;
      if (lastSeq.current && newest > lastSeq.current) setFlash(newest);
      lastSeq.current = newest;
      setData(payload);
      setError(null);
      setLive(true);
      return true;
    } catch {
      setError("Cannot reach the bridge server. Is it running?");
      setLive(false);
      return false;
    }
  }, []);

  // Role is asked once, from whoami. Renaming is a participant action, so the
  // pencil must not appear on a read-only seat and then fail with a 403 —
  // offering an action you cannot perform is worse than not offering it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setCanWrite(Boolean(body?.you?.canWrite));
      } catch {
        /* the poll below surfaces connectivity problems; this is only the pencil */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // A self-rescheduling timeout rather than setInterval, so the delay can grow
  // on failure and snap back on the first success. setInterval cannot do that —
  // its period is fixed at creation, which is precisely why the rate-limited
  // state was unrecoverable.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = POLL_MS;

    const tick = async () => {
      const ok = await load(token);
      if (stopped) return;
      delay = ok ? POLL_MS : Math.min(delay * 2, POLL_MAX_MS);
      timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, load]);

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(t);
  }, [flash]);

  const roomId = data?.room.id;
  useEffect(() => {
    if (!roomId) return;
    try {
      setNames(JSON.parse(localStorage.getItem(TREE_KEY(roomId)) ?? "{}"));
    } catch {
      setNames({});
    }
  }, [roomId]);

  function renameFolder(key: string, label: string) {
    if (!roomId) return;
    const next = { ...names, [key]: label };
    setNames(next);
    localStorage.setItem(TREE_KEY(roomId), JSON.stringify(next));
  }

  async function saveName() {
    const topic = nameDraft.trim();
    setRenaming(false);
    if (!topic || !data || topic === data.room.topic) return;
    const res = await fetch("/api/rooms", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ topic }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "The room could not be renamed.");
      return;
    }
    void load(token);
  }

  const entries = data?.entries ?? [];
  const openIds = openQuestionIds(entries);
  const reopenedIds = new Set(
    entries.filter((e) => e.type === "reopen" && e.answers).map((e) => e.answers as string),
  );
  const open = entries.filter((e) => e.type === "question" && openIds.has(e.id));
  const uncheckedAnswers = entries.filter((e) => e.type === "answer" && !e.checkedAgainst).length;
  const thinEvidence = entries.filter((e) => {
    if (e.type !== "answer" || !e.checkedAgainst) return false;
    const c = classifyCitation(e.checkedAgainst);
    return isUnlocated(c) || isWideRange(c);
  }).length;
  const decisions = entries.filter((e) => e.type === "decision");

  /** The whole record, as the two files a person would actually keep. */
  function download(kind: "json" | "md") {
    if (!data) return;
    const stamp = data.exportedAt.slice(0, 10);
    const name = `bridger-${data.room.id}-${stamp}.${kind}`;
    const body =
      kind === "json"
        ? JSON.stringify(data, null, 2)
        : [
            `# ${data.room.topic}`,
            ``,
            `Room \`${data.room.id}\` — ${data.room.you.label} and ${data.room.peer.label}`,
            `Exported ${data.exportedAt}`,
            ``,
            ...(data.contract
              ? [`## Contract`, ``, data.contract.body, ``, `_last changed by ${data.contract.updatedBy}_`, ``]
              : []),
            `## Record`,
            ``,
            ...entries.flatMap((e) => [
              `### ${e.id} — ${e.author} ${verbFor(e.type)}${e.answers ? ` → ${e.answers}` : ""}`,
              ``,
              e.title,
              ...(e.body && e.body !== e.title ? [``, e.body] : []),
              ...(e.why ? [``, `**Why:** ${e.why}`] : []),
              ...(e.type === "answer"
                ? [``, e.checkedAgainst ? `**Checked against:** \`${e.checkedAgainst}\`` : `**Unchecked** — nobody named what this rests on.`]
                : []),
              ``,
            ]),
          ].join("\n");

    const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="bx-room">
      <header className="top bx-top">
        <div className="bx-title">
          {renaming ? (
            <input
              className="bx-rename"
              value={nameDraft}
              autoFocus
              maxLength={200}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h1>
              {data?.room.topic ?? "…"}
              {canWrite && data && (
                <button
                  type="button"
                  className="bx-pencil"
                  title="Rename this room"
                  onClick={() => {
                    setNameDraft(data.room.topic);
                    setRenaming(true);
                  }}
                >
                  ✎
                </button>
              )}
            </h1>
          )}
          <p className="meta">
            {data ? (
              <>
                <span className="sideA">{data.room.you.label}</span>
                <span className="dot">·</span>
                <span className="sideB">{data.room.peer.label}</span>
                {data.room.peer.joinedAt === null && <span className="warn"> — has not connected yet</span>}
                <span className="dot">·</span>
                <span className="mono dim">room {data.room.id}</span>
              </>
            ) : (
              "connecting…"
            )}
          </p>
        </div>
        <div className="bx-actions">
          <button type="button" className="bx-save" onClick={() => download("md")} disabled={!data}>
            Save .md
          </button>
          <button type="button" className="bx-save" onClick={() => download("json")} disabled={!data}>
            Save .json
          </button>
          <div className={`pulse ${live ? "on" : "off"}`}>
            <span className="led" />
            {live ? "live" : "stalled"}
          </div>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="bx-panels">
        {/* LEFT — the record, as browsable folders */}
        <aside className="bx-tree">
          <h2>Record</h2>
          {FOLDERS.map((f) => {
            // "Open questions" is the one folder that is not a plain type
            // filter: a question stops belonging there once it is answered, and
            // `openQuestionIds` is the shared predicate that knows a `reopen`
            // makes it open again. Every other folder is its types.
            const items = f.key === "open" ? open : entries.filter((e) => f.types.includes(e.type));
            return (
              <section key={f.key} className="bx-folder">
                <h3>
                  <input
                    className="bx-folder-name"
                    value={names[f.key] ?? f.label}
                    onChange={(e) => renameFolder(f.key, e.target.value)}
                    aria-label={`Rename the ${f.label} folder`}
                  />
                  <span className="bx-count">{items.length}</span>
                </h3>
                <ul>
                  {items.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        className={`bx-leaf ${focus === e.id ? "on" : ""} ${e.side === "a" ? "sideA" : "sideB"}`}
                        onClick={() => setFocus(focus === e.id ? null : e.id)}
                      >
                        <code>{e.id}</code>
                        <span>{e.title}</span>
                      </button>
                    </li>
                  ))}
                  {items.length === 0 && <li className="bx-none">empty</li>}
                </ul>
              </section>
            );
          })}
          <p className="fine">
            Folder names are yours and stay in this browser. The contents are the room&rsquo;s real
            entries, grouped — nothing here is a second copy.
          </p>
        </aside>

        {/* CENTRE — the conversation */}
        <section className="bx-chat">
          <div className="bx-chat-head">
            <h2>Conversation</h2>
            {focus && (
              <button type="button" className="link" onClick={() => setFocus(null)}>
                showing {focus} — show everything
              </button>
            )}
          </div>
          <div className="feed">
            {entries.length === 0 && (
              <p className="empty">
                Nothing on the bridge yet. When either side calls <code>bridger_ask</code>, it
                appears here within {POLL_MS / 1000} seconds.
              </p>
            )}
            {entries
              .filter((e) => !focus || e.id === focus || e.answers === focus)
              .map((e) => (
                <article
                  key={e.id}
                  className={`entry ${e.side === "a" ? "sideA" : "sideB"} ${flash === e.seq ? "flash" : ""}`}
                >
                  <div className="head">
                    <code className="id">{e.id}</code>
                    <span className="author">{e.author}</span>
                    <span className="verb">{verbFor(e.type)}</span>
                    {e.answers && <code className="ref">→ {e.answers}</code>}
                    <span className="time mono dim">{timeOf(e.ts)}</span>
                    {reopenedIds.has(e.id) && <span className="reopened">reopened</span>}
                  </div>
                  {!e.body.startsWith(e.title) && <p className="title">{e.title}</p>}
                  {e.body && e.body !== e.title && <p className="body">{e.body}</p>}
                  {e.why && (
                    <p className="why">
                      <span>why</span> {e.why}
                    </p>
                  )}
                  {e.type === "answer" &&
                    (e.checkedAgainst ? (
                      (() => {
                        const c = classifyCitation(e.checkedAgainst);
                        const weak = isUnlocated(c) || isWideRange(c);
                        return (
                          <p className={`prov ${weak ? "thin" : "ok"}`}>
                            {weak ? "◐" : "✓"} checked against <code>{e.checkedAgainst}</code>
                            <span
                              className="span"
                              title="How specific the citation is. Says nothing about whether the answer is correct."
                            >
                              {describeCitation(c)}
                            </span>
                          </p>
                        );
                      })()
                    ) : (
                      <p className="prov bad">⚠ unchecked — nobody named what this rests on</p>
                    ))}
                </article>
              ))}
          </div>
        </section>

        {/* RIGHT — what the two sides actually agreed */}
        <aside className="bx-agree">
          <h2>Agreements</h2>

          <section className="stats bx-stats">
            <div className={open.length ? "hot" : ""}>
              <strong>{open.length}</strong>
              <span>open</span>
            </div>
            <div className={uncheckedAnswers ? "flag" : ""}>
              <strong>{uncheckedAnswers}</strong>
              <span>unchecked</span>
            </div>
            <div
              className={thinEvidence ? "flag" : ""}
              title="Cited, but not to a place you could go and check. Counts the citation, not the answer."
            >
              <strong>{thinEvidence}</strong>
              <span>thin</span>
            </div>
          </section>

          {data?.contract ? (
            <div className="bx-contract">
              <h3>Contract</h3>
              <p className="meta">
                last changed by {data.contract.updatedBy} at {timeOf(data.contract.updatedAt)}
              </p>
              <pre>{data.contract.body}</pre>
            </div>
          ) : (
            <p className="bx-none">
              No contract yet. Either side writes one with <code>bridger_contract</code>.
            </p>
          )}

          <h3>Decisions</h3>
          {decisions.length === 0 && <p className="bx-none">Nothing decided yet.</p>}
          {decisions.map((d) => (
            <div key={d.id} className={`bx-decision ${d.side === "a" ? "sideA" : "sideB"}`}>
              <code>{d.id}</code>
              <strong>{d.title}</strong>
              {d.body && <p>{d.body}</p>}
              {d.why && (
                <p className="why">
                  <span>why</span> {d.why}
                </p>
              )}
            </div>
          ))}

          {open.length > 0 && (
            <>
              <h3>Waiting on an answer</h3>
              {open.map((q) => (
                <div key={q.id} className={`openq ${q.side === "a" ? "sideA" : "sideB"}`}>
                  <code>{q.id}</code>
                  <span className="who">{q.author} asked</span>
                  <span className="qt">{q.title}</span>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>

      <footer>
        <button className="link" onClick={onForget}>
          forget token
        </button>
        <span className="dim">read-only · every write goes through the MCP tools</span>
      </footer>
    </main>
  );
}

// ── shell ────────────────────────────────────────────────────────

export default function Bridger() {
  const [view, setView] = useState<"gate" | "create" | "minted">("gate");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) setToken(saved);
    setReady(true);
  }, []);

  const watch = (t: string) => {
    sessionStorage.setItem(STORAGE_KEY, t);
    setToken(t);
  };

  // Nothing renders until sessionStorage has been read. Without this the gate
  // flashes for one frame on every reload of an already-watched room.
  if (!ready) return <main className="gate" />;

  if (token) {
    return (
      <RoomView
        token={token}
        onForget={() => {
          sessionStorage.removeItem(STORAGE_KEY);
          setToken(null);
          setMinted(null);
          setView("gate");
        }}
      />
    );
  }
  if (view === "minted" && minted) return <TokenBox minted={minted} onWatch={watch} />;
  if (view === "create")
    return (
      <Create
        onCancel={() => setView("gate")}
        onMinted={(m) => {
          setMinted(m);
          setView("minted");
        }}
      />
    );
  return <Gate onWatch={watch} onCreate={() => setView("create")} />;
}
