"use client";

import { useEffect, useRef } from "react";

/**
 * THE GLITCH FIELD — a wall of noise that resolves into one word.
 *
 * The technique is React Bits' `LetterGlitch` (a character grid on a canvas,
 * a slice of cells re-rolled on a timer, colours lerped toward a target). The
 * borrow is the TECHNIQUE, not the code — same convention as the wire's use of
 * gradient noise. What is ours is what the noise does: it converges.
 *
 * WHY THIS SHAPE FITS THE PRODUCT. Bridger is two companies' sessions writing
 * into one record. So the field is two-coloured — side A's hue on the left,
 * side B's on the right, the same `--side-a`/`--side-b` tokens the wire already
 * spreads its dots between — and the WORD forms where they meet, in a single
 * neutral that belongs to neither side. Noise is two colours; agreement is one.
 * The word assembles cell by cell out of the churn, holds, and dissolves back.
 *
 * WHY IT IS NOT DRAWN EVERY FRAME. A full grid at a wide viewport is ~10k
 * cells, and `fillText` is far more expensive than `fillRect` — repainting all
 * of them at 60fps does not fit in a frame budget. It does not need to: on any
 * given frame only a few hundred cells actually change (the glitch slice, the
 * cells crossing their reveal threshold, and whatever a spark is touching). So
 * this keeps the grid as state and repaints DIRTY CELLS ONLY, clearing and
 * redrawing each one. The cost tracks what changed rather than what exists.
 */

/** Cell size in CSS px. Bigger cells mean fewer glyphs and a coarser wall. */
const CELL_W = 12;
/** Default cell height. Overridable per instance -- see `cellH`. */
const CELL_H = 20;
/**
 * The glyph is drawn centred in its cell and only ITS OWN cell is cleared before
 * the repaint, so a font taller than the cell leaves ink no one erases. Deriving
 * the size from the cell keeps that safe at any grid: 0.7 x 20 is 14, which is
 * exactly what this shipped with.
 */
const fontPxFor = (cellH: number) => Math.round(cellH * 0.7);

const GLYPHS = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/\\<>[]{}=+*#$%&@?!:;-_");

/** How much of the grid re-rolls on each glitch tick. */
const CHURN = 0.045;

/** Seconds for one full assemble-hold-dissolve cycle of the word. */
const CYCLE_S = 16;

/** Radius of a spark's glow, in cells. */
const SPARK_R = 3;

/**
 * THE SWEEP — a band of light travelling right to left across the field.
 *
 * It runs against the reading direction on purpose. Left-to-right rides along
 * with the eye and disappears into the text; right-to-left is counter to it and
 * registers as its own movement, which is what makes the wall feel alive rather
 * than merely busy.
 *
 * WHY IT IS QUANTISED. Everything here repaints dirty cells only, and a sweep is
 * the one effect that threatens that: a brightness varying continuously with x
 * makes every cell change every frame, which is the full 10k-glyph repaint this
 * design exists to avoid. But the sweep is a function of COLUMN ALONE — every
 * cell in a column shares it — so its level is computed per column, quantised
 * into steps, and a column is marked dirty only when it crosses a step
 * boundary. A handful of columns cross per frame. The banding is invisible at
 * 28 steps and the cost stays proportional to what actually moved.
 */
const SWEEP_SECONDS = 7.5;
const SWEEP_WIDTH = 0.16;
const SWEEP_STEPS = 28;

