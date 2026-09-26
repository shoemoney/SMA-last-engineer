/**
 * Grades the COMPOSITED SCREENSHOT, not the canvas.
 *
 * An earlier version copied the 3D canvas into a 2D canvas in-page and read it
 * back. It reported 100% black on a scene that was demonstrably rendering: a
 * WebGL/WebGPU drawing buffer is not preserved after compositing, so drawImage
 * hands you an empty surface. The probe was broken, not the game — which is
 * exactly the failure that sank the Unreal build.
 *
 * The screenshot is the only surface that is definitionally what a human sees:
 * it includes the DOM HUD, the CSS, and the 3D view, already composited.
 */
import { inflateSync } from 'node:zlib'

export function decodePng(buf) {
  let pos = 8, w = 0, h = 0, colorType = 0, bitDepth = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (type === 'IHDR') {
      w = buf.readUInt32BE(pos + 8)
      h = buf.readUInt32BE(pos + 12)
      bitDepth = buf[pos + 16]
      colorType = buf[pos + 17]
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(pos + 8, pos + 8 + len))
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  let p = 0

  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = (line[x] + add) & 0xff
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { width: w, height: h, channels, data: out }
}

export function analyze(pngBuffer) {
  const { width, height, channels, data } = decodePng(pngBuffer)
  const n = width * height
  const lums = new Float64Array(n)
  const hues = new Uint32Array(36)
  let sum = 0, black = 0, white = 0, colored = 0

  for (let i = 0, px = 0; px < n; i += channels, px++) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 255
    lums[px] = L
    sum += L
    if (L < 4) black++
    if (L > 250) white++

    const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min
    if (c > 0.06 && max > 0.08) {
      colored++
      let hd
      if (max === r) hd = 60 * (((g - b) / c) % 6)
      else if (max === g) hd = 60 * ((b - r) / c + 2)
      else hd = 60 * ((r - g) / c + 4)
      if (hd < 0) hd += 360
      hues[Math.min(35, Math.floor(hd / 10))]++
    }
  }

  const mean = sum / n
  let v = 0
  for (let px = 0; px < n; px++) { const d = lums[px] - mean; v += d * d }
  const totalColored = hues.reduce((a, b) => a + b, 0)

  return {
    width, height,
    meanLuminance: +mean.toFixed(2),
    stdDev: +Math.sqrt(v / n).toFixed(2),
    blackPct: +(100 * black / n).toFixed(2),
    whitePct: +(100 * white / n).toFixed(2),
    coloredPct: +(100 * colored / n).toFixed(2),
    distinctHues: hues.filter(x => x > totalColored * 0.01).length,
  }
}

/** A frame passes only if it is lit, varied, and not a flat wash. */
export const GATE = {
  meanLuminance: [14, 200],
  stdDev: [12, Infinity],
  blackPct: [0, 78],
  whitePct: [0, 25],
  distinctHues: [4, Infinity],
}

export function judge(m) {
  const fails = []
  for (const [k, [lo, hi]] of Object.entries(GATE)) {
    const val = m[k]
    if (typeof val !== 'number' || val < lo || val > hi) {
      fails.push(`${k}=${val} outside [${lo}, ${hi === Infinity ? '∞' : hi}]`)
    }
  }
  return fails
}

// ---------------------------------------------------------------------------
// Shard silhouettes
// ---------------------------------------------------------------------------

