"use client";

/**
 * The bridge, watchable.
 *
 * WHY A READ-ONLY VIEW
 * -------------------
 * The ledger already has two readers: the agents (via MCP tools) and a human
 * with a terminal (`bridger log`, or the materialised `bridger/` folder). This
 * is the third — someone watching an exchange happen who is not going to run a
 * CLI, which includes the case where you are showing it to somebody.
 *
 * It writes nothing. Every mutation goes through the MCP tools, so there is
 * exactly one write path into the record and this page cannot become a second
 * one. That is deliberate: a UI that can post would need its own authorship
 * rules, and "who wrote this" is the property the whole ledger rests on.
 *
 * THE TOKEN NEVER GOES IN THE URL
 * -------------------------------
 * It is pasted, held in `sessionStorage`, and sent as a bearer header. A token
 * in a query string ends up in browser history, in server logs, and in any
 * screenshot of the address bar — which is exactly the artifact someone would
 * post while demoing this.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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

const POLL_MS = 3000;
const STORAGE_KEY = "bridger.token";

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

function timeOf(iso: string) {
  return iso.slice(11, 19);
}

export default function BridgeView() {
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<ExportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const lastSeq = useRef(0);
  const [flash, setFlash] = useState<number | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) setToken(saved);
  }, []);

  const load = useCallback(async (tok: string) => {
    try {
      const res = await fetch("/api/export", { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(
          res.status === 401
            ? `Token rejected (${body.error ?? "unknown"}). It may have been revoked or rotated.`
            : res.status === 410
              ? "This room has been closed."
              : res.status === 503
                ? "The registry is unreachable — the server cannot read its own token store."
                : `Server said ${res.status}: ${body.error ?? ""}`,
        );
        setLive(false);
        return;
      }
      const payload = (await res.json()) as ExportPayload;
      const newest = payload.entries.at(-1)?.seq ?? 0;
      if (lastSeq.current && newest > lastSeq.current) setFlash(newest);
      lastSeq.current = newest;
      setData(payload);
      setError(null);
      setLive(true);
    } catch {
      setError("Cannot reach the bridge server. Is it running?");
      setLive(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    void load(token);
    const t = setInterval(() => void load(token), POLL_MS);
    return () => clearInterval(t);
  }, [token, load]);

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(t);
  }, [flash]);

  if (!token) {
    return (
      <main className="gate">
        <div className="gate-card">
          <h1>Bridger</h1>
          <p className="sub">A traced record between two builders&rsquo; AI sessions.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = draft.trim();
              if (!t) return;
              sessionStorage.setItem(STORAGE_KEY, t);
              setToken(t);
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
            Held in this tab only, sent as a bearer header. Never placed in the URL — an address
            bar ends up in history, logs, and screenshots.
          </p>
        </div>
      </main>
    );
  }

  /**
   * Shared with the tools via `lib/question-state.ts` — NOT a local copy.
   *
   * The local copy that used to live here was `filter(e => e.answers)`, which
   * was correct until `reopen` entries existed. A reopen carries `answers` too,
   * so the moment reopening shipped this panel began showing every REOPENED
   * question as answered: the opposite of the truth, in the one place a human
   * looks to decide whose turn it is.
   */
  const openIds = openQuestionIds(data?.entries ?? []);
  const reopenedIds = new Set(
    (data?.entries ?? []).filter((e) => e.type === "reopen" && e.answers).map((e) => e.answers as string),
  );
  const open = (data?.entries ?? []).filter((e) => e.type === "question" && openIds.has(e.id));
  const signedOff = (data?.entries ?? []).reduce<Record<string, { author: string; at: string; note: string }>>(
    (acc, e) => {
      if (e.type === "signoff") acc[e.side] = { author: e.author, at: e.ts, note: e.title };
      else delete acc[e.side];
      return acc;
    },
    {},
  );
  const uncheckedAnswers = (data?.entries ?? []).filter(
    (e) => e.type === "answer" && !e.checkedAgainst,
  ).length;
  /**
   * Answers that DID cite something, but not to a place a reader could go.
   * Counted apart from `uncheckedAnswers` because the two failures are not the
   * same: one is honest about resting on nothing, the other reads as verified.
   */
  const thinEvidence = (data?.entries ?? []).filter((e) => {
    if (e.type !== "answer" || !e.checkedAgainst) return false;
    const c = classifyCitation(e.checkedAgainst);
    return isUnlocated(c) || isWideRange(c);
  }).length;

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>{data?.room.topic ?? "…"}</h1>
          <p className="meta">
            {data ? (
              <>
                <span className="sideA">{data.room.you.label}</span>
                <span className="dot">·</span>
                <span className="sideB">{data.room.peer.label}</span>
                {data.room.peer.joinedAt === null && (
                  <span className="warn"> — has not connected yet</span>
                )}
                <span className="dot">·</span>
                <span className="mono dim">room {data.room.id}</span>
              </>
            ) : (
              "connecting…"
            )}
          </p>
        </div>
        <div className={`pulse ${live ? "on" : "off"}`}>
          <span className="led" />
          {live ? "live" : "stalled"}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {data && (
        <>
          <section className="stats">
            <div>
              <strong>{data.entries.length}</strong>
              <span>entries</span>
            </div>
            <div className={open.length ? "hot" : ""}>
              <strong>{open.length}</strong>
              <span>open question{open.length === 1 ? "" : "s"}</span>
            </div>
            <div className={uncheckedAnswers ? "flag" : ""}>
              <strong>{uncheckedAnswers}</strong>
              <span>unchecked answer{uncheckedAnswers === 1 ? "" : "s"}</span>
            </div>
            {/*
              Kept SEPARATE from unchecked, deliberately. "No citation" is an
              honest admission. A citation that names no place you could go and
              look — "the codebase" — or one spanning hundreds of lines, reads
              as verified and is not. Merging the two counts would hide the
              worse case behind the better-behaved one.
            */}
            <div className={thinEvidence ? "flag" : ""} title="Cited, but not to a place you could go and check. Counts the citation, not the answer.">
              <strong>{thinEvidence}</strong>
              <span>thin citation{thinEvidence === 1 ? "" : "s"}</span>
            </div>
          </section>

          {Object.values(signedOff).length > 0 && (
            <section className="signoff">
              {Object.values(signedOff).map((s) => (
                <div key={s.author}>
                  <strong>{s.author}</strong> signed off {timeOf(s.at)} — {s.note}
                </div>
              ))}
            </section>
          )}

          {open.length > 0 && (
            <section className="open">
              <h2>Waiting on an answer</h2>
              {open.map((q) => (
                <div key={q.id} className={`openq ${q.side === "a" ? "sideA" : "sideB"}`}>
                  <code>{q.id}</code>
                  <span className="who">{q.author} asked</span>
                  <span className="qt">{q.title}</span>
                  {reopenedIds.has(q.id) && <span className="reopened">reopened</span>}
                </div>
              ))}
            </section>
          )}

          <section className="feed">
            {data.entries.length === 0 && (
              <p className="empty">
                Nothing on the bridge yet. When either side calls <code>bridger_ask</code>, it
                appears here within {POLL_MS / 1000} seconds.
              </p>
            )}
            {data.entries.map((e) => (
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
                </div>
                {/*
                  `bridger_answer` stores its title as the first 200 chars of
                  the answer, so for answers the title is a PREFIX of the body,
                  not a summary of it. Rendering both printed every answer
                  twice. Questions are the other case — their body is genuinely
                  separate context — so the test is prefix-ness, not type.
                */}
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
                      // A citation and a gesture used to render identically —
                      // both as "✓ checked". S#271 had to audit two citations
                      // BY HAND to find that one covered 70 lines and only
                      // glancingly touched the claim. The span is a fact; show
                      // it and let the reader judge.
                      const c = classifyCitation(e.checkedAgainst);
                      const weak = isUnlocated(c) || isWideRange(c);
                      return (
                        <p className={`prov ${weak ? "thin" : "ok"}`}>
                          {weak ? "◐" : "✓"} checked against <code>{e.checkedAgainst}</code>
                          <span className="span" title="How specific the citation is. Says nothing about whether the answer is correct.">
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
          </section>

          {data.contract && (
            <section className="contract">
              <h2>Contract</h2>
              <p className="meta">
                last changed by {data.contract.updatedBy} at {timeOf(data.contract.updatedAt)}
              </p>
              <pre>{data.contract.body}</pre>
            </section>
          )}
        </>
      )}

      <footer>
        <button
          className="link"
          onClick={() => {
            sessionStorage.removeItem(STORAGE_KEY);
            setToken(null);
            setData(null);
          }}
        >
          forget token
        </button>
        <span className="dim">read-only · every write goes through the MCP tools</span>
      </footer>
    </main>
  );
}
