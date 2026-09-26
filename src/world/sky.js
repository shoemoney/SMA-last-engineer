/**
 * sky.js — the night this station is buried under.
 *
 * Until now the level was a sealed tunnel: `scene.background` was one flat near-black
 * colour, every opening was capped, and the only thing in the build that claimed there was
 * a world above ground was a bright quad over the light well. A player could climb the
 * stair, stand on the mezzanine, look up — and find that the game had no outside.
 *
 * This module is the outside. Four things, in the order they matter:
 *
 * 1. **A sky.** A baked equirectangular night — zenith to horizon gradient, about a
 *    thousand stars thinning into the haze, a moon with a real halo, low cloud lit from
 *    underneath by the orange sodium a city throws up at it, and a skyline silhouette with
 *    lit windows in it. It is set BOTH as `scene.background` and as a dome mesh, because
 *    those two paths fail differently and the sky is the one thing that must not vanish.
 *
 * 2. **Rain, in two fields.** Outside, falling onto the street — and that field rides the
 *    eye in a 30 m box, floored at the pavement, so it is there wherever anybody ends up
 *    standing and is correctly absent underground. And inside the light well — through the
 *    pavement grating, down the shaft, past the summit gantry at Z 690, onto the stair
 *    treads, and through the balcony's void all the way to the platform slab. That second
 *    field is the one a player actually sees from the hall AND the one falling past them
 *    on the gantry, and it is the reason this module exists rather than being a postcard
 *    nobody can reach.
 *
 * 3. **Splash rings**, wherever a drop lands: on the wet asphalt above, on the treads, and
 *    on the slab under the void where the cold beam already falls.
 *
 * 4. **A patch of wet street** at the top of the well, so the exterior rain has something
 *    to break on and whoever builds the roof has a datum to build against.
 *
 * ## Why nothing here is per-drop
 *
 * Two rain fields and two splash pools: four instanced draws for the whole weather system.
 * Each drop's slant is baked into the GEOMETRY rather than into its matrix, so a frame's
 * work per drop is three float writes into the instance matrix buffer — no Matrix4, no
 * quaternion, no allocation.
 *
 * ## Why the station geometry is restated here
 *
 * station.js belongs to another agent this round and its `STAIRS` block is module-private.
 * The dozen numbers below are re-derived from the same `rules.js` fields station.js derives
 * them from, and labelled with what they mirror. Nothing here is invented beside it; if
 * that block moves, `EXIT` has to move with it, and the console check in `initSky` shouts
 * when the two have drifted apart.
 *
 * ## Contract
 *
 * `initSky(scene, renderer)` -> `{ update(dt), setIntensity(n), dispose() }`. Every pass is
 * built inside its own try/catch and logs exactly once on failure: a sky that cannot build
 * must leave a playable, lit station behind it, never a black screen.
 */

import * as THREE from 'three/webgpu'
import { attribute, positionView, smoothstep } from 'three/tsl'
import { STATION } from '../game/rules.js'
import { Rng } from '../core/rng.js'

const DIM = STATION.DIMENSIONS
const LEVELS = STATION.LEVELS
const PROPS = STATION.PROPS

/** Spec frame (Z-up) to three frame (Y-up): (x, y, z) -> (x, z, -y). Same bridge station.js uses. */
const v3 = (x, y, z) => new THREE.Vector3(x, z, -y)

const deg = Math.PI / 180
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)

/**
 * The stairwell's own geometry, mirrored out of station.js's private `STAIRS` block.
 *
 * Every line derives from the same rules.js field station.js derives it from, so these are
 * the spec's numbers taking a second route to the same place rather than a set of guesses
 * standing next to them. The three that station.js chose rather than derived — the stair
 * threshold, the well's eastward reach and the grating height — are marked.
 */
const EXIT = Object.freeze({
  shaftMinX: PROPS.stairwell.centre[0] - PROPS.stairwell.halfExtent[0], // 80
  shaftMaxX: PROPS.stairwell.centre[0] + PROPS.stairwell.halfExtent[0], // 520 — the stair mouth
  shaftHalfY: PROPS.stairwell.halfExtent[1], // 260 — and the ceiling hole's half-width

  wellMinX: PROPS.mezzanine.centre[0] - PROPS.mezzanine.halfExtent[0], // 40
  wellHalfY: PROPS.mezzanine.halfExtent[1], // 300
  deckTopZ: PROPS.mezzanine.centre[2] + PROPS.mezzanine.halfExtent[2], // 250

  deckThreshold: 140.0, // station.js STAIRS.deckThreshold — solid deck before the void opens
  wellReachEast: 120.0, // station.js STAIRS.wellReachEast — how far east the ceiling stays open
  voidHalfY: PROPS.hangingSign.halfExtent[1] + 30.0, // 110 — station.js STAIRS.voidHalfY
  newelHalfY: DIM.columnRadius + 10.0, // 55 — the spine between the two flights

  landingDepth: 120.0, // station.js STAIRS.landingDepth
  wellTopZ: 940.0, // station.js STAIRS.wellTopZ — the pavement grating
  wellCapThickness: 40.0, // station.js STAIRS.wellCapThickness
})

const VOID_MIN_X = EXIT.shaftMaxX + EXIT.deckThreshold // 660
const VOID_MAX_X = VOID_MIN_X + EXIT.wellReachEast // 780 — and the inner face of the well's east wall
const WELL_MAX_X = VOID_MAX_X + DIM.wallThickness // 820
const LANDING_MAX_X = EXIT.shaftMinX + EXIT.landingDepth // 200
const LANDING_Z = EXIT.deckTopZ * 0.5 // 125 — the half-landing, by construction
const STREET_Z = EXIT.wellTopZ + EXIT.wellCapThickness // 980 — pavement level

/**
 * Presentation-only. None of this has a home in rules.js: the original level had no sky,
 * no weather and nothing above the ceiling slab at all, so there is no spec line to diff
 * against. One frozen block so it stays findable, the way lighting.js keeps its `RIG`.
 */
