"use client";

/**
 * THE WIRE — the one signature element, and the only decorative surface here.
 *
 * WHAT IT IS. A field of dots that each move on their own, and together form a
 * coherent wave travelling across the screen. Every dot has its own position in
 * the wave, so it rises and falls on its own schedule; the shape only exists as
 * the sum of them. That is the effect, and getting it right mattered enough to
 * throw away a version that did something else.
 *
 * WHAT IT WAS FIRST, AND WHY THAT WAS WRONG. The first build kept the dots
 * FIXED and moved brightness through them — "the medium is still, the signal
 * propagates". It made a nicer sentence and it was not what had been asked for:
 * a lattice with light sweeping over it reads as a scanline passing across a
 * texture, not as a wave made of moving parts. Erik described the real thing
 * twice ("each dot had their own movement, together they formed waves") before
 * I stopped defending the tidier idea. The brief was not ambiguous; the design
 * rationale was just more attractive to me than the observation. Recorded here
 * because the failure mode — preferring your own framing to the reference in
 * front of you — is the expensive one.
 *
 * HOW THE MOTION WORKS. Each dot's vertical offset is the sum of two travelling
 * sines sampled at its own (x, y). Two, because a single sine is visibly
 * periodic within seconds and the eye starts predicting it. The y term is what
 * makes neighbouring ROWS lag each other, which is what turns a flat left-right
 * oscillation into something with depth. The spatial part of the phase depends
 * only on where a dot sits, so it is computed once when the lattice is built and
 * only the time term moves per frame.
 *
 * WHY NOT WEBGL. Canvas 2D, no dependency, no shader compile, no context-loss
 * handling, and it degrades to a single static frame without a fallback path.
 * The whole product's stance is deterministic-first; a background does not get
 * to be the heaviest thing on the page.
 *
 * WHY IT CANNOT HURT READING. Three separate guarantees, because "it looked
 * fine on my monitor" is not one:
 *   1. It renders BEHIND content at low alpha, and the hero puts a vignette
 *      between it and the type.
 *   2. `prefers-reduced-motion: reduce` renders ONE static frame and stops. Not
 *      "slower" — stopped. Vestibular triggers are not a taste setting.
 *   3. It stops entirely when the tab is hidden or the canvas scrolls out of
 *      view, so it is never burning a laptop battery behind another window.
 *
 * IT READS ITS COLOURS FROM CSS. `--wire-dot` and `--wire-crest` are resolved
 * from the live computed style, so light mode, dark mode and any future theme
 * change move the canvas with them. A hardcoded rgba here would be the classic
 * way a "theme-aware" page ends up with one surface stuck in the wrong palette.
 */

import { useEffect, useRef } from "react";

export interface WireProps {
  /**
   * Rough vertical band the lattice occupies, 0..1 of the canvas height.
   * The hero uses a tall band; the room header uses a shallow one.
   */
  band?: [number, number];
  /** Dot pitch in CSS pixels. Larger = sparser, cheaper, calmer. */
  pitch?: number;
  /** Seconds for one full wave cycle. Higher = slower. */
  period?: number;
  /** Peak alpha of a fully-lit dot. The single knob for "how loud". */
  intensity?: number;
  /** Vertical travel of a dot, as a multiple of pitch. This is the wave's height. */
  amplitude?: number;
  /**
   * Bump this number to send one bright packet down the wire. The room view
   * passes a counter of real arrivals, so an entry actually landing on the
   * bridge is what lights it — the animation is driven by the record, not by a
   * timer. The packet also LIFTS the dots as it passes, so an arrival visibly
   * disturbs the field rather than just tinting it.
   */
  ping?: number;
  className?: string;
}

interface Dot {
  x: number;
  /** How far this dot hangs BELOW the moving surface, in pixels. Fixed. */
  depth: number;
  /** 0..1, depth as a fraction of the band. Drives fade and size. */
  d01: number;
  /** Spatial term of the wave phase — fixed per dot, so computed once. */
  p1: number;
  p2: number;
  /** Per-dot size variation, deterministic. */
  scale: number;
  /**
   * This dot's own colour as a bare "r,g,b" string, ready for alpha.
   *
   * Precomputed at build rather than mixed per frame: the mix depends only on
   * where the dot sits and on its jitter, neither of which changes between
   * frames. Per-frame it costs exactly what a single shared colour cost — one
   * template concat — so the nuance is free.
   */
  rgb: string;
}

interface Packet {
  x: number;
  born: number;
}