/**
 * Grades the SHAPE of a blood gob as it actually renders — real geometry, real material,
 * real lighting, real post chain — by hulling the red component in the composited
 * screenshot. Nothing here names a constant that appears in src/fx/impacts.js, so the gate
 * cannot be satisfied by editing a number in one place and calling the silhouette fixed.
 *
 * HONEST CAVEAT ON SCALE: the probe renders one gob at 26 cm seen from 150 cm, so the
 * silhouette is ~100 px and can be hulled. In game a gob is 2.0-3.5 cm and covers 4-9 px,
 * and a 5 px blob cannot be hulled reliably — a first attempt at the true in-game size left
 * 3 of 9 gobs with too few pixels to grade. This gate therefore asserts SHAPE, which is
 * scale-invariant, and says nothing about SIZE. That gap is exactly why no existing gate
 * caught a cube here.
 *
 * WHY THE TURN ANGLE IS MEASURED OVER AN ARC WINDOW AND NOT PER HULL VERTEX: rasterising a
 * straight edge gives a staircase, and every step is a hull vertex with a tiny turn, so raw
 * per-vertex turns describe the pixel grid rather than the shape. The obvious fix — simplify
 * the hull by perpendicular distance first — is WRONG and was measured to be wrong here: at
 * eps 1.5 px a filled disc of radius 50 collapsed from a 44-vertex hull to a QUADRILATERAL
 * with circularity 0.785, i.e. the simplifier turned a circle into a square and the grader
 * would have reported the fix as still broken. Instead each hull vertex is judged by the
 * angle between the chord reaching it from TURN_WINDOW of the perimeter back and the chord
 * leaving it TURN_WINDOW forward. That is scale-invariant and has closed-form expectations:
 * square 90 deg, hexagon 60, 12-gon 30, smooth circle 360 * TURN_WINDOW.
 */

/**
 * The backdrop colour, as the MODE of the frame's own pixels. The probe puts a flat
 * unlit panel behind the gob grid, so the backdrop is by far the most common colour and
 * this needs no threshold chosen by hand — the frame calibrates the grader, not the other
 * way round. Colour-thresholding the gob instead was measured to FAIL: a dark object is
 * black on its unlit side, so a `red-dominant` mask captured only the LIT FACE of each
 * cube and would have graded a sphere's lit cap as a chord-cut disc with two sharp
 * corners, failing a correct fix.
 */
function backdropColor(img) {
  const { width, height, channels, data } = img
  const bins = new Map()
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const i = (x + y * width) * channels
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
      const e = bins.get(key)
      if (e) { e[0] += data[i]; e[1] += data[i + 1]; e[2] += data[i + 2]; e[3]++ }
      else bins.set(key, [data[i], data[i + 1], data[i + 2], 1])
    }
  }
  let best = null
  for (const e of bins.values()) if (!best || e[3] > best[3]) best = e
  return [best[0] / best[3], best[1] / best[3], best[2] / best[3], best[3]]
}

/**
 * How much of the backdrop's blueness a pixel has to lose before it counts as gob.
 *
 * THE PROBE PAINTS A SATURATED BLUE PANEL, and that is the half of this probe that makes
 * the other half work. Blue is the one thing a blood gob cannot be: the gob is dark red and
 * its specular highlight is warm white, so classifying by HUE separates them in a way no
 * brightness test can. Two brightness tests were tried and both were measured wrong:
 *
 *   "differs from the backdrop"  — the gob's highlight blooms a bright spur PAST the rim,
 *                                  the flood fill swallowed it, and three of nine gobs grew
 *                                  a 49-62 deg spike on geometry that is visibly round.
 *   "darker than the backdrop"   — drops the bloom, but also drops the bright specular
 *                                  crescent ALONG the rim, so the hull chords across it and
 *                                  gob 2 read 41.4 deg where the same sphere read 27-32 deg
 *                                  wherever no highlight touched an edge.
 *
 * Morphological closing was tried against that second failure and is not the answer either:
 * closing only ever adds pixels INSIDE the convex hull, so hull(close(X)) === hull(X) and it
 * cannot restore a rim the mask lost. It was removed rather than left in looking useful.
 *
 * The hue test keeps both the dark body and the white highlight, and rejects the halo, for
 * a reason worth stating exactly: blue-lead is INVARIANT under additive white. Bloom adds
 * the same amount to all three channels, so b - max(r, g) does not move at all — until a
 * channel CLAMPS at 255, after which blue stops rising while red and green keep going and
 * the lead collapses. That is the single failure mode, and the panel is therefore kept dark
 * enough to leave ~160 of headroom before blue clamps, rather than bright enough to look
 * like a studio backdrop. A panel at 0x0020a0 measured gob 2 at 44.5 deg against an
 * analytic silhouette of 28.7 deg; the headroom is what closes that gap.
 */