const NIGHT = Object.freeze({
  /**
   * The hour, stated once so every number below can be checked against one intent:
   * a little after midnight, overcast breaking up, a gibbous moon low in the south-west,
   * and enough sodium in the cloud base that the sky never reaches black.
   */
  sky: Object.freeze({
    /**
     * 4096x2048, and the doubling buys STARS and kills a lattice — it is not about detail.
     *
     * At 2048 wide this texture MAGNIFIES on screen: 360 degrees of sky across a 90 degree
     * 1280 px frame is 5120 px, so one texel covered two and a half of them. Every star was
     * therefore a soft blob three pixels wide before it ever reached a bloom pass, and every
     * one-bit artefact in the canvas was blown up to two and a half pixels and became
     * visible structure. At 4096x2048 a texel lands on 1.25 px horizontally and 1.08 px
     * vertically — near enough 1:1 that a one-texel star stays a point.
     */
    width: 4096,
    height: 2048, // equirect: v=0 is the zenith, v=0.5 the horizon, v=1 straight down
    seed: 0x4e19d7,

    /** The dome is drawn AFTER the opaque station and writes no depth, so it costs only the pixels nothing else covered. */
    domeRadius: 14000.0, // cm; camera far is 20000 and the furthest eye sits 3000 off centre
    domeSegments: Object.freeze([64, 40]),
    renderOrder: 1000,

    /**
     * Zenith to nadir, as sRGB hex the air pass interpolates through.
     *
     * Lifted off the old ramp, which ran #0b1a2e through the band a standing player spends
     * the whole shot looking at and measured 22 mean luminance in the frame. That is a
     * COUNTRY sky. This city has eight million street lights under a broken overcast, and
     * the thing that makes a real one read is that it never gets anywhere near black — the
     * silhouette is legible BECAUSE the sky behind it is not.
     */
    ramp: Object.freeze([
      Object.freeze([0.0, '#060c1a']), // zenith
      Object.freeze([0.16, '#0b1628']),
      Object.freeze([0.3, '#14243e']),
      Object.freeze([0.4, '#213350']),
      Object.freeze([0.46, '#39353f']),
      Object.freeze([0.5, '#46332d']), // the horizon, already warm
      Object.freeze([0.54, '#1e1618']),
      Object.freeze([0.66, '#09090c']),
      Object.freeze([1.0, '#040406']),
    ]),

    /**
     * Light pollution: the continuous sodium wash a city throws up into its own sky.
     *
     * The seven domes below were the only glow there was, and seven blobs on a horizon are
     * seven blobs — between them the sky fell straight back to the ramp, so the skyline was
     * a black cut-out standing against nothing. This is the BAND they stand on. It peaks on
     * the horizon line itself and is gone by `topAltitudeDeg`, which is deliberately a long
     * way up: what sells a city at night is that its glow reaches further than you expect.
     */
    lightPollution: Object.freeze({
      rgb: Object.freeze([255, 152, 74]),
      peak: 0.26, // fraction of `rgb` added on the horizon line
      /**
       * Deliberately most of the way to the zenith. A glow that stops at 20 degrees is a
       * strip light behind the skyline; one that keeps going is a city. The measurement
       * that set it: the band a standing player looks at on the summit is 17 to 29 degrees
       * up, and it has to still be carrying warmth up there or the skyline has nothing to
       * read against. The zenith stays dark regardless — that is what `falloff` is for.
       */
      topAltitudeDeg: 40.0,
      falloff: 1.9, // over 1 keeps it tight to the horizon instead of tinting the zenith
      /** It carries a little way under the horizon too, or the skyline stands on a hard edge. */
      belowAltitudeDeg: 5.0,
    }),

    /** Light domes standing on the horizon. This is the city, seen as its own glow. */
    sodiumDomes: 7,
    sodiumRgb: '255,146,58',
    sodiumPeakAlpha: 0.5,

    /**
     * The dome's own gain, over 1 on purpose. The night is authored dark so it reads as
     * night in the canvas, and then the post chain's tone mapping takes another bite out of
     * it; without this the moon stops being the brightest thing in the frame and the whole
     * sky sits under the station's own black.
     *
     * Raised from 1.2 once the bloom came down. Measured on the summit frame, the baked sky
     * reads about 51 luminance at 20 degrees altitude and arrives on screen at 27 — the
     * chain is costing it a little over half, and the dome's own gain is the only place in
     * this file that can pay it back without touching a single light in the station.
     */
    exposure: 1.4,

    /**
     * The dome draws only when the eye is above the station's ceiling line, and that is a
     * BUG FIX, not a saving.
     *
     * The hall is not as sealed as it looks: the platform shot has a gap somewhere in the
     * west enclosure, and with a sky behind it that gap stopped being invisible. It used to
     * read as the flat near-black background and now it read as an L-shaped panel of cloud
     * hanging over the track pit — measured at RGB (40, 51, 67) against a (1, 7, 7) void,
     * which is this texture's own cloud band and nothing else in the game. Hiding the dome
     * underground puts the background back behind that hole exactly as it was, and costs
     * nothing, because from inside a buried station there is no sky to see anyway.
     *
     * The threshold is the ceiling slab's top rather than the pavement, so the summit
     * gantry inside the light well still gets a sky the moment anyone opens the grating
     * over it.
     */
    showAboveZ: LEVELS.ceilingTopZ,
  }),

  stars: Object.freeze({
    count: 1500,
    /** Stars below this altitude are eaten by haze; the fade runs from here to the horizon. */
    hazeAltitudeDeg: 26.0,
    /**
     * A star is a POINT, and this one had no point in it.
     *
     * It was a radial gradient out to 2.6x its radius and nothing else — no core at all —
     * so the brightest pixel in a star was whatever the gradient happened to reach at the
     * centre, and the shape was a smudge three pixels across before magnification doubled
     * it. A critic counting the stars in a whole frame found four. A real one is one hard
     * pixel with a breath of halo around it, so the halo is now worth a third of what it
     * was and the core is drawn explicitly, snapped to the texel grid.
     */
    glowFactor: 1.5,
    glowAlpha: 0.34,
    coreAlpha: 0.95,
    minRadius: 0.5,
    maxRadius: 2.1,
    /** How hard the population skews dim. The old 2.1 left almost everything a whisper. */
    brightnessGamma: 1.45,
    flareChance: 0.04,
    tints: Object.freeze(['255,255,255', '206,222,255', '255,236,208', '185,205,255']),
  }),

  moon: Object.freeze({
    azimuthDeg: 208.0, // south-south-west
    altitudeDeg: 33.0,
    radiusDeg: 2.3, // well over life size — a life-size moon is four pixels and reads as a star
    craters: 9,
    /** Deliberately past 1 in linear space so the postfx bloom finds it. */
    coreRgb: '255,252,240',
    haloRadiusFactor: 11.0,
    haloAlpha: 0.44,
  }),

  clouds: Object.freeze({
    banks: 26,
    puffsPerBank: 14,
    /** Cloud lives between these two altitudes; the base is lit sodium, the top is cold. */
    baseAltitudeDeg: 4.0,
    topAltitudeDeg: 42.0,
    darkRgb: '20,26,40',
    litRgb: '255,150,66',
    coolRgb: '124,146,190',
  }),

  skyline: Object.freeze({
    blocks: 64,
    maxAltitudeDeg: 4.6,
    /** One block in nine is a tower. A skyline of one height is a wall, not a city. */
    towerChance: 0.11,
    towerFactor: 2.6,
    windowChance: 0.16,
    windowRgb: '255,198,120',
    silhouette: '#05070c',
  }),

  /**
   * The street. A patch, not a city — it exists so the exterior rain lands on something and
   * so whoever builds the roof has a surface to build against. It rings the light well's cap
   * rather than covering it, because that cap IS the pavement grating.
   */
  street: Object.freeze({
    /**
     * Two centimetres UNDER the pavement datum, which is deference rather than geometry.
     *
     * This patch exists so the exterior rain has something to break on. Somebody else has
     * since built a real street up here — towers, lamp standards, kerbs — and if theirs is
     * laid on the datum at STREET_Z then a rain-catcher half a centimetre above it would
     * quietly replace their road surface with a flat dark plane. Below the datum, any real
     * street wins, this one is never seen, and it still catches every drop; with no real
     * street it shows two centimetres low, which at this scale is nothing. Delete this
     * group outright once the exterior has a floor of its own — it is one named node,
     * `night-street`, for exactly that reason.
     */
    z: STREET_Z - 2.0,
    apron: 900.0, // cm of pavement out past the well on every side
    colorHex: 0x0a0c11,
    roughness: 0.38, // wet asphalt; the sodium lamps have to streak across it
    metalness: 0.05,
  }),

  /**
   * Rain. Two fields with the same geometry and the same material family, differing only in
   * where they live and how hard they are driven.
   *
   * `slantDeg` is baked into the streak geometry, and the drift that carries a drop sideways
   * is derived from it — so a streak always travels along its own length instead of
   * skating. Wind blows east, down the platform's own axis, which is the axis every
   * composed shot in this game looks along.
   */
  rain: Object.freeze({
    slantDeg: 17.0, // enough lean to read as weather; 13 came back as vertical scratches
    colorHex: 0xbcd4ff,

    /**
     * How close a drop may come to the lens before it stops being drawn, in centimetres of
     * view-space depth.
     *
     * A drop against the glass is not a drop, it is a BAR ACROSS THE FRAME, and that is the
     * single thing a critic zooming these frames kept finding: "a solid slab, uniform edge
     * to edge, ending in a hard square flat-cut bottom at full brightness — it reads as a
     * fluorescent tube fragment or a scratch on the lens, not as a drop." The station's haze
     * cones have solved this since they were built (materials.js, HAZE_NEAR_FADE_START /
     * _END, the same smoothstep on the same term); rain was the one additive thing in the
     * game still painting at full strength one metre from the eye.
     */
    nearFadeStart: 140.0,
    nearFadeEnd: 700.0,

    /**
     * `width` is in centimetres and is set per field because a streak is only rain while it
     * is at least a pixel across. At this game's 90 degree horizontal FOV over 1280 px, one
     * centimetre subtends 1.28 px at 5 m and 0.32 px at 20 m — so the street field, which is
     * never seen closer than about fifteen metres, has to be well over twice the section of
     * the shaft field to survive rasterisation at all.
     *
     * Both went up by about 1.7x when the streak stopped being a flat ribbon and became a
     * triangular section that peaks on its own centreline (see `buildStreakGeometry`). That
     * profile is what makes a two-pixel streak read as a drop rather than a scratch, and it
     * costs half the ribbon's width at half-maximum — so the number has to buy it back or
     * the rain quietly disappears.
     */
    outside: Object.freeze({
      count: 1100,
      minSpeed: 1500.0, // cm/s — a real drop terminal-velocities near 900, this reads better
      maxSpeed: 2100.0,
      length: 95.0,
      width: 7.0,
      opacity: 0.5,
      seed: 0x7a1155,
      /**
       * The box this field carries around the eye, in centimetres.
       *
       * 30 m across and 20 m tall, so a drop is on screen for a little under a second at
       * these speeds and the field never has a visible edge in an 18 m view. `splashZ` is
       * filled in at build time with the pavement height: a drop rings when it crosses the
       * street, whether the eye is standing on it or forty metres above it.
       */
      follow: Object.freeze({ halfX: 1500.0, halfY: 1500.0, rise: 1100.0, drop: 900.0, splashZ: STREET_Z }),
    }),

    /**
     * The shaft field, and the only one a player on the platform can see.
     *
     * Slower and shorter than the outside field on purpose: these drops are between two
     * and nine metres from the eye rather than thirty, and rain reads by ANGULAR speed. At
     * the outside field's numbers the shaft turned into vertical scratches.
     */
    shaft: Object.freeze({
      count: 600,
      minSpeed: 620.0,
      maxSpeed: 1000.0,
      length: 44.0,
      width: 3.0,
      /**
       * Measured down from 0.42 on the summit frame. These streaks are additive and the
       * light well is the brightest volume in the game — station.js hangs three daylight
       * heads over it — so at 0.42 they stopped being rain and became white bars across a
       * white room. 0.30 keeps every streak legible and gives the shaft its exposure back.
       */
      opacity: 0.3,
      seed: 0x33cc91,
    }),
  }),

  splash: Object.freeze({
    /** Per field. A drop that lands with none free simply does not ring. */
    /**
     * Per field, and the stairwell's is the one that was measured: driven for a second and a
     * half the shaft field keeps 146 rings alive at once, so a 150-deep pool spends its life
     * full and starts refusing rings — and the ones it refuses are as likely to be the six
     * on the platform slab, which are the only rings in this game a player on the platform
     * can see, as the hundred and forty up on the treads.
     */
    count: Object.freeze({ outside: 200, shaft: 220 }),
    segments: 24,
    innerRadius: 0.58, // of the outer, so the ring has a thickness that thins as it grows
    minRadius: 3.0,
    maxRadius: Object.freeze({ outside: 26.0, shaft: 17.0 }),
    life: Object.freeze({ outside: 0.42, shaft: 0.34 }),
    colorOutsideHex: 0xa8c4ff, // moonlit
    colorShaftHex: 0xcfe2ff, // the daylight/moon heads over the well are colder still
    opacity: 0.7,
  }),
})