interface Cell {
  ch: string;
  /** 0 = pure noise, 1 = fully part of the word. */
  locked: boolean;
  /** Reveal level at which this cell joins the word. Fixed per cell, so the
   *  word always assembles in the same scattered order rather than sweeping. */
  threshold: number;
  /** Whether the cell falls inside the word's letterforms. */
  inWord: boolean;
  /**
   * Just OUTSIDE the letterforms -- the counters of a B, the gap between two
   * letters, the halo around the whole word.
   *
   * Measured before this existed: word cells sat at median luminance 47.7 while
   * 5.8% of wall cells ran BRIGHTER, up to 200. The `hot` minority is why the
   * wall has colour at all, so it cannot go; but a hot cell landing inside the
   * counter of a D closes that counter, and there are enough of them to close
   * most counters most of the time. So the wall is damped in the word's
   * immediate neighbourhood only, which is the difference between a word that
   * is brighter than its surroundings and a word that is legible.
   */
  nearWord: boolean;
  /** 0..1 across the field, for the two-sided hue. */
  mix: number;
  /** Base alpha, so the wall has depth rather than being uniform. */
  dim: number;
  /**
   * A minority of cells burn brighter than the rest.
   *
   * The field is two-coloured on purpose -- side A's hue on the left, side B's
   * on the right -- but hue does not survive low alpha on a black ground: a
   * uniformly dim wall reads grey no matter what colour it is. Raising the
   * average would drown the headline, so instead a small fraction of cells run
   * hot. The mean stays low, the colour becomes visible, and the wall gains the
   * uneven density that keeps it from looking printed.
   */
  hot: boolean;
  /** Spark brightness, decaying. */
  spark: number;
  dirty: boolean;
}

interface Spark {
  col: number;
  row: number;
  born: number;
}

export interface LetterGlitchProps {
  className?: string;
  /** The word that forms out of the noise. */
  word?: string;
  /** Milliseconds between glitch ticks. Lower is more frantic. */
  glitchMs?: number;
  /** Peak alpha of the field. */
  intensity?: number;
  /** Bump to fire a burst of sparks — a real arrival on the bridge. */
  ping?: number;
  /** Set false for the thin strip, where a word would not fit. */
  showWord?: boolean;
  /**
   * Cell height in CSS px. The word is sampled at one mask pixel per cell, so
   * this is the VERTICAL RESOLUTION the letterforms get -- in a 260px band, 20
   * buys 13 rows and the counters of B, R, D and G close at that size.
   */
  cellH?: number;
  /**
   * How much of the width the word aims to fill, 0..1. Inert while the height
   * cap binds, which it does at 13 rows: raising it there changes nothing.
   */
  wordWidth?: number;
}