const BACKDROP_BLUE_MARGIN = 0.35

/** How far blue leads the warmer channels. The panel's is high; nothing on a gob's is. */
const blueLead = (r, g, b) => b - Math.max(r, g)

/** The component CONTAINING the seed. A box collect leaks background; this cannot. */
function floodFrom(img, sx, sy, bg) {
  const { width, height, channels, data } = img
  const total = width * height
  const cut = BACKDROP_BLUE_MARGIN * blueLead(bg[0], bg[1], bg[2])
  const isGob = (i) => blueLead(data[i], data[i + 1], data[i + 2]) < cut
  let seed = Math.round(sx) + Math.round(sy) * width
  if (seed < 0 || seed >= total) return []

  // The seed is the projected CENTRE of the gob. It should land on the gob, but a stretch
  // that shrinks one axis can leave it a few px outside; nudge onto the nearest gob pixel.
  if (!isGob(seed * channels)) {
    let best = -1
    for (let r = 1; r <= 8 && best < 0; r++) {
      for (let dy = -r; dy <= r && best < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.round(sx) + dx, y = Math.round(sy) + dy
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          if (isGob((x + y * width) * channels)) { best = x + y * width; break }
        }
      }
    }
    if (best < 0) return []
    seed = best
  }

  return floodComponent(width, height, i => isGob(i * channels), seed, new Uint8Array(total))
}

/**
 * The one 4-connected flood in this file. `isIn(pixelIndex)` decides membership, `seen` is
 * shared so a caller sweeping for the LARGEST component visits every pixel once in total
 * rather than once per component.
 *
 * Two callers with two membership tests is fine; two floods is how the two drift apart.
 */
function floodComponent(width, height, isIn, seed, seen) {
  const px = []
  const stack = [seed]
  seen[seed] = 1
  while (stack.length) {
    const p = stack.pop()
    const x = p % width, y = (p / width) | 0
    px.push([x, y])
    if (px.length > 250000) break
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const q = nx + ny * width
      if (seen[q] || !isIn(q)) continue
      seen[q] = 1
      stack.push(q)
    }
  }
  return px
}

/** The biggest 4-connected blob `isIn` describes, as [x, y] pairs. */
function largestComponent(width, height, isIn) {
  const seen = new Uint8Array(width * height)
  let best = []
  for (let p = 0; p < seen.length; p++) {
    if (seen[p] || !isIn(p)) continue
    const px = floodComponent(width, height, isIn, p, seen)
    if (px.length > best.length) best = px
  }
  return best
}

