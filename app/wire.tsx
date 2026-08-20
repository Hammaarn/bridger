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
 * THE SEA: a Gerstner (trochoidal) spectrum, not a sum of sines.
 *
 * A sine surface is symmetric. Its troughs are the same shape as its crests,
 * and no amount of layering fixes that, because it is a property of the
 * FUNCTION rather than of the parameters. Real gravity waves are trochoidal:
 * each surface particle travels a CIRCLE instead of bobbing straight up and
 * down, which sharpens the crests and flattens the troughs. Gerstner solved it
 * exactly in 1802 and it is what CG oceans have used ever since.
 *
 * For a POINT FIELD it buys something a heightmap does not care about. The
 * circular orbit displaces each point HORIZONTALLY as well as vertically, and
 * the horizontal component converges on the crest, so the dots physically
 * GATHER where the water gathers. Brightness along a wave is then real density
 * rather than an alpha threshold.
 *
 * That distinction is the whole reason this rewrite exists. The previous
 * version keyed glow to HEIGHT, and a height threshold on a surface can only
 * ever select an iso-height contour, which is a LINE. No tuning reaches a wave
 * from there; the generating model has to change.
 *
 * Steepness is what Gerstner carries instead of amplitude: `a = s / k`. The
 * steepnesses must sum to under 1 or the surface self-intersects and knots --
 * which is, pleasingly, the exact point at which a real wave breaks.
 *
 * The headings are SPREAD, not aligned. A real sea has directional spreading
 * around a dominant heading, and it is most of why water reads as water rather
 * than as corrugated iron.
 */
const WAVE_SPEC: { lambda: number; ang: number; s: number }[] = [
  { lambda: 12.0, ang: 0.66, s: 1.0 },
  { lambda: 7.3, ang: 0.34, s: 0.94 },
  { lambda: 4.9, ang: 1.02, s: 0.88 },
  { lambda: 3.1, ang: 0.12, s: 0.82 },
  { lambda: 2.05, ang: 1.38, s: 0.76 },
  { lambda: 1.32, ang: -0.31, s: 0.7 },
  { lambda: 0.83, ang: 0.92, s: 0.63 },
  { lambda: 0.54, ang: -0.66, s: 0.55 },
  { lambda: 0.35, ang: 1.71, s: 0.46 },
  { lambda: 0.22, ang: 0.5, s: 0.36 },
];

/**
 * Gravity, in the world units the wavelengths are in.
 *
 * It is here for DISPERSION, the second thing summed sines could not do. Deep
 * water travels at `c = sqrt(g/k)`, so long waves outrun short ones, and that
 * one relationship is what makes wave GROUPS form and dissolve by themselves.
 * The previous version faked groups with a slow noise field modulating
 * amplitude. With real dispersion they are emergent and the fake comes out.
 */
const G = 9.8;

/**
 * A sine lookup table.
 *
 * Ten components, each needing a sine AND a cosine, across tens of thousands of
 * points, every frame: roughly half a million transcendental calls per frame,
 * which does not fit in a frame budget. The table makes each one an array read.
 * 4096 steps over a full turn is 0.0015 rad, far below anything visible on a
 * dot two pixels wide.
 *
 * A point's phase is `k*(D . x) - w*t`. The FIRST term is constant per point
 * per wave and is precomputed at build as an integer table index; the second is
 * constant per wave per FRAME. So the entire per-point-per-wave cost inside the
 * loop is one integer subtract and two array reads.
 */
const LUT_BITS = 12;
const LUT_SIZE = 1 << LUT_BITS;
const LUT_MASK = LUT_SIZE - 1;
const LUT_QUARTER = LUT_SIZE >> 2;
const LUT_SCALE = LUT_SIZE / (Math.PI * 2);
const SIN_LUT = (() => {
  const t = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) t[i] = Math.sin((i / LUT_SIZE) * Math.PI * 2);
  return t;
})();

/**
 * The light, as a half-vector in world space. Deliberately NOT vertical.
 *
 * A near-vertical light lands on flat water and leaves the wave faces dark,
 * which is the inverse of what a sea looks like. A LOW light grazes the faces
 * tilted toward it and produces the glitter path: the broad, moving road of
 * light that reads instantly as water. Tilted far enough off vertical that calm
 * water sits low on the specular curve and only a tilted face climbs it.
 */
const H_X = 0.14;
const H_Y = 0.42;
const H_Z = -0.9;

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

/**
 * The widest dot, in CSS px, and therefore how many size variants each hue
 * caches. Eight covers the near edge on a large display with room to spare.
 */