// ---------------------------------------------------------------------------
// baking the sky
// ---------------------------------------------------------------------------

const _warned = new Set()
function warnOnce(key, message, err) {
  if (_warned.has(key)) return
  _warned.add(key)
  if (err) console.warn(message, err)
  else console.warn(message)
}

/** Equirect pixel column for a compass azimuth, and pixel row for an altitude. */
const azimuthToX = (azDeg, width) => ((azDeg % 360) + 360) % 360 / 360 * width
const altitudeToY = (altDeg, height) => (0.5 - altDeg / 180) * height

/**
 * The whole night, painted once into a 2048x1024 equirectangular canvas.
 *
 * Order matters twice over. It is the order a real sky stacks — air, the city's glow
 * standing on the horizon, cloud, the moon's halo through it, stars, the moon itself, and
 * the skyline the whole lot sits behind — and it is also split, in the middle, by
 * `settleGradients`. Everything soft is painted first so it can be filtered together;
 * everything with an edge is painted after, so the filter never reaches it.
 *
 * Exported so the sky can be LOOKED AT without booting the game. It is a 2D canvas and
 * touches no GPU, so `bakeNightSky().image` can be dumped to a PNG in a headless page in
 * about a second — which is the only way to iterate on a night sky while six agents are
 * queued on one GPU for the frame gate.
 */
export function bakeNightSky() {
  if (typeof document === 'undefined') {
    warnOnce('no-document', '[sky] no DOM: the night sky cannot be baked, the scene keeps its flat background.')
    return null
  }

  const { width, height, seed, sodiumDomes, sodiumRgb, sodiumPeakAlpha } = NIGHT.sky
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    warnOnce('no-2d', '[sky] no 2D context: the night sky cannot be baked, the scene keeps its flat background.')
    return null
  }
  const rng = new Rng(seed)

  // --- air, and the city glow standing in it --------------------------------
  paintAir(ctx, width, height)

  // --- the city, as light standing on the horizon ---------------------------
  // Drawn twice where a dome would cross u=0, because an equirect seam that does not match
  // is a vertical scar running the full height of the sky.
  ctx.globalCompositeOperation = 'lighter'
  const horizonY = altitudeToY(0, height)
  for (let i = 0; i < sodiumDomes; i++) {
    const x = rng.range(0, width)
    const radius = rng.range(0.1, 0.26) * height
    const alpha = rng.range(0.16, sodiumPeakAlpha)
    for (const shift of [-width, 0, width]) {
      if (x + shift < -radius || x + shift > width + radius) continue
      const dome = ctx.createRadialGradient(x + shift, horizonY, 0, x + shift, horizonY, radius)
      dome.addColorStop(0, `rgba(${sodiumRgb},${alpha.toFixed(3)})`)
      dome.addColorStop(0.45, `rgba(${sodiumRgb},${(alpha * 0.32).toFixed(3)})`)
      dome.addColorStop(1, `rgba(${sodiumRgb},0)`)
      ctx.fillStyle = dome
      ctx.fillRect(x + shift - radius, horizonY - radius, radius * 2, radius * 2)
    }
  }
  ctx.globalCompositeOperation = 'source-over'

  // --- cloud, and the sodium it catches from below --------------------------
  drawClouds(ctx, width, height, rng)

  // --- the moon's halo, which is a soft field and belongs with the soft ones --
  drawMoonHalo(ctx, width, height)

  // --- settle everything soft, BEFORE anything sharp is drawn on top ---------
  // Order is the whole trick here: see `settleGradients`. Every pass above paints a
  // large smooth field through a Skia gradient and every pass below paints something
  // with an edge — a star, the moon's limb, a roof line, a lit window. Only the first
  // group can be filtered, and only the second group would be hurt by filtering it.
  settleGradients(ctx, width, height)

  // --- stars ----------------------------------------------------------------
  drawStars(ctx, width, height, rng)

  // --- the moon itself ------------------------------------------------------
  drawMoonDisc(ctx, width, height, rng)

  // --- the skyline everything sits behind -----------------------------------
  drawSkyline(ctx, width, height, rng)

  const texture = new THREE.CanvasTexture(canvas)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearFilter // no mips: a mipped equirect smears the moon into a smudge
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/** '#0b1a2e' -> [11, 26, 46]. */
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The air, and the city's glow standing in it, written pixel by pixel instead of filled
 * with a canvas gradient — which reads like a micro-optimisation and is in fact the fix for
 * the worst artefact in the build.
 *
 * `createLinearGradient` goes through Skia, and SKIA DITHERS GRADIENTS: it breaks every
 * 8-bit step with a fixed ordered pattern so a ramp does not band. Sampled 1:1 into a
 * framebuffer that is invisible and correct. Magnified onto a dome, where one texel covers
 * more than one screen pixel, the pattern stops being dither and becomes GEOMETRY — a
 * regular diagonal weave over the entire sky, which is exactly what a critic measured: "a
 * perfectly regular diagonal grid of alternating light/dark cells covering the whole dome,
 * already discernible at 260%". Read straight back out of a headless canvas, a row of this
 * ramp that should be flat reads 9,22,41 / 10,23,42 / 9,22,41 / 10,23,42, forever.
 *
 * So the ramp is evaluated in floating point per row, the light-pollution band is added on
 * top of it, and the result is quantised with RANDOM rounding rather than ordered. Same
 * average colour, same absence of banding, and nothing left with a period for magnification
 * to find. The noise comes off a fixed xorshift, so the frame gate still compares stable
 * pixels.
 */