/** Andrew's monotone chain. Verified against a filled disc: 44 vertices at radius 50. */
function convexHull(points) {
  if (points.length < 3) return points.slice()
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src) => {
    const h = []
    for (const p of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  return half(pts).concat(half(pts.reverse()))
}

/** Fraction of the outline walked either side of a vertex to judge how sharply it turns. */
const TURN_WINDOW = 0.06

/** Walk `dist` px along the hull from vertex `i`, in direction `dir` (+1 / -1). */
function walk(hull, edge, i, dist, dir) {
  const n = hull.length
  let at = i
  let left = dist
  for (let guard = 0; guard < n; guard++) {
    const e = dir > 0 ? edge[at] : edge[(at - 1 + n) % n]
    if (e >= left || e === 0) {
      const from = hull[at]
      const to = hull[(at + dir + n) % n]
      const t = e === 0 ? 0 : left / e
      return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
    }
    left -= e
    at = (at + dir + n) % n
  }
  return hull[(i + dir + n) % n]
}

function hullMetrics(hull) {
  const n = hull.length
  const edge = new Float64Array(n)
  let area = 0, perim = 0
  for (let i = 0; i < n; i++) {
    const p = hull[i], q = hull[(i + 1) % n]
    area += p[0] * q[1] - q[0] * p[1]
    edge[i] = Math.hypot(q[0] - p[0], q[1] - p[1])
    perim += edge[i]
  }
  area = Math.abs(area) / 2

  const span = perim * TURN_WINDOW
  const turns = new Array(n)
  let maxTurn = 0
  for (let i = 0; i < n; i++) {
    const back = walk(hull, edge, i, span, -1)
    const fwd = walk(hull, edge, i, span, +1)
    const p = hull[i]
    const a = Math.atan2(p[1] - back[1], p[0] - back[0])
    const b = Math.atan2(fwd[1] - p[1], fwd[0] - p[0])
    let t = Math.abs(((b - a) * 180) / Math.PI) % 360
    if (t > 180) t = 360 - t
    turns[i] = +t.toFixed(1)
    if (t > maxTurn) maxTurn = t
  }
  return {
    area: Math.round(area),
    vertices: n,
    maxTurn: +maxTurn.toFixed(1),
    turns,
    perimeter: Math.round(perim),
    circularity: perim > 0 ? +((4 * Math.PI * area) / (perim * perim)).toFixed(3) : 0,
  }
}

/**
 * Consecutive over-threshold hull vertices are ONE corner seen from several pixels, not
 * several corners. Counting them individually would report a square as having a dozen.
 */
function countCorners(turns, threshold) {
  const n = turns.length
  const hot = turns.map((t) => t > threshold)
  if (!hot.some(Boolean)) return 0
  if (hot.every(Boolean)) return 1
  // One corner per RUN of hot vertices: count each vertex whose predecessor, wrapping round
  // the hull, is not itself hot.
  let corners = 0
  for (let i = 0; i < n; i++) if (hot[i] && !hot[(i - 1 + n) % n]) corners++
  return corners
}

/**
 * A cube silhouette is a square or a hexagon: 4-6 straight edges turning 60-90 deg at every
 * corner. A >=12-segment round droplet turns at most 30 deg, and a smooth curve only
 * 360 * TURN_WINDOW = 21.6 deg.
 *
 * VALIDATED ON SYNTHETIC SHAPES rendered through this exact flood/hull path, so the
 * grader's own arithmetic is pinned independently of the game (scratch harness, r=50 px):
 *   square (a cube head-on)    maxTurn 88.0  corners 4  circularity 0.796  -> FAIL, as it must
 *   hexagon (a cube corner-on) maxTurn 58.6  corners 4  circularity 0.918  -> FAIL, as it must
 *   12-gon                     maxTurn 29.6  corners 0  circularity 0.983  -> pass
 *   12-gon stretched 1.8:1     maxTurn 49.6  corners 2  circularity 0.865  -> FAIL
 * That last row is the one to keep in mind: roundness is not free, an over-stretched round
 * gob fails this gate too, which is why FX.IMPACT.bloodStretchMax is not a free parameter.
 *
 * MEASURED IN THE REAL FRAME by the FINISHED probe, all 9 gobs, 1280x720,
 * ?renderer=webgpu&verify=1&seed=1337. Both runs use the identical probe — the BEFORE was
 * re-taken after the probe stopped changing, not carried over from an earlier version:
 *
 *   BEFORE (BoxGeometry, the defect)
 *     maxTurn  78.1 / 82.9 / 85.9 / 87.0 / 87.7 / 91.2 / 91.8 / 92.4 / 93.0
 *     corners  3-5 on every gob          circularity 0.803 - 0.888
 *   AFTER (SphereGeometry 14x10 + per-shard stretch)
 *     maxTurn  26.0 / 27.3 / 28.4 / 28.9 / 30.1 / 30.9 / 31.3 / 31.4 / 32.4
 *     corners  0 on every gob            circularity 0.976 - 0.995 (gob 1 0.985, gob 5 0.989)
 *
 * Re-verified at HEAD (commit f3fe95f "delete the colour jitter that never reached a
 * pixel" and unchanged since — src/fx/impacts.js has had no commits after it): gob 5 reads
 * 28.9, not the 29.7 an earlier AFTER series recorded. That series was captured one commit
 * before this one (6836e66, jitter still present); deleting the per-shard colour jitter
 * removes one rng.range() draw per blood shard, which shifts the shared RNG stream, moves
 * the crowd, and changes the light falling on gob 5. Confirmed stable in both directions via
 * a worktree A/B at 6836e66 (29.7) and f3fe95f/HEAD (28.9). The 9-value RANGE (26.0-32.4)
 * and the circularity range (0.976-0.995) both still hold — only that one gob's exact digit
 * had rotted.
 *
 * TO REGENERATE: boot the built game headless (`serve.mjs` + a Chromium page, same
 * `--use-angle=metal --enable-unsafe-webgpu` args as verify/e2e.mjs) at
 * `?renderer=webgpu&verify=1&seed=1337`, wait for `__SHOE__.ready`, run
 * `__SHOE__.scenario('firefight')` long enough for at least 9 blood gobs to land on the
 * blue backdrop, screenshot, then locate each gob's seed pixel (scan for the blood hue
 * against the panel's blue via `backdropColor`/`blueLead`, same test this file already
 * uses to confirm the panel is in frame) and pass those 9 points to
 * `gradeShardSilhouettes`. Sort the returned `maxTurn` values ascending before recording
 * them — the ORDER is by measured angle, not by which gob happened to render first.
 *
 * The thresholds below sit between BEFORE and AFTER and are not to be moved. Corroboration
 * that the probe measures GEOMETRY and not lighting: an independent analytic model of the
 * same nine gobs — the convex hull of the mesh's projected vertices, which for a convex
 * solid IS its silhouette — predicts 24.5-31.3 deg, against the 26.0-32.4 measured. They
 * agree to about 2 deg. Before bloom was dialled out of the probe frame they disagreed by 16.
 *
 * `minArea` is not a quality bar, it is a "did the probe actually find the gob" bar — a
 * component below it is reported as ungradeable rather than silently passed.
 */
export const SHARD_GATE = {
  minArea: 400,
  maxCorners: 0,      // BEFORE: 3-5 per gob.  AFTER: 0 on all nine.
  sharpCornerDeg: 40, // BEFORE: 78.1-93.0 deg.  AFTER: 26.0-32.4.
  minCircularity: 0.93, // BEFORE: 0.803-0.888.  AFTER: 0.976-0.995.
}

export function gradeShardSilhouettes(pngBuffer, points) {
  const img = decodePng(pngBuffer)
  const bg = backdropColor(img)
  // Fail loudly rather than grade nonsense: without the blue panel every test below is
  // measuring something other than a silhouette.
  if (blueLead(bg[0], bg[1], bg[2]) < 40) {
    return points.map((_, i) => ({
      i, ungradeable: true,
      fails: [`backdrop is rgb(${bg.slice(0, 3).map(Math.round).join(',')}), not the blue probe panel`],
    }))
  }
  const gobs = []
  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i]
    const px = floodFrom(img, x, y, bg)
    if (px.length < SHARD_GATE.minArea) {
      gobs.push({
        i, px: px.length, ungradeable: true,
        fails: [`only ${px.length}px off the blue panel at (${Math.round(x)},${Math.round(y)}) — probe found no gob`],
      })
      continue
    }
    const m = hullMetrics(convexHull(px))
    const corners = countCorners(m.turns, SHARD_GATE.sharpCornerDeg)
    const fails = []
    if (corners > SHARD_GATE.maxCorners) {
      fails.push(`${corners} corner(s) over ${SHARD_GATE.sharpCornerDeg}deg (maxTurn ${m.maxTurn})`)
    }
    if (m.circularity < SHARD_GATE.minCircularity) {
      fails.push(`circularity ${m.circularity} < ${SHARD_GATE.minCircularity}`)
    }
    gobs.push({ i, px: px.length, ...m, corners, fails })
  }
  return gobs
}

