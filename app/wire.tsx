"use client";

/**
 * THE WIRE — the one signature element, and the only decorative surface here.
 *
 * WHAT IT IS. An ocean surface, seen in perspective. A grid of points lies on a
 * horizontal plane running away from the camera to a horizon; the plane's height
 * is the sum of several directional waves, the strongest travelling across it at
 * roughly 45 degrees. The points are projected through a real pinhole camera, so
 * columns converge toward a vanishing point, rows compress as they recede, and a
 * point's size and brightness fall off with distance. That projection is the
 * entire reason it reads as three-dimensional.
 *
 * WHAT IT WAS FOR THREE ATTEMPTS, AND WHY NONE COULD HAVE WORKED.
 *   1. A fixed lattice with brightness sweeping over it — a scanline crossing a
 *      texture, not a wave.
 *   2. Dots displaced vertically in 2D. Closer, and still a flat field.
 *   3. The same plus horizontal drift, so the field "flowed".
 * Every round was a parameter change and the gap to the reference never closed,
 * because the reference is not a 2D field with better numbers — it is a THREE
 * DIMENSIONAL surface with a camera in front of it. No tuning makes a flat plane
 * look like a perspective one. When repeated tuning fails to approach a
 * reference, the structure is wrong rather than the values, and the question to
 * ask first is "what is the camera?" — which went unasked until Erik said the
 * word 3D outright.
 *
 * WHY THE WAVES LOOK RANDOM WITHOUT BEING RANDOM. Four sine components with
 * different wavelengths, directions and speeds, summed. Superposition is how
 * real water gets its irregularity: no single component is irregular, but their
 * sum does not repeat on any timescale a viewer will sit through. The dominant
 * one runs diagonally; the others cross it, which is what varies the apparent
 * height and width of each crest as it travels.
 *
 * WHY NOT WEBGL. Canvas 2D, no dependency, no shader compile, no context-loss
 * handling, and it degrades to a single static frame without a fallback path.
 * The product's stance is deterministic-first; a background does not get to be
 * the heaviest thing on the page.
 *
 * WHY IT CANNOT HURT READING. `prefers-reduced-motion: reduce` renders ONE
 * static frame and stops — not slower, stopped. It halts when the tab is hidden
 * or the canvas scrolls out of view. It sits behind content at low alpha, and
 * the hero puts a vignette between it and the type.
 *
 * IT READS ITS COLOURS FROM CSS, and rebuilds when the colour scheme changes.
 */

import { useEffect, useRef } from "react";

export interface WireProps {
  /**
   * `[horizon, near]` as fractions of canvas height. `horizon` is the screen
   * line the plane recedes to; `near` is where its closest edge lands. The plane
   * spans the FULL WIDTH at every depth — a property of the projection, not
   * something a caller can get wrong.
   */
  band?: [number, number];
  /** Screen spacing near the horizon, in px. Smaller = denser and costlier. */
  pitch?: number;
  /** Seconds for the slowest wave component to complete a cycle. */
  period?: number;
  /** Peak alpha of the nearest points. */
  intensity?: number;
  /** Wave height in world units. The sea state. */
  amplitude?: number;
  /** Flips the travel direction of every component. */
  reverse?: boolean;
  /**
   * Bump to send a swell across the surface. The room view passes a counter of
   * real arrivals, so an entry landing on the bridge is what disturbs the water
   * — the animation is driven by the record, never by a timer.
   */
  ping?: number;
  className?: string;
}

interface Point {
  x: number;
  z: number;
  fog: number;
  scale: number;
  rgb: string;
}

interface Packet {
  born: number;
}

/**
 * The sea state. Four components: one dominant diagonal, three crossing it.
 * `dx`/`dz` are a direction vector, `k` the wave number, `sp` relative speed.
 */
const COMPONENTS = [
  { amp: 1.0, dx: 0.72, dz: 0.69, k: 0.62, sp: 1.0 },
  { amp: 0.52, dx: 0.94, dz: -0.34, k: 1.05, sp: 1.31 },
  { amp: 0.34, dx: -0.3, dz: 0.95, k: 1.48, sp: 0.83 },
  { amp: 0.19, dx: 0.55, dz: 0.84, k: 2.6, sp: 1.72 },
];

const Z_NEAR = 1.0;
const Z_FAR = 18;