export default function LetterGlitch({
  className,
  word = "BRIDGER",
  glitchMs = 62,
  intensity = 0.9,
  ping = 0,
  showWord = true,
  cellH = CELL_H,
  wordWidth = 0.62,
}: LetterGlitchProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const burst = useRef(0);
  const seenPing = useRef(ping);

  useEffect(() => {
    if (ping !== seenPing.current) {
      seenPing.current = ping;
      if (ping > 0) burst.current = performance.now();
    }
  }, [ping]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");

    let cells: Cell[] = [];
    let cols = 0;
    let rows = 0;
    let w = 0;
    let h = 0;
    let raf = 0;
    let running = false;
    let visible = true;
    let lastGlitch = 0;
    let sparks: Spark[] = [];
    const touched = new Set<number>();
    let reveal = 0;
    /** Last quantised reveal, so the halo repaints on crossings only. */
    let revealBucket = -1;
    /** Indices of the halo, kept so a reveal crossing does not scan the grid. */
    let haloCells: number[] = [];
    /** Last quantised sweep level per column, so only crossings repaint. */
    let sweepBucket = new Int16Array(0);
    /** Current sweep level per column, read by drawCell. */
    let sweepLevel = new Float32Array(0);

    let colA: [number, number, number] = [116, 178, 255];
    let colB: [number, number, number] = [255, 176, 108];
    let colWord: [number, number, number] = [235, 242, 252];
    let bg = "#07090d";
    /**
     * Additive only on dark. On paper the glyphs are dark ink and `lighter`
     * would erase them into the page — the same call the wire makes, for the
     * same reason.
     */
    let additive = true;

    const triplet = (v: string, fb: [number, number, number]): [number, number, number] => {
      const p = v.split(",").map((n) => Number(n.trim()));
      return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : fb;
    };

    const readColors = () => {
      const s = getComputedStyle(canvas);
      const neutral = triplet(s.getPropertyValue("--glyph").trim(), [192, 208, 230]);
      colA = triplet(s.getPropertyValue("--side-a").trim(), neutral);
      colB = triplet(s.getPropertyValue("--side-b").trim(), neutral);
      colWord = neutral;
      bg = s.getPropertyValue("--bg").trim() || "#07090d";
      const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      additive = (lum(colA) + lum(colB)) / 2 > 128;
    };

    const rnd = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

    /**
     * Which cells the word occupies.
     *
     * Rendered ONCE into an offscreen canvas that is exactly one pixel per
     * CELL, then read back. Sampling the glyph coverage at grid resolution is
     * what makes the word appear built out of characters rather than drawn on
     * top of them, and it costs one rasterisation per resize.
     */
    /**
     * The word's neighbourhood: every cell within `HALO` of a letterform cell,
     * itself excluded. Dilated on the grid rather than measured in px, because
     * what has to be kept clear is a COUNTER -- and a counter is one or two
     * cells wide however large the word is.
     */
    const HALO = 1;
    const dilate = (mask: boolean[]): boolean[] => {
      const near = new Array<boolean>(cols * rows).fill(false);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (mask[r * cols + c]) continue;
          let hit = false;
          for (let dr = -HALO; dr <= HALO && !hit; dr++) {
            for (let dc = -HALO; dc <= HALO && !hit; dc++) {
              const rr = r + dr, cc = c + dc;
              if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
              if (mask[rr * cols + cc]) hit = true;
            }
          }
          near[r * cols + c] = hit;
        }
      }
      return near;
    };

    const buildMask = (): boolean[] => {
      const mask = new Array<boolean>(cols * rows).fill(false);
      if (!showWord || cols < 16 || rows < 6) return mask;

      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const oc = off.getContext("2d");
      if (!oc) return mask;

      // THE CELL IS NOT SQUARE, AND THIS CANVAS IS ONE PIXEL PER CELL.
      // A mask pixel is displayed CELL_W wide and `cellH` tall, so a glyph
      // rasterised here at its natural proportions arrives on screen squeezed
      // horizontally by CELL_W / cellH -- 0.6 at the shipped 12x20. That is the
      // "too tight" this shipped with: BRIDGER rendered at 60% of its own width,
      // every counter closed, unreadable as letterforms. Pre-stretching x by the
      // inverse cancels it exactly, and this is the only place the two cell
      // dimensions are allowed to differ.
      const kx = cellH / CELL_W;

      // Taller and narrower than the obvious fit, because the STROKE WIDTH is
      // what has to survive being sampled at one pixel per cell. A word sized
      // to fill the width reads as a ragged band; a word sized to fill the
      // height has strokes several cells thick, and only then does the shape
      // come through the letters that fill it.
      let size = rows * 0.78;
      oc.font = `900 ${size}px ui-sans-serif, system-ui, sans-serif`;
      const target = cols * wordWidth;
      const measured = oc.measureText(word).width * kx;
      if (measured > 0) size = Math.max(4, Math.min(size * (target / measured), rows * 0.86));

      oc.font = `900 ${size}px ui-sans-serif, system-ui, sans-serif`;
      oc.textAlign = "center";
      oc.textBaseline = "middle";
      oc.fillStyle = "#fff";
      oc.setTransform(kx, 0, 0, 1, 0, 0);
      oc.fillText(word, cols / 2 / kx, rows / 2);
      oc.setTransform(1, 0, 0, 1, 0, 0);

      const d = oc.getImageData(0, 0, cols, rows).data;
      for (let i = 0; i < cols * rows; i++) mask[i] = d[i * 4 + 3] > 96;
      return mask;
    };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();

      cols = Math.max(1, Math.ceil(w / CELL_W));
      rows = Math.max(1, Math.ceil(h / cellH));
      sweepBucket = new Int16Array(cols).fill(-1);
      sweepLevel = new Float32Array(cols);

      const mask = buildMask();
      const near = dilate(mask);
      cells = new Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          cells[i] = {
            ch: rnd(),
            locked: false,
            threshold: Math.random(),
            inWord: mask[i],
            nearWord: near[i],
            mix: cols > 1 ? c / (cols - 1) : 0.5,
            // A vertical falloff so the wall fades rather than ending on a line.
            dim: 0.1 + Math.random() * 0.34,
            hot: !near[i] && Math.random() < 0.07,
            spark: 0,
            dirty: true,
          };
        }
      }
      haloCells = [];
      for (let i = 0; i < cells.length; i++) if (cells[i].nearWord) haloCells.push(i);
      revealBucket = -1;
      sparks = [];
      touched.clear();
      paintAll();
    };

    /**
     * Push a colour away from grey.
     *
     * The two side hues are already saturated as tokens, but a glyph drawn at
     * low alpha on black lands close to its own luminance and reads as ash. The
     * fix is not more alpha — that drowns the headline — it is more DISTANCE
     * from grey per unit of alpha. Everything below is that: the same hues,
     * further from the middle.
     */
    const saturate = (c: [number, number, number], k: number): [number, number, number] => {
      const g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      return [
        Math.max(0, Math.min(255, g + (c[0] - g) * k)),
        Math.max(0, Math.min(255, g + (c[1] - g) * k)),
        Math.max(0, Math.min(255, g + (c[2] - g) * k)),
      ];
    };

    const rgbOf = (cell: Cell, sweep: number): [number, number, number] => {
      if (cell.locked) return colWord;
      // The two sides, and the sweep leaning the mix toward whichever side it
      // is passing over — so the band reads as a change of COLOUR travelling,
      // not only a change of brightness.
      const m = Math.max(0, Math.min(1, cell.mix + sweep * 0.22 - 0.11));
      const base: [number, number, number] = [
        colA[0] + (colB[0] - colA[0]) * m,
        colA[1] + (colB[1] - colA[1]) * m,
        colA[2] + (colB[2] - colA[2]) * m,
      ];
      return saturate(base, 1.5 + sweep * 0.9);
    };

    const drawCell = (i: number) => {
      const cell = cells[i];
      const c = i % cols;
      const r = (i / cols) | 0;
      const x = c * CELL_W;
      const y = r * cellH;

      // Clear first: this is a repaint of one cell, not a fresh frame.
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(x, y, CELL_W, cellH);

      const sweep = sweepLevel[c] ?? 0;
      const [rr, gg, bb] = rgbOf(cell, sweep);
      let a = intensity * cell.dim * (cell.hot ? 2.9 : 1) * (1 + sweep * 2.6);
      // The clearing only exists while there is a word to clear FOR. At reveal 0
      // this is 1 and the wall is untouched, so the field is unchanged whenever
      // the word is away -- the halo is part of the word's arrival, not a
      // permanent hole in the noise.
      if (cell.nearWord) a *= 1 - 0.55 * reveal;
      // The word takes the sweep too -- as BRIGHTNESS, not as hue. It keeps the
      // neutral that makes it belong to neither side, but it lights up as the
      // band crosses it, so the sweep passes over the whole field rather than
      // parting around the one thing you are meant to look at.
      if (cell.locked) a = intensity * (0.66 + 0.72 * sweep);
      a += cell.spark * 0.9;
      if (a <= 0.015) return;

      ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
      ctx.fillStyle = `rgba(${rr | 0},${gg | 0},${bb | 0},${Math.min(1, a).toFixed(3)})`;
      ctx.font = cell.locked ? WORD_FONT : NOISE_FONT;
      ctx.fillText(cell.ch, x + CELL_W / 2, y + cellH / 2);
      ctx.globalCompositeOperation = "source-over";
    };

    /**
     * Two fonts, and the difference is doing real work.
     *
     * Brightness alone did not separate the word from the wall: the locked
     * cells were already far brighter and the shape still read as a rectangle
     * of text rather than as letterforms. Weight is the cue that carries at
     * this size -- a bold glyph has more ink per cell, so the strokes of the
     * big word gain body while the counters stay thin and open.
     */
    const fontPx = fontPxFor(cellH);
    const NOISE_FONT = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const WORD_FONT = `700 ${fontPx + 1}px ui-monospace, SFMono-Regular, Menlo, monospace`;

    const setFont = () => {
      ctx.font = NOISE_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    };

    const paintAll = () => {
      ctx.clearRect(0, 0, w, h);
      setFont();
      for (let i = 0; i < cells.length; i++) {
        cells[i].dirty = false;
        drawCell(i);
      }
    };

    /**
     * The bloom, drawn ONCE per spark, over the repainted glyphs.
     *
     * The first version drew this radial inside `drawCell`, which meant every
     * cell in the spark's neighbourhood painted the WHOLE blob -- some thirty
     * overlapping copies, additively, which is why the sparks came out as
     * saturated vertical streaks rather than points of light. A glow belongs to
     * the spark, not to each cell it touches.
     */
    const drawSparkGlow = (s: Spark, level: number) => {
      if (!additive) return;
      const cx = s.col * CELL_W + CELL_W / 2;
      const cy = s.row * cellH + cellH / 2;
      const rad = CELL_W * SPARK_R;
      const cell = cells[s.row * cols + s.col];
      const [rr, gg, bb] = rgbOf(cell, sweepLevel[s.col] ?? 0);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${rr | 0},${gg | 0},${bb | 0},${(level * 0.34).toFixed(3)})`);
      g.addColorStop(0.5, `rgba(${rr | 0},${gg | 0},${bb | 0},${(level * 0.1).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rr | 0},${gg | 0},${bb | 0},0)`);
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      ctx.globalCompositeOperation = "source-over";
    };

    /** A spark marks its whole neighbourhood dirty, because its glow spills. */
    const dirtyAround = (col: number, row: number) => {
      for (let dr = -SPARK_R; dr <= SPARK_R; dr++) {
        for (let dc = -SPARK_R; dc <= SPARK_R; dc++) {
          const c = col + dc;
          const r = row + dr;
          if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
          cells[r * cols + c].dirty = true;
        }
      }
    };

    const spawnSpark = (t: number, preferWord: boolean) => {
      let idx = (Math.random() * cells.length) | 0;
      if (preferWord) {
        // Try a few times for a cell inside the word, then give up rather than
        // looping — a word that has not formed yet has no cells to find.
        for (let k = 0; k < 8; k++) {
          const cand = (Math.random() * cells.length) | 0;
          if (cells[cand].locked) {
            idx = cand;
            break;
          }
        }
      }
      sparks.push({ col: idx % cols, row: (idx / cols) | 0, born: t });
    };

    const draw = (t: number) => {
      setFont();

      // ── the sweep ───────────────────────────────────────────────────────
      // Travels right to left. A raised cosine rather than a hard edge, and it
      // wraps, so there is no seam to catch the eye on the way round.
      const sPhase = ((t / 1000) % SWEEP_SECONDS) / SWEEP_SECONDS;
      const head = 1 - sPhase; // 1 -> 0 : the right edge toward the left
      for (let c = 0; c < cols; c++) {
        const x = cols > 1 ? c / (cols - 1) : 0;
        let d = Math.abs(x - head);
        if (d > 0.5) d = 1 - d; // wrap, so the band re-enters from the right
        const level = d < SWEEP_WIDTH ? 0.5 + 0.5 * Math.cos((d / SWEEP_WIDTH) * Math.PI) : 0;
        sweepLevel[c] = level;
        const bucket = (level * SWEEP_STEPS) | 0;
        if (bucket !== sweepBucket[c]) {
          sweepBucket[c] = bucket;
          for (let r = 0; r < rows; r++) cells[r * cols + c].dirty = true;
        }
      }

      // ── the word's slow tide ────────────────────────────────────────────
      // A hold at each end, so it is not a permanent throb: the word arrives,
      // stays long enough to be read, and leaves.
      const phase = ((t / 1000) % CYCLE_S) / CYCLE_S;
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      reveal = Math.min(1, Math.max(0, (tri - 0.12) / 0.5));

      // The halo dims as the word arrives, so it changes every frame the reveal
      // moves -- the same problem the sweep has, and the same answer: quantise,
      // and repaint only the frames that cross a step. 20 steps over a 16s cycle
      // is a crossing every ~0.2s, against a scan of a few hundred cells.
      const rb = (reveal * 20) | 0;
      if (rb !== revealBucket) {
        revealBucket = rb;
        for (const i of haloCells) cells[i].dirty = true;
      }

      if (showWord) {
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          if (!cell.inWord) continue;
          const want = reveal > cell.threshold;
          if (want !== cell.locked) {
            cell.locked = want;
            // A cell joining the word takes a letter OF the word, so the
            // shape is spelled out of its own name.
            //
            // Indexed by COLUMN AND ROW, not by the flat cell index. The first
            // version used `(i * 7) % word.length` and "BRIDGER" is seven
            // letters long, so the stride and the modulus were the same number
            // and every single cell resolved to index 0 -- the word formed
            // correctly and was rendered entirely in Bs.
            if (want) cell.ch = word[(((i % cols) + ((i / cols) | 0) * 3) % word.length + word.length) % word.length];
            else cell.ch = rnd();
            cell.dirty = true;
          }
        }
      }

      // ── the churn ───────────────────────────────────────────────────────
      if (t - lastGlitch >= glitchMs) {
        lastGlitch = t;
        const n = Math.max(1, (cells.length * CHURN) | 0);
        for (let k = 0; k < n; k++) {
          const i = (Math.random() * cells.length) | 0;
          const cell = cells[i];
          // Locked cells hold. The word is the one thing that is not noise.
          if (cell.locked) continue;
          cell.ch = rnd();
          cell.dim = 0.1 + Math.random() * 0.34;
          cell.hot = !cell.nearWord && Math.random() < 0.07;
          cell.dirty = true;
        }
        if (Math.random() < 0.5) spawnSpark(t, reveal > 0.5);
      }

      // ── sparks ──────────────────────────────────────────────────────────
      if (burst.current && t - burst.current < 260) {
        for (let k = 0; k < 3; k++) spawnSpark(t, true);
        burst.current = 0;
      }
      const LIFE = 900;
      sparks = sparks.filter((s) => t - s.born < LIFE);

      // Everything a spark touched LAST frame is repainted this one, whether or
      // not that spark still exists. Without this a dying spark leaves its last
      // bloom burned into the canvas -- there is no full clear to erase it,
      // which is the price of repainting dirty cells only.
      for (const i of touched) {
        cells[i].spark = 0;
        cells[i].dirty = true;
      }
      touched.clear();

      for (const s of sparks) {
        const age = (t - s.born) / LIFE;
        const level = (1 - age) * (1 - age);
        for (let dr = -SPARK_R; dr <= SPARK_R; dr++) {
          for (let dc = -SPARK_R; dc <= SPARK_R; dc++) {
            const c = s.col + dc;
            const r = s.row + dr;
            if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
            const d = Math.hypot(dc, dr);
            if (d > SPARK_R) continue;
            const idx = r * cols + c;
            cells[idx].spark = Math.max(cells[idx].spark, level * (1 - d / SPARK_R));
            cells[idx].dirty = true;
            touched.add(idx);
          }
        }
      }

      // ── repaint only what moved ─────────────────────────────────────────
      for (let i = 0; i < cells.length; i++) {
        if (!cells[i].dirty) continue;
        cells[i].dirty = false;
        drawCell(i);
      }

      // The blooms go on top of the freshly painted glyphs, one per spark.
      for (const s of sparks) {
        const age = (t - s.born) / LIFE;
        drawSparkGlow(s, (1 - age) * (1 - age));
      }
    };

    const loop = (t: number) => {
      if (!running) return;
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || !visible || reduced?.matches) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    /** One frame with the word fully formed, for anyone who asked for stillness. */
    const still = () => {
      stop();
      draw(CYCLE_S * 250);
      paintAll();
    };

    build();
    if (reduced?.matches) still();
    else start();

    const onMotion = () => (reduced?.matches ? still() : start());
    reduced?.addEventListener?.("change", onMotion);

    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => {
      build();
      if (reduced?.matches) still();
    };
    scheme?.addEventListener?.("change", onScheme);

    const ro = new ResizeObserver(() => {
      build();
      if (reduced?.matches) still();
    });
    ro.observe(canvas);

    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        if (!visible) stop();
        else start();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduced?.removeEventListener?.("change", onMotion);
      scheme?.removeEventListener?.("change", onScheme);
    };
  }, [word, glitchMs, intensity, showWord, cellH, wordWidth]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