// ---------------------------------------------------------------------------
// Viewmodel silhouette
// ---------------------------------------------------------------------------

/**
 * Grades the WEAPON IN THE PLAYER'S HANDS as it actually renders, from the composited
 * screenshot, by differencing two frames that are identical except for
 * `scene.getObjectByName('viewmodel').visible`.
 *
 * WHY A DIFFERENCE AND NOT A REGION. The gun sits over the station, over the tunnel mouth and
 * under the DOM HUD, none of which hold still from one scenario to the next, and a hand-drawn
 * rectangle around "where the pistol usually is" would grade whatever else fell inside it —
 * which is precisely how the first report of this defect mistook a sliver of station background
 * for gun furniture. Toggling one flag leaves every other pixel in the frame — HUD, station,
 * lighting, post chain, exposure (fixed at 1.15 in engine.js, so there is no adaptation to
 * confound this) — bit-identical, so whatever moved IS the weapon and its arms and nothing else.
 *
 * WHAT THE THREE NUMBERS ARE FOR, and why one alone is not enough:
 *   medianL       is it lit at all. A gun rendering at median luminance 8 out of 255 is a
 *                 silhouette, not an object.
 *   pctUnder20    how much of it is in that hole. A bright optic on a black slab can carry the
 *                 median; this cannot be carried by a highlight.
 *   patchLsd_p50  local contrast, as the median standard deviation of luminance inside an 8x8
 *                 patch. This is the one that separates "unlit" from "untextured": a flat grey
 *                 slab and a fully baked gun can share a median, and only one of them has
 *                 structure at the scale of a slide serration or a magazine seam. Raising a
 *                 light intensity moves the first two numbers and barely moves this one.
 *
 * Nothing here names a light, an intensity, a budget or a tier. The gate cannot be satisfied by
 * editing a number in src/ and declaring the gun lit.
 */

