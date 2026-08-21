"use client";

import { useEffect, useState } from "react";

import Wire, { type WireProps } from "./wire";
import LetterGlitch from "./letter-glitch";

/**
 * THE BACKGROUND SLOT — one place that decides what the page is made of.
 *
 * Erik's ask, verbatim: keep the wave, but be able to swap it out MOMENTARILY
 * to see what fits the vibe better. That is a comparison problem, not a
 * replacement one, and the two have very different answers. Replacing means
 * editing `page.tsx` and losing the thing you were comparing against; comparing
 * means both exist and the choice is one keystroke.
 *
 * So the variant comes from `?bg=` in the URL and nothing else. No build step,
 * no env var, no state to reset — two browser tabs side by side, one URL each,
 * and the page is otherwise identical. `wire` is the default, so production is
 * unaffected by any of this and a visitor who never types a query string never
 * knows it exists.
 *
 * Read in an effect rather than during render, deliberately: the server has no
 * query string in scope here, so resolving it inline would hydrate one tree and
 * then swap it, which React flags. First paint is always the default.
 */
export type BackgroundVariant = "wire" | "glitch";

const VARIANTS: BackgroundVariant[] = ["wire", "glitch"];
const DEFAULT: BackgroundVariant = "wire";

export function useBackgroundVariant(): BackgroundVariant {
  const [variant, setVariant] = useState<BackgroundVariant>(DEFAULT);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("bg");
    if (q && (VARIANTS as string[]).includes(q)) setVariant(q as BackgroundVariant);
  }, []);
  return variant;
}

export interface BackgroundProps extends WireProps {
  /**
   * The word the glitch field resolves into. Ignored by the wire, which has no
   * text in it — the slot deliberately takes the UNION of both variants' props
   * rather than a lowest common denominator, so neither is crippled to fit.
   */
  word?: string;
  /** False on the thin strip, where a word has no room to form. */
  showWord?: boolean;
  /** Cell height for the glitch grid -- the word's vertical resolution. */
  cellH?: number;
  /** Fraction of the width the glitch word aims to fill. */
  wordWidth?: number;
}

export default function Background({ word, showWord, cellH, wordWidth, ...wire }: BackgroundProps) {
  const variant = useBackgroundVariant();

  if (variant === "glitch") {
    return (
      <LetterGlitch
        className={wire.className}
        word={word}
        showWord={showWord}
        cellH={cellH}
        wordWidth={wordWidth}
        intensity={wire.intensity}
        ping={wire.ping}
      />
    );
  }
  return <Wire {...wire} />;
}

/**
 * The comparison control, and it only exists once you have asked for one.
 *
 * Rendered ONLY when `?bg=` is already in the URL. A visitor who arrives at the
 * bare domain gets the wave and no chrome; whoever is comparing gets a switch
 * without having to hand-edit a query string every time. That gate is the whole
 * reason this is safe to leave in the page.
 */
export function BackgroundSwitch() {
  const [armed, setArmed] = useState(false);
  const current = useBackgroundVariant();

  useEffect(() => {
    setArmed(new URLSearchParams(window.location.search).has("bg"));
  }, []);

  if (!armed) return null;

  return (
    <div className="bg-switch" role="group" aria-label="Background">
      {VARIANTS.map((v) => (
        <a key={v} href={`?bg=${v}`} data-on={v === current ? "" : undefined}>
          {v}
        </a>
      ))}
    </div>
  );
}