const MAX_DOT = 8;

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
    // Indexed [hue][sizeInCssPx]. See buildSprites for why the size is part
    // of the key rather than a scale factor at draw time.
    let discSprites: HTMLCanvasElement[][] = [];
    let dprNow = 1;

    // Flat typed arrays rather than an array of objects: this is read ten times
    // per point per frame and property lookup at that rate is not free.
    const NW = WAVE_SPEC.length;
    const wAX = new Float32Array(NW); // a * D.x  -- horizontal orbit, x
    const wAY = new Float32Array(NW); // a        -- vertical orbit
    const wAZ = new Float32Array(NW); // a * D.z  -- horizontal orbit, z
    const wSX = new Float32Array(NW); // s * D.x  -- normal, x
    const wSY = new Float32Array(NW); // s        -- normal, y
    const wSZ = new Float32Array(NW); // s * D.z  -- normal, z
    const wK = new Float32Array(NW);
    const wDX = new Float32Array(NW);
    const wDZ = new Float32Array(NW);
    const wOmega = new Float32Array(NW);
    const wtIdx = new Int32Array(NW);
    // One phase index per point per wave, filled AFTER the painter sort so the
    // row order matches `pts`.
    let phaseIdx = new Int32Array(0);


    /**
     * Resolve the spectrum against this instance's sea state and period.
     *
     * `amplitude` is reinterpreted as TOTAL STEEPNESS, which is the parameter
     * Gerstner actually has, and clamped below 1 because at 1 the surface ties
     * itself in knots. The per-wave share keeps the spectrum's shape.
     *
     * Time is scaled so that the LONGEST wave completes in `period` seconds,
     * which preserves the meaning the prop always had while leaving the
     * dispersion RATIO between components untouched -- the ratio is the part
     * that does the visual work.
     */
    const buildWaves = () => {
      let sum = 0;
      for (const c of WAVE_SPEC) sum += c.s;
      const total = Math.min(0.75, Math.max(0.04, amplitude * 2.2));
      const k0 = (Math.PI * 2) / WAVE_SPEC[0].lambda;
      const timeScale = Math.PI * 2 / period / Math.sqrt(G * k0);

      for (let i = 0; i < NW; i++) {
        const c = WAVE_SPEC[i];
        const k = (Math.PI * 2) / c.lambda;
        const s = (c.s / sum) * total;
        const a = s / k;
        const dx = Math.cos(c.ang);
        const dz = Math.sin(c.ang);
        wK[i] = k;
        wDX[i] = dx;
        wDZ[i] = dz;
        wAX[i] = a * dx;
        wAY[i] = a;
        wAZ[i] = a * dz;
        wSX[i] = s * dx;
        wSY[i] = s;
        wSZ[i] = s * dz;
        wOmega[i] = Math.sqrt(G * k) * timeScale;
      }
    };
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
      discSprites = [];
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

        // THE CORE DOT. This is the complaint that would not go away, and
        // the reason is that the first fix only reached part of it.
        //
        // The dot was `fillRect(sx, sy, size, size)` -- an actual square, two to
        // five pixels wide depending on the display. Making the HALO radial and
        // leaving the core a rect fixed the wrong half, and then gating discs to
        // dots wider than 2.6px fixed almost none of them, because almost no dot
        // is that wide. On a 2545px-wide window every one of them read as a cube.
        //
        // So: no threshold, every dot is a disc. The cost of that is the reason
        // for the size key. `drawImage` with a scale factor is markedly more
        // expensive than a straight blit, so instead of one sprite stretched per
        // point, there is one sprite PER INTEGER PIXEL SIZE, rendered at device
        // resolution, and the draw maps it 1:1 onto the pixel grid. Rounding the
        // size to whole pixels costs nothing anyone can see at two to eight
        // pixels wide, and buys the fast path.
        const row: HTMLCanvasElement[] = [];
        for (let px = 0; px <= MAX_DOT; px++) {
          const dim = Math.max(1, Math.round(px * dprNow));
          const disc = document.createElement("canvas");
          disc.width = dim;
          disc.height = dim;
          const dc = disc.getContext("2d");
          if (!dc) return;
          if (dim <= 2) {
            // At one or two device pixels there is no room for a falloff, and a
            // gradient here only produces a dimmer dot, not a rounder one.
            dc.fillStyle = `rgb(${r},${g},${b})`;
            dc.fillRect(0, 0, dim, dim);
          } else {
            const rad = dim / 2;
            const dg = dc.createRadialGradient(rad, rad, 0, rad, rad, rad);
            dg.addColorStop(0, `rgba(${r},${g},${b},1)`);
            dg.addColorStop(0.5, `rgba(${r},${g},${b},1)`);
            dg.addColorStop(0.82, `rgba(${r},${g},${b},0.5)`);
            dg.addColorStop(1, `rgba(${r},${g},${b},0)`);
            dc.fillStyle = dg;
            dc.fillRect(0, 0, dim, dim);
          }
          row.push(disc);
        }
        discSprites.push(row);
      }
    };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprNow = dpr;
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
      buildSprites();
      buildWaves();

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

      // NEAR TO FAR, which is the reverse of what this used to do.
      //
      // Painter's order stopped mattering the moment the field went additive --
      // addition commutes, so the draw order cannot change the result. What
      // does need an order is the silhouette buffer, and it only works walking
      // toward the horizon: you cannot know what a wave hides until you have
      // drawn the wave.
      pts.sort((a, b) => a.z - b.z);

      // The stationary half of every phase, as a table index. Computed AFTER
      // the sort so row `i` here is the same point as `pts[i]` in the loop.
      phaseIdx = new Int32Array(pts.length * NW);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const base = i * NW;
        for (let j = 0; j < NW; j++) {
          phaseIdx[base + j] =
            (wK[j] * (wDX[j] * p.x + wDZ[j] * p.z) * LUT_SCALE) | 0;
        }
      }
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

      // The moving half of every phase: constant per wave per frame.
      for (let j = 0; j < NW; j++) {
        wtIdx[j] = (wOmega[j] * time * LUT_SCALE) | 0;
      }

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const base = i * NW;

        // Gerstner displacement and the analytic surface normal, accumulated in
        // one pass because they share the same sine and cosine.
        let ox = 0;
        let oy = 0;
        let oz = 0;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (let j = 0; j < NW; j++) {
          const idx = phaseIdx[base + j] - wtIdx[j];
          const S = SIN_LUT[idx & LUT_MASK];
          const C = SIN_LUT[(idx + LUT_QUARTER) & LUT_MASK];
          ox += wAX[j] * C;
          oy += wAY[j] * S;
          oz += wAZ[j] * C;
          nx += wSX[j] * C;
          ny += wSY[j] * S;
          nz += wSZ[j] * C;
        }

        // A real arrival still disturbs the water, and it now disturbs the
        // SURFACE rather than a brightness constant, so the swell lights itself
        // through the same specular term as every other wave.
        let ring = 0;
        if (swellR > 0) {
          const d = Math.abs(p.z - swellR);
          if (d < 1.6) {
            ring = Math.cos((d / 1.6) * Math.PI * 0.5) * swellA;
            oy += ring * 0.42;
          }
        }

        // Depth is displaced too, so points really do ride toward and away from
        // the camera rather than only up and down.
        const wz = p.z + oz;
        if (wz < 0.4) continue;

        const s = focal / wz;
        const sx = cx + (p.x + ox) * s;
        if (sx < -10 || sx > w + 10) continue;
        const sy = horizonY + (camY - oy) * s;
        if (sy < -10 || sy > h + 10) continue;

        // THE LIGHT COMES OFF THE SLOPE, NOT THE HEIGHT.
        //
        // N = (-nx, 1 - ny, -nz) is the Gerstner normal. Dotting it against a
        // low half-vector and raising that to the twelfth power gives a
        // specular response that is near zero on flat water and climbs steeply
        // on a face turned toward the light -- so the bright regions are the
        // FACES of the waves, which are areas that travel, rather than a
        // constant-height contour, which is a line. The power is reached by
        // squaring rather than by `Math.pow`, which at this call rate matters.
        const nY = 1 - ny;
        const inv = 1 / Math.sqrt(nx * nx + nY * nY + nz * nz);
        const dot = (-nx * H_X + nY * H_Y + -nz * H_Z) * inv;
        let spec = 0;
        if (dot > 0) {
          const d2 = dot * dot;
          const d4 = d2 * d2;
          spec = d4 * d4;
        }

        const size = Math.max(0.7, Math.min(3.4, s * 0.017 * p.scale));
        let fill = p.fill;
        let a = p.alpha * (0.62 + 0.7 * spec);
        if (ring > 0.02) {
          fill = crestSolid;
          a = Math.min(0.95, a + ring * 0.5);
        }
        if (a < 0.012) continue;

        // The bloom, on the lit faces only. Additive, so where a face turns
        // into the light and the dots crowd together at the crest, the overlap
        // does the accumulating -- density and light rising together, which is
        // what a wave actually does.
        if (glow && spec > 0.12 && size > 0.9) {
          const halo = haloSprites[p.hue];
          if (halo) {
            const hs = size * (2.6 + spec * 3.4);
            ctx.globalAlpha = Math.min(0.6, p.alpha * HALO_PEAK * spec);
            ctx.drawImage(halo, sx - hs / 2, sy - hs / 2, hs, hs);
          }
        }

        ctx.globalAlpha = a;
        const row = discSprites[p.hue];
        const px = size < 1 ? 1 : size > MAX_DOT ? MAX_DOT : Math.round(size);
        const sprite = row && row[px];
        if (sprite) {
          const half = px / 2;
          ctx.drawImage(sprite, sx - half, sy - half, px, px);
        } else {
          ctx.fillStyle = fill;
          ctx.fillRect(sx, sy, size, size);
        }
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