/** How far a channel must move before a pixel counts as part of the weapon. */
const VIEWMODEL_DIFF = 25
/** Side of the local-detail patch, in pixels, and how far apart the patches are sampled. */
const PATCH = 8
const PATCH_STRIDE = 4

/**
 * MEASURED ON HEAD, all three weapons in one platform frame, with the view rig dead:
 *   pistol   medianL  6.86   pctUnder20 65.31%   patchLsd_p50  1.17   <- fails all three
 *   shotgun  medianL 22.43   pctUnder20 45.28%   patchLsd_p50  3.21
 *   rifle    medianL 88.55   pctUnder20 13.57%   patchLsd_p50 10.65
 * The pistol is the STARTING weapon (PLAYER.START.weapon), so the gun every player sees first
 * was the one failing, and the two that pass are the two nobody holds at the title screen.
 *
 * The thresholds sit under the weakest weapon that already passes and well over what the
 * pistol managed, and they are not to be moved. `minArea` is not a quality bar, it is a "did
 * the probe find the weapon at all" bar — under it the result is reported ungradeable rather
 * than quietly passed.
 */
export const VIEWMODEL_GATE = {
  minArea: 4000,
  medianL: 20,
  pctUnder20: 55,
  patchLsd_p50: 2.5,
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function median(values) {
  if (!values.length) return 0
  const sorted = Float64Array.from(values).sort()
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * @param {Buffer} onPng   the frame WITH the viewmodel visible
 * @param {Buffer} offPng  the same frame with it hidden
 * @param {string} [label] the weapon id, for the failure text
 */
export function gradeViewmodelSilhouette(onPng, offPng, label = 'viewmodel') {
  const on = decodePng(onPng)
  const off = decodePng(offPng)
  if (on.width !== off.width || on.height !== off.height) {
    return { label, ungradeable: true, fails: [`frames disagree on size: ${on.width}x${on.height} vs ${off.width}x${off.height}`] }
  }

  const { width, height, channels, data } = on
  const oc = off.channels, od = off.data
  const moved = (p) => {
    const i = p * channels, j = p * oc
    return Math.max(
      Math.abs(data[i] - od[j]),
      Math.abs(data[i + 1] - od[j + 1]),
      Math.abs(data[i + 2] - od[j + 2]),
    ) > VIEWMODEL_DIFF
  }

  const px = largestComponent(width, height, moved)
  if (px.length < VIEWMODEL_GATE.minArea) {
    return { label, area: px.length, ungradeable: true,
             fails: [`largest changed blob is only ${px.length}px — the probe did not find a weapon`] }
  }

  // The mask, so a patch can ask whether all 64 of its pixels are weapon.
  const inMask = new Uint8Array(width * height)
  let x0 = width, y0 = height, x1 = 0, y1 = 0
  const lums = new Float64Array(px.length)
  let under = 0
  // Over-drive telltales. A fixture 13 cm from the slide can push the diffuse lobe past what
  // the tonemapper holds, and when it does the round-four note's diagnosis applies: a surface
  // out-values its own albedo and the clipped pixels carry the offending fixture's hue. So the
  // clipped FRACTION and the clipped pixels' mean colour are reported, not just the peak — one
  // blown pixel on a specular is a highlight, a blown tenth of the gun is a lighting fault.
  let clipped = 0
  const clipSum = [0, 0, 0]
  for (let k = 0; k < px.length; k++) {
    const [x, y] = px[k]
    const p = x + y * width
    inMask[p] = 1
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
    const i = p * channels
    const L = luminance(data[i], data[i + 1], data[i + 2])
    lums[k] = L
    if (L < 20) under++
    if (L > 250) {
      clipped++
      clipSum[0] += data[i]; clipSum[1] += data[i + 1]; clipSum[2] += data[i + 2]
    }
  }

  // Local detail. Only patches ENTIRELY inside the mask count: a patch straddling the rim
  // measures the edge against the background, which is the largest contrast in the frame and
  // has nothing to do with whether the gun has surface.
  const sds = []
  for (let y = y0; y + PATCH <= y1 + 1; y += PATCH_STRIDE) {
    for (let x = x0; x + PATCH <= x1 + 1; x += PATCH_STRIDE) {
      let sum = 0, sumSq = 0, full = true
      for (let dy = 0; dy < PATCH && full; dy++) {
        for (let dx = 0; dx < PATCH; dx++) {
          const p = (x + dx) + (y + dy) * width
          if (!inMask[p]) { full = false; break }
          const i = p * channels
          const L = luminance(data[i], data[i + 1], data[i + 2])
          sum += L
          sumSq += L * L
        }
      }
      if (!full) continue
      const n = PATCH * PATCH
      sds.push(Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)))
    }
  }

  const m = {
    label,
    area: px.length,
    bbox: [x0, y0, x1, y1],
    patches: sds.length,
    medianL: +median(lums).toFixed(2),
    pctUnder20: +(100 * under / px.length).toFixed(2),
    patchLsd_p50: +median(sds).toFixed(2),
    peakL: +Math.max(...lums).toFixed(2),
    clipPct: +(100 * clipped / px.length).toFixed(3),
    clipRgb: clipped ? clipSum.map(v => Math.round(v / clipped)) : null,
  }

  const fails = []
  if (!sds.length) fails.push('no 8x8 patch fits inside the mask — nothing to measure detail on')
  if (m.medianL < VIEWMODEL_GATE.medianL) fails.push(`medianL ${m.medianL} < ${VIEWMODEL_GATE.medianL}`)
  if (m.pctUnder20 > VIEWMODEL_GATE.pctUnder20) fails.push(`pctUnder20 ${m.pctUnder20} > ${VIEWMODEL_GATE.pctUnder20}`)
  if (m.patchLsd_p50 < VIEWMODEL_GATE.patchLsd_p50) fails.push(`patchLsd_p50 ${m.patchLsd_p50} < ${VIEWMODEL_GATE.patchLsd_p50}`)
  return { ...m, fails }
}