function paintAir(ctx, width, height) {
  const { ramp, lightPollution: lp } = NIGHT.sky
  const stops = ramp.map(([at, hex]) => ({ at, rgb: hexRgb(hex) }))
  const image = ctx.createImageData(width, height)
  const data = image.data
  let noise = 0x9e3779b9 | 0

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    let hi = 1
    while (hi < stops.length - 1 && stops[hi].at < v) hi++
    const lo = stops[hi - 1]
    const up = stops[hi]
    const t = up.at === lo.at ? 0 : clamp01((v - lo.at) / (up.at - lo.at))

    // Full strength on the horizon line, out by `topAltitudeDeg`, and carried a few degrees
    // UNDER it so the skyline is not standing on a hard edge.
    const altitude = (0.5 - v) * 180
    const reach = altitude >= 0 ? lp.topAltitudeDeg : lp.belowAltitudeDeg
    const glow = lp.peak * (1 - clamp01(Math.abs(altitude) / reach)) ** lp.falloff

    const cr = lo.rgb[0] + (up.rgb[0] - lo.rgb[0]) * t + lp.rgb[0] * glow
    const cg = lo.rgb[1] + (up.rgb[1] - lo.rgb[1]) * t + lp.rgb[1] * glow
    const cb = lo.rgb[2] + (up.rgb[2] - lo.rgb[2]) * t + lp.rgb[2] * glow

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5
      data[i] = Math.floor(cr + ((noise >>> 8) & 255) / 256)
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5
      data[i + 1] = Math.floor(cg + ((noise >>> 8) & 255) / 256)
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5
      data[i + 2] = Math.floor(cb + ((noise >>> 8) & 255) / 256)
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

/**
 * Nulls the ordered dither Skia leaves in every gradient above, then re-quantises with
 * random rounding. This is the fix for the screen door over the sky, and it has to happen
 * HERE — after everything soft, before anything sharp.
 *
 * `paintAir` explains why Skia dithers at all and why magnification turns that dither into
 * visible geometry. What it could not fix is the rest of this file: seven sodium domes, a
 * thousand cloud puffs and the moon's halo are radial gradients, and they are composited
 * with `lighter`. Each one lays down the SAME device-space ordered matrix, in phase, so
 * where a dozen puffs overlap their dither ADDS. Measured in the finished bake, a patch of
 * cloud that should be flat ran 66 / 76 / 66 / 76 across a row — plus or minus five, not
 * the plus or minus a half a single gradient contributes. That is why masking it with
 * noise was never going to work: there was five times more pattern than there was dither.
 *
 * A box filter of width exactly four nulls every frequency at a quarter and a half of the
 * sample rate, which is precisely and completely the set of frequencies an ordered 4x4
 * dither matrix lives on. Four texels of softening is nothing to a cloud bank three hundred
 * texels across, and the passes that care about sharpness have not run yet.
 *
 * Separable, with a running sum, and both directions walked row-major — a column-major
 * vertical pass over a buffer this size is a cache miss per texel and takes seconds.
 */
function settleGradients(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  // Horizontal sums, UNDIVIDED, in 16 bits: four 8-bit samples cannot exceed 1020, and the
  // float buffer this replaced was 100 MB of transient allocation during boot for no extra
  // precision at all.
  const sums = new Uint16Array(width * height * 3)
  // WRAPPED across the seam, not clamped. This texture is an equirect with RepeatWrapping,
  // so u=0 and u=1 are the same meridian — clamping there would leave the two columns at
  // the seam unfiltered, which is a thin vertical scar of surviving dither running the full
  // height of the sky. Vertically it clamps, because a pole is genuinely an end.
  const wrapX = (x) => (x < 0 ? x + width : x >= width ? x - width : x)
  const clampY = (y) => (y < 0 ? 0 : y >= height ? height - 1 : y)

  // --- horizontal, window x-2 .. x+1 ---
  for (let y = 0; y < height; y++) {
    const row = y * width
    let s0 = 0, s1 = 0, s2 = 0
    for (let k = -2; k <= 1; k++) {
      const o = (row + wrapX(k)) * 4
      s0 += data[o]; s1 += data[o + 1]; s2 += data[o + 2]
    }
    for (let x = 0; x < width; x++) {
      const b = (row + x) * 3
      sums[b] = s0; sums[b + 1] = s1; sums[b + 2] = s2
      const oi = (row + wrapX(x + 2)) * 4
      const oo = (row + wrapX(x - 2)) * 4
      s0 += data[oi] - data[oo]
      s1 += data[oi + 1] - data[oo + 1]
      s2 += data[oi + 2] - data[oo + 2]
    }
  }

  // --- vertical, window y-2 .. y+1, carrying one running sum per column ---
  const acc = new Int32Array(width * 3)
  for (let k = -2; k <= 1; k++) {
    const r = clampY(k) * width
    for (let x = 0; x < width; x++) {
      const b = x * 3
      const sb = (r + x) * 3
      acc[b] += sums[sb]; acc[b + 1] += sums[sb + 1]; acc[b + 2] += sums[sb + 2]
    }
  }
  // Random rounding on the way out, for the same reason paintAir uses it: an 8-bit write of
  // a smooth field either bands or carries a pattern, and noise is the only third option.
  let noise = 0x2545f491 | 0
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const b = x * 3
      const o = (row + x) * 4
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5
      data[o] = Math.floor(acc[b] * 0.0625 + ((noise >>> 8) & 255) / 256)
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5
      data[o + 1] = Math.floor(acc[b + 1] * 0.0625 + ((noise >>> 8) & 255) / 256)
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5
      data[o + 2] = Math.floor(acc[b + 2] * 0.0625 + ((noise >>> 8) & 255) / 256)
    }
    const rIn = clampY(y + 2) * width
    const rOut = clampY(y - 2) * width
    for (let x = 0; x < width; x++) {
      const b = x * 3
      const bi = (rIn + x) * 3
      const bo = (rOut + x) * 3
      acc[b] += sums[bi] - sums[bo]
      acc[b + 1] += sums[bi + 1] - sums[bo + 1]
      acc[b + 2] += sums[bi + 2] - sums[bo + 2]
    }
  }
  ctx.putImageData(image, 0, 0)
}

function drawStars(ctx, width, height, rng) {
  const {
    count, hazeAltitudeDeg, minRadius, maxRadius,
    brightnessGamma, glowFactor, glowAlpha, coreAlpha, flareChance, tints,
  } = NIGHT.stars
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere rather than uniform in the image, or the pole grows a clot of stars.
    const altitude = Math.asin(rng.range(0.02, 1)) / deg
    const x = rng.range(0, width)
    const y = altitudeToY(altitude, height)

    const haze = clamp01(altitude / hazeAltitudeDeg)
    const brightness = rng.range(0.18, 1) ** brightnessGamma * (0.3 + 0.7 * haze)
    const radius = minRadius + (maxRadius - minRadius) * brightness
    const tint = rng.pick(tints)

    const halo = radius * glowFactor
    const glow = ctx.createRadialGradient(x, y, 0, x, y, halo)
    glow.addColorStop(0, `rgba(${tint},${(glowAlpha * brightness).toFixed(3)})`)
    glow.addColorStop(0.4, `rgba(${tint},${(glowAlpha * 0.4 * brightness).toFixed(3)})`)
    glow.addColorStop(1, `rgba(${tint},0)`)
    ctx.fillStyle = glow
    ctx.fillRect(x - halo, y - halo, halo * 2, halo * 2)

    // The core, which is the part that was missing: one hard texel, snapped to the grid so
    // it survives sampling instead of smearing itself across four of them. Two texels for
    // the bright ones, which is how a star gets a magnitude instead of a radius.
    const core = brightness > 0.62 ? 2 : 1
    ctx.fillStyle = `rgba(${tint},${(coreAlpha * (0.35 + 0.65 * brightness)).toFixed(3)})`
    ctx.fillRect(Math.floor(x), Math.floor(y), core, core)

    if (brightness > 0.62 && rng.chance(flareChance)) {
      // A four-point flare on the handful of bright ones. Without it every star is the same dot.
      ctx.strokeStyle = `rgba(${tint},${(0.5 * brightness).toFixed(3)})`
      ctx.lineWidth = 0.8
      const arm = radius * 4
      ctx.beginPath()
      ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y)
      ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm)
      ctx.stroke()
    }
  }
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * Low cloud, built out of overlapping soft puffs rather than noise, because a cloud needs a
 * SILHOUETTE and fbm gives you weather-map mush. Each bank is drawn three times: the dark
 * body that hides stars, the cold top where the moon side catches, and the sodium underside
 * — which is the whole reason a city sky is never black.
 */
