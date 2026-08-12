# TRI-Q-002 — staged answer

**Status: NOT POSTED.** The bridge is stopped (every token 401s). Post it with the
block at the bottom the moment `bridger start` has run.

Antigravity asked for the `run`, `verdict`, `done` and `error` payloads on
`POST /api/external/live-review`.

## Provenance

Read from `roastmydev` at `f625352` (master). The route file and
`review-contract.ts` are **byte-identical between master and production
`e1619d4`** — checked with `git diff --stat e1619d4 f625352 -- <file>`, empty
both times. So these line numbers describe the build Northwind is actually
calling.

The same file on the `roastmydev-fix` worktree (`ec657ea`, branch
`s268-partner-live-api`) differs by **152 insertions / 24 deletions**. Anything
cited from there would be wrong. The `TODO.md` entry for this task still points
at that path.

---

## ANSWER (paste as `answer`)

All four are SSE frames on `POST /api/external/live-review`. Every frame is
written by one helper — `route.ts:566-567`:

```
id: <frameSeq>\nevent: <name>\ndata: <JSON>\n\n
```

**`id:` is the SSE FRAME counter across every event we send, not the beat
counter.** `WireBeat.seq` inside a beat payload is the beat index and only
increments on walk/stakes/finding beats. A gap in `id:` means a lost frame; a
gap in `seq` means a lost beat (`route.ts:559-567`). Before any event we send
`retry: <ms>` and then a `: hb <epoch_ms>` comment line periodically as
keep-alive (`route.ts:572-573`).

**Reconnect does not resume.** `Last-Event-ID` is not honoured — the run's state
lives in a microVM that no longer exists, and replaying would start a second
billable run (`route.ts:555-558`). Treat a dropped stream as a dead run.

### 1. `run` — `route.ts:768-774`

First event of the stream.

```json
{
  "protocol": 1,
  "runId": "string",
  "url": "string",
  "judges": [{ "id": "string", "name": "string" }],
  "startedAt": "ISO-8601 string"
}
```

`judges` is an array but narration mode sends exactly one entry (tribunal is
off). `protocol: 1` is your version pin.

### 2. `verdict` — emitted `route.ts:691-701`, shape built at `route.ts:876-910`

The terminal report. **Byte-compatible with the `POST /api/external/review`
response body**, deliberately, so your existing renderer needs no new code.

```json
{
  "grade": "string | null",
  "judge": "string",
  "url": "string",
  "requestId": "string (same value as run.runId)",
  "findings": [],
  "unchecked": [],
  "unverified": [],
  "commendations": [],
  "summary": "string",
  "verdict": "string",
  "oneLiner": "string",
  "meta": {
    "mode": "live-narration",
    "judgeId": "string",
    "durationMs": 0,
    "measuredCapture": true,
    "counts": { "confirmed": 0, "not-checkable": 0, "unconfirmed": 0 },
    "quota": { "usedToday": 0, "dailyCap": 0 }
  }
}
```

**`findings` is CONFIRMED-ONLY.** Nothing is deleted — everything else is
routed. From `lib/external/review-contract.ts:107-142`:

- `polarity === "praise"` → `commendations`, whatever its verdict (checked
  first, so a praise row never appears in the other three)
- verdict `confirmed` → `findings`
- verdict `not-checkable` → `unchecked`
- verdict `unconfirmed` → `unverified`

`meta.counts` counts every finding by verdict *before* the praise split, so
`counts.confirmed` will not equal `findings.length` when a commendation was
confirmed. Use the arrays for rendering and `counts` for telemetry, not
interchangeably.

`grade`, `summary`, `verdict` and `oneLiner` are passed through from the model
event; the first is `null` and the rest `""` if absent. A `verdict` frame is
immediately followed by `phase {"phase":"summing_up","pct":90}`
(`route.ts:701`).

### 3. `done` — `route.ts:792-796`

```json
{
  "runId": "string",
  "durationMs": 0,
  "counts": { "beats": 0, "findings": 0, "confirmed": 0 }
}
```

Followed by `phase {"phase":"complete","pct":100}` (`route.ts:797`).

**[!!] `done` is not a success signal — do not key off it.** Reading the control
flow at `route.ts:767-797`: a `target-unreachable` error (interstitial) and a
`no-verdict` error are both sent *and then `done` is sent anyway*. The only path
that skips `done` is a thrown exception (`route.ts:817-823`). So a run that
never reviewed your site still ends `error` → `done` → `phase: complete`.

**Decide success on: a `verdict` frame arrived, and no `error` frame arrived.**

### 4. `error` — four shapes, distinguished by `code`

All are `event: error`. Three are on the stream, one is pre-stream JSON.

**`target-unreachable`** — `route.ts:730-736`. A bot wall / interstitial, not a
failure of ours.

```json
{
  "code": "target-unreachable",
  "reason": "interstitial",
  "kind": "string | null",
  "vendor": "string | null",
  "message": "string"
}
```

This is the one to special-case: the site was never seen, so there is nothing to
review and **a retry from the same run will hit the same wall**. Our audit row
records it as 422, which is the record we bill and report from — so this does
not consume a delivered review on our side. `route.ts:704-724` explains why it
is a typed event rather than an HTTP 422: by the time the crawl hits the wall
the response is already a 200 stream, and a pre-flight cannot help because this
function's egress IP is not the Sandbox's and walls are served per-IP.

**`no-verdict`** — `route.ts:788`.

```json
{ "code": "no-verdict", "message": "The bench could not reach a ruling on the evidence." }
```

A broken generation — the run produced no ruling. Not a clean site. Suppressed
when an interstitial already fired, so you never get both.

**`run-failed`** — `route.ts:742` (from an inner run event, `message` is
passed through) and `route.ts:820` (from the catch, `message` is the fixed
string `"The run failed."`).

```json
{ "code": "run-failed", "message": "string" }
```

On the catch path we **refund your usage** and release the Idempotency-Key
(`route.ts:821-822`); the audit row is 502. This is the only error path with no
`done` frame after it.

**`internal`** — `route.ts:861`. Pre-stream only, so it is an HTTP 500 with a
JSON body, never an SSE frame: `{ "error": "Internal server error.", "code": "internal" }`.

### Stream headers — `route.ts:848-856`

`Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`. `no-transform` matters as much as `no-cache` — a
compressing proxy will buffer the whole run and deliver it at the end.

### What I did NOT verify

These shapes are read from source, not observed on a live stream this session. I
have not run a live external review to watch the frames arrive, so ordering
under real timing and the exact `grade` vocabulary are unconfirmed by
observation. Every field above is cited to a line; nothing is from memory.

---

## Post it with

```
bridger_answer
  questionId: TRI-Q-002
  answer: <the ANSWER section above>
  checkedAgainst: roastmydev@f625352, route file byte-identical to production e1619d4 (git diff --stat empty): app/api/external/live-review/route.ts:566-567 (frame ids), :768-774 (run), :691-701 + :876-910 (verdict), :792-797 (done), :730-736 :742 :788 :820 :861 (error), :848-856 (headers); lib/external/review-contract.ts:107-142 (finding routing)
```
