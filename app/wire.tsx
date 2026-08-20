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
  /**
   * SOLID `rgb(...)`, built once, with the alpha carried separately as a NUMBER.
   *
   * Composing a colour string in the draw loop meant ~40k string allocations AND
   * ~40k CSS colour parses per frame once the halo pass doubled the fills, which
   * measured 37fps. That was the entire cost; the extra rect was not.
   *
   * The alpha now VARIES per frame, because the wave drives it, so it can no
   * longer be baked into the string. It is applied through `ctx.globalAlpha`
   * instead, which is a float assignment with no parse behind it. A per-frame
   * brightness therefore costs what a cached string cost, and the 37fps trap
   * stays shut.
   */
  fill: string;
  /** `intensity * fog`: the point's brightness ceiling, before the wave. */
  alpha: number;
  /** Index into the pre-rendered halo sprites, one per quantised hue. */
  hue: number;
}

interface Packet {
  born: number;
}

/**
 * The sea state. Six components: one dominant diagonal swell, the rest crossing
 * it at other angles and much shorter wavelengths. `dx`/`dz` are a direction
 * vector, `k` the wave number, `sp` relative speed.
 */
const COMPONENTS = [
  { amp: 1.0, dx: 0.72, dz: 0.69, k: 0.55, sp: 1.0 },
  { amp: 0.58, dx: 0.94, dz: -0.34, k: 1.05, sp: 1.31 },
  { amp: 0.4, dx: -0.3, dz: 0.95, k: 1.62, sp: 0.83 },
  { amp: 0.26, dx: 0.55, dz: 0.84, k: 2.7, sp: 1.72 },
  { amp: 0.17, dx: -0.86, dz: 0.51, k: 4.1, sp: 2.15 },
  { amp: 0.11, dx: 0.38, dz: -0.93, k: 6.3, sp: 2.9 },
];

/**
 * PERLIN NOISE — the thing sine superposition cannot do.
 *
 * Summed sines get you an irregular-looking surface, but every crest is still a
 * smooth arc and the irregularity is periodic if you watch long enough. Real
 * water has structure at every scale, and the standard way to get that is
 * gradient noise summed over octaves (fBm). React Bits' own `Waves` background
 * — the site Erik pointed at — uses `perlin2` for exactly this reason, which is
 * the borrow here: the technique, not the code.
 *
 * Seeded from a constant rather than Math.random, so the sea looks identical on
 * every load and across a resize. A field that reshuffles itself when the window
 * changes width is a field the reader notices.
 */