export default function Wire({
  band = [0.3, 1],
  pitch = 12,
  period = 11,
  intensity = 0.85,
  amplitude = 2.4,
  ping = 0,
  className,
}: WireProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const packets = useRef<Packet[]>([]);
  const seenPing = useRef(ping);

  // A ping arriving is a render-time event, but the canvas loop lives outside
  // React. A ref queue is the seam: the effect below only pushes, the loop only
  // drains, and neither re-renders the component.
  useEffect(() => {
    if (ping !== seenPing.current) {
      seenPing.current = ping;
      if (ping > 0) packets.current.push({ x: 0, born: performance.now() });
    }
  }, [ping]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let dots: Dot[] = [];
    let w = 0;
    let h = 0;
    let amp = 0;
    /** Resting y of the surface the dot mass hangs from. */
    let surfaceTop = 0;
    let raf = 0;
    let running = false;
    let visible = true;

    // Resolved once per resize rather than per frame: getComputedStyle is a
    // layout read, and doing it 60 times a second inside the draw loop is how a
    // background animation starts costing more than the application.
    let dotColor = "255,255,255";
    let crestColor = "255,255,255";
    let colA: [number, number, number] = [192, 208, 230];
    let colB: [number, number, number] = [192, 208, 230];

    const triplet = (v: string, fallback: [number, number, number]): [number, number, number] => {
      const p = v.split(",").map((n) => Number(n.trim()));
      return p.length === 3 && p.every((n) => Number.isFinite(n))
        ? [p[0], p[1], p[2]]
        : fallback;
    };

    const readColors = () => {
      const s = getComputedStyle(canvas);
      dotColor = s.getPropertyValue("--wire-dot").trim() || "255,255,255";
      crestColor = s.getPropertyValue("--wire-crest").trim() || dotColor;
      const neutral = triplet(dotColor, [192, 208, 230]);
      colA = triplet(s.getPropertyValue("--wire-a").trim(), neutral);
      colB = triplet(s.getPropertyValue("--wire-b").trim(), neutral);
    };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      // Cap the device ratio at 2. A 3x phone gains no visible fidelity on a
      // field of 2px dots and pays for every one of those pixels.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();

      amp = pitch * amplitude;
      surfaceTop = h * band[0];

      const [top, bottom] = band;
      const y0 = h * top;
      const y1 = h * bottom;
      const span = Math.max(1, y1 - y0);
      const rows = Math.max(1, Math.floor(span / pitch));
      const cols = Math.max(1, Math.floor(w / pitch));

      // Wavelengths across the width. Roughly two crests on a desktop, which is
      // wide enough to read as a wave rather than as ripples.
      const kx1 = (Math.PI * 2 * 1.7) / Math.max(1, w);
      const kx2 = (Math.PI * 2 * 2.9) / Math.max(1, w);
      // A SMALL lag with depth, so the mass behaves like a soft body being
      // dragged rather than a rigid sheet. Large values here tilt the wavefronts
      // until the whole thing reads as diagonal moiré — which is what the
      // previous two attempts did.
      const kd1 = (Math.PI * 2 * 0.16) / span;
      const kd2 = (Math.PI * 2 * 0.26) / span;

      dots = [];
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          // A deterministic pseudo-jitter keyed on the cell. A perfect grid
          // reads as a texture swatch; full randomness reads as noise. This
          // sits between, and being deterministic means a resize does not
          // reshuffle the whole field in front of the reader.
          const seed = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453;
          const j = seed - Math.floor(seed);
          const seed2 = Math.sin(r * 39.3467 + c * 11.135) * 24634.6345;
          const j2 = seed2 - Math.floor(seed2);
          const x = c * pitch + (j - 0.5) * pitch * 0.55;
          const depth = r * pitch + (((j * 7) % 1) - 0.5) * pitch * 0.55;

          // Where this dot sits between the two sides. The base term walks left
          // to right across the field; the scatter term is what stops it being
          // a clean gradient — neighbouring dots land on different tones, which
          // is the whole source of the liveliness. Depth nudges it slightly too,
          // so the mass is not uniform front-to-back.
          // A plain left-to-right gradient puts the MIDDLE of the screen at the
          // exact average of the two colours — which is neutral grey, across
          // most of the visible field. That is what the first attempt did, and
          // magnifying it showed a grey wave with two faintly tinted edges.
          //
          // So the positional term is kept weak and the per-dot scatter is made
          // dominant, then pushed toward the poles with a double smoothstep.
          // Neighbouring dots land near A or near B rather than both landing in
          // the middle, so the field is cool-and-warm everywhere instead of
          // averaging itself out.
          let m = Math.min(
            1,
            Math.max(0, x / Math.max(1, w) * 0.46 + 0.27 + (j2 - 0.5) * 0.95 + (depth / span - 0.5) * 0.1),
          );
          m = m * m * (3 - 2 * m);
          const mix = m * m * (3 - 2 * m);

          // Per-dot luminance wobble on top of the hue mix. Without it the field
          // reads as two tinted halves; with it, every dot is its own value.
          const lum = 0.82 + j * 0.42;
          const mixed = (a: number, b: number) => Math.round(Math.min(255, (a + (b - a) * mix) * lum));

          dots.push({
            x,
            depth,
            d01: Math.min(1, depth / span),
            p1: x * kx1 + depth * kd1,
            p2: x * kx2 - depth * kd2 + 1.7,
            scale: 0.75 + j * 0.5,
            rgb: `${mixed(colA[0], colB[0])},${mixed(colA[1], colB[1])},${mixed(colA[2], colB[2])}`,
          });
        }
      }
    };

    /**
     * One frame.
     *
     * The field is a SURFACE with dots hanging beneath it. Each dot keeps a
     * fixed depth and its y is the surface height at its own x plus that depth,
     * so every dot rises and falls individually while the mass as a whole has a
     * defined, undulating top edge.
     *
     * That edge is the thing. Two earlier versions moved the dots correctly and
     * still did not read as a wave, because a uniformly-filled rectangle of
     * dots has no silhouette — the eye needs the boundary to see the shape. The
     * reference had a ridge; the copies had a texture.
     */
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const time = t / 1000;
      const w1 = (time / period) * Math.PI * 2;
      const w2 = w1 * 1.37;

      for (const d of dots) {
        const s1 = Math.sin(d.p1 - w1);
        const s2 = Math.sin(d.p2 - w2);
        const n = s1 * 0.62 + s2 * 0.38; // -1..1

        let lift = 0;
        let packetHit = 0;
        if (packets.current.length) {
          const u = d.x / Math.max(1, w);
          for (const p of packets.current) {
            const pd = Math.abs(u - p.x);
            if (pd < 0.1) {
              const f = 1 - pd / 0.1;
              packetHit = Math.max(packetHit, f);
              lift -= f * f * amp * 0.85; // upward bulge as it passes
            }
          }
        }

        const y = surfaceTop + n * amp + d.depth + lift;
        if (y < -4 || y > h + 4) continue;

        // Density falls off downward: bright and tight at the ridge, dissolving
        // into the dark below it. This is what makes it a mass with an edge
        // rather than a rectangle of confetti.
        const fade = Math.pow(1 - d.d01 * 0.82, 1.25);
        const alpha = intensity * fade * (0.72 + ((n + 1) / 2) * 0.28);

        if (alpha < 0.012 && packetHit < 0.02) continue;

        const size = (0.9 + (1 - d.d01) * 0.7) * d.scale + packetHit * 1.2;
        if (packetHit > 0.02) {
          ctx.fillStyle = `rgba(${crestColor},${Math.min(0.95, alpha + packetHit * 0.8)})`;
        } else {
          ctx.fillStyle = `rgba(${d.rgb},${alpha})`;
        }
        ctx.fillRect(d.x, y, size, size);
      }

      // Advance and retire packets. 2.6s to cross, then gone.
      packets.current = packets.current.filter((p) => {
        p.x = (t - p.born) / 2600;
        return p.x <= 1.1;
      });
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

    const still = () => {
      // The static frame is taken at a phase where the wave is mid-swing, so it
      // still shows the wave FORM rather than an arbitrary slice that might be
      // almost flat.
      stop();
      draw(period * 250);
    };

    build();
    if (reduced?.matches) still();
    else start();

    const onMotionChange = () => {
      if (reduced?.matches) still();
      else start();
    };
    reduced?.addEventListener?.("change", onMotionChange);

    // Rebuild when the colour scheme flips. The canvas resolves its palette from
    // CSS at build time, and build only ran on resize — so before this, toggling
    // the OS theme left the dot field painted in the previous scheme's colours
    // until something happened to resize it. Barely visible when every dot was
    // one neutral grey; obvious now that each dot carries its own hue.
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

    // Off-screen and hidden-tab both mean "nobody is looking at this", and both
    // are cheap to detect. A background that keeps painting behind another
    // window is a battery bug, not a design decision.
    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        if (!visible) stop();
        else start();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduced?.removeEventListener?.("change", onMotionChange);
      scheme?.removeEventListener?.("change", onScheme);
    };
  }, [band, pitch, period, intensity, amplitude]);

  // aria-hidden and not focusable: it carries no information a screen reader
  // could use, and everything it hints at is stated in text elsewhere.
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
