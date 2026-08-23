/**
 * SEAT IDENTITY — colour and mark. (S#281)
 *
 * Two problems, one module, because they are the same problem seen twice:
 * **you cannot tell who is who.** The live cross-company room has
 * `label: "claude"` on BOTH sides, and a solo room is worse by construction —
 * every seat is a model and several of them are called Claude something.
 *
 * `identify` (S#280) fixed the naming half. This is the seeing half.
 */

import type { SideId } from "./room-registry";

/**
 * THE PALETTE, and it is a fixed set rather than a colour wheel.
 *
 * A free picker lets someone choose a hue that vanishes against the page in one
 * theme, or lands on `--seal` — the colour reserved for provenance — and
 * reintroduces exactly the confusion it was opened to fix. Every entry here is
 * checked against both themes, and the seal's warm orange is deliberately
 * ABSENT: a seat that looks like a citation badge is a worse bug than two seats
 * that look alike.
 *
 * `light`/`dark` are the two renderings of one idea, not two colours. The name
 * is what a person picks by, so it has to be a word rather than a hex.
 */
export interface SeatColour {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const SEAT_COLOURS: SeatColour[] = [
  { id: "azure", name: "Azure", light: "#9cc4f0", dark: "#2b5c8f" },
  { id: "moss", name: "Moss", light: "#a8d5b5", dark: "#2f6b45" },
  { id: "plum", name: "Plum", light: "#d3b3e8", dark: "#5c3a78" },
  { id: "clay", name: "Clay", light: "#e8b3a8", dark: "#8a4436" },
  { id: "slate", name: "Slate", light: "#b8c2cc", dark: "#4a5560" },
  { id: "gold", name: "Gold", light: "#e8d5a0", dark: "#7a6420" },
];

/**
 * The default for seat N, chosen so the FIRST TWO match what a trust room has
 * always looked like.
 *
 * Changing the colours of the two-party room while adding a feature nobody
 * asked for it in would be a gratuitous break: `--side-a` is azure and
 * `--side-b` was warm orange, and the warm orange is the one that collided with
 * `--seal`. So `a` keeps its blue, `b` moves to a green that cannot be mistaken
 * for a provenance badge, and the rest follow.
 */
export function defaultColourFor(seat: SideId): SeatColour {
  const i = "abcdef".indexOf(seat);
  return SEAT_COLOURS[i >= 0 ? i % SEAT_COLOURS.length : 0]!;
}

export function colourById(id: string | null | undefined): SeatColour | null {
  if (!id) return null;
  return SEAT_COLOURS.find((c) => c.id === id) ?? null;
}

/**
 * WHICH VENDOR A SEAT IS, guessed from the name the operator typed.
 *
 * Guessed, and that word is load-bearing. Nothing here VERIFIES anything: a
 * transport cannot know what model is on the other end of a bearer token, and
 * S#280 settled that `agent` renders as a self-declared badge with no
 * verification affordance. This is the same claim with a colour attached.
 *
 * So it reads a label the operator chose, for the operator's own benefit, in a
 * room where every seat is theirs. It is a convenience for telling your own
 * three tabs apart — never evidence about who you are talking to.
 *
 * **These are NOT the vendors' logos.** They are a letterform and a brand-
 * adjacent hue. Shipping inlined copies of Anthropic's, Google's and OpenAI's
 * trademarks from our own origin on a public product is a call about somebody
 * else's business, and nominative fair use covering it does not make it
 * automatic. Swapping in official artwork is one map below and the operator's
 * decision. (`DECISIONS.md` 2026-08-23.)
 */
export interface VendorMark {
  id: string;
  /** What renders in the mark. One or two characters. */
  glyph: string;
  /** Display name, for the title attribute and screen readers. */
  name: string;
  hue: string;
}

const VENDORS: { match: RegExp; mark: VendorMark }[] = [
  { match: /\bclaude\b|\banthropic\b|\bopus\b|\bsonnet\b|\bhaiku\b/i,
    mark: { id: "anthropic", glyph: "A", name: "Claude", hue: "#d97757" } },
  { match: /\bgemini\b|\bgoogle\b|\bbard\b/i,
    mark: { id: "google", glyph: "G", name: "Gemini", hue: "#4285f4" } },
  { match: /\bgpt\b|\bopenai\b|\bchatgpt\b|\bo\d\b/i,
    mark: { id: "openai", glyph: "O", name: "GPT", hue: "#10a37f" } },
  { match: /\bllama\b|\bmeta\b/i,
    mark: { id: "meta", glyph: "L", name: "Llama", hue: "#0668e1" } },
  { match: /\bmistral\b|\bmixtral\b/i,
    mark: { id: "mistral", glyph: "M", name: "Mistral", hue: "#ff7000" } },
  { match: /\bgrok\b|\bxai\b/i,
    mark: { id: "xai", glyph: "X", name: "Grok", hue: "#8b8b8b" } },
  { match: /\bdeepseek\b/i,
    mark: { id: "deepseek", glyph: "D", name: "DeepSeek", hue: "#4d6bfe" } },
  { match: /\bperplexity\b/i,
    mark: { id: "perplexity", glyph: "P", name: "Perplexity", hue: "#20808d" } },
  { match: /\bcopilot\b/i,
    mark: { id: "copilot", glyph: "C", name: "Copilot", hue: "#0078d4" } },
  { match: /\bqwen\b|\balibaba\b/i,
    mark: { id: "qwen", glyph: "Q", name: "Qwen", hue: "#615ced" } },
];

/**
 * Recognise a vendor, or return null.
 *
 * **Null is a first-class answer and must render as a monogram**, not as a
 * fallback logo. Guessing wrong is worse than not guessing: a seat labelled
 * "backend team" wearing an OpenAI mark is a false statement about who is in
 * the room, in a product whose entire argument is that its record is
 * trustworthy.
 */
export function vendorFor(label: string | null | undefined): VendorMark | null {
  if (!label) return null;
  for (const v of VENDORS) if (v.match.test(label)) return v.mark;
  return null;
}

/** The two-letter fallback when no vendor is recognised. */
export function monogramFor(label: string | null | undefined): string {
  const clean = (label ?? "").trim();
  if (!clean) return "??";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}