function drawClouds(ctx, width, height, rng) {
  const { banks, puffsPerBank, baseAltitudeDeg, topAltitudeDeg, darkRgb, litRgb, coolRgb } = NIGHT.clouds

  for (let b = 0; b < banks; b++) {
    const altitude = rng.range(baseAltitudeDeg, topAltitudeDeg)
    // Low cloud stretches in the image the way an equirect stretches everything near the
    // horizon; the flattening keeps a bank looking like a bank rather than a ball.
    const cx = rng.range(0, width)
    const cy = altitudeToY(altitude, height)
    const spanX = rng.range(0.07, 0.2) * width
    const spanY = rng.range(0.018, 0.055) * height
    // Higher cloud is thinner and further off, so it hides less and catches less.
    const density = 1 - clamp01((altitude - baseAltitudeDeg) / (topAltitudeDeg - baseAltitudeDeg)) * 0.62
    const sodium = clamp01(1 - altitude / 24) ** 1.6

    for (const shift of [-width, 0, width]) {
      if (cx + shift < -spanX * 2 || cx + shift > width + spanX * 2) continue
      for (let p = 0; p < puffsPerBank; p++) {
        const px = cx + shift + rng.range(-spanX, spanX)
        const py = cy + rng.range(-spanY, spanY)
        const pr = rng.range(0.25, 1) * spanY * 2.6 + spanY * 0.5

        // body
        puff(ctx, px, py, pr, darkRgb, 0.3 * density, 'source-over')
        // cold crown, offset up
        puff(ctx, px, py - pr * 0.3, pr * 0.72, coolRgb, 0.07 * density, 'lighter')
        // sodium belly, offset down
        if (sodium > 0.01) puff(ctx, px, py + pr * 0.36, pr * 0.8, litRgb, 0.16 * density * sodium, 'lighter')
      }
    }
  }
}

function puff(ctx, x, y, r, rgb, alpha, mode) {
  if (!(r > 0) || alpha <= 0.002) return
  ctx.globalCompositeOperation = mode
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, `rgba(${rgb},${alpha.toFixed(3)})`)
  g.addColorStop(0.55, `rgba(${rgb},${(alpha * 0.45).toFixed(3)})`)
  g.addColorStop(1, `rgba(${rgb},0)`)
  ctx.fillStyle = g
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
  ctx.globalCompositeOperation = 'source-over'
}

/** Where the moon is and how big, in bake pixels. Both passes below need all three. */
function moonPlacement(width, height) {
  return {
    x: azimuthToX(NIGHT.moon.azimuthDeg, width),
    y: altitudeToY(NIGHT.moon.altitudeDeg, height),
    r: (NIGHT.moon.radiusDeg / 180) * height,
  }
}

/**
 * The halo, drawn with the clouds rather than with the moon — it is a soft field thirty
 * times the disc's area and it carries Skia's dither exactly like every other gradient
 * here, so it has to land on the near side of `settleGradients`. A moon behind thin cloud
 * is mostly halo, and the halo is what makes a small disc read as the brightest thing in
 * the sky.
 */
function drawMoonHalo(ctx, width, height) {
  const { coreRgb, haloRadiusFactor, haloAlpha } = NIGHT.moon
  const { x, y, r } = moonPlacement(width, height)
  ctx.globalCompositeOperation = 'lighter'
  const halo = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * haloRadiusFactor)
  halo.addColorStop(0, `rgba(${coreRgb},${haloAlpha})`)
  halo.addColorStop(0.22, `rgba(210,226,255,${(haloAlpha * 0.38).toFixed(3)})`)
  halo.addColorStop(1, 'rgba(190,210,255,0)')
  ctx.fillStyle = halo
  ctx.fillRect(x - r * haloRadiusFactor, y - r * haloRadiusFactor, r * haloRadiusFactor * 2, r * haloRadiusFactor * 2)
  ctx.globalCompositeOperation = 'source-over'
}

