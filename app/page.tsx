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

interface Entry {
  id: string;
  seq: number;
  type: "question" | "answer" | "decision" | "note" | "contract";
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
};

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
        <style jsx>{styles}</style>
        <style jsx global>{globalStyles}</style>
      </main>
    );
  }

  const answered = new Set((data?.entries ?? []).filter((e) => e.answers).map((e) => e.answers));
  const open = (data?.entries ?? []).filter((e) => e.type === "question" && !answered.has(e.id));
  const uncheckedAnswers = (data?.entries ?? []).filter(
    (e) => e.type === "answer" && !e.checkedAgainst,
  ).length;

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
          </section>

          {open.length > 0 && (
            <section className="open">
              <h2>Waiting on an answer</h2>
              {open.map((q) => (
                <div key={q.id} className={`openq ${q.side === "a" ? "sideA" : "sideB"}`}>
                  <code>{q.id}</code>
                  <span className="who">{q.author} asked</span>
                  <span className="qt">{q.title}</span>
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
                  <span className="verb">{TYPE_LABEL[e.type]}</span>
                  {e.answers && <code className="ref">→ {e.answers}</code>}
                  <span className="time mono dim">{timeOf(e.ts)}</span>
                </div>
                <p className="title">{e.title}</p>
                {e.body && e.body !== e.title && <p className="body">{e.body}</p>}
                {e.why && (
                  <p className="why">
                    <span>why</span> {e.why}
                  </p>
                )}
                {e.type === "answer" &&
                  (e.checkedAgainst ? (
                    <p className="prov ok">
                      ✓ checked against <code>{e.checkedAgainst}</code>
                    </p>
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

      <style jsx>{styles}</style>
      <style jsx global>{globalStyles}</style>
    </main>
  );
}

const globalStyles = `
  :root {
    --bg: #faf9f7; --panel: #ffffff; --ink: #1a1a19; --dim: #6b6b66;
    --line: #e4e2dd; --a: #2f6f4f; --b: #7a4a1f; --bad: #a3341f; --hot: #8a6d1f;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f; --panel: #1c1c17; --ink: #eceae4; --dim: #8f8d85;
      --line: #2c2c25; --a: #7fc59c; --b: #d8a06a; --bad: #e8735a; --hot: #d8bd6a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
`;

const styles = `
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em;
       color: var(--dim); margin: 28px 0 10px; font-weight: 600; }
  .meta { margin: 0; color: var(--dim); font-size: 13px; }
  .dim { color: var(--dim); }
  .dot { margin: 0 7px; color: var(--line); }
  .sideA { color: var(--a); } .sideB { color: var(--b); }
  .warn { color: var(--hot); }

  .top { display: flex; justify-content: space-between; align-items: flex-start;
         gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 16px; }
  .pulse { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); }
  .led { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .pulse.on .led { background: var(--a); animation: blink 2s ease-in-out infinite; }
  .pulse.off .led { background: var(--bad); }
  @keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

  .error { margin: 16px 0; padding: 12px 14px; border-radius: 6px;
           background: color-mix(in srgb, var(--bad) 12%, transparent);
           border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent); font-size: 14px; }

  .stats { display: flex; gap: 28px; margin: 20px 0 4px; }
  .stats div { display: flex; flex-direction: column; }
  .stats strong { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .stats span { font-size: 12px; color: var(--dim); }
  .stats .hot strong { color: var(--hot); }
  .stats .flag strong { color: var(--bad); }

  .openq { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
           padding: 9px 12px; border-left: 2px solid currentColor;
           background: var(--panel); border-radius: 0 5px 5px 0; margin-bottom: 6px; }
  .openq code { font-size: 12px; }
  .openq .who { font-size: 12px; color: var(--dim); }
  .openq .qt { color: var(--ink); font-size: 14px; }

  .feed { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
  .empty { color: var(--dim); font-size: 14px; padding: 24px 0; }
  .entry { background: var(--panel); border: 1px solid var(--line);
           border-left: 3px solid currentColor; border-radius: 0 7px 7px 0; padding: 12px 14px; }
  .entry.flash { animation: land 2s ease-out; }
  @keyframes land { from { background: color-mix(in srgb, currentColor 16%, var(--panel)); } }
  .head { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; margin-bottom: 5px; }
  .id { font-size: 12px; font-weight: 600; }
  .author { font-size: 13px; color: var(--ink); font-weight: 500; }
  .verb { font-size: 12px; color: var(--dim); }
  .ref { font-size: 11px; color: var(--dim); }
  .time { font-size: 11px; margin-left: auto; }
  .title { margin: 0; color: var(--ink); }
  .body { margin: 6px 0 0; color: var(--dim); font-size: 14px; white-space: pre-wrap; }
  .why { margin: 8px 0 0; font-size: 13px; color: var(--dim); }
  .why span { text-transform: uppercase; font-size: 10px; letter-spacing: .08em;
              margin-right: 6px; opacity: .7; }
  .prov { margin: 9px 0 0; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .prov.ok { color: var(--a); }
  .prov.bad { color: var(--bad); }
  .prov code { font-size: 12px; }

  .contract pre { background: var(--panel); border: 1px solid var(--line); border-radius: 7px;
                  padding: 14px; overflow-x: auto; font-size: 13px; margin: 8px 0 0; }

  footer { display: flex; justify-content: space-between; align-items: center; gap: 12px;
           margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--line);
           font-size: 12px; flex-wrap: wrap; }
  .link { background: none; border: 0; color: var(--dim); cursor: pointer;
          text-decoration: underline; font: inherit; padding: 0; }

  .gate { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
  .gate-card { width: 100%; max-width: 380px; background: var(--panel);
               border: 1px solid var(--line); border-radius: 10px; padding: 26px; }
  .sub { margin: 0 0 20px; color: var(--dim); font-size: 14px; }
  label { display: block; font-size: 12px; color: var(--dim); margin-bottom: 6px; }
  input { width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 6px;
          background: var(--bg); color: var(--ink); font-family: ui-monospace, Menlo, monospace;
          font-size: 13px; }
  input:focus { outline: 2px solid var(--a); outline-offset: 1px; }
  button[type="submit"] { width: 100%; margin-top: 12px; padding: 9px; border: 0; border-radius: 6px;
                          background: var(--ink); color: var(--bg); font: inherit;
                          font-weight: 500; cursor: pointer; }
  .fine { margin: 16px 0 0; font-size: 11.5px; color: var(--dim); line-height: 1.5; }

  @media (max-width: 560px) {
    .stats { gap: 18px; }
    .time { margin-left: 0; }
  }
`;
