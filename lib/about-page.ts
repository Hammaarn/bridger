/**
 * `/api/about`, FOR A PERSON — without giving a machine a different answer.
 *
 * THE CHARGE. A JudgeMySite review (S#285) found that this endpoint is linked
 * from the landing page three times as a trust document a cautious human is
 * expected to read, and is served raw into the browser with no title, no `lang`
 * and no presentation. It was right. The content here is the most carefully
 * written prose in the project — permissions, retention, and the `cannotVerify`
 * list we would rather state than have a reader discover — and it arrived as an
 * unbroken wall of JSON.
 *
 * WHAT THIS IS NOT. The review proposed an HTML page that fetches `/api/about`
 * and renders it client-side. That is circular (this IS `/api/about`), and it
 * would have broken the thing the endpoint exists for: an agent with no
 * JavaScript would get an empty shell instead of the document it came to read.
 * Its other suggestion — "serve `application/json` and let the browser's viewer
 * handle it" — was already what we shipped.
 *
 * SO: CONTENT NEGOTIATION, AND THE MACHINE PATH IS THE DEFAULT.
 * HTML is served only when a client *explicitly* asks for `text/html`. A browser
 * does. `curl` (which sends a wildcard Accept), `fetch` and every agent do not,
 * so they keep the exact bytes they got before. The rule is deliberately not
 * "is it a browser" — user-agent sniffing is a guess, an Accept header is a
 * statement.
 *
 * THE HTML IS GENERATED FROM THE SAME OBJECT, never hand-written. A second copy
 * of these claims is precisely how the page came to say "one exception" while
 * `/api/about` described two (fixed the same session). One source, two
 * renderings — the rule `lib/site-content.ts` already sets for the landing page.
 */

/**
 * Serve HTML only on an explicit `text/html`.
 *
 * A wildcard Accept is not a request for HTML, it is the absence of a
 * preference, and the
 * absence of a preference must keep resolving to the machine answer — every
 * verification command in `VERIFY.md`, on the landing page and in this repo's
 * own docs is a bare `curl`, and all of them must keep working byte-for-byte.
 */
export function prefersHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  if (!lower.includes("text/html")) return false;
  // An explicit application/json ranked ahead of text/html wins: a client that
  // named both and put JSON first is asking for JSON.
  const html = lower.indexOf("text/html");
  const json = lower.indexOf("application/json");
  return json === -1 || html < json;
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** A bare URL becomes a link; everything else is escaped text. */
function linkify(text: string): string {
  return esc(text).replace(
    /https?:\/\/[^\s<>"')]+/g,
    (u) => `<a href="${u}" rel="noreferrer noopener">${u}</a>`,
  );
}

/**
 * `callsAModel` -> "Calls A Model".
 *
 * Two passes, and the second is the one that is easy to forget: splitting only
 * on lower-then-upper leaves a run of capitals fused to the word after it, so
 * this key rendered as "Calls AModel" on the first try. The second pass breaks
 * the boundary INSIDE a capital run, where the last capital starts a new word.
 */
const label = (k: string) =>
  esc(
    k
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/^./, (c) => c.toUpperCase()),
  );

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return `<span class="nil">not set</span>`;
  if (typeof v === "boolean") return `<span class="bool">${v ? "yes" : "no"}</span>`;
  if (typeof v === "number") return `<span class="num">${v.toLocaleString("en-GB")}</span>`;
  if (typeof v === "string") return `<p>${linkify(v)}</p>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `<span class="nil">none</span>`;
    return `<ul>${v.map((x) => `<li>${renderValue(x)}</li>`).join("")}</ul>`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  return `<dl>${entries
    .map(([k, val]) => `<dt>${label(k)}</dt><dd>${renderValue(val)}</dd>`)
    .join("")}</dl>`;
}

/**
 * Colours are duplicated from `globals.css` rather than imported, and that is a
 * known cost stated rather than hidden: a route handler cannot resolve the
 * hashed stylesheet bundle, and linking the app's CSS to style six elements
 * would ship the whole design system to a document that needs a background and
 * two text colours. Kept to the smallest set that can drift.
 */
const STYLE = `
:root { color-scheme: dark }
* { box-sizing: border-box }
body {
  margin: 0; padding: 56px 24px 96px;
  background: #07080a; color: #e9ebef;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 820px; margin: 0 auto }
.eyebrow {
  font: 600 11.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .14em; text-transform: uppercase; color: #7d8695; margin: 0 0 14px;
}
h1 { font-size: clamp(28px, 4.4vw, 40px); line-height: 1.12; letter-spacing: -.02em; margin: 0 0 12px }
.lede { color: #a6adba; margin: 0 0 10px; font-size: 16px }
.note { color: #7d8695; font-size: 13px; margin: 0 0 40px }
.note code { color: #a6adba }
h2 {
  font-size: 20px; line-height: 1.25; letter-spacing: -.015em;
  margin: 40px 0 12px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.09);
}
p { margin: 0 0 10px }
dl { margin: 0 }
dt {
  font: 600 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .06em; text-transform: uppercase; color: #7d8695; margin: 14px 0 4px;
}
dd { margin: 0 0 4px }
ul { margin: 0 0 10px; padding-left: 18px }
li { margin: 0 0 8px }
a { color: #9fc4e8; text-underline-offset: 2px }
a:hover { color: #cfe3f7 }
.bool, .num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd5df }
.nil { color: #6b7280; font-style: italic }
footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.09); color: #7d8695; font-size: 13px }
`.trim();

/**
 * Sections rendered in the order a reader needs them rather than the order the
 * object happens to declare them: what it is, then what it can reach, then what
 * it cannot prove. Any key NOT listed here still renders, after these — so
 * adding a field to the payload can never silently drop it from the page.
 */
const ORDER = [
  "what",
  "operator",
  "source",
  "build",
  "permissions",
  "callsAModel",
  "callsAModelDetail",
  "dataHandling",
  "retention",
  "limits",
  "safety",
  "cannotVerify",
  "recommendedBeforeTrusting",
  "endpoints",
];

export function renderAboutHtml(about: Record<string, unknown>, origin: string): string {
  const seen = new Set(["service"]);
  const keys = [
    ...ORDER.filter((k) => k in about),
    ...Object.keys(about).filter((k) => !ORDER.includes(k) && k !== "service"),
  ];

  const body = keys
    .map((k) => {
      seen.add(k);
      const v = about[k];
      // `what` is the opening statement, not a section with a heading.
      if (k === "what") return `<p class="lede">${linkify(String(v))}</p>`;
      return `<h2>${label(k)}</h2>${renderValue(v)}`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What this server is — Bridger</title>
<meta name="description" content="What Bridger is, what it can reach, and what it cannot prove about itself.">
<meta name="theme-color" content="#07080a">
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">bridger / api / about</p>
<h1>What this server is</h1>
${body}
<footer>
<p>This page is a rendering of the JSON at <a href="${esc(origin)}/api/about">${esc(origin)}/api/about</a> —
same bytes, same source. Ask for it with <code>curl</code> or any Accept header that is not
<code>text/html</code> and you get the machine version.</p>
<p><a href="${esc(origin)}/">Back to Bridger</a></p>
</footer>
</main>
</body>
</html>`;
}