/** The disc, its craters and its terminator — all of it edged, all of it drawn after the box filter. */
function drawMoonDisc(ctx, width, height, rng) {
  const { craters, coreRgb } = NIGHT.moon
  const { x, y, r } = moonPlacement(width, height)

  ctx.globalCompositeOperation = 'lighter'

  // The disc, with the terminator of a gibbous moon taken out of the west limb.
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.clip()
  ctx.fillStyle = `rgba(${coreRgb},1)`
  ctx.fillRect(x - r, y - r, r * 2, r * 2)

  ctx.globalCompositeOperation = 'source-over'
  for (let i = 0; i < craters; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = Math.sqrt(rng.next()) * r * 0.82
    const cr = rng.range(0.07, 0.22) * r
    const shade = ctx.createRadialGradient(x + Math.cos(a) * d, y + Math.sin(a) * d, 0, x + Math.cos(a) * d, y + Math.sin(a) * d, cr)
    shade.addColorStop(0, 'rgba(150,158,178,0.5)')
    shade.addColorStop(1, 'rgba(150,158,178,0)')
    ctx.fillStyle = shade
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  // Gibbous, not full — a full moon is a sticker, a terminator is an object.
  const terminator = ctx.createLinearGradient(x - r, y, x + r * 0.1, y)
  terminator.addColorStop(0, 'rgba(6,8,16,0.92)')
  terminator.addColorStop(0.5, 'rgba(6,8,16,0.3)')
  terminator.addColorStop(1, 'rgba(6,8,16,0)')
  ctx.fillStyle = terminator
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
  ctx.restore()

  ctx.globalCompositeOperation = 'source-over'
}

/**
 * A skyline. This is the line that turns "a night sky" into "somewhere" — without it the
 * horizon is a gradient and the place could be a field.
 */
function drawSkyline(ctx, width, height, rng) {
  const { blocks, maxAltitudeDeg, towerChance, towerFactor, windowChance, windowRgb, silhouette } = NIGHT.skyline
  const baseY = altitudeToY(-0.6, height)
  // Every pixel literal below was authored against a 1024-tall bake. Scaling them keeps a
  // window the same size ON THE SKY when the bake resolution moves.
  const px = height / 1024

  // Below the horizon is not a black plate: it is ground, and ground under a sodium sky
  // still carries a little of it for the first few degrees before it goes out.
  const ground = ctx.createLinearGradient(0, baseY, 0, height)
  ground.addColorStop(0, '#120e0b')
  ground.addColorStop(0.1, '#0a0809')
  ground.addColorStop(1, '#020203')
  ctx.fillStyle = ground
  ctx.fillRect(0, baseY, width, height - baseY)

  let x = 0
  while (x < width) {
    const w = rng.range(width / (blocks * 2.2), width / (blocks * 0.7))
    const tower = rng.chance(towerChance)
    const h = rng.range(0.1, 1) ** 1.8 * (maxAltitudeDeg / 180) * height * (tower ? towerFactor : 1) + 2
    ctx.fillStyle = silhouette
    ctx.fillRect(x, baseY - h, w + px, h + 2 * px)

    // Lit windows. Sparse, because a city at this hour is mostly asleep and a fully lit
    // tower reads as a Christmas tree.
    const cols = Math.max(1, Math.floor(w / (7 * px)))
    const rows = Math.max(1, Math.floor(h / (6 * px)))
    ctx.globalCompositeOperation = 'lighter'
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (!rng.chance(windowChance)) continue
        ctx.fillStyle = `rgba(${windowRgb},${rng.range(0.25, 0.85).toFixed(3)})`
        ctx.fillRect(x + 2 * px + c * 7 * px, baseY - h + 3 * px + r * 6 * px, 2.6 * px, 2.6 * px)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
    x += w
  }
}

// ---------------------------------------------------------------------------
// rain
// ---------------------------------------------------------------------------

/**
 * The shape of a falling drop, as a 4x3 lattice: four rows along the fall, three columns
 * across it, crossed into two planes so it reads from any heading.
 *
 * Every number in both directions is about what a drop LOOKS like, and both were wrong.
 *
 * ROWS — the profile along the fall. It used to be three rows running 0.04 -> 0.55 -> 1.0
 * with the full-brightness row sitting on the very last vertex, so the streak terminated in
 * a hard square edge at peak brightness. A critic zoomed one and called it a fluorescent
 * tube fragment, which is precisely what it was: nothing in nature ends at maximum. A real
 * drop is brightest just BEHIND its head and falls away both ways, so the peak moved inboard
 * to t -0.28 and a fourth row was added at the tip, at zero, for the head to fade into.
 *
 * COLUMNS — the profile across the width, which did not exist at all. Two columns give a
 * quad with the same shade on both edges: a flat ribbon with hard vertical sides. Three
 * columns with a 0 / 1 / 0 multiplier make the section a TRIANGLE peaking on the centreline
 * and reaching zero at both edges, so the streak antialiases itself. That matters more here
 * than anywhere else in the game, because these are one to three pixels wide and no amount
 * of MSAA softens the interior of a primitive — only its silhouette.
 *
 * `w` tapers the width per row on top of that, so the drop is a spindle rather than a strip:
 * fine at the tail, widest at the shoulder, drawn back to a point at the head.
 *
 * The slant is rotated INTO the vertices. That is the whole performance argument for this
 * file: with the tilt baked, an instance's transform never needs anything but a translation,
 * so a frame costs three float writes per drop instead of a matrix compose. Twelve vertices
 * a plane instead of six changes nothing about that — this geometry is built once, shared by
 * every drop in the field, and never touched again.
 */
function buildStreakGeometry(width, length, slantRad, color) {
  const rows = [
    { t: 0.5, w: 0.3, shade: 0.02 }, // tail, up-wind, all but gone
    { t: 0.12, w: 0.75, shade: 0.3 },
    { t: -0.28, w: 1.0, shade: 1.0 }, // the shoulder: the brightest part of a drop
    { t: -0.5, w: 0.35, shade: 0.0 }, // the head, fading out instead of being cut off
  ]
  // Across the width: zero at both edges, full on the centreline.
  const columns = [
    { side: -1, gain: 0.0 },
    { side: 0, gain: 1.0 },
    { side: 1, gain: 0.0 },
  ]
  const cos = Math.cos(slantRad)
  const sin = Math.sin(slantRad)

  const positions = []
  const colors = []
  const indices = []

  // plane === 0 spreads the section across three.x, plane === 1 across three.z: a cross.
  for (let plane = 0; plane < 2; plane++) {
    const base = positions.length / 3
    for (const row of rows) {
      for (const column of columns) {
        const half = column.side * width * 0.5 * row.w
        const lx = plane === 0 ? half : 0
        const lz = plane === 0 ? 0 : half
        const ly = row.t * length
        // Lean the whole streak down-wind about three's Z axis.
        positions.push(lx * cos - ly * sin, lx * sin + ly * cos, lz)
        const shade = row.shade * column.gain
        colors.push(color.r * shade, color.g * shade, color.b * shade)
      }
    }
    // Two triangle pairs per row gap now, one for each half of the section.
    for (let r = 0; r < rows.length - 1; r++) {
      for (let c = 0; c < columns.length - 1; c++) {
        const a = base + r * columns.length + c
        indices.push(a, a + 1, a + columns.length + 1, a, a + columns.length + 1, a + columns.length)
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  return geometry
}

/**
 * A field of falling drops inside one axis-aligned spec-space box.
 *
 * `catchZ(x, y)` answers what a drop lands ON, which is what lets the shaft field break on
 * the stair treads, on the balcony deck and on the platform slab at three different heights
 * inside one box — and it is what makes the rain look like it is in the building rather
 * than drawn over it.
 */
function buildRainField(spec, bounds, catchZ, onSplash) {
  const slant = NIGHT.rain.slantDeg * deg
  const color = new THREE.Color(NIGHT.rain.colorHex)
  const geometry = buildStreakGeometry(spec.width, spec.length, slant, color)

  // A node material rather than a plain one, for exactly one term: the near fade. Nothing
  // else in this file needs TSL and nothing else here uses it — but a drop a metre from the
  // lens is a bar across the frame, and the only place that can be fixed is in the shader.
  // `colorNode` replaces the vertex-colour path outright, which is why `vertexColors` is
  // gone; `material.opacity` still applies on top, so `setOpacity` is unchanged.
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
    opacity: spec.opacity,
  })
  // positionView.z is negative in front of the camera, so negate it to get depth in cm. Same
  // term, same direction and the same pair of constants the station's haze cones use.
  material.colorNode = attribute('color', 'vec3')
    .mul(smoothstep(NIGHT.rain.nearFadeStart, NIGHT.rain.nearFadeEnd, positionView.z.negate()))

  const mesh = new THREE.InstancedMesh(geometry, material, spec.count)
  mesh.frustumCulled = false // the drops move every frame; a stale bounding sphere pops the field out
  mesh.castShadow = false
  mesh.receiveShadow = false
  // Every matrix changes every frame. Without this three re-uploads the whole buffer on each
  // version bump instead of taking the dynamic path.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const rng = new Rng(spec.seed)
  const n = spec.count
  const px = new Float32Array(n)
  const py = new Float32Array(n)
  const pz = new Float32Array(n)
  const speed = new Float32Array(n)
  const matrices = mesh.instanceMatrix.array

  /**
   * A field either sits still or rides the camera.
   *
   * The shaft field sits still, because the light well is a fixed hole in a fixed building
   * and 520 drops fill it. The exterior field cannot: "outside" is now everything above the
   * ceiling slab of a 60 m station, and eleven hundred drops spread over that is a drizzle
   * you would have to be told about. So it carries a 30 m box that wraps around the eye,
   * which is the standard trick and the only one that survives someone adding a summit
   * somewhere this module has never heard of.
   *
   * The camera comes from `onBeforeRender`, which three hands every object right before it
   * draws it. No signature changes, no reaching into the game for a camera this module has
   * no business holding.
   */
  const follow = bounds.follow ?? null
  let anchorX = follow ? (bounds.minX + bounds.maxX) * 0.5 : 0
  let anchorY = 0
  let anchorZ = follow ? bounds.maxZ - follow.rise : 0
  if (follow) {
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      anchorX = camera.position.x
      anchorY = -camera.position.z
      anchorZ = camera.position.y
    }
  }

  /**
   * The follow box rides the eye horizontally but is FLOORED at the pavement, and that
   * clamp is the whole difference between weather and a bug.
   *
   * Without it, an eye standing on the platform at Z 64 drags the box down to Z -836 and
   * eleven hundred drops rain through the inside of the station — down the hall, through
   * the slab, past the benches. Pinned to the street the same box sits entirely above the
   * ceiling slab and the well cap, so from underground it is correctly invisible, and it
   * lifts off the pavement only once the eye climbs past it.
   */
  const fieldBottom = () => (follow ? Math.max(follow.splashZ, anchorZ - follow.drop) : bounds.minZ)
  const fieldTop = () => (follow ? fieldBottom() + follow.rise + follow.drop : bounds.maxZ)

  const respawn = (i, initial) => {
    px[i] = follow ? anchorX + rng.range(-follow.halfX, follow.halfX) : rng.range(bounds.minX, bounds.maxX)
    py[i] = follow ? anchorY + rng.range(-follow.halfY, follow.halfY) : rng.range(-bounds.halfY, bounds.halfY)
    const top = fieldTop()
    // The opening fill seeds the whole column so the rain does not arrive as one front —
    // but never BELOW what that drop would land on, or the first frame is a hundred and
    // fifty simultaneous splashes and an empty sky.
    const floor = follow ? fieldBottom() : catchZ(px[i], py[i])
    pz[i] = initial ? rng.range(floor + 4, top) : top - rng.range(0, spec.length)
    speed[i] = rng.range(spec.minSpeed, spec.maxSpeed)
  }

  for (let i = 0; i < n; i++) {
    respawn(i, true)
    // Identity rotation, per-drop length jitter on the fall axis only. Written once.
    const o = i * 16
    const stretch = rng.range(0.7, 1.25)
    matrices[o] = 1; matrices[o + 5] = stretch; matrices[o + 10] = 1; matrices[o + 15] = 1
  }

  const driftPerCm = Math.tan(slant) // the streak leans this far east per cm it falls

  function update(dt) {
    for (let i = 0; i < n; i++) {
      const fall = speed[i] * dt
      const wasZ = pz[i]
      pz[i] -= fall
      px[i] += fall * driftPerCm

      if (follow) {
        // Break on the pavement wherever the eye happens to be, then keep falling: a drop
        // seen from a rooftop passes street level a long way below the camera, and the ring
        // it leaves down there is what tells you how high up you are standing.
        if (wasZ > follow.splashZ && pz[i] <= follow.splashZ) onSplash(px[i], py[i], follow.splashZ)
        if (pz[i] < fieldBottom()) respawn(i, false) // respawn already lands it on the anchor
        else wrapAround(i)
      } else {
        const floor = catchZ(px[i], py[i])
        if (pz[i] <= floor || px[i] > bounds.maxX) {
          if (pz[i] <= floor) onSplash(px[i], py[i], floor)
          respawn(i, false)
        }
      }

      const o = i * 16
      matrices[o + 12] = px[i]
      matrices[o + 13] = pz[i] // spec Z is three Y
      matrices[o + 14] = -py[i] // spec Y is three -Z
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  /** Slide a drop the width of the box when the eye has walked out from under it. */
  function wrapAround(i) {
    const dx = px[i] - anchorX
    if (dx > follow.halfX) px[i] -= follow.halfX * 2
    else if (dx < -follow.halfX) px[i] += follow.halfX * 2
    const dy = py[i] - anchorY
    if (dy > follow.halfY) py[i] -= follow.halfY * 2
    else if (dy < -follow.halfY) py[i] += follow.halfY * 2
  }

  return {
    mesh,
    material,
    update,
    /** Spec Z of the eye, as of the last frame this field was drawn. Null for a fixed field. */
    eyeZ: () => (follow ? anchorZ : null),
    setOpacity(n2) { material.opacity = spec.opacity * n2 },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

// ---------------------------------------------------------------------------
// splashes
// ---------------------------------------------------------------------------

/**
 * Expanding rings where drops land. One pool, shared by both fields, coloured per instance —
 * so a splash on the moonlit street and one on the cold slab under the void can be the same
 * draw call and still be different lights.
 *
 * Fading is per-instance colour rather than per-instance opacity because a material has one
 * opacity and three hundred rings do not. Additive blending makes that identical: a ring
 * whose colour has fallen to black has gone out.
 */
function buildSplashPool(count) {
  const spec = { ...NIGHT.splash, count }
  const geometry = new THREE.RingGeometry(spec.innerRadius, 1.0, spec.segments, 1)
  geometry.rotateX(-Math.PI / 2) // an unrotated ring stands up in three's XY plane; rain lands flat

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
    opacity: spec.opacity,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, spec.count)
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const n = spec.count
  const age = new Float32Array(n)
  const life = new Float32Array(n)
  const grow = new Float32Array(n)
  const tint = new Float32Array(n * 3)
  const matrices = mesh.instanceMatrix.array

  for (let i = 0; i < n; i++) {
    const o = i * 16
    matrices[o + 15] = 1 // everything else stays zero: a dead ring has zero scale and draws nothing
    life[i] = 0
  }
  // setColorAt allocates instanceColor; doing it once up front keeps the first frame off the
  // slow path and makes a backend that cannot do instance colour fail here, loudly, not later.
  mesh.setColorAt(0, new THREE.Color(0, 0, 0))
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  const colors = mesh.instanceColor.array
  colors.fill(0)

  let cursor = 0
  function spawn(x, y, z, color, maxRadius, seconds) {
    // Linear scan from a rolling cursor: a pool almost always has a free slot two or three
    // steps away, so this is cheaper than maintaining a free list.
    for (let step = 0; step < n; step++) {
      const i = (cursor + step) % n
      if (life[i] > 0) continue
      cursor = (i + 1) % n
      age[i] = 0
      life[i] = seconds
      grow[i] = maxRadius
      tint[i * 3] = color.r
      tint[i * 3 + 1] = color.g
      tint[i * 3 + 2] = color.b
      const o = i * 16
      matrices[o + 12] = x
      matrices[o + 13] = z + 0.8 // off the surface, or the ring z-fights the slab it broke on
      matrices[o + 14] = -y
      return
    }
  }

  function update(dt) {
    let live = 0
    for (let i = 0; i < n; i++) {
      if (life[i] <= 0) continue
      age[i] += dt
      const t = age[i] / life[i]
      const o = i * 16
      if (t >= 1) {
        life[i] = 0
        matrices[o] = 0; matrices[o + 5] = 0; matrices[o + 10] = 0
        colors[i * 3] = 0; colors[i * 3 + 1] = 0; colors[i * 3 + 2] = 0
        continue
      }
      live++
      // Fast out, slow to a stop — a splash ring decelerates, it does not travel.
      const radius = NIGHT.splash.minRadius + (grow[i] - NIGHT.splash.minRadius) * (1 - (1 - t) ** 2)
      const fade = (1 - t) ** 2
      matrices[o] = radius; matrices[o + 5] = 1; matrices[o + 10] = radius
      colors[i * 3] = tint[i * 3] * fade
      colors[i * 3 + 1] = tint[i * 3 + 1] * fade
      colors[i * 3 + 2] = tint[i * 3 + 2] * fade
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
    return live
  }

  return {
    mesh,
    material,
    spawn,
    update,
    setOpacity(n2) { material.opacity = NIGHT.splash.opacity * n2 },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

// ---------------------------------------------------------------------------
// where rain lands
// ---------------------------------------------------------------------------

/**
 * The surface a drop inside the light well breaks on, in spec centimetres.
 *
 * This is the shape of the building, restated as a falling body sees it: the balcony deck
 * at 250, the void punched through it that goes all the way to the slab at 0, the
 * half-landing at 125, and the two flights of the switchback either side of the spine. The
 * flights are read as ramps rather than as twenty discrete treads because a splash 6 cm off
 * the nosing it should have landed on is invisible, and a per-tread lookup is not.
 */
function wellCatchZ(x, y) {
  if (x >= VOID_MIN_X && x <= VOID_MAX_X && Math.abs(y) <= EXIT.voidHalfY) return LEVELS.platformTopZ
  if (x > EXIT.shaftMaxX) return EXIT.deckTopZ
  if (x <= LANDING_MAX_X) return LANDING_Z

  const run = EXIT.shaftMaxX - LANDING_MAX_X
  if (y <= EXIT.newelHalfY) return LANDING_Z * ((EXIT.shaftMaxX - x) / run) // the lower flight, climbing west
  return LANDING_Z + LANDING_Z * ((x - LANDING_MAX_X) / run) // the upper flight, climbing back east
}

// ---------------------------------------------------------------------------
// the street
// ---------------------------------------------------------------------------

/**
 * A patch of wet pavement ringing the light well's cap, in four pieces so the cap itself —
 * which IS the grating — stays uncovered. It is a rain-catcher and a datum, not a city:
 * whoever builds the roof should extend or replace it, and it is one named group so that
 * costs them one line.
 */
function buildStreet() {
  const group = new THREE.Group()
  group.name = 'night-street'
  const s = NIGHT.street
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(s.colorHex),
    roughness: s.roughness,
    metalness: s.metalness,
  })

  const minX = EXIT.wellMinX - s.apron
  const maxX = WELL_MAX_X + s.apron
  const halfY = EXIT.wellHalfY + s.apron
  const slabs = [
    ['night-street-n', [minX, maxX], [EXIT.wellHalfY, halfY]],
    ['night-street-s', [minX, maxX], [-halfY, -EXIT.wellHalfY]],
    ['night-street-w', [minX, EXIT.wellMinX], [-EXIT.wellHalfY, EXIT.wellHalfY]],
    ['night-street-e', [WELL_MAX_X, maxX], [-EXIT.wellHalfY, EXIT.wellHalfY]],
  ]

  const geometries = []
  for (const [name, xs, ys] of slabs) {
    const geometry = new THREE.PlaneGeometry(xs[1] - xs[0], ys[1] - ys[0])
    geometry.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    mesh.position.copy(v3((xs[0] + xs[1]) * 0.5, (ys[0] + ys[1]) * 0.5, s.z))
    // Nothing up here casts, and every shadow receiver spends from the same 16-sampled-texture
    // WebGPU budget lighting.js already caps its caster count against.
    mesh.receiveShadow = false
    group.add(mesh)
    geometries.push(geometry)
  }

  return {
    group,
    dispose() {
      for (const g of geometries) g.dispose()
      material.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------

/**
 * Build the night into `scene`.
 *
 * @param {THREE.Scene} scene
 * @param {object} [renderer] the WebGPU renderer, when the caller has one. Nothing here
 *   needs it — the sky is a baked canvas and two instanced meshes — but the contract names
 *   it, and anisotropy is read off it when it is present.
 * @returns {{ update(dt: number): void, setIntensity(n: number): void, dispose(): void }}
 */
export function initSky(scene, renderer = null) {
  const group = new THREE.Group()
  group.name = 'night-sky'
  scene.add(group)

  const built = []
  const disposers = []
  let intensity = NIGHT.sky.exposure

  // --- the sky itself -------------------------------------------------------
  let skyTexture = null
  let dome = null
  const previousBackground = scene.background
  try {
    skyTexture = bakeNightSky()
    if (skyTexture) {
      if (renderer?.capabilities?.getMaxAnisotropy) {
        skyTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
      }
      /**
       * A dome, and NOT `scene.background`, which was the first thing tried.
       *
       * Assigning an equirect texture to `scene.background` works on this renderer, but the
       * WebGPU path routes it through `CubeMapNode`, which allocates a `CubeRenderTarget` at
       * the texture's own height and re-renders the sky into six mipped faces before it can
       * sample it. For a 2048x1024 night that is a 25 MB cube plus a render pass per texture
       * change — to produce a BLURRIER sky than the source, because every star in here is
       * about one pixel and a cube conversion is where one-pixel things go to die.
       *
       * The dome samples the canvas directly, costs one draw, and keeps the stars.
       * `scene.background` stays the flat fog colour lighting.js set, which is exactly the
       * right thing to find behind a dome that is a sphere and therefore always covers.
       */
      const geometry = new THREE.SphereGeometry(NIGHT.sky.domeRadius, NIGHT.sky.domeSegments[0], NIGHT.sky.domeSegments[1])
      const material = new THREE.MeshBasicMaterial({
        map: skyTexture,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: true,
      })
      dome = new THREE.Mesh(geometry, material)
      dome.name = 'night-dome'
      // Drawn after the opaque station with no depth write, so it only ever costs the pixels
      // nothing else covered — and underground, that is none of them.
      dome.renderOrder = NIGHT.sky.renderOrder
      dome.frustumCulled = false
      dome.position.copy(v3(DIM.length * 0.5, 0, STREET_Z)) // horizon at pavement height
      dome.material.color.setScalar(NIGHT.sky.exposure)
      dome.visible = false // until the eye is out of the hall; see NIGHT.sky.showAboveZ
      group.add(dome)
      disposers.push(() => { geometry.dispose(); material.dispose() })
      built.push('dome')
    }
  } catch (err) {
    warnOnce('sky-dome', '[sky] the night sky could not be built; the scene keeps its flat background.', err)
    dome = null
  }

  // --- the street -----------------------------------------------------------
  let street = null
  try {
    street = buildStreet()
    group.add(street.group)
    disposers.push(() => street.dispose())
    built.push('street')
  } catch (err) {
    warnOnce('sky-street', '[sky] the pavement could not be built; rain outside will fall through it.', err)
    street = null
  }

  // --- splashes, before rain, because rain spawns them ----------------------
  // Two pools, not one. Eleven hundred drops crossing the pavement every second would empty
  // a shared pool inside a frame and starve the stairwell of the only rings a player on the
  // platform can actually see — the street would be drowning the one shot that matters.
  let splashes = null
  let shaftSplashes = null
  try {
    splashes = buildSplashPool(NIGHT.splash.count.outside)
    splashes.mesh.name = 'splash-street'
    group.add(splashes.mesh)
    disposers.push(() => splashes.dispose())
    shaftSplashes = buildSplashPool(NIGHT.splash.count.shaft)
    shaftSplashes.mesh.name = 'splash-stairwell'
    group.add(shaftSplashes.mesh)
    disposers.push(() => shaftSplashes.dispose())
    built.push('splashes')
  } catch (err) {
    warnOnce('sky-splash', '[sky] splash rings could not be built; rain will land without breaking.', err)
    splashes = null
    shaftSplashes = null
  }

  const splashOutside = new THREE.Color(NIGHT.splash.colorOutsideHex)
  const splashShaft = new THREE.Color(NIGHT.splash.colorShaftHex)

  // --- rain -----------------------------------------------------------------
  const fields = []
  try {
    const outside = buildRainField(
      NIGHT.rain.outside,
      {
        minX: EXIT.wellMinX - NIGHT.street.apron,
        maxX: WELL_MAX_X + NIGHT.street.apron,
        halfY: EXIT.wellHalfY + NIGHT.street.apron,
        minZ: STREET_Z,
        maxZ: STREET_Z + NIGHT.rain.outside.follow.rise,
        follow: NIGHT.rain.outside.follow,
      },
      () => STREET_Z,
      (x, y, z) => splashes?.spawn(x, y, z, splashOutside, NIGHT.splash.maxRadius.outside, NIGHT.splash.life.outside),
    )
    outside.mesh.name = 'rain-street'
    group.add(outside.mesh)
    fields.push(outside)
    disposers.push(() => outside.dispose())
    built.push('rain:street')
  } catch (err) {
    warnOnce('sky-rain-out', '[sky] the exterior rain could not be built; the street will be dry.', err)
  }

  try {
    // Kept a little inside the ceiling hole (X 80..780, |Y| <= 260) so every drop in this
    // field is a drop that can actually reach the building instead of one landing on a slab.
    const shaft = buildRainField(
      NIGHT.rain.shaft,
      { minX: EXIT.shaftMinX + 15, maxX: VOID_MAX_X - 10, halfY: EXIT.shaftHalfY - 12, minZ: LEVELS.platformTopZ, maxZ: EXIT.wellTopZ - 8 },
      wellCatchZ,
      (x, y, z) => shaftSplashes?.spawn(x, y, z, splashShaft, NIGHT.splash.maxRadius.shaft, NIGHT.splash.life.shaft),
    )
    shaft.mesh.name = 'rain-stairwell'
    group.add(shaft.mesh)
    fields.push(shaft)
    disposers.push(() => shaft.dispose())
    built.push('rain:stairwell')
  } catch (err) {
    warnOnce('sky-rain-shaft', '[sky] the rain down the stairwell could not be built; the exit will be dry.', err)
  }

  // The one check that catches this file drifting away from station.js's stairwell: the
  // void has to be a hole in the deck the platform can be seen through, not a solid strip.
  if (!(VOID_MIN_X < VOID_MAX_X && wellCatchZ((VOID_MIN_X + VOID_MAX_X) * 0.5, 0) === LEVELS.platformTopZ)) {
    console.warn(
      '[sky] the balcony void no longer lines up with station.js — rain will stop at the deck ' +
        'instead of falling through onto the platform. Re-derive EXIT against STAIRS.',
    )
  }

  console.info(
    `[sky] night built: ${built.join(', ') || 'nothing'} — ` +
      `${NIGHT.rain.outside.count + NIGHT.rain.shaft.count} drops in 2 instanced fields, ` +
      `${NIGHT.splash.count.outside + NIGHT.splash.count.shaft} splash rings, moon at ${NIGHT.moon.altitudeDeg}° / ${NIGHT.moon.azimuthDeg}°`,
  )

  function update(dt) {
    if (!(dt > 0)) return
    // A tab that was backgrounded hands back a several-second step; teleporting every drop
    // a hundred metres would empty both fields into one frame of splashes.
    const step = Math.min(dt, 0.1)
    try {
      for (const field of fields) field.update(step)
      splashes?.update(step)
      shaftSplashes?.update(step)
      if (dome) {
        // The exterior field is the one thing here that always draws, so it is where the
        // eye's height comes from. No field, no reading — and then the sky stays up.
        const eyeZ = fields.map(f => f.eyeZ()).find(z => z !== null)
        dome.visible = eyeZ === undefined || eyeZ > NIGHT.sky.showAboveZ
      }
    } catch (err) {
      warnOnce('sky-update', '[sky] the weather stopped updating; the rain will hang in the air.', err)
    }
  }

  /** Scales the whole night at once — sky, rain and splashes together. */
  function setIntensity(n) {
    intensity = Math.max(0, n)
    try {
      if (dome) dome.material.color.setScalar(NIGHT.sky.exposure * intensity)
      for (const field of fields) field.setOpacity(intensity)
      splashes?.setOpacity(intensity)
      shaftSplashes?.setOpacity(intensity)
    } catch (err) {
      warnOnce('sky-intensity', '[sky] the night could not be dimmed; it stays where it was.', err)
    }
  }

  return {
    group,
    dome,
    fields,
    splashes,
    shaftSplashes,
    street,
    /** Spec-space Z of the pavement, so the light rig can hang street lamps over it. */
    streetZ: STREET_Z,
    update,
    setIntensity,
    dispose() {
      for (const fn of disposers) {
        try { fn() } catch (err) { warnOnce('sky-dispose', '[sky] a night pass would not dispose cleanly.', err) }
      }
      skyTexture?.dispose()
      scene.background = previousBackground
      scene.remove(group)
    },
  }
}
