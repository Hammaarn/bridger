/**
 * THE STATUS CODE MUST AGREE WITH `terminal`.
 *
 * This file exists because it did not, for the whole life of the project until
 * S#276, and nothing could have caught it: every unit test asserted the BODY,
 * which was always right. The status code — the part an HTTP client acts on
 * before a model reads one token of the body — was inverted.
 *
 * `daily-cap` and `room-daily-cap` returned **429** while being terminal. 429 is
 * the canonical "come back shortly" and is retried automatically by client
 * libraries and SDK retry middleware. So the two refusals whose entire job is to
 * stop a runaway loop were instructing the transport to continue it, underneath
 * the layer where our refusal text could be understood. The `STOP.` idle brake
 * on the flat transport had the same shape.
 *
 * The rule these tests enforce, stated once:
 *
 *   1. A TERMINAL refusal never returns a status that invites a retry (429).
 *   2. Any status that DOES invite a retry (429, 503) must carry `Retry-After`.
 *   3. A recoverable refusal never returns a status that reads as permanent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DENY_STATUS,
  DENY_MESSAGE,
  TERMINAL_DENIALS,
  retryAfterSeconds,
  type DenyReason,
} from "../room-registry";
import { operationRefusalStatus, refusalBody, refusalHeaders } from "../http-gate";
import { T0 } from "./fake-store";

const REASONS = Object.keys(DENY_STATUS) as DenyReason[];

/** Statuses whose defined meaning is "try this again later". */
const INVITES_RETRY = new Set([429, 503]);

describe("refusal status codes agree with `terminal`", () => {
  it("covers every reason in the vocabulary — no reason escapes these rules", () => {
    // A guard on the guard: if someone adds a DenyReason and forgets a status,
    // that must fail here rather than surface as `undefined` in a header.
    assert.ok(REASONS.length >= 11, "expected the full deny vocabulary");
    for (const r of REASONS) {
      assert.equal(typeof DENY_STATUS[r], "number", `${r} has no status`);
      assert.equal(typeof DENY_MESSAGE[r], "string", `${r} has no message`);
    }
  });

  it("[!!] no TERMINAL refusal returns 429 — the bug that shipped", () => {
    for (const reason of REASONS) {
      if (!TERMINAL_DENIALS.has(reason)) continue;
      assert.notEqual(
        DENY_STATUS[reason],
        429,
        `${reason} is terminal but returns 429, which every conformant client retries`,
      );
    }
  });

  it("every status that invites a retry carries Retry-After", () => {
    for (const reason of REASONS) {
      if (!INVITES_RETRY.has(DENY_STATUS[reason])) continue;
      const headers = refusalHeaders(reason, T0);
      assert.ok(
        headers["Retry-After"],
        `${reason} returns ${DENY_STATUS[reason]} with no Retry-After — a naive client picks its own interval`,
      );
      assert.ok(
        Number(headers["Retry-After"]) > 0,
        `${reason} must never advertise an immediate retry`,
      );
    }
  });

  it("no Retry-After on refusals that do not invite one", () => {
    // A Retry-After on a 403 is a mixed signal, and mixed signals are what this
    // whole file is about.
    for (const reason of REASONS) {
      if (INVITES_RETRY.has(DENY_STATUS[reason])) continue;
      assert.deepEqual(
        refusalHeaders(reason, T0),
        {},
        `${reason} is not retryable but advertises Retry-After`,
      );
    }
  });

  it("the body's `terminal` never contradicts the status", () => {
    for (const reason of REASONS) {
      const body = refusalBody(reason);
      if (body.terminal) {
        assert.notEqual(DENY_STATUS[reason], 429, `${reason}: terminal body, retryable status`);
      } else {
        // A recoverable refusal must not read as permanently forbidden.
        assert.notEqual(DENY_STATUS[reason], 403, `${reason}: recoverable body, permanent status`);
      }
    }
  });

  it("rate-limited is the one genuinely retryable refusal, and it says when", () => {
    // NEGATIVE CONTROL for the rule above: if the rules were vacuous — if
    // nothing was allowed to be retryable — they would pass trivially. Exactly
    // one reason must be 429, and it must be the per-minute limiter.
    const retryable = REASONS.filter((r) => DENY_STATUS[r] === 429);
    assert.deepEqual(retryable, ["rate-limited"]);
    assert.equal(TERMINAL_DENIALS.has("rate-limited"), false);
  });

  it("Retry-After for the rate limiter tracks the minute bucket, not a constant", () => {
    // The limiter is a per-minute bucket, so the honest answer is "when this
    // minute ends" — a fixed 60 would tell a caller at :59 to wait a full
    // minute for a window opening in one second.
    const at10s = retryAfterSeconds("rate-limited", new Date("2026-08-11T10:00:10.000Z"));
    const at50s = retryAfterSeconds("rate-limited", new Date("2026-08-11T10:00:50.000Z"));
    assert.equal(at10s, 50);
    assert.equal(at50s, 10);
    assert.ok(at50s! < at10s!, "later in the minute must mean a shorter wait");
  });

  it("never advertises a zero or negative wait at the minute boundary", () => {
    assert.equal(retryAfterSeconds("rate-limited", new Date("2026-08-11T10:00:00.000Z")), 60);
    assert.ok(retryAfterSeconds("rate-limited", new Date("2026-08-11T10:00:59.999Z"))! >= 1);
  });
});

describe("operation refusals — the mapping the idle brake rides on", () => {
  /**
   * The `STOP.` brake is `terminal: true`. Until S#276 that produced a 429 on
   * the flat transport, so the refusal built to end a runaway loop returned the
   * status every HTTP client retries. This is the assertion that would have
   * caught it — and it could not exist, because the mapping was three
   * characters of ternary inside a route handler.
   */
  it("[!!] a terminal operation refusal is never 429", () => {
    assert.notEqual(operationRefusalStatus(true), 429);
  });

  it("terminal means permanently refused", () => {
    assert.equal(operationRefusalStatus(true), 403);
  });

  it("recoverable means 'your request was wrong', not 'you are forbidden'", () => {
    // NEGATIVE CONTROL: if this returned 403 too, the first assertion would
    // pass while the mapping carried no information at all.
    assert.equal(operationRefusalStatus(false), 400);
    assert.notEqual(operationRefusalStatus(false), operationRefusalStatus(true));
  });
});