export default function Wire({
  band = [0.42, 1],
  pitch = 7,
  period = 13,
  intensity = 0.85,
  amplitude = 0.14,
  reverse = false,
  ping = 0,
  className,
}: WireProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const packets = useRef<Packet[]>([]);
  const seenPing = useRef(ping);

  useEffect(() => {
    if (ping !== seenPing.current) {
      seenPing.current = ping;
      if (ping > 0) packets.current.push({ born: performance.now() });
    }
  }, [ping]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let pts: Point[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let running = false;
    let visible = true;

    let focal = 1;
    let camY = 1;
    let horizonY = 0;

    let dotColor = "255,255,255";
    let crestColor = "255,255,255";
    let colA: [number, number, number] = [192, 208, 230];
    let colB: [number, number, number] = [192, 208, 230];

    const triplet = (v: string, fb: [number, number, number]): [number, number, number] => {
      const p = v.split(",").map((n) => Number(n.trim()));
      return p.length === 3 && p.every((n) => Number.isFinite(n)) ? [p[0], p[1], p[2]] : fb;
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();

      horizonY = h * band[0];
      // Focal length chosen so the plane's NEAR edge lands at `band[1]`:
      //   sy(Z_NEAR) = horizonY + camY * focal / Z_NEAR = h * band[1]
      const drop = Math.max(0.05, band[1] - band[0]);
      camY = 1.0;
      focal = (h * drop * Z_NEAR) / camY;

      const cols = Math.min(300, Math.max(24, Math.round(w / pitch)));
      const rows = Math.min(110, Math.max(14, Math.round((h * drop) / (pitch * 1.5))));

      pts = [];
      for (let r = 0; r <= rows; r++) {
        // Linear in z, so the compression of rows toward the horizon is the
        // projection's doing rather than something faked in the distribution.
        const zBase = Z_NEAR + (r / rows) * (Z_FAR - Z_NEAR);
        for (let c = 0; c <= cols; c++) {
          const seed = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453;
          const j = seed - Math.floor(seed);
          const seed2 = Math.sin(r * 39.3467 + c * 11.135) * 24634.6345;
          const j2 = seed2 - Math.floor(seed2);

          const z = zBase + (j2 - 0.5) * ((Z_FAR - Z_NEAR) / rows) * 0.9;
          if (z <= Z_NEAR * 0.9) continue;

          // Each ROW is spread across the screen width AT ITS OWN DEPTH, rather
          // than over one world-space width sized for the far plane.
          //
          // The world-uniform version was tried first and is wrong here: with
          // Z_FAR/Z_NEAR = 18, adjacent columns land ~126px apart at the near
          // plane, so the foreground was a handful of scattered dots while
          // everything else got culled off-screen. Filling it that way would
          // need ~200k points. Depth does not suffer, because it is carried by
          // row compression, by size falling off as 1/z, by fog, and above all
          // by the wave's SCREEN amplitude shrinking with distance — near crests
          // are tall, far ones are a ripple. What is given up is converging
          // column lines, which the reference does not show either.
          const halfXAtZ = ((w / 2 + pitch * 2) * z) / focal;
          const x = (c / cols - 0.5) * 2 * halfXAtZ + (j - 0.5) * ((2 * halfXAtZ) / cols) * 0.9;

          const t01 = (z - Z_NEAR) / (Z_FAR - Z_NEAR);
          // Distance fog, with a hold-back on the very nearest rank so the
          // bottom edge does not blow out.
          const fog = Math.pow(1 - t01, 0.8) * Math.min(1, 0.3 + t01 * 5);

          // Hue spread between the two sides, scattered per point and pushed to
          // the poles — a plain gradient puts mid-screen at the exact average of
          // the two colours, which is neutral grey.
          let m = Math.min(1, Math.max(0, (x / (2 * halfXAtZ) + 0.5) * 0.45 + 0.28 + (j2 - 0.5) * 0.95));
          m = m * m * (3 - 2 * m);
          m = m * m * (3 - 2 * m);
          const lum = 0.82 + j * 0.4;
          const mix = (a: number, b: number) => Math.round(Math.min(255, (a + (b - a) * m) * lum));

          pts.push({
            x,
            z,
            fog,
            scale: 0.8 + j * 0.45,
            rgb: `${mix(colA[0], colB[0])},${mix(colA[1], colB[1])},${mix(colA[2], colB[2])}`,
          });
        }
      }

      // Painter's order: far first, so nearer points draw over them.
      pts.sort((a, b) => b.z - a.z);
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const time = (t / 1000) * (reverse ? -1 : 1);
      const base = (time / period) * Math.PI * 2;
      const cx = w / 2;

      // A swell from a real arrival: a ring travelling out toward the horizon.
      let swellR = -1;
      let swellA = 0;
      if (packets.current.length) {
        const p = packets.current[packets.current.length - 1];
        const age = (t - p.born) / 3000;
        if (age <= 1) {
          swellR = Z_NEAR + age * (Z_FAR - Z_NEAR);
          swellA = (1 - age) * 1.4;
        }
        packets.current = packets.current.filter((q) => (t - q.born) / 3000 <= 1);
      }

      for (const p of pts) {
        let y = 0;
        for (const c of COMPONENTS) {
          y += c.amp * Math.sin((p.x * c.dx + p.z * c.dz) * c.k - base * c.sp);
        }
        y *= amplitude;

        if (swellR > 0) {
          const d = Math.abs(p.z - swellR);
          if (d < 1.6) y += Math.cos((d / 1.6) * Math.PI * 0.5) * swellA * amplitude * 2.2;
        }

        const s = focal / p.z;
        const sx = cx + p.x * s;
        if (sx < -8 || sx > w + 8) continue;
        const sy = horizonY + (camY - y) * s;
        if (sy < -8 || sy > h + 8) continue;

        const alpha = intensity * p.fog;
        if (alpha < 0.012) continue;

        // Size straight off the projection, so nearer points really are bigger.
        const size = Math.max(0.7, Math.min(3.2, s * 0.017 * p.scale));

        if (swellR > 0 && Math.abs(p.z - swellR) < 0.9) {
          const f = 1 - Math.abs(p.z - swellR) / 0.9;
          ctx.fillStyle = `rgba(${crestColor},${Math.min(0.95, alpha + f * 0.7)})`;
        } else {
          ctx.fillStyle = `rgba(${p.rgb},${alpha})`;
        }
        ctx.fillRect(sx, sy, size, size);
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
    const still = () => {
      stop();
      draw(period * 320);
    };

    build();
    if (reduced?.matches) still();
    else start();

    const onMotion = () => (reduced?.matches ? still() : start());
    reduced?.addEventListener?.("change", onMotion);

    // The canvas resolves its palette from CSS inside build(), and build() only
    // runs on resize — so without this a theme flip left the field painted in
    // the previous scheme until something happened to resize it.
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
  }, [band, pitch, period, intensity, amplitude, reverse]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