const PERM = (() => {
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  // xorshift, fixed seed. Deterministic shuffle.
  let s = 0x9e3779b9;
  for (let i = 255; i > 0; i--) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function perlin2(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const grad = (hash: number, gx: number, gy: number) => {
    switch (hash & 3) {
      case 0: return gx + gy;
      case 1: return -gx + gy;
      case 2: return gx - gy;
      default: return -gx - gy;
    }
  };

  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];

  const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
  const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
  return x1 + v * (x2 - x1);
}

const Z_NEAR = 1.0;
const Z_FAR = 18;

/**
 * How many pre-rendered halo tints exist across the two side colours.
 *
 * The halo cannot be tinted per point at draw time without paying back the
 * string cost this whole render was built to avoid, so the hue is quantised and
 * one sprite is rendered per bucket. Fourteen steps across a two-colour spread
 * is well below where banding is visible on a dot this small.
 */
const HUE_BUCKETS = 14;

/** Halo sprite radius in CSS px. Rendered once, scaled down at draw time. */
const HALO_SPRITE_R = 24;

/**
 * Peak halo alpha as a fraction of the point's own alpha, at a full crest.
 *
 * The old value was 0.16 applied to EVERY near point uniformly. This is larger
 * per point and much dimmer overall, because it is now gated on the crest: most
 * of the field carries no halo at all at any given moment.
 */
const HALO_PEAK = 0.55;

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
    let haloSprites: HTMLCanvasElement[] = [];
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
    let crestSolid = "rgb(255,255,255)";
    /**
     * Whether to bloom additively.
     *
     * Decided from the DOT COLOURS rather than from a media query, so it follows
     * whatever the page's tokens actually are instead of assuming the OS setting
     * is the truth. Additive compositing on a light background washes the dots
     * out toward invisible, so the glow is a dark-surface effect only.
     */
    let glow = true;
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
      crestSolid = `rgb(${crestColor})`;
      const neutral = triplet(dotColor, [192, 208, 230]);
      colA = triplet(s.getPropertyValue("--wire-a").trim(), neutral);
      colB = triplet(s.getPropertyValue("--wire-b").trim(), neutral);
      const lumOf = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      glow = (lumOf(colA) + lumOf(colB)) / 2 > 128;
    };

    /**
     * Render the halo ONCE per hue bucket, into offscreen canvases.
     *
     * Deliberately not `ctx.shadowBlur`: canvas shadows are re-rasterised on
     * every draw call and would cost more than this entire render loop. A
     * cached sprite blitted with `drawImage` is one call per point, the same
     * budget the old rect had, and it is the only way to get a real radial
     * falloff without per-frame path work.
     *
     * No hot centre: the core dot supplies the highlight. A bright sprite
     * centre stacked on top of it under additive compositing is precisely what
     * made the old glow read as neon rather than as light coming off water.
     */
    const buildSprites = () => {
      const R = HALO_SPRITE_R;
      haloSprites = [];
      for (let i = 0; i < HUE_BUCKETS; i++) {
        const m = i / (HUE_BUCKETS - 1);
        const r = Math.round(colA[0] + (colB[0] - colA[0]) * m);
        const g = Math.round(colA[1] + (colB[1] - colA[1]) * m);
        const b = Math.round(colA[2] + (colB[2] - colA[2]) * m);
        const sprite = document.createElement("canvas");
        sprite.width = R * 2;
        sprite.height = R * 2;
        const sc = sprite.getContext("2d");
        if (!sc) return;
        const grad = sc.createRadialGradient(R, R, 0, R, R, R);
        grad.addColorStop(0, `rgba(${r},${g},${b},0.62)`);
        grad.addColorStop(0.22, `rgba(${r},${g},${b},0.26)`);
        grad.addColorStop(0.52, `rgba(${r},${g},${b},0.07)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        sc.fillStyle = grad;
        sc.fillRect(0, 0, R * 2, R * 2);
        haloSprites.push(sprite);
      }
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
      buildSprites();

      horizonY = h * band[0];
      // Focal length chosen so the plane's NEAR edge lands at `band[1]`:
      //   sy(Z_NEAR) = horizonY + camY * focal / Z_NEAR = h * band[1]
      const drop = Math.max(0.05, band[1] - band[0]);
      camY = 1.0;
      focal = (h * drop * Z_NEAR) / camY;

      const cols = Math.min(340, Math.max(24, Math.round(w / pitch)));
      const rows = Math.min(150, Math.max(14, Math.round((h * drop) / (pitch * 1.15))));

      // Rows are placed evenly in SCREEN space and the depth is then solved for,
      // rather than spaced evenly in z.
      //
      // Linear-in-z was the first version and it is why the foreground had holes
      // in it. Screen row spacing goes as camY*focal/z², so with Z_FAR/Z_NEAR=18
      // the nearest rows landed ~120px apart while the horizon was solid — dense
      // at the back, gappy at the front, which is the opposite of a compact
      // waveform. Inverting the projection (z = camY*focal/offset) bounds the
      // near gap by construction. The exponent keeps a little extra density at
      // the horizon so it still reads as receding rather than as a flat grid.
      const offNear = camY * focal / Z_NEAR;
      const offFar = camY * focal / Z_FAR;
      const ROW_BIAS = 1.25;

      pts = [];
      for (let r = 0; r <= rows; r++) {
        const off = offFar + (offNear - offFar) * Math.pow(r / rows, ROW_BIAS);
        const zBase = (camY * focal) / Math.max(0.0001, off);
        for (let c = 0; c <= cols; c++) {
          const seed = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453;
          const j = seed - Math.floor(seed);
          const seed2 = Math.sin(r * 39.3467 + c * 11.135) * 24634.6345;
          const j2 = seed2 - Math.floor(seed2);

          const z = zBase * (1 + (j2 - 0.5) * 0.055);
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

          const rgb = `${mix(colA[0], colB[0])},${mix(colA[1], colB[1])},${mix(colA[2], colB[2])}`;
          pts.push({
            x,
            z,
            fog,
            scale: 0.8 + j * 0.45,
            fill: `rgb(${rgb})`,
            alpha: intensity * fog,
            hue: Math.min(HUE_BUCKETS - 1, Math.round(m * (HUE_BUCKETS - 1))),
          });
        }
      }

      // Painter's order: far first, so nearer points draw over them.
      pts.sort((a, b) => b.z - a.z);
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      // Additive on dark, normal on light. Light mode paints DARK dots on paper,
      // and additive compositing there lightens them toward the background —
      // the glow would erase the field instead of intensifying it.
      ctx.globalCompositeOperation = glow ? "lighter" : "source-over";
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

      // Noise scroll. The field drifts diagonally, so detail travels with the
      // swell rather than sitting still underneath it.
      const nx = time * 0.055;
      const nz = time * 0.038;

      for (const p of pts) {
        let y = 0;
        for (const c of COMPONENTS) {
          y += c.amp * Math.sin((p.x * c.dx + p.z * c.dz) * c.k - base * c.sp);
        }

        // Two octaves of fBm on top of the swell. This is what puts structure
        // between the crests — chop, texture, the parts of a real sea that are
        // not any single wave.
        const n1 = perlin2(p.x * 0.42 + nx, p.z * 0.42 + nz);
        const n2 = perlin2(p.x * 0.95 - nx * 1.7, p.z * 0.95 + nz * 1.3);
        y += n1 * 0.85 + n2 * 0.42;

        // WAVE GROUPS. A very slow, very large-scale noise field modulating the
        // amplitude, so some stretches of water are calm and others are rough
        // and the boundary moves. Without this the sea is uniformly choppy
        // everywhere, which is the one thing an ocean never is — and it is what
        // "randomized height and width" actually describes.
        const env = 0.42 + 0.78 * (perlin2(p.x * 0.07 + time * 0.014, p.z * 0.07) * 0.5 + 0.5);

        y *= amplitude * env;

        if (swellR > 0) {
          const d = Math.abs(p.z - swellR);
          if (d < 1.6) y += Math.cos((d / 1.6) * Math.PI * 0.5) * swellA * amplitude * 2.2;
        }

        const s = focal / p.z;
        const sx = cx + p.x * s;
        if (sx < -8 || sx > w + 8) continue;
        const sy = horizonY + (camY - y) * s;
        if (sy < -8 || sy > h + 8) continue;

        const alpha = p.alpha;
        if (alpha < 0.012) continue;

        // Size straight off the projection, so nearer points really are bigger.
        const size = Math.max(0.7, Math.min(3.2, s * 0.017 * p.scale));

        // THE CREST FACTOR. This is what makes the motion drive the light.
        //
        // `y` is the point's wave height with the group envelope already
        // applied, so dividing out `amplitude` alone leaves a number that is
        // large on a crest, negative in a trough, and small EVERYWHERE inside a
        // calm stretch. Squaring it concentrates the light onto the crest line
        // instead of spreading it over the whole upper half of the wave.
        //
        // The consequence is that the glow is carried BY the water: a crest
        // travelling across the field takes its bloom with it, and the calm
        // bands between wave groups genuinely go dark. Before this, halo alpha
        // was `intensity * fog * 0.16`, fixed at BUILD time, so it varied with
        // depth and nothing else, and the sea moved underneath a stationary
        // field of light. The swell from a real arrival feeds in here too, so a
        // message landing on the bridge now lights the ring it travels on.
        const lift = y / amplitude;
        const crest = Math.min(1, Math.max(0, (lift - 0.15) / 1.7));
        const crestGlow = crest * crest;

        let fill = p.fill;
        let a = alpha * (0.88 + 0.24 * crestGlow);
        if (swellR > 0 && Math.abs(p.z - swellR) < 0.9) {
          const f = 1 - Math.abs(p.z - swellR) / 0.9;
          fill = crestSolid;
          a = Math.min(0.95, alpha + f * 0.7);
        }

        // THE HALO: a pre-rendered radial sprite, not a rect.
        //
        // It used to be a second, larger `fillRect`, and that is exactly why the
        // glow read as BOXY. A square of uniform alpha has no falloff, so every
        // bright dot wore a visible 2.9x box, and on a dense crest those boxes
        // tiled into a slab. A radial gradient is the shape a glow actually has.
        //
        // Additive still does the real work: dense parts of a crest bloom where
        // neighbouring halos overlap, which is where the light comes from rather
        // than from any single point. The halo also GROWS with the crest, so a
        // wave brings a widening bloom with it rather than only a brightening.
        const sprite =
          glow && crestGlow > 0.12 && size > 0.95 ? haloSprites[p.hue] : undefined;
        if (sprite) {
          const hs = size * (3.2 + crestGlow * 2.4);
          ctx.globalAlpha = alpha * HALO_PEAK * crestGlow;
          ctx.drawImage(
            sprite,
            sx + size / 2 - hs / 2,
            sy + size / 2 - hs / 2,
            hs,
            hs,
          );
        }

        ctx.globalAlpha = a;
        ctx.fillStyle = fill;
        ctx.fillRect(sx, sy, size, size);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
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
