"use client";

/**
 * THE WIRE — the one signature element, and the only decorative surface here.
 *
 * WHAT IT IS. A still lattice of dots with a coherent wave of LIGHT travelling
 * through it. The dots never move. What moves is brightness: a crest sweeps
 * left to right and each dot lights as the crest reaches it. That is the whole
 * trick, and it is chosen rather than decorative — the medium is fixed and the
 * signal propagates through it, which is exactly what a bridge between two
 * sessions is. A field of dots that merely drifted would be a screensaver.
 *
 * WHY NOT WEBGL. Canvas 2D, no dependency, no shader compile, no context-loss
 * handling, and it degrades to a single static frame without a fallback path.
 * The whole product's stance is deterministic-first; a background does not get
 * to be the heaviest thing on the page.
 *
 * WHY IT CANNOT HURT READING. Three separate guarantees, because "it looked
 * fine on my monitor" is not one:
 *   1. It renders BEHIND content at low alpha and never under body copy at a
 *      density that changes measured contrast — the hero sits above it, and in
 *      the room it is a thin band, not a page-wide wash.
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
  /** Seconds for one crest to cross the full width. Higher = slower. */
  period?: number;
  /** Peak alpha of a fully-lit dot. The single knob for "how loud". */
  intensity?: number;
  /**
   * Bump this number to send one bright packet down the wire. The room view
   * passes the newest entry's seq, so a real arrival on the bridge is what
   * lights it — the animation is driven by the record, not by a timer.
   */
  ping?: number;
  className?: string;
}

interface Packet {
  /** 0..1 across the width. */
  x: number;
  born: number;
}

export default function Wire({
  band = [0.32, 0.98],
  pitch = 13,
  period = 26,
  intensity = 0.5,
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
    let dots: { x: number; y: number; row: number; jitter: number }[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let running = true;
    let visible = true;

    // Resolved once per resize rather than per frame: getComputedStyle is a
    // layout read, and doing it 60 times a second inside the draw loop is how a
    // background animation starts costing more than the application.
    let dotColor = "255,255,255";
    let crestColor = "255,255,255";

    const readColors = () => {
      const s = getComputedStyle(canvas);
      dotColor = s.getPropertyValue("--wire-dot").trim() || "255,255,255";
      crestColor = s.getPropertyValue("--wire-crest").trim() || dotColor;
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

      const [top, bottom] = band;
      const y0 = h * top;
      const y1 = h * bottom;
      const rows = Math.max(1, Math.floor((y1 - y0) / pitch));
      const cols = Math.max(1, Math.floor(w / pitch));
      dots = [];
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          // A deterministic pseudo-jitter keyed on the cell. A perfect grid
          // reads as a texture swatch; full randomness reads as noise. This
          // sits between, and being deterministic means a resize does not
          // reshuffle the whole field in front of the reader.
          const seed = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453;
          const j = seed - Math.floor(seed);
          dots.push({
            x: c * pitch + (j - 0.5) * pitch * 0.55,
            y: y0 + r * pitch + (((j * 7) % 1) - 0.5) * pitch * 0.55,
            row: r / rows,
            jitter: j,
          });
        }
      }
    };

    /**
     * One frame.
     *
     * The crest is the sum of two sines of different wavelength, which is what
     * stops it reading as a metronome — a single sine is visibly periodic
     * within a few seconds and the eye starts predicting it.
     */
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const time = t / 1000;
      const phase = (time / period) * Math.PI * 2;

      for (const d of dots) {
        const u = d.x / Math.max(1, w);
        const crest =
          Math.sin(u * Math.PI * 2.1 - phase) * 0.6 +
          Math.sin(u * Math.PI * 3.7 - phase * 1.35 + 1.2) * 0.4;

        // Distance from this dot's row to the crest line, in row units. The
        // falloff is what makes a band of light rather than a lit half-screen.
        //
        // TUNED S#277 AFTER LOOKING AT IT. The first version used a 3.4 falloff
        // with the brightness weighted toward the TOP of the field, and on a
        // real screen the wave was almost invisible: the narrow band put most
        // dots below the threshold, and the weighting dimmed exactly the region
        // the crest travels through. A build passing and a stylesheet loading
        // told me nothing about that — only the screenshot did.
        const crestRow = 0.46 + crest * 0.3;
        const dist = Math.abs(d.row - crestRow);
        // Asymmetric falloff. Sharper ABOVE the crest than below, so the field
        // has a defined upper silhouette — that edge is what makes the eye read
        // "a wave" instead of "a gradient band". Symmetric falloff looked like a
        // scanline and was the main thing missing from the first pass.
        let lit = Math.max(0, 1 - dist * (d.row < crestRow ? 3.1 : 1.7));
        lit *= lit;

        // Everything BELOW the crest keeps a faint glow, so the wave reads as a
        // lit mass with a defined upper edge rather than a floating stripe —
        // the silhouette is what makes it a wave and not a scanline.
        const under = d.row > crestRow ? Math.max(0, 1 - (d.row - crestRow) * 1.5) * 0.4 : 0;

        // A gentle weighting toward the lower field, which is where the wave
        // lives and where there is no text to compete with.
        const depth = 0.55 + d.row * 0.45;
        let alpha = Math.min(1, lit + under) * intensity * depth;

        // A packet is a local brightening travelling along the crest.
        let packetHit = 0;
        for (const p of packets.current) {
          const pd = Math.abs(u - p.x);
          if (pd < 0.08) packetHit = Math.max(packetHit, (1 - pd / 0.08) * lit);
        }

        if (alpha < 0.012 && packetHit < 0.02) continue;

        const size = 1 + lit * 0.9 + packetHit * 1.1;
        if (packetHit > 0.02) {
          ctx.fillStyle = `rgba(${crestColor},${Math.min(0.95, alpha + packetHit * 0.85)})`;
        } else {
          ctx.fillStyle = `rgba(${dotColor},${alpha})`;
        }
        ctx.fillRect(d.x, d.y, size, size);
      }

      // Advance and retire packets. 2.6s to cross, then gone.
      const now = t;
      packets.current = packets.current.filter((p) => {
        p.x = (now - p.born) / 2600;
        return p.x <= 1.05;
      });
    };

    const loop = (t: number) => {
      if (!running) return;
      draw(t);
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running || !visible) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const still = () => {
      // The reduced-motion frame is deliberately taken at a phase where the
      // crest sits mid-field, so the static image still shows the wave shape
      // rather than an arbitrary slice that might be almost empty.
      stop();
      draw(period * 250);
    };

    build();

    if (reduced?.matches) {
      still();
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onMotionChange = () => {
      if (reduced?.matches) still();
      else {
        running = false;
        start();
      }
    };
    reduced?.addEventListener?.("change", onMotionChange);

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
        else if (!reduced?.matches) start();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVis = () => {
      if (document.hidden) stop();
      else if (visible && !reduced?.matches) start();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduced?.removeEventListener?.("change", onMotionChange);
    };
  }, [band, pitch, period, intensity]);

  // aria-hidden and not focusable: it carries no information a screen reader
  // could use, and everything it hints at is stated in text elsewhere.
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
