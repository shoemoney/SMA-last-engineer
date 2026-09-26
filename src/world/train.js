/**
 * train.js — the subway car that brings the wave.
 *
 * The arrival is the game's signature beat: headlights come up out of the west tunnel,
 * rake the length of the platform past the player, the car brakes, stops, opens four
 * doors, and unloads. The original had none of this. It had one untextured 800x160x160
 * box that slid 3000 cm on a quadratic ease and had no material, no windows, no doors as
 * geometry, no lights and no interior (spec/world-subway-station.md unknowns). Everything
 * here that is not motion timing is therefore new presentation built on the spec's box.
 *
 * Placement: the level PLACED both trains correctly in the track pits and then, at
 * start-up, teleported them onto the platform centreline (defect 1, §3.5). The station
 * publishes the in-pit positions that nothing ever read. This module can run either, but
 * defaults to the shipped platform placement because the zombie and wave specs both quote
 * stop (0,0,0) / staging (-3000,0,0), and because doors over a 250 cm trench put every
 * spawned zombie somewhere its AI has to climb out of.
 *
 * Frame: the spec authors the world Z-up (+X along the station, +Z up). three.js is Y-up.
 * The whole train hangs under one group that applies the (x, y, z)_spec -> (x, z, -y)_three
 * remap once, so every number below can stay in the spec's frame and be read against the
 * spec directly.
 */

import * as THREE from 'three/webgpu'
import { abs, attribute, dot, normalView, positionView, positionViewDirection, pow, smoothstep } from 'three/tsl'
import { STATION, TRAIN, FX, AUDIO, WAVES } from '../game/rules.js'
import { bus, EV } from '../core/events.js'
import { Rng, rng as defaultRng } from '../core/rng.js'
import {
  AD_PANEL,
  SIGN_FONT,
  SIGN_STRIP,
  ageArt,
  createBrandingTextures,
  drawBullet,
} from './materials.js'

const DEG = Math.PI / 180

/** Reused every frame so the update path allocates nothing. */
const SCRATCH = new THREE.Vector3()

/** Spec's Z-up frame to three's Y-up frame. The one conversion this module performs. */
function toThree(x, y, z) {
  return new THREE.Vector3(x, z, -y)
}

export const TRAIN_STATE = Object.freeze({
  idle: 'idle',
  arriving: 'arriving',
  departing: 'departing',
})

/**
 * Two placements, both spelled out in rules.js. `shipped` is what the abandoned build
 * actually did; `designed` is the station's own published stop/staging, which parks the
 * car in the north pit at station centre.
 */
const PLACEMENTS = Object.freeze({
  shipped: Object.freeze({
    stop: TRAIN.platformStopLocation,
    staging: TRAIN.stagingLocation,
    yawDeg: 0,
  }),
  designed: Object.freeze({
    stop: [STATION.DESIGNED.trainStopX, STATION.DESIGNED.trainStopY, STATION.DESIGNED.trainStopZ],
    staging: STATION.DESIGNED.trainStagingNorth,
    yawDeg: 0,
  }),
})

/**
 * Proportions for geometry the original simply did not have — it declared a single box and
 * stopped. There is nothing to diff these against in the spec, so they live here rather
 * than in rules.js, which is reserved for numbers a reviewer can check against the Unreal
 * source. Every one is a fraction of a spec dimension, so the carriage stays coherent if
 * the 800x160x160 box ever changes.
 */
const MODEL = Object.freeze({
  roofInsetFraction: 0.12, // of body width; the crown tapers in from the flanks
  roofRiseFraction: 0.1, // of body height
  hvacLengthFraction: 0.34, // of body length; the roof-mounted plant box
  hvacWidthFraction: 0.6, // of roof width
  skirtDropFraction: 0.06, // of body height; underframe valance below the floor line

  noseLengthFraction: 0.09, // of body length; the cab cap at each end
  noseWidthFraction: 0.9, // inset on every side so it never coplanar-fights the hull
  noseHeightFraction: 0.92,
  screenWidthFraction: 0.66, // of body width; the cab windscreen
  screenHeightFraction: 0.3, // of body height
  screenCentreFraction: 0.66, // of body height

  // Every flank detail is this thick, and each successive layer steps out by a multiple of
  // it: recess -0.5, windows and livery +0.5, door leaves +2, destination board +2.5. No
  // two faces ever land on the same plane, which is what keeps the car free of z-fighting.
  surfaceLayer: 2.0, // cm
  windowHeightFraction: 0.34, // of body height
  windowSillFraction: 0.42, // of body height, measured from the floor line
  // A 9.6 cm pinstripe is a detail; a 25 cm painted band is a LIVERY, and a livery is the
  // only thing that tells a player at fifty metres whose train just pulled in. It is wide
  // enough to carry the wordmark and still clears the window line by 13 cm.
  liveryBandFraction: 0.16, // of body height
  liveryStripeFraction: 0.022, // of body height; the gold pinstripe riding above the band
  liveryStripeGapFraction: 0.028, // of body height, between band top and stripe
  /** Centimetres of carriage covered by one repeat of the livery wordmark. */
  liveryTileCm: 210.0,

  // Panes are cut to a FIXED width and centred in whatever gap the doors leave, rather
  // than stretched to fill it. Filling the gap gave three different pane widths at two
  // different sill heights, which is precisely why the first pass read as lightboxes
  // punched into a box instead of as glass in a carriage.
  windowPaneWidth: 84.0, // cm
  windowPaneMinMargin: 5.0, // cm of hull that must survive either side of a pane
  windowGasketMargin: 4.0, // cm of rubber frame proud of the glass on every edge
  // The bare emissive blew to rgb(254,254,248) with no interior detail left. The glow map
  // carries the shape now, so the material only has to supply the lamp behind it.
  windowEmissiveTrim: 0.25, // of TRAIN.windowEmissiveIntensity
  cabGlassTrim: 0.015, // the cab is not a saloon; its screen must not out-shine the row

  // The arrival is the signature beat, so the lit flank has to LAND on the platform. One
  // wash lamp per bay, outside the glass, always on — a row of windows that throws no
  // light is the single loudest tell that a scene is not really lit.
  // Standoff and intensity are a pair: a bright lamp parked 20 cm off the glass bleaches
  // the hull it is meant to reveal (measured L=249 on the near flank) long before the
  // platform gets anything. Pushed out and cut down, the same light lands on the floor.
  windowWashStandoff: 90.0, // cm outboard of the glass
  windowWashIntensityFraction: 0.25, // of the station's own head-height fill
  windowWashDistance: 760.0, // cm — reaches the platform lip without flooding the tunnel
  // Sat dead level with the glass, the wash lit a bright belt across the middle of the
  // car and left the roof at L=81 under a body at L=180 — a gradient running the wrong
  // way. Lifting it to the window head spreads the same light up over the crown.
  windowWashLiftFraction: 0.15, // of window height, above the sill centre
  windowWashSpacing: 100.0, // cm between bays on the platform side — one per window and door
  windowWashBlindSpacing: 250.0, // the blind flank only has a tunnel wall to paint

  // Every carriage roof in service is paler than its body — it is unpainted alloy under
  // a decade of tunnel dust, and nobody washes it. It is also the only top-down cue the
  // car has from a platform that is lit from above, so it earns its own tint.
  roofPaintHex: 0xb9bec4,
  roofRibCount: 11, // cross ribs; the roofline is the train's whole silhouette from the platform
  roofRibWidthFraction: 0.012, // of body length
  roofRibRiseFraction: 0.35, // of roof height

  // The roll sign runs the full door line rather than sitting over one pair of them: it is
  // the loudest lit object on the car and the only thing on it that says a WORD, so it gets
  // the length. Lifted clear of the door heads (0.82 of body height) so nothing coplanar
  // fights, and stood off three layers so it clears the door leaves' own two.
  boardLengthFraction: 0.42, // of body length; the destination roll over the doors
  // 336 x 21 cm, i.e. 16:1 — the aspect bakeRollSign draws the flank roll at. A board
  // whose proportions disagree with its texture stretches the type and the sign stops
  // reading as type at all.
  boardHeightFraction: 0.131, // of body height
  boardCentreFraction: 0.92, // of body height
  boardOffsetFraction: 0.0, // of half-length; centred on the door line
  boardStandoffLayers: 3.0, // of surfaceLayer, outboard of the flank

  /** The cab-end roll sign, over the windscreen at both ends. */
  endBoardWidthFraction: 0.72, // of body width
  endBoardHeightFraction: 0.13, // of body height — 115 x 21 cm, the cab roll's own 5.6:1
  endBoardCentreFraction: 0.90, // of body height

  /** Route bullet and fleet number, stencilled on the hull beside each cab. */
  cabPlateSizeFraction: 0.30, // of body height
  cabPlateInsetFraction: 0.74, // of half-length
  cabPlateCentreFraction: 0.26, // of body height

  doorLeafWidthFraction: 0.26, // of door spacing; two leaves per doorway
  doorHeightFraction: 0.82, // of body height
  doorSlideFraction: 0.95, // of a leaf's width; an open leaf still overlaps its jamb
  doorPortWidthFraction: 0.55, // of a leaf; the little window in the door. Its HEIGHT and
  // sill are not free parameters — they are the flank's, so the window line is unbroken.

  lampRadius: 11.0, // cm; headlight and tail-lamp discs
  lampInsetFraction: 0.44, // of half-width; lateral offset of each lamp pair
  // Under the screen, not in it. At 0.62 the lamp discs landed inside the windscreen
  // rectangle and the spots sat a centimetre behind its glass, which bleached the whole
  // cab face to a flat cream panel with two holes in it.
  headlightHeightFraction: 0.28, // of body height
  headlightAngleRad: 0.52, // ~30 degree half-angle; wide enough to wash the platform edge
  headlightPenumbra: 0.55,
  headlightFlickerDepth: 0.06, // peak intensity wobble on the approach
  headlightFlickerRate: 0.02, // radians per cm travelled, so the wobble tracks the car
  hazeConeLength: 2600.0, // cm of fake volumetric shaft drawn in front of each headlight
  // The visible shaft is much tighter than the light's outer falloff. At the full cone
  // angle it comes out 30 m across, which is wider than the station and reads as fog.
  hazeConeAngleFraction: 0.45, // of the headlight half-angle
  hazeConeOpacity: 0.09,
  // How much shaft is left once the car is parked. At 0.25 the parked cone ran at
  // 0.09 x 0.25 = 0.0225, which through the tone curve at 720p is nothing: the docked car
  // had two flat white discs on its nose and threw no beam at all, in the one frame where
  // a light with a visible HOUSING could have sold "the light comes from somewhere". The
  // arrival is this file's whole reason to exist, so the parked shaft stays lit.
  hazeIdleFraction: 0.65,
  /** Length-wise ramp on the shaft: hot at the lamp, dead by this fraction of the cone. */
  hazeFalloffEnd: 0.62,
  // Extra brightness in the first tenth of the shaft, where the glass still is. Kept
  // modest: the throat is the one part of the beam that sits under the bloom threshold's
  // nose, and a hot ring there turns two headlights into one white smear.
  hazeThroatGain: 1.25,

  interiorHeightFraction: 0.6, // of body height
  doorSpillHeightFraction: 0.4, // of body height
  doorSpillReachFactor: 6.0, // of the door lateral offset; how far the doorway throws light

  bogieCount: 2,
  bogieInsetFraction: 0.62, // of half-length
  bogieLengthFraction: 0.34, // of half-length
  bogieWidthFraction: 1.2, // of half-width
  bogieHeightFraction: 0.7, // of the clearance below the floor line
  wheelRadiusFraction: 0.45, // of the clearance
  wheelSpanFraction: 0.12, // of half-length; axle separation within a truck
  wheelTrackFraction: 0.8, // of half-width
  wheelThicknessFraction: 0.18, // of half-width

  brakeRollDeg: 1.6, // peak body roll while accelerating or braking
  brakeShudderHz: 11.0,
  brakeShudderDepth: 0.25, // of the roll amplitude
  rollResponse: 8.0, // per second; how fast the body catches up to its target roll
  hazeResponse: 3.0, // per second
  idleSpeedDecay: 4.0, // per second; bleeds the stored speed once parked
})

/** The 20 cm the designed stop sits above the pit floor is exactly the running gear's room. */
const BOGIE_CLEARANCE = STATION.DESIGNED.trainStopZ - STATION.LEVELS.trackFloorZ

/** Quadratic ease-in-out, verbatim from ShoeTrain.cpp:69. */
function ease(t) {
  const e = TRAIN.easeExponent
  if (t < 0.5) return 0.5 * Math.pow(2 * t, e)
  return 0.5 + 0.5 * (1 - Math.pow(2 - 2 * t, e))
}

function disposeTree(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose()
    const mat = node.material
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else if (mat) mat.dispose()
  })
}

// ---------------------------------------------------------------------------
// Skin
//
// The carriage shipped as one untextured MeshStandardMaterial and measured sd=13 on a
// window-free hull patch against the platform floor's sd=41 — a beige cuboid with white
// rectangles cut out of it, which is the exact greybox failure this whole rebuild exists
// to avoid. Everything below bakes the flank the station bakes its own surfaces:
// albedo + a glTF-style ORM pack (G = roughness, B = metalness, one binding doing two
// jobs) + a normal map derived from the same height field.
//
// It lives here rather than in materials.js because materials.js is owned elsewhere this
// round, and because a carriage needs things a wall baker does not have: body seams,
// rivet rows following those seams, a belt rail, corrugated lower panels, and dirt that
// runs DOWN. The convention is deliberately identical, so folding it into the station's
// baker later is a move, not a rewrite.
// ---------------------------------------------------------------------------

const SKIN = Object.freeze({
  size: 512,
  seed: 0x7a2d19,
  /** One bake tile covers this much carriage, so the seams land at believable spacing. */
  tileCm: 200.0,
  /** Vertical body seams within a tile. */
  seamsU: Object.freeze([0.0, 0.5]),
  /** Horizontal rails: belt above the glass, solebar under it. */
  railsV: Object.freeze([0.285, 0.855]),
  rivetPitch: 0.030,
  corrugations: 26,
  // The seams, rivets and corrugation are only ever as visible as the light that grazes
  // them, and below the window line this car is grazed by nothing. At 5.0 the relief
  // vanished entirely on the blind flank (measured sd 6.8 against the lit upper flank's
  // 34). Driven hard, the little light that does reach the solebar catches an edge.
  normalStrength: 8.5,
  /**
   * three multiplies map x material.color, and both are dark here: the livery is already
   * 0x6e737a. Baking the paint at its own value on top of that drove the hull to a
   * measured L=0.3 — black. The map is a MODULATION, so it is lifted to sit near white
   * and the livery colour stays the only thing setting how dark the car is.
   */
  paintLift: 1.42,
})

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const mix = (a, b, t) => a + (b - a) * t
function smooth01(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

/** Shortest distance from `x` to `at` on a wrapped 0..1 axis. */
function ringDistance(x, at) {
  return Math.abs(((x - at + 1.5) % 1) - 0.5)
}

/**
 * Paints a length-wise ramp into a haze cone's vertex colours.
 *
 * The cone blends additively, so a vertex colour of zero contributes nothing — this is an
 * alpha ramp bought for one attribute and no shader. It matters because a flat additive
 * cone is a cone-shaped OBJECT: it has a visible rim where the geometry stops, 26 m down
 * the platform, and a beam that ends in a straight edge reads as a prop. Ramped, the shaft
 * is hottest at the housing and gone by about 16 m, which is a light dying into fog.
 */
function applyHazeFalloff(geometry, length) {
  const pos = geometry.getAttribute('position')
  // FOUR components, not three. three's node pipeline declares the `color` attribute as a
  // vec4 whatever the buffer holds, and a three-component buffer under a vec4 declaration
  // is a vertex-format mismatch the WebGPU backend rejects outright.
  const colors = new Float32Array(pos.count * 4)
  for (let i = 0; i < pos.count; i++) {
    // ConeGeometry stands its apex at +Y, so t runs 0 at the lamp to 1 at the far rim.
    const t = clamp01(0.5 - pos.getY(i) / length)
    const ramp =
      (1 - smooth01(0.015, MODEL.hazeFalloffEnd, t)) *
      mix(MODEL.hazeThroatGain, 1.0, smooth01(0.0, 0.1, t))
    colors[i * 4] = ramp
    colors[i * 4 + 1] = ramp
    colors[i * 4 + 2] = ramp
    colors[i * 4 + 3] = 1
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
}

let warnedNoDom = false
function makeCanvas(width, height = width) {
  if (typeof document === 'undefined') {
    if (!warnedNoDom) {
      warnedNoDom = true
      console.warn(
        '[train] no DOM: the carriage skin cannot be baked, so the car falls back to flat ' +
          'colour — the untextured slab the rebuild exists to replace.',
      )
    }
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function toTexture(canvas, colorSpace, repeatX = 1, repeatY = 1, clamp = false) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = colorSpace
  tex.wrapS = tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping
  tex.repeat.set(repeatX, repeatY)
  tex.anisotropy = 16
  tex.needsUpdate = true
  return tex
}

/** Value noise on a wrapped lattice, so every octave tiles at u,v = 1. */
function tileableNoise(rng, cells) {
  const grid = new Float32Array(cells * cells)
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next()
  return (u, v) => {
    const x = u * cells
    const y = v * cells
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const cx0 = ((x0 % cells) + cells) % cells
    const cy0 = ((y0 % cells) + cells) % cells
    const cx1 = (cx0 + 1) % cells
    const cy1 = (cy0 + 1) % cells
    const a = grid[cy0 * cells + cx0]
    const b = grid[cy0 * cells + cx1]
    const c = grid[cy1 * cells + cx0]
    const d = grid[cy1 * cells + cx1]
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
  }
}

function tileableFbm(rng, baseCells, octaves) {
  const layers = []
  let cells = baseCells
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    layers.push({ noise: tileableNoise(rng, cells), amp })
    total += amp
    cells *= 2
    amp *= 0.5
  }
  return (u, v) => {
    let sum = 0
    for (const layer of layers) sum += layer.noise(u, v) * layer.amp
    return sum / total
  }
}

/** Stretched along v — rain, rust and brake dust all run down a carriage, never across. */
function streakFbm(rng, cells, octaves, stretch) {
  const f = tileableFbm(rng, cells, octaves)
  return (u, v) => f(u, v / stretch)
}

/** Height field to an OpenGL-convention tangent-space normal map; sampling wraps. */
function heightToNormal(height, size, strength) {
  const canvas = makeCanvas(size)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const inv = 1 / Math.hypot(-dx, dy, 1)
      const i = (y * size + x) * 4
      data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return toTexture(canvas, THREE.NoColorSpace)
}

/**
 * Painted steel carriage flank. Kept close to neutral so `material.color` still carries
 * the livery — one bake dresses the hull, the dark underframe and the red accent band.
 *
 * `v = 0` is the roofline and `v = 1` is the solebar. Note the flip: a box's +Y face — the
 * flank that faces the platform, the only one a player ever sees — runs its UV v OPPOSITE
 * to the -Y face, so a canvas drawn the obvious way up arrives on that flank upside down.
 * It landed the window seals and the passengers along the TOP of every pane, reading as
 * drips. The content is therefore authored flipped, and the platform side is the side that
 * comes out right. Grime belongs low and dust belongs high, on the flank that is looked at.
 */
function bakeCarriageSkin() {
  const size = SKIN.size
  const albedoCanvas = makeCanvas(size)
  if (!albedoCanvas) return {}
  const ormCanvas = makeCanvas(size)

  const rng = new Rng(SKIN.seed)
  const broad = tileableFbm(rng, 4, 4)
  const chips = tileableFbm(rng, 15, 4)
  const grain = tileableFbm(rng, 72, 2)
  const rustField = streakFbm(rng, 11, 4, 6)
  const runoff = streakFbm(rng, 28, 4, 9)

  const albedoCtx = albedoCanvas.getContext('2d')
  const ormCtx = ormCanvas.getContext('2d')
  const albedo = albedoCtx.createImageData(size, size)
  const orm = ormCtx.createImageData(size, size)
  const height = new Float32Array(size * size)
  const roughRaw = new Float32Array(size * size)
  const metalRaw = new Float32Array(size * size)
  let maxRough = 0
  let maxMetal = 0

  for (let y = 0; y < size; y++) {
    const v = 1 - (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size

      let seamD = 1
      for (const s of SKIN.seamsU) seamD = Math.min(seamD, ringDistance(u, s))
      let railD = 1
      for (const r of SKIN.railsV) railD = Math.min(railD, Math.abs(v - r))

      const seam = 1 - smooth01(0.0, 0.0065, seamD)
      const rail = 1 - smooth01(0.0, 0.0075, railD)

      // Rivets follow the seams they fasten: down each body seam, along each rail.
      const rivetV = Math.abs(((v / SKIN.rivetPitch) % 1) - 0.5)
      const rivetU = Math.abs(((u / SKIN.rivetPitch) % 1) - 0.5)
      const rivets =
        (1 - smooth01(0.2, 0.36, rivetV)) * (1 - smooth01(0.004, 0.012, seamD)) +
        (1 - smooth01(0.2, 0.36, rivetU)) * (1 - smooth01(0.004, 0.012, railD))

      // Corrugated lower panels — the ribbing every subway car carries below the sill.
      const corrMask = smooth01(0.62, 0.74, v) * (1 - smooth01(0.90, 0.97, v))
      const corrugation = Math.sin(u * Math.PI * 2 * SKIN.corrugations) * corrMask
      const crest = clamp01(corrugation)
      const trough = clamp01(-corrugation)

      const b = broad(u, v)
      const g = grain(u, v)
      const chip = smooth01(0.61, 0.75, chips(u, v)) * 0.55
      const bleed = clamp01(rustField(u, v) * 1.75 - 0.66)
      const dirt = clamp01(runoff(u, v) * 1.5 - 0.54) * smooth01(0.18, 0.95, v)
      const grime = smooth01(0.70, 1.0, v)
      const dust = 1 - smooth01(0.015, 0.11, v)

      const tone = mix(0.52, 0.74, b)
      let r = tone
      let gg = tone * 0.995
      let bb = tone * 1.035 // cold steel, so the sodium wash has something to warm

      // seams and rails are shadowed grooves, the rivets catch the light along them
      const groove = Math.max(seam, rail * 0.8)
      r = mix(r, r * 0.42, groove)
      gg = mix(gg, gg * 0.42, groove)
      bb = mix(bb, bb * 0.46, groove)
      const proud = clamp01(rivets) * 0.16
      r += proud
      gg += proud
      bb += proud

      // rust bleeds downward out of every chip, then the chip itself
      r = mix(r, 0.40, bleed * 0.62)
      gg = mix(gg, 0.20, bleed * 0.62)
      bb = mix(bb, 0.10, bleed * 0.62)
      r = mix(r, 0.45, chip)
      gg = mix(gg, 0.24, chip)
      bb = mix(bb, 0.13, chip)

      // brake dust and rain runs, heavier the lower they get
      r = mix(r, 0.21, dirt * 0.7)
      gg = mix(gg, 0.19, dirt * 0.7)
      bb = mix(bb, 0.17, dirt * 0.7)
      // Was 0.34. The `fall` ramp added below now carries the body's vertical grade, and
      // two stacked gradients on the same 25 cm of solebar crushed it to black.
      const sink = grime * 0.20
      r *= 1 - sink
      gg *= 1 - sink
      bb *= 1 - sink * 0.92

      // pale tunnel dust sits on the roofline and is what gives the car its top-down run
      r = mix(r, 0.78, dust * 0.42)
      gg = mix(gg, 0.77, dust * 0.42)
      bb = mix(bb, 0.73, dust * 0.42)

      // Below the sill this car is a corrugated panel, and until now the ribbing lived
      // ONLY in the height field — which needs a lamp raking it before it shows. Nothing
      // on this platform throws light at the solebar, so the ribs never appeared and the
      // whole blind flank baked out as a single flat value. Painting the ribs into the
      // ALBEDO as well gives the lower body structure that survives with no light on it
      // at all: crests wiped clean by twenty years of brush washes, troughs holding what
      // the brushes could not reach.
      const rib = crest * 0.20 - trough * 0.18
      r = clamp01(r + rib)
      gg = clamp01(gg + rib)
      bb = clamp01(bb + rib * 1.06)

      // Self-shading, for the same reason. A flank with no gradient down it reads as a
      // DECAL of a train; the eye takes a falloff as form even when the light is flat.
      // The solebar is where brake dust, rail spray and road film collect, so it goes
      // dirty and the belt rail stays the brightest thing below the glass.
      const fall = smooth01(0.30, 0.95, v)
      r *= mix(1.06, 0.62, fall)
      gg *= mix(1.05, 0.60, fall)
      bb *= mix(1.04, 0.58, fall)

      const speck = (g - 0.5) * 0.05
      const p = y * size + x
      const i = p * 4
      albedo.data[i] = clamp01((r + speck) * SKIN.paintLift) * 255
      albedo.data[i + 1] = clamp01((gg + speck) * SKIN.paintLift) * 255
      albedo.data[i + 2] = clamp01((bb + speck) * SKIN.paintLift) * 255
      albedo.data[i + 3] = 255

      // The crest of every rib is the one part of a carriage flank that gets WIPED, by
      // brushes and by shoulders. Polishing them alternates gloss with matte down the
      // lower body, so the ribs answer a grazing platform lamp with a specular band even
      // where the diffuse term has nothing to give.
      const rough = clamp01(
        mix(mix(0.30, 0.52, b), 0.95, Math.max(chip * 1.6, bleed * 0.8, dirt, grime * 0.7)) +
          groove * 0.12 -
          crest * 0.30,
      )
      const metal = clamp01(mix(0.88, 0.10, Math.max(chip * 1.6, bleed * 0.7, dirt * 0.8)))
      roughRaw[p] = rough
      metalRaw[p] = metal
      if (rough > maxRough) maxRough = rough
      if (metal > maxMetal) maxMetal = metal

      height[p] = clamp01(
        0.58 -
          seam * 0.34 -
          rail * 0.18 +
          clamp01(rivets) * 0.26 +
          corrugation * 0.12 +
          (g - 0.5) * 0.1 -
          chip * 0.4,
      )
    }
  }

  // Normalised, because three MULTIPLIES these by material.roughness / material.metalness:
  // the spec's values stay the roughest and most metallic the surface ever gets.
  const roughScale = maxRough > 0 ? 255 / maxRough : 0
  const metalScale = maxMetal > 0 ? 255 / maxMetal : 0
  for (let p = 0; p < roughRaw.length; p++) {
    const i = p * 4
    orm.data[i] = 255
    orm.data[i + 1] = roughRaw[p] * roughScale
    orm.data[i + 2] = metalRaw[p] * metalScale
    orm.data[i + 3] = 255
  }

  albedoCtx.putImageData(albedo, 0, 0)
  ormCtx.putImageData(orm, 0, 0)

  return {
    map: toTexture(albedoCanvas, THREE.SRGBColorSpace),
    ormMap: toTexture(ormCanvas, THREE.NoColorSpace),
    normalMap: heightToNormal(height, size, SKIN.normalStrength),
  }
}

/**
 * What is behind the glass. A pane lit by a flat emissive is a lightbox; a pane lit by a
 * ceiling strip it cannot see, with grab poles and a couple of slumped passengers in the
 * way, is a carriage. Bright across the top 70%, down to about a third of that at the
 * sill, which is where a saloon light actually falls off.
 */
function bakeWindowGlow() {
  const w = 256
  const h = 128
  const canvas = makeCanvas(w, h)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  // See bakeCarriageSkin: the platform-facing flank reads v upside down.
  ctx.translate(0, h)
  ctx.scale(1, -1)

  const glow = ctx.createLinearGradient(0, 0, 0, h)
  glow.addColorStop(0.0, '#fff6dc')
  glow.addColorStop(0.28, '#ffe8b4')
  glow.addColorStop(0.70, '#f2c47e')
  glow.addColorStop(0.92, '#8a5c2c')
  glow.addColorStop(1.0, '#4a3018')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)

  // The saloon strip itself, bounced off the ceiling the pane cannot show you.
  const strip = ctx.createLinearGradient(0, 0, 0, h * 0.22)
  strip.addColorStop(0, 'rgba(255,255,245,0.85)')
  strip.addColorStop(1, 'rgba(255,255,245,0)')
  ctx.fillStyle = strip
  ctx.fillRect(0, 0, w, h * 0.22)

  // A pane is about ten pixels tall from the platform. Passenger silhouettes were tried
  // here and every figure collapsed into a dark triangle — a row of them read as a sawtooth
  // along the sill, not as people. What survives that scale is tone: seat backs and the
  // sill shadow as one soft dark band, and two wide, faint stanchions. Nothing figurative,
  // nothing thin, nothing that can alias.
  const seats = ctx.createLinearGradient(0, h * 0.58, 0, h)
  seats.addColorStop(0, 'rgba(26,19,12,0)')
  seats.addColorStop(0.55, 'rgba(26,19,12,0.45)')
  seats.addColorStop(1, 'rgba(18,13,9,0.72)')
  ctx.fillStyle = seats
  ctx.fillRect(0, h * 0.58, w, h * 0.42)

  ctx.fillStyle = 'rgba(40,30,20,0.26)'
  for (const cx of [0.33, 0.67]) ctx.fillRect(Math.round(cx * w) - 3, 0, 7, h)
  ctx.fillStyle = 'rgba(8,7,6,0.95)'
  ctx.fillRect(0, h - 5, w, 5)
  ctx.fillRect(0, 0, w, 2)

  return toTexture(canvas, THREE.SRGBColorSpace, 1, 1, true)
}

/**
 * The destination roll sign. It said "6:15 — PLATFORM ONE", which is a timetable, not a
 * destination — the one lit object on the flank with a chance to say whose train this is,
 * spending it on the clock. Amber dot-matrix on black, in the HUD's own mono face, so the
 * train and the interface read as the same world.
 *
 * `pitch` is the dot spacing in pixels. The matrix has to be COARSE relative to the glyph
 * or it stops reading as a display and goes back to being a sticker, so a short board with
 * big characters gets a wider pitch than the long flank roll.
 *
 * There is no flip option and there must not be one. The flank board used to be a BOX,
 * and a BoxGeometry's +Y face lands the texture rotated 180 degrees, so the art was baked
 * upside down to compensate — which corrected the vertical and left the type MIRRORED, and
 * it shipped that way because a mirrored word at eight metres still looks like a word. The
 * board is a plane now, like every other lettered fitting on this carriage, and planes have
 * one unambiguous UV convention. See #facePlane.
 */
function bakeRollSign(head, sub, { w = 1024, h = 128, pitch = 5, squeeze = 0.78 } = {}) {
  const canvas = makeCanvas(w, h)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#07080b'
  ctx.fillRect(0, 0, w, h)

  const line = (text, cy, size, color) => {
    ctx.save()
    const face = `'JetBrains Mono', 'Barlow Condensed', ${SIGN_FONT}`
    ctx.font = `700 ${Math.round(size)}px ${face}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const measured = ctx.measureText(text).width * squeeze
    const fit = measured > w * 0.94 ? (size * w * 0.94) / measured : size
    ctx.font = `700 ${Math.round(fit)}px ${face}`
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = fit * 0.40
    ctx.translate(w / 2, cy)
    ctx.scale(squeeze, 1)
    ctx.fillText(text, 0, 0)
    ctx.restore()
  }

  if (sub) {
    line(head, h * 0.36, h * 0.44, '#ffb43a')
    line(sub, h * 0.76, h * 0.25, '#d8790f')
  } else {
    line(head, h * 0.56, h * 0.62, '#ffb43a')
  }

  // Dot-matrix: black gridlines punched back over the glyphs. Without it the board is a
  // sticker; with it, it is a display.
  ctx.fillStyle = '#07080b'
  for (let x = 0; x < w; x += pitch) ctx.fillRect(x, 0, 1, h)
  for (let y = 0; y < h; y += pitch) ctx.fillRect(0, y, w, 1)

  ctx.strokeStyle = 'rgba(255,180,58,0.30)'
  ctx.lineWidth = 3
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3)

  // The glass over a roll sign is as filthy as everything else in this tunnel.
  ageArt(ctx, 0, 0, w, h, 0.30, 7)

  return toTexture(canvas, THREE.SRGBColorSpace, 1, 1, true)
}

/**
 * The livery band. It was a flat red stripe — a COLOUR, not a livery, and a colour says
 * nothing about who is driving. This is the painted band a real operator puts its name in:
 * house red, the wordmark repeating along the car with the route bullet as separator, and
 * the paint scraped back to primer along the bottom edge where a platform lip has been
 * chewing it for twenty years.
 *
 * 8:1, so one repeat covers MODEL.liveryTileCm of carriage and the letters stay one height
 * whether the panel under them is 96 cm of door bay or 6.5 m of blind flank.
 */
function bakeLiveryBand() {
  const w = 1024
  const h = 128
  const canvas = makeCanvas(w, h)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  const rng = new Rng(SKIN.seed ^ 0x4b17)

  // Unlike the hull skin, this map is NOT a modulation: it carries the paint itself, and
  // the material that wears it is left at white.
  //
  // The first version did it the skin's way — a pale field lifted above `material.color`,
  // with the wordmark in white — and the wordmark was invisible at every light level,
  // because multiplying white letters by a red livery gives red letters on a red band.
  // Contrast between the letters and the field has to survive the multiply, so it has to
  // live in the texture. The field is still the spec's accent colour, read from rules.js
  // rather than retyped, so a reviewer can still diff it.
  const accent = `#${STATION.COLORS.trainAccentHex.toString(16).padStart(6, '0')}`
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, w, h)

  const shade = ctx.createLinearGradient(0, 0, 0, h)
  shade.addColorStop(0, 'rgba(88,58,62,0.55)')
  shade.addColorStop(0.22, 'rgba(255,255,255,0.12)')
  shade.addColorStop(0.78, 'rgba(255,255,255,0.04)')
  shade.addColorStop(1, 'rgba(58,36,40,0.62)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.font = `800 ${Math.round(h * 0.54)}px ${SIGN_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fbf6ea'
  try {
    ctx.letterSpacing = '6px'
  } catch {
    // Chrome 99+. Tracking is a refinement of the wordmark, never a requirement.
  }
  ctx.translate(w * 0.5, h * 0.52)
  ctx.scale(0.72, 1)
  ctx.fillText('SHOEMONEY EXPRESS', 0, 0)
  ctx.restore()

  // A bullet at each end, so the repeat reads as continuous paint rather than as one word
  // stamped once per panel.
  for (const cx of [w * 0.035, w * 0.965]) {
    ctx.beginPath()
    ctx.arc(cx, h * 0.5, h * 0.32, 0, Math.PI * 2)
    ctx.fillStyle = '#fbf6ea'
    ctx.fill()
    ctx.save()
    ctx.font = `800 ${Math.round(h * 0.54)}px ${SIGN_FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#7d1018'
    ctx.fillText('$', cx, h * 0.53)
    ctx.restore()
  }

  for (let i = 0; i < 70; i++) {
    ctx.globalAlpha = rng.range(0.08, 0.42)
    ctx.fillStyle = rng.chance(0.4) ? '#5c4a3a' : '#c9c2b2'
    ctx.fillRect(rng.next() * w, h * rng.range(0.62, 1.0), rng.range(6, 54), rng.range(1, 4))
  }
  ctx.globalAlpha = 1

  ageArt(ctx, 0, 0, w, h, 0.28, 23)

  return toTexture(canvas, THREE.SRGBColorSpace, 1, 1, false)
}

/**
 * The plate beside each cab: route bullet over a fleet number. A real carriage carries its
 * own number in 15 cm characters and nothing else on the body is that small — which is
 * exactly why it reads as a real carriage from a platform where you cannot make the digits
 * out at all.
 */
function bakeCabPlate() {
  const size = 256
  const canvas = makeCanvas(size, size)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')

  // An opaque plate, not a cut-out decal: the aging pass below lays semi-transparent dirt
  // over whatever is under it, and over nothing at all that comes back as a grey smear.
  ctx.fillStyle = '#23262c'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(160,158,150,0.5)'
  ctx.lineWidth = size * 0.02
  ctx.strokeRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92)

  drawBullet(ctx, size * 0.5, size * 0.37, size * 0.30, {
    fill: '#c4141f',
    ink: '#faf4e6',
    ring: 'rgba(250,244,230,0.78)',
  })

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${Math.round(size * 0.15)}px 'JetBrains Mono', ${SIGN_FONT}`
  ctx.fillStyle = '#e6dfcd'
  ctx.fillText('R-4179', size * 0.5, size * 0.79)
  ctx.font = `600 ${Math.round(size * 0.072)}px ${SIGN_FONT}`
  ctx.fillStyle = '#b3a892'
  ctx.fillText('SHOEMONEY TRANSIT', size * 0.5, size * 0.92)

  ageArt(ctx, 0, 0, size, size, 0.22, 31)

  return toTexture(canvas, THREE.SRGBColorSpace, 1, 1, true)
}

export class Train {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [options]
   * @param {'shipped'|'designed'} [options.placement]
   * @param {Function} [options.onArrived] fired the frame the slide completes, before the doors move
   * @param {Function} [options.onDeparted]
   * @param {boolean} [options.emitEvents] publish TRAIN_INBOUND / TRAIN_DOORS on the bus
   */
  constructor(scene, options = {}) {
    const placementKey = options.placement ?? 'shipped'
    const placement = PLACEMENTS[placementKey]
    if (!placement) {
      throw new Error(`[train] unknown placement "${placementKey}" — expected 'shipped' or 'designed'`)
    }

    this.scene = scene
    this.placementKey = placementKey
    this.onArrived = options.onArrived ?? null
    this.onDeparted = options.onDeparted ?? null
    this.emitEvents = options.emitEvents !== false

    this.stop = new THREE.Vector3(...placement.stop)
    this.staging = new THREE.Vector3(...placement.staging)
    this.yawDeg = placement.yawDeg

    /** Spec-frame position of the carriage's floor centre. */
    this.position = this.staging.clone()
    this.from = this.staging.clone()
    this.to = this.staging.clone()

    this.state = TRAIN_STATE.idle
    this.elapsed = 0
    this.duration = TRAIN.arrivalTime
    this.speed = 0 // cm/s along the travel axis; drives wheel spin and brake roll
    this.travelled = 0

    /** 0 = shut, 1 = fully open. The doors only move once the car is parked. */
    this.doorPhase = 0
    this.doorTarget = 0

    this.clock = 0

    this.group = new THREE.Group()
    this.group.name = 'train'
    this.group.rotation.y = this.yawDeg * DEG

    /** Everything under here is authored in the spec's Z-up local frame. */
    this.frame = new THREE.Group()
    this.frame.name = 'train:frame'
    this.frame.rotation.x = -Math.PI / 2
    this.group.add(this.frame)

    this.#build()
    this.#applyTransform()

    scene.add(this.group)
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  #build() {
    const [length, width, height] = TRAIN.bodySize
    const winH = height * MODEL.windowHeightFraction
    const dims = {
      length,
      width,
      height,
      halfL: length / 2,
      halfW: width / 2,
      noseL: length * MODEL.noseLengthFraction,
      layer: MODEL.surfaceLayer,
      leafW: TRAIN.doorSpacing * MODEL.doorLeafWidthFraction,
      // One window line for the whole car. The doors carry the same sill and the same
      // pane height as the flank, because a row that steps up and down at every doorway
      // is what made the first pass read as rectangles of random size.
      winH,
      winZ: height * MODEL.windowSillFraction + winH / 2,
    }

    // The pivot is the carriage FLOOR, not the body centre. The spec's centred pivot buries
    // half the car in the platform slab at stop Z = 0 and leaves the doors' local Z = 0 in
    // mid-air; hanging the body off its floor line makes door Z = 0 mean "the step".
    this.body = new THREE.Group()
    this.body.name = 'train:body'
    this.frame.add(this.body)

    const mats = this.#buildMaterials(dims)

    this.#buildHull(mats, dims)
    this.#buildDoors(mats, dims)
    this.#buildFlanks(mats, dims)
    this.#buildRunningGear(mats, dims)
    this.#buildLights(mats, dims)
  }

  /**
   * Every painted surface on the car draws from one skin bake, tinted by its own livery
   * colour and re-tiled for its own size. Cloned textures share the uploaded image, so
   * three repeats cost one GPU texture, not three.
   */
  #buildMaterials(d) {
    const skin = bakeCarriageSkin()
    this.textures = [skin.map, skin.ormMap, skin.normalMap].filter(Boolean)

    const dress = (material, repeatX, repeatY) => {
      if (!skin.map) return material
      const map = skin.map.clone()
      const orm = skin.ormMap.clone()
      const normal = skin.normalMap.clone()
      for (const tex of [map, orm, normal]) {
        tex.repeat.set(repeatX, repeatY)
        tex.needsUpdate = true
        this.textures.push(tex)
      }
      material.map = map
      // One texture in both slots: three reads .g for roughness and .b for metalness.
      material.roughnessMap = orm
      material.metalnessMap = orm
      material.normalMap = normal
      material.normalScale = new THREE.Vector2(1, 1)
      return material
    }

    // The hull's side faces carry 0..1 UVs across 800 x 160 cm, so one tile per 200 cm of
    // length and one up the full height puts the seams and the belt rail where a carriage
    // actually has them, and keeps the dirt gradient running the right way down the body.
    const hullRepeatX = d.length / SKIN.tileCm
    const glowMap = bakeWindowGlow()
    // Three rolls, because a train that says one thing at one end is a prop. The flank
    // names the service, the cab announces it down the tunnel ahead of the car, and the
    // tail tells the platform it just left that nothing is coming back.
    // The copy is cut to the BOARD, not the other way round. bakeRollSign only ever
    // shrinks type to fit, so a 16:1 flank roll carrying a 7:1 phrase comes back as one
    // small word adrift in a long black box — which is what a dead sign looks like. The
    // flank gets a full service line; the cab boards are 5.6:1 and get one phrase each.
    const boardMap = bakeRollSign('SHOEMONEY EXPRESS · TERMINUS · DO NOT BOARD', null, {
      w: 2048,
      h: 128,
      pitch: 7,
    })
    const frontMap = bakeRollSign('SHOEMONEY EXPRESS', null, { w: 640, h: 115, pitch: 6 })
    const rearMap = bakeRollSign('NOT IN SERVICE', null, { w: 640, h: 115, pitch: 6 })
    const bandMap = bakeLiveryBand()
    const plateMap = bakeCabPlate()
    for (const tex of [glowMap, boardMap, frontMap, rearMap, bandMap, plateMap]) {
      if (tex) this.textures.push(tex)
    }

    /** One roll-sign material per board: same recipe, different art. */
    const rollSign = (map) =>
      new THREE.MeshStandardMaterial({
        color: map ? 0x0a0b0e : STATION.COLORS.signageHex,
        map: map ?? null,
        emissive: new THREE.Color(map ? 0xffffff : STATION.COLORS.signageHex),
        emissiveMap: map ?? null,
        emissiveIntensity: STATION.PROPS.hangingSign.emissiveIntensity,
        roughness: STATION.MATERIALS.signageRoughness,
        metalness: STATION.MATERIALS.signageMetalness,
      })

    // Glass is almost black in diffuse and everything you see in it is emitted. Leaving
    // the pane a white diffuse surface meant the wash lamps lit it as well as the lamp
    // inside it did, and it clipped flat at rgb(255,255,254) with the interior erased.
    const glass = new THREE.MeshStandardMaterial({
      color: 0x14110c,
      emissive: new THREE.Color(glowMap ? 0xffffff : TRAIN.windowEmissiveHex),
      emissiveMap: glowMap ?? null,
      emissiveIntensity: TRAIN.windowEmissiveIntensity * MODEL.windowEmissiveTrim,
      roughness: STATION.MATERIALS.railRoughness,
      metalness: 0,
    })

    return {
      hull: dress(
        new THREE.MeshStandardMaterial({
          color: STATION.COLORS.trainBodyHex,
          roughness: STATION.MATERIALS.furnitureRoughness,
          metalness: STATION.MATERIALS.furnitureMetalness,
        }),
        hullRepeatX,
        1,
      ),
      dark: dress(
        new THREE.MeshStandardMaterial({
          color: STATION.COLORS.tunnelPortalHex,
          roughness: STATION.MATERIALS.railRoughness,
          metalness: STATION.MATERIALS.railMetalness,
        }),
        2,
        2,
      ),
      roof: dress(
        new THREE.MeshStandardMaterial({
          color: MODEL.roofPaintHex,
          roughness: STATION.MATERIALS.concreteRoughness,
          metalness: STATION.MATERIALS.furnitureMetalness * 0.5,
        }),
        hullRepeatX,
        0.5,
      ),
      // The band no longer wears the hull skin: it wears its own painted wordmark, and a
      // repeat is set per panel in #buildFlanks so the letters keep one height across a
      // 96 cm door bay and a 6.5 m blind flank alike.
      accent: new THREE.MeshStandardMaterial({
        // White, because bakeLiveryBand paints the accent colour into the map itself —
        // see the note there. Without the band art the spec's flat accent is the fallback.
        color: bandMap ? 0xffffff : STATION.COLORS.trainAccentHex,
        map: bandMap ?? null,
        // Faintly self-lit, and not as a cheat. Operator livery is retroreflective film —
        // the whole reason it is specified is that it answers a headlight in a tunnel. A
        // purely diffuse band sits below the window line where nothing on this car throws
        // light, and the first render of it came back as a black stripe on a black flank:
        // the wordmark was there and unreadable, which is the same as not being there.
        emissive: new THREE.Color(bandMap ? 0xfff0e8 : 0x000000),
        emissiveMap: bandMap ?? null,
        // 0.26 was measured and it was not enough; neither was 0.45. The band sits at
        // Z 29..54 on a 160 cm car, and the window wash lamps stand 42 cm outboard at the
        // window HEAD, so what they throw goes out to the platform and grazes the lower
        // flank at nothing. At 0.45 the wordmark still did not appear anywhere on the
        // shipped frame — a livery nobody can read is the same as no livery, and the
        // livery is the only thing on this car that says whose train just pulled in. At
        // this level the film answers the station the way real retroreflective livery
        // does, and because the map is now the paint, the near-white letters glow about
        // five times harder than the dark red field they sit on.
        emissiveIntensity: 1.2,
        // Sharper than the station's signage default, because retroreflective film is not
        // a matte painted panel: it needs a specular lobe as well as a glow, or the band
        // is a flat glowing rectangle instead of a strip of varnish on a steel body.
        roughness: 0.22,
        metalness: STATION.MATERIALS.signageMetalness,
      }),
      /** The gold pinstripe above the band. No map: it is 3.5 cm tall. */
      pinstripe: new THREE.MeshStandardMaterial({
        color: 0xd8a516,
        roughness: 0.38,
        metalness: 0.55,
      }),
      plate: new THREE.MeshStandardMaterial({
        color: plateMap ? 0xffffff : STATION.COLORS.furnitureHex,
        map: plateMap ?? null,
        emissive: new THREE.Color(plateMap ? 0xffffff : 0x000000),
        emissiveMap: plateMap ?? null,
        // Barely lit: a number plate is painted steel that CATCHES light, not a display.
        emissiveIntensity: 0.14,
        roughness: STATION.MATERIALS.furnitureRoughness,
        metalness: STATION.MATERIALS.furnitureMetalness,
      }),
      glass,
      // The cab screen is not a lit saloon — nobody is driving this one. On the window
      // material it blew the nose to mean 221; on a dim emissive it read as a flat khaki
      // card. It is black glass, and what you see in it is the tunnel it came out of.
      cab: new THREE.MeshStandardMaterial({
        color: 0x0a0d12,
        emissive: new THREE.Color(TRAIN.windowEmissiveHex),
        emissiveIntensity: TRAIN.windowEmissiveIntensity * MODEL.cabGlassTrim,
        roughness: 0.07,
        metalness: 0.45,
      }),
      // A display is black glass with light behind it. Left at a white diffuse the wash
      // lamps lit the board to the same L=229 cream as the hull around it and the text
      // vanished into the flank.
      sign: rollSign(boardMap),
      signFront: rollSign(frontMap),
      signRear: rollSign(rearMap),
      headlight: new THREE.MeshBasicMaterial({ color: TRAIN.headlightColorHex }),
      tail: new THREE.MeshBasicMaterial({ color: STATION.COLORS.trainAccentHex }),
    }
  }

  #buildHull(mats, d) {
    const hull = new THREE.Mesh(new THREE.BoxGeometry(d.length, d.width, d.height), mats.hull)
    hull.position.set(0, 0, d.height / 2)
    hull.castShadow = true
    hull.receiveShadow = true
    this.body.add(hull)

    // A tapered crown reads as a roof rather than a lid, and catches the ceiling strips.
    const roofW = d.width * (1 - MODEL.roofInsetFraction)
    const roofH = d.height * MODEL.roofRiseFraction
    const roof = new THREE.Mesh(new THREE.BoxGeometry(d.length, roofW, roofH), mats.roof)
    roof.position.set(0, 0, d.height + roofH / 2)
    roof.castShadow = true
    this.body.add(roof)

    const hvac = new THREE.Mesh(
      new THREE.BoxGeometry(d.length * MODEL.hvacLengthFraction, roofW * MODEL.hvacWidthFraction, roofH),
      mats.dark,
    )
    hvac.position.set(0, 0, d.height + roofH * 1.5)
    hvac.castShadow = true
    this.body.add(hvac)

    // From the platform the roofline IS the train's silhouette — you stand below it and
    // read the car against the ceiling. An unbroken lid up there is half of why the body
    // came back as one uniform slab, so the ribs break it every 70 cm.
    const ribGeo = new THREE.BoxGeometry(
      d.length * MODEL.roofRibWidthFraction,
      roofW * 1.02,
      roofH * MODEL.roofRibRiseFraction,
    )
    for (let i = 0; i < MODEL.roofRibCount; i++) {
      const t = (i + 0.5) / MODEL.roofRibCount
      const rib = new THREE.Mesh(ribGeo, mats.dark)
      rib.position.set((t - 0.5) * d.length * (1 - MODEL.noseLengthFraction * 2), 0, d.height + roofH)
      rib.castShadow = true
      this.body.add(rib)
    }

    const skirtH = d.height * MODEL.skirtDropFraction
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(d.length, d.width, skirtH), mats.dark)
    skirt.position.set(0, 0, -skirtH / 2)
    this.body.add(skirt)

    // Cab caps at both ends, inset on every side so no face is coplanar with the hull, and
    // dark so the nose reads as a silhouette against the tunnel it comes out of.
    for (const sign of [1, -1]) {
      const nose = new THREE.Mesh(
        new THREE.BoxGeometry(
          d.noseL,
          d.width * MODEL.noseWidthFraction,
          d.height * MODEL.noseHeightFraction,
        ),
        mats.dark,
      )
      // Pushed one layer PROUD of the hull end. The note above promised an inset "on every
      // side", but X was never one of them: the cap sat flush at +/-halfL, sharing that
      // plane with the hull's own end face, and two coplanar faces on two materials are a
      // stipple of z-fighting on the exact surface the arrival shot is pointed at. Every
      // fitting on the cab now steps outward from this face.
      nose.position.set(sign * (d.halfL - d.noseL / 2 + d.layer), 0, d.height / 2)
      nose.castShadow = true
      this.body.add(nose)

      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(
          d.layer,
          d.width * MODEL.screenWidthFraction,
          d.height * MODEL.screenHeightFraction,
        ),
        mats.cab,
      )
      screen.position.set(
        sign * (d.halfL + d.layer * 1.5),
        0,
        d.height * MODEL.screenCentreFraction,
      )
      this.body.add(screen)

      // The cab roll sign. A destination that exists only on the flank is one the platform
      // reads AFTER the train has arrived; this one comes up the tunnel ahead of the car,
      // which is the moment it means anything.
      const endW = d.width * MODEL.endBoardWidthFraction
      const endH = d.height * MODEL.endBoardHeightFraction
      const endZ = d.height * MODEL.endBoardCentreFraction
      const endSurround = new THREE.Mesh(
        new THREE.BoxGeometry(
          d.layer,
          endW + MODEL.windowGasketMargin * 2,
          endH + MODEL.windowGasketMargin * 2,
        ),
        mats.dark,
      )
      endSurround.position.set(sign * (d.halfL + d.layer * 1.2), 0, endZ)
      this.body.add(endSurround)

      this.body.add(
        this.#facePlane(
          endW,
          endH,
          sign > 0 ? mats.signFront : mats.signRear,
          sign * (d.halfL + d.layer * 1.9),
          0,
          endZ,
          sign > 0 ? '+x' : '-x',
        ),
      )

      // Route bullet over a fleet number, under the windscreen: the badge that makes this a
      // numbered car out of a fleet rather than one anonymous box on a track.
      const plateSize = d.height * MODEL.cabPlateSizeFraction
      this.body.add(
        this.#facePlane(
          plateSize,
          plateSize,
          mats.plate,
          sign * (d.halfL + d.layer * 1.9),
          0,
          d.height * MODEL.cabPlateCentreFraction,
          sign > 0 ? '+x' : '-x',
        ),
      )

      // The same plate again, half size, low on both flanks — where a real car carries it,
      // under the livery band and clear of every window.
      for (const flank of [1, -1]) {
        this.body.add(
          this.#facePlane(
            plateSize * 0.54,
            plateSize * 0.54,
            mats.plate,
            sign * d.halfL * MODEL.cabPlateInsetFraction,
            flank * (d.halfW + d.layer * 0.5),
            d.height * 0.09,
            flank > 0 ? '+y' : '-y',
          ),
        )
      }
    }

    // The destination board rides above the doorways: the one genuinely bright thing on the
    // flank, and the cue that tells the player which side is about to open.
    const boardW = d.length * MODEL.boardLengthFraction
    const boardH = d.height * MODEL.boardHeightFraction
    const boardX = d.halfL * MODEL.boardOffsetFraction
    const boardZ = d.height * MODEL.boardCentreFraction
    const bezel = MODEL.windowGasketMargin

    const surround = new THREE.Mesh(
      new THREE.BoxGeometry(boardW + bezel * 2, d.layer, boardH + bezel * 2),
      mats.dark,
    )
    surround.position.set(boardX, d.halfW + d.layer * (MODEL.boardStandoffLayers - 0.5), boardZ)
    this.body.add(surround)

    this.body.add(
      this.#facePlane(
        boardW,
        boardH,
        mats.sign,
        boardX,
        d.halfW + d.layer * MODEL.boardStandoffLayers,
        boardZ,
        '+y',
      ),
    )
  }

  /**
   * A textured quad standing on one of the four cardinal faces of the carriage, with its
   * type the right way up and the right way round.
   *
   * Box UVs would be cheaper, but a BoxGeometry's six faces do not agree about which way is
   * up — which is why the flank roll sign has to bake itself mirrored — and a plate that
   * arrives upside down on one end of the car is the class of defect nobody notices until
   * it is in a screenshot. A plane's UVs are unambiguous, so the orientation lives here
   * once, as four cases, instead of being rediscovered per fitting.
   */
  #facePlane(width, height, material, x, y, z, face) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
    // Euler XYZ, so the matrix is Rx * Ry: Ry aims the plane's +Z normal at the face and
    // the fixed Rx(90) stands the plane upright in the spec's Z-up frame. Checked per face
    // against an observer's own right vector, cross(forward, up).
    if (face === '+x') mesh.rotation.set(Math.PI / 2, Math.PI / 2, 0)
    else if (face === '-x') mesh.rotation.set(Math.PI / 2, -Math.PI / 2, 0)
    else if (face === '+y') mesh.rotation.set(Math.PI / 2, Math.PI, 0)
    else mesh.rotation.set(Math.PI / 2, 0, 0)
    mesh.position.set(x, y, z)
    return mesh
  }

  /**
   * Segments of a flank that are not a doorway, clamped inside the cab caps. Returns pairs
   * of local X. With four doors 200 apart this yields the three panels between them.
   */
  #flankSpans(d) {
    const limit = d.halfL - d.noseL
    const spans = []
    let cursor = -limit
    for (const x of TRAIN.doorLocalXs) {
      if (x - d.leafW > cursor) spans.push([cursor, x - d.leafW])
      cursor = x + d.leafW
    }
    if (limit > cursor) spans.push([cursor, limit])
    return spans
  }

  #buildDoors(mats, d) {
    const doorH = d.height * MODEL.doorHeightFraction
    const doorZ = doorH / 2
    this.doorLeaves = []

    for (const x of TRAIN.doorLocalXs) {
      // A dark recess behind the leaves, so an open door is a hole rather than a seam. It
      // pokes 1 cm proud of the flank so its face never coplanar-fights the hull.
      const recess = new THREE.Mesh(
        new THREE.BoxGeometry(d.leafW * 2, d.layer * 2, doorH),
        mats.dark,
      )
      recess.position.set(x, d.halfW - d.layer / 2, doorZ)
      this.body.add(recess)

      for (const sign of [-1, 1]) {
        const leaf = new THREE.Group()
        leaf.position.set(x + sign * (d.leafW / 2), d.halfW + d.layer * 2, doorZ)

        const panel = new THREE.Mesh(new THREE.BoxGeometry(d.leafW, d.layer, doorH), mats.hull)
        leaf.add(panel)

        const portW = d.leafW * MODEL.doorPortWidthFraction
        const portZ = d.winZ - doorZ

        const portGasket = new THREE.Mesh(
          new THREE.BoxGeometry(
            portW + MODEL.windowGasketMargin * 2,
            d.layer / 2,
            d.winH + MODEL.windowGasketMargin * 2,
          ),
          mats.dark,
        )
        portGasket.position.set(0, d.layer * 0.45, portZ)
        leaf.add(portGasket)

        const port = new THREE.Mesh(
          new THREE.BoxGeometry(portW, d.layer * 0.4, d.winH),
          mats.glass,
        )
        port.position.set(0, d.layer * 0.75, portZ)
        leaf.add(port)

        leaf.userData.shutX = leaf.position.x
        leaf.userData.openX = leaf.position.x + sign * d.leafW * MODEL.doorSlideFraction
        this.body.add(leaf)
        this.doorLeaves.push(leaf)
      }
    }
  }

  /**
   * Windows and livery. The door side gets panels only between the doorways; the blind side
   * gets an unbroken ribbon, because a lit window strip running the full length is what
   * makes the car read as a train rather than as a shipping container.
   */
  #buildFlanks(mats, d) {
    const winH = d.winH
    const winZ = d.winZ
    const bandH = d.height * MODEL.liveryBandFraction
    const bandZ = d.height * MODEL.windowSillFraction - bandH
    const limit = d.halfL - d.noseL
    const gasket = MODEL.windowGasketMargin

    const gaps = this.#flankSpans(d)
    const doorSpans = TRAIN.doorLocalXs.map((x) => [x - d.leafW, x + d.leafW])

    const flanks = [
      { sign: 1, windows: gaps, band: gaps }, // doors live here
      { sign: -1, windows: [...gaps, ...doorSpans], band: [[-limit, limit]] },
    ]

    for (const flank of flanks) {
      const gasketY = flank.sign * (d.halfW + d.layer / 2)
      const paneY = flank.sign * (d.halfW + d.layer)
      for (const [x0, x1] of flank.windows) {
        const span = x1 - x0
        // Fixed pane width, centred, as long as the hull survives either side of it.
        const paneW = Math.min(MODEL.windowPaneWidth, span - MODEL.windowPaneMinMargin * 2)
        if (paneW <= 0) continue
        const cx = (x0 + x1) / 2

        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(paneW + gasket * 2, d.layer, winH + gasket * 2),
          mats.dark,
        )
        frame.position.set(cx, gasketY, winZ)
        this.body.add(frame)

        const pane = new THREE.Mesh(new THREE.BoxGeometry(paneW, d.layer * 0.6, winH), mats.glass)
        pane.position.set(cx, paneY, winZ)
        this.body.add(pane)
      }
      for (const [x0, x1] of flank.band) {
        const w = x1 - x0
        if (w <= 0) continue
        // The wordmark has to keep ONE height and ONE phase across panels of three
        // different widths, or the livery reads as three different stickers. Each panel
        // therefore gets its own clone of the map, repeated by its own length and offset by
        // where it sits on the car, so the paint runs continuously through the doorways.
        // A PLANE, for the same reason the roll sign is one: a BoxGeometry's +Y face lands
        // its texture rotated 180 degrees, so a wordmark painted on a box arrives upside
        // down AND mirrored. The pinstripe below can stay a box — it has no artwork on it
        // to get wrong.
        this.body.add(
          this.#facePlane(
            w,
            bandH,
            this.#bandMaterial(mats, w, x0, limit),
            (x0 + x1) / 2,
            gasketY,
            bandZ,
            flank.sign > 0 ? '+y' : '-y',
          ),
        )

        // A gold pinstripe riding the band. Two parallel lines of different weight is the
        // oldest trick in livery design and it costs one box per panel.
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(w, d.layer * 0.6, d.height * MODEL.liveryStripeFraction),
          mats.pinstripe,
        )
        stripe.position.set(
          (x0 + x1) / 2,
          gasketY,
          bandZ + bandH / 2 + d.height * (MODEL.liveryStripeGapFraction + MODEL.liveryStripeFraction / 2),
        )
        this.body.add(stripe)
      }
    }
  }

  /**
   * One livery panel's material. The texture is cloned per panel (the uploaded image is
   * shared, so this costs a sampler, not a texture) and the material with it, because
   * `repeat` and `offset` live on the texture and three panels of different widths need
   * three different ones.
   */
  #bandMaterial(mats, width, x0, limit) {
    if (!mats.accent.map) return mats.accent
    const map = mats.accent.map.clone()
    map.repeat.set(width / MODEL.liveryTileCm, 1)
    map.offset.set((x0 + limit) / MODEL.liveryTileCm, 0)
    map.needsUpdate = true
    this.textures.push(map)

    const material = mats.accent.clone()
    // BOTH slots, one texture. Re-pointing only `map` left the emissive sampling the
    // original at repeat 1, so the glow would have sat at a different scale and phase
    // from the paint it is supposed to be coming off — a wordmark with a second,
    // misaligned wordmark shining through it.
    material.map = map
    material.emissiveMap = map
    // No register needed: every clone is hung on a mesh under this.group, and disposeTree
    // walks that tree on the way out.
    return material
  }

  #buildRunningGear(mats, d) {
    this.wheels = []
    this.wheelRadius = BOGIE_CLEARANCE * MODEL.wheelRadiusFraction

    const wheelGeo = new THREE.CylinderGeometry(
      this.wheelRadius,
      this.wheelRadius,
      d.halfW * MODEL.wheelThicknessFraction,
      16,
    )

    for (let b = 0; b < MODEL.bogieCount; b++) {
      const bx = (b === 0 ? -1 : 1) * d.halfL * MODEL.bogieInsetFraction
      const truck = new THREE.Mesh(
        new THREE.BoxGeometry(
          d.halfL * MODEL.bogieLengthFraction,
          d.halfW * MODEL.bogieWidthFraction,
          BOGIE_CLEARANCE * MODEL.bogieHeightFraction,
        ),
        mats.dark,
      )
      truck.position.set(bx, 0, -BOGIE_CLEARANCE / 2)
      this.body.add(truck)

      for (const dx of [-1, 1]) {
        for (const dy of [-1, 1]) {
          const wheel = new THREE.Mesh(wheelGeo, mats.dark)
          // A cylinder's axis is its own local Y, and the axle runs across the car, which is
          // the spec's Y. Inside this Z-up frame that already lines up.
          wheel.position.set(
            bx + dx * d.halfL * MODEL.wheelSpanFraction,
            dy * d.halfW * MODEL.wheelTrackFraction,
            -BOGIE_CLEARANCE + this.wheelRadius,
          )
          this.body.add(wheel)
          this.wheels.push(wheel)
        }
      }
    }
  }

  #buildLights(mats, d) {
    const scale = FX.LIGHT_INTENSITY_SCALE
    const lampGeo = new THREE.CircleGeometry(MODEL.lampRadius, 20)
    const lampY = d.halfW * MODEL.lampInsetFraction
    const lampZ = d.height * MODEL.headlightHeightFraction

    this.headlights = []
    this.hazeCones = []

    for (const dy of [-1, 1]) {
      // CircleGeometry faces its own +Z; the nose faces the spec's +X.
      const disc = new THREE.Mesh(lampGeo, mats.headlight)
      disc.rotation.y = Math.PI / 2
      disc.position.set(d.halfL + d.layer * 2.6, dy * lampY, lampZ)
      this.body.add(disc)

      const spot = new THREE.SpotLight(
        TRAIN.headlightColorHex,
        TRAIN.headlightIntensity * scale,
        TRAIN.headlightAttenuationRadius,
        MODEL.headlightAngleRad,
        MODEL.headlightPenumbra,
        2,
      )
      // Ahead of the cab glass, or the screen sits at the apex of a 640k-candela cone.
      spot.position.set(d.halfL + d.layer * 3, dy * lampY, lampZ)
      // The target has to be a child too, or it stays in world space and the beam swings
      // wildly as the car travels.
      spot.target.position.set(d.halfL + TRAIN.headlightAttenuationRadius, dy * lampY, 0)
      this.body.add(spot)
      this.body.add(spot.target)
      this.headlights.push(spot)

      // Segmented down its length so applyHazeFalloff has vertices to ramp between; one
      // height segment could only carry a linear fade and the shaft needs a curve.
      const coneGeo = new THREE.ConeGeometry(
        Math.tan(MODEL.headlightAngleRad * MODEL.hazeConeAngleFraction) * MODEL.hazeConeLength,
        MODEL.hazeConeLength,
        24,
        16,
        true,
      )
      applyHazeFalloff(coneGeo, MODEL.hazeConeLength)
      const coneMaterial = new THREE.MeshBasicNodeMaterial({
        color: TRAIN.headlightColorHex,
        transparent: true,
        // Parked is the state the arrival frame is actually captured in, so the shaft
        // starts there rather than fading up from nothing and missing an early capture.
        opacity: MODEL.hazeConeOpacity * MODEL.hazeIdleFraction,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
        // Scene fog MIXES toward the fog colour, and on an additive surface that means
        // the far end of the shaft gets brighter the deeper into the haze it goes —
        // exactly backwards. The vertex ramp above is doing this job properly.
        fog: false,
      })
      coneMaterial.colorNode = attribute('color', 'vec3')
        .mul(pow(abs(dot(normalView, positionViewDirection)), 1.35))
        .mul(smoothstep(90, 560, positionView.z.negate()))
      const cone = new THREE.Mesh(coneGeo, coneMaterial)
      // Rotating +90 about Z sends the cone's +Y apex to -X, so pushing the cone forward by
      // half its length leaves the apex sitting exactly on the lamp. Stands in for a
      // volumetric shaft, which is what sells the approach through the tunnel haze.
      cone.rotation.z = Math.PI / 2
      cone.position.set(d.halfL + MODEL.hazeConeLength / 2, dy * lampY, lampZ)
      this.body.add(cone)
      this.hazeCones.push(cone)

      const tail = new THREE.Mesh(lampGeo, mats.tail)
      tail.rotation.y = -Math.PI / 2
      tail.position.set(-d.halfL - d.layer * 2.6, dy * lampY, lampZ)
      this.body.add(tail)
    }

    // Interior fill, pitched at the station's own head-height fill level so the carriage
    // does not read brighter than the room it is standing in.
    this.interiorLight = new THREE.PointLight(
      TRAIN.windowEmissiveHex,
      STATION.LIGHTING.ambientFill.intensity * scale,
      d.length,
      2,
    )
    this.interiorLight.position.set(0, 0, d.height * MODEL.interiorHeightFraction)
    this.body.add(this.interiorLight)

    // Spill out of the doorway side, ramped by doorPhase, so an open door throws a slab of
    // light onto the platform. This is what makes the unload read from the player's side.
    this.doorSpill = new THREE.PointLight(
      TRAIN.windowEmissiveHex,
      0,
      TRAIN.doorLateralOffset * MODEL.doorSpillReachFactor,
      2,
    )
    this.doorSpill.position.set(0, d.halfW, d.height * MODEL.doorSpillHeightFraction)
    this.body.add(this.doorSpill)

    // The window wash. A wall of lit glass that puts nothing on the floor is the loudest
    // possible tell that a scene is faked: the platform under the row measured DARKER than
    // the platform 250 cm away from it. These are always on, independent of doorPhase,
    // one per 100 cm bay on the door side so the slab picks up per-window banding, and a
    // sparser run on the blind flank because all it has to paint is the tunnel wall.
    const washIntensity =
      STATION.LIGHTING.ambientFill.intensity * scale * MODEL.windowWashIntensityFraction
    const reach = d.halfL - d.noseL
    this.windowWash = []
    for (const [flankSign, spacing] of [
      [1, MODEL.windowWashSpacing],
      [-1, MODEL.windowWashBlindSpacing],
    ]) {
      const bays = Math.floor(reach / spacing)
      for (let i = -bays; i <= bays; i++) {
        const wash = new THREE.PointLight(
          TRAIN.windowEmissiveHex,
          washIntensity,
          MODEL.windowWashDistance,
          2,
        )
        wash.castShadow = false
        wash.position.set(
          i * spacing,
          flankSign * (d.halfW + MODEL.windowWashStandoff),
          d.winZ + d.winH * MODEL.windowWashLiftFraction,
        )
        this.body.add(wash)
        this.windowWash.push(wash)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------

  /** Teleport to staging with the doors shut. The original did this on BeginPlay. */
  reset() {
    this.position.copy(this.staging)
    this.from.copy(this.staging)
    this.to.copy(this.staging)
    this.state = TRAIN_STATE.idle
    this.elapsed = 0
    this.speed = 0
    this.travelled = 0
    this.doorPhase = 0
    this.doorTarget = 0
    for (const leaf of this.doorLeaves) leaf.position.x = leaf.userData.shutX
    this.#applyTransform()
  }

  arrive() {
    this.from.copy(this.position)
    this.to.copy(this.stop)
    this.duration = TRAIN.arrivalTime
    this.elapsed = 0
    this.state = TRAIN_STATE.arriving
    this.doorTarget = 0

    if (this.emitEvents) {
      bus.emit(EV.TRAIN_INBOUND, {
        cue: AUDIO.TRAIN.arrivingCue,
        volume: AUDIO.TRAIN.arrivingVolume,
        // §3.3: the one-shot plays at the train's position the instant Arrive is called,
        // which is the staging point, not the dock.
        position: this.position.toArray(),
        seconds: this.duration,
      })
    }
  }

  depart() {
    this.from.copy(this.position)
    this.to.copy(this.staging)
    this.duration = TRAIN.departTime
    this.elapsed = 0
    this.state = TRAIN_STATE.departing
    this.doorTarget = 0
  }

  get isMoving() {
    return this.state !== TRAIN_STATE.idle
  }

  get doorsOpen() {
    return this.doorPhase >= 1
  }

  update(dt) {
    if (!(dt > 0)) return
    this.clock += dt

    this.#updateMotion(dt)
    this.#updateDoors(dt)
    this.#updateLights(dt)
    this.#applyTransform()
  }

  #updateMotion(dt) {
    if (this.state === TRAIN_STATE.idle) {
      this.speed *= Math.max(0, 1 - dt * MODEL.idleSpeedDecay)
      return
    }

    SCRATCH.copy(this.position)
    this.elapsed += dt
    const t = Math.min(1, Math.max(0, this.elapsed / this.duration))
    this.position.lerpVectors(this.from, this.to, ease(t))

    const step = this.position.distanceTo(SCRATCH)
    this.travelled += step
    this.speed = step / dt

    if (t < 1) return

    const finished = this.state
    this.state = TRAIN_STATE.idle
    this.speed = 0

    if (finished === TRAIN_STATE.departing) {
      this.onDeparted?.(this)
      return
    }

    this.doorTarget = 1
    this.onArrived?.(this)
    if (this.emitEvents) {
      bus.emit(EV.TRAIN_DOORS, {
        cue: AUDIO.TRAIN.doorsOpenCue,
        seconds: TRAIN.doorOpenSeconds,
        doors: this.doorWorldPositions().map((v) => v.toArray()),
      })
    }
  }

  #updateDoors(dt) {
    if (this.doorPhase === this.doorTarget) return
    const rate = dt / TRAIN.doorOpenSeconds
    this.doorPhase =
      this.doorTarget > this.doorPhase
        ? Math.min(this.doorTarget, this.doorPhase + rate)
        : Math.max(this.doorTarget, this.doorPhase - rate)

    // Eased so the leaves settle into the jamb instead of stopping dead against it.
    const s = ease(this.doorPhase)
    for (const leaf of this.doorLeaves) {
      leaf.position.x = leaf.userData.shutX + (leaf.userData.openX - leaf.userData.shutX) * s
    }
  }

  #updateLights(dt) {
    const moving = this.isMoving
    const approaching = this.state === TRAIN_STATE.arriving

    // The haze shaft only earns its fill cost while the car is running at you.
    const targetHaze = MODEL.hazeConeOpacity * (moving ? 1 : MODEL.hazeIdleFraction)
    for (const cone of this.hazeCones) {
      cone.material.opacity += (targetHaze - cone.material.opacity) * Math.min(1, dt * MODEL.hazeResponse)
    }

    // Tied to distance travelled rather than to the clock, so it reads as the car rocking
    // on its springs and settles when the car does.
    const flicker = approaching
      ? 1 + MODEL.headlightFlickerDepth * Math.sin(this.travelled * MODEL.headlightFlickerRate)
      : 1
    for (const spot of this.headlights) {
      spot.intensity = TRAIN.headlightIntensity * FX.LIGHT_INTENSITY_SCALE * flicker
    }

    this.doorSpill.intensity =
      STATION.LIGHTING.ambientFill.intensity * FX.LIGHT_INTENSITY_SCALE * this.doorPhase

    if (this.speed > 0) {
      const spin = (this.speed * dt) / this.wheelRadius
      for (const wheel of this.wheels) wheel.rotation.y += spin
    }

    // Body roll follows the ease's own acceleration, so it pitches into the run and heaves
    // back on the brake. cos(PI*t) is positive on the accelerating half and negative on the
    // decelerating half, which is exactly the sign change a braking carriage makes.
    const t = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1
    const accel = moving ? Math.cos(Math.PI * t) : 0
    const shudder = moving
      ? Math.sin(this.clock * Math.PI * 2 * MODEL.brakeShudderHz) * MODEL.brakeShudderDepth
      : 0
    const targetRoll = (accel + shudder) * MODEL.brakeRollDeg * DEG
    this.body.rotation.x += (targetRoll - this.body.rotation.x) * Math.min(1, dt * MODEL.rollResponse)
  }

  #applyTransform() {
    this.group.position.copy(toThree(this.position.x, this.position.y, this.position.z))
  }

  // -------------------------------------------------------------------------
  // Door points — what the wave director consumes
  // -------------------------------------------------------------------------

  /** The four door points in the spec's Z-up frame, already in world coordinates. */
  doorSpecPositions() {
    const yaw = this.yawDeg * DEG
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const dy = TRAIN.doorLateralOffset
    return TRAIN.doorLocalXs.map(
      (dx) =>
        new THREE.Vector3(
          this.position.x + dx * cos - dy * sin,
          this.position.y + dx * sin + dy * cos,
          this.position.z + TRAIN.doorLocalZ,
        ),
    )
  }

  /** The same four points in three's Y-up world frame. */
  doorWorldPositions() {
    return this.doorSpecPositions().map((p) => toThree(p.x, p.y, p.z))
  }

  /**
   * One spawn placement, §3.4: uniform door choice, then an independent uniform jitter on
   * X and on Y of +/- spawnScatterRadius. Z is deliberately untouched, and the spawn is
   * never cancelled for being occupied.
   *
   * Returns both frames, because the simulation and the renderer disagree about which axis
   * is up and silently handing back the wrong one is the kind of bug that passes every test
   * and puts a zombie inside a wall.
   */
  doorSpawnPoint(rng = defaultRng) {
    const doors = this.doorSpecPositions()
    const index = Math.min(doors.length - 1, Math.floor(rng.next() * doors.length))
    const door = doors[index]
    const r = WAVES.spawnScatterRadius
    const spec = new THREE.Vector3(door.x + rng.range(-r, r), door.y + rng.range(-r, r), door.z)
    return {
      doorIndex: index,
      spec,
      position: toThree(spec.x, spec.y, spec.z),
      yawDeg: this.yawDeg,
    }
  }

  dispose() {
    this.branding?.dispose()
    this.branding = null
    this.scene.remove(this.group)
    disposeTree(this.group)
    // material.dispose() does not release the textures hanging off it, and the skin bake
    // is the most expensive thing this module owns.
    for (const tex of this.textures ?? []) tex.dispose()
    this.textures = []
  }
}


// ---------------------------------------------------------------------------
// Platform branding
//
// Six thousand centimetres of blank tile on both sides of the room is what makes a
// subway read as a corridor with a texture on it rather than as a station. Real
// stations are papered: ad panels between every pair of pilasters, wayfinding above
// them, the line diagram, the name on the wall, MIND THE GAP scrubbed into the paint at
// the platform edge. That signage is also the only warm rectangle at eye level down
// there, which is why its absence reads as flat lighting even when the lighting is fine.
//
// This lives in train.js, and it should not. It belongs beside the rest of the station
// geometry in station.js, which another agent owns this round — the same reason the
// carriage skin above is baked here instead of in materials.js. The textures ARE in
// materials.js (createBrandingTextures), so folding the geometry across later is a move
// of one function, not a rewrite. Everything below is authored in the spec's Z-up frame
// and hung under one group that applies the same (x, y, z) -> (x, z, -y) remap the
// carriage uses.
// ---------------------------------------------------------------------------

const BRAND = Object.freeze({
  /** Ad panels: centred in the 500 cm bay between each pair of pilasters. */
  adCentreZ: 150.0,
  adDepth: 16.0, // cm the light box stands proud of the wall face
  adBezel: 15.0, // cm of housing showing around the poster on every side
  adHaloGrow: 2.15, // of panel size; how far the fake pool of light spreads on the tile

  /** Wayfinding strips, in the band between the ad panels and the ceiling. */
  stripCentreZ: 322.0,
  stripDepth: 8.0,
  stripBezel: 7.0,
  stripHaloGrow: 1.75,

  /** MIND THE GAP, scrubbed into the platform inboard of the safety stripe. */
  stencilY: 612.0,
  stencilZ: 3.4, // cm above the slab: clear of the 3 cm safety stripe, no depth fight
  stencilWidth: 430.0,
  stencilHeight: 69.4, // 6.2:1, the aspect of the atlas cell
  stencilFirstX: 850.0,
  stencilSpacing: 1100.0,
  stencilCount: 5,

  /** Enamel name plates on the pilaster faces, which stand 30 cm proud of the wall. */
  plateWidth: 84.0,
  plateHeight: 40.6, // 2.067:1, the aspect of the atlas cell
  plateZ: 205.0,
  plateStandoff: 1.5,

  /** Hanging exit signs over the stairwell and over the turnstiles. */
  exitWidth: 220.0,
  exitHeight: 108.3, // 2.032:1, the aspect of the atlas cell
  exitZ: 318.0,
  exitXs: Object.freeze([300.0, 5600.0]),
  hangerRadius: 3.0,
  hangerInset: 70.0,

  /**
   * Six real lamps, not sixteen. The halo quads sell the pool of light on the tile for
   * free; these put actual photons on the wall between the panels so the brightness is
   * in the shading and not only in the texture. Every one is short-range and dim — the
   * station's own 28 lights still do the work.
   */
  lampBays: Object.freeze([1, 4, 7]),
  lampStandoff: 95.0,
  lampIntensityFraction: 0.34, // of the station's head-height fill
  lampDistance: 660.0,
  lampColorHex: 0xffd9a0,
})

/** Accumulates loose quads into one indexed buffer. `right` and `up` are HALF vectors. */
class QuadSoup {
  constructor() {
    this.position = []
    this.normal = []
    this.uv = []
    this.index = []
    this.vertices = 0
  }

  quad(c, right, up, rect) {
    const nx = right[1] * up[2] - right[2] * up[1]
    const ny = right[2] * up[0] - right[0] * up[2]
    const nz = right[0] * up[1] - right[1] * up[0]
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1)

    // Wound bottom-left, bottom-right, top-right, top-left, so the UV rect maps without
    // a second convention to remember.
    const corners = [
      [-1, -1], [1, -1], [1, 1], [-1, 1],
    ]
    const uvs = [
      [rect.u0, rect.v0], [rect.u1, rect.v0], [rect.u1, rect.v1], [rect.u0, rect.v1],
    ]
    for (let k = 0; k < 4; k++) {
      const [sr, su] = corners[k]
      this.position.push(
        c[0] + right[0] * sr + up[0] * su,
        c[1] + right[1] * sr + up[1] * su,
        c[2] + right[2] * sr + up[2] * su,
      )
      this.normal.push(nx * inv, ny * inv, nz * inv)
      this.uv.push(uvs[k][0], uvs[k][1])
    }
    const b = this.vertices
    this.index.push(b, b + 1, b + 2, b, b + 2, b + 3)
    this.vertices += 4
  }

  /**
   * The five faces of a wall-mounted light box that anyone can see: the front and the four
   * returns. The sixth is against the tile.
   *
   * `side` is +1 for the north wall and -1 for the south, and `wallY` the inner face both
   * of them are mounted on.
   */
  housing(cx, cz, wallY, side, halfW, halfH, depth, rect) {
    const frontY = side * (wallY - depth)
    const midY = side * (wallY - depth / 2)
    const halfD = depth / 2
    // Front. The right vector is signed by the wall so the normal always points inboard.
    this.quad([cx, frontY, cz], [side * halfW, 0, 0], [0, 0, halfH], rect)
    this.quad([cx, midY, cz + halfH], [halfW, 0, 0], [0, halfD, 0], rect)
    this.quad([cx, midY, cz - halfH], [halfW, 0, 0], [0, -halfD, 0], rect)
    this.quad([cx + halfW, midY, cz], [0, halfD, 0], [0, 0, halfH], rect)
    this.quad([cx - halfW, midY, cz], [0, -halfD, 0], [0, 0, halfH], rect)
  }

  build() {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    geometry.setIndex(this.index)
    geometry.computeBoundingSphere()
    return geometry
  }
}

const FULL_RECT = Object.freeze({ u0: 0, v0: 0, u1: 1, v1: 1 })

/**
 * Build the platform's advertising, wayfinding and floor markings into `scene`.
 *
 * Everything shares four atlased materials, so sixteen ad panels, sixteen wayfinding
 * plates, eighteen enamel name plates, ten platform stencils and four hanging exit signs
 * come to five draw calls between them.
 *
 * @returns {{ group: THREE.Group, dispose: () => void }}
 */
export function createPlatformBranding(scene) {
  const branding = createBrandingTextures()
  if (!branding.ads || !branding.signs) {
    // materials.js has already said why. Building the housings without any artwork to hang
    // in them would put sixteen black slabs on the wall, which is worse than blank tile.
    return { group: null, dispose() { branding.dispose() } }
  }
  const DIM = STATION.DIMENSIONS
  const LEVELS = STATION.LEVELS

  const group = new THREE.Group()
  group.name = 'platform-branding'
  const frame = new THREE.Group()
  frame.name = 'platform-branding:frame'
  frame.rotation.x = -Math.PI / 2 // (x, y, z)_spec -> (x, z, -y)_three, as above
  group.add(frame)

  // The bays: one between each adjacent pair of pilasters, which is where a real station
  // hangs its advertising because the pilasters are the frame.
  const bays = []
  for (let i = 0; i < STATION.COUNTS.pilastersPerWall - 1; i++) {
    bays.push(DIM.columnMargin + (i + 0.5) * DIM.columnSpacing)
  }

  const wallY = LEVELS.wallInnerY
  const posters = new QuadSoup()
  const lit = new QuadSoup()
  const paint = new QuadSoup()
  const housings = new QuadSoup()
  const halos = new QuadSoup()

  const adHalfW = AD_PANEL.width / 2
  const adHalfH = AD_PANEL.height / 2
  const stripHalfW = SIGN_STRIP.width / 2
  const stripHalfH = SIGN_STRIP.height / 2

  /**
   * The existing backlit board and logo panel occupy the north wall at station centre from
   * Z 270 up. A wayfinding strip in that bay would be inside them, so that one is skipped
   * — the ad below it clears both by 20 cm and stays.
   */
  const boardBayX = STATION.PROPS.wallBoard.centre[0]
  const boardHalfLength = STATION.PROPS.wallBoard.halfExtent[0] + DIM.columnSpacing * 0.3

  for (const side of [1, -1]) {
    bays.forEach((cx, i) => {
      // Different poster on the two walls at the same X, so one glance never catches the
      // same bill twice.
      const adIndex = side > 0 ? i % branding.ads.cells.length : (i + 5) % branding.ads.cells.length
      const stripIndex = side > 0 ? (i * 3) % branding.signs.strips.length : (i * 5 + 2) % branding.signs.strips.length

      housings.housing(cx, BRAND.adCentreZ, wallY, side, adHalfW + BRAND.adBezel, adHalfH + BRAND.adBezel, BRAND.adDepth, FULL_RECT)
      const adY = side * (wallY - BRAND.adDepth - 0.6)
      posters.quad([cx, adY, BRAND.adCentreZ], [side * adHalfW, 0, 0], [0, 0, adHalfH], branding.ads.cells[adIndex])
      halos.quad(
        [cx, side * (wallY - 1.2), BRAND.adCentreZ],
        [side * adHalfW * BRAND.adHaloGrow, 0, 0],
        [0, 0, adHalfH * BRAND.adHaloGrow],
        FULL_RECT,
      )

      const nearBoard = side > 0 && Math.abs(cx - boardBayX) < boardHalfLength
      if (nearBoard) return

      housings.housing(cx, BRAND.stripCentreZ, wallY, side, stripHalfW + BRAND.stripBezel, stripHalfH + BRAND.stripBezel, BRAND.stripDepth, FULL_RECT)
      lit.quad(
        [cx, side * (wallY - BRAND.stripDepth - 0.6), BRAND.stripCentreZ],
        [side * stripHalfW, 0, 0],
        [0, 0, stripHalfH],
        branding.signs.strips[stripIndex],
      )
      halos.quad(
        [cx, side * (wallY - 1.2), BRAND.stripCentreZ],
        [side * stripHalfW * BRAND.stripHaloGrow, 0, 0],
        [0, 0, stripHalfH * BRAND.stripHaloGrow],
        FULL_RECT,
      )
    })

    // Enamel name plates on the pilasters. They are the smallest type in the station and
    // the whole point of them is that you cannot read them from where you are standing.
    const pilasterFaceY = side * (LEVELS.wallInnerY - DIM.pilasterExtraDepth - BRAND.plateStandoff)
    for (let i = 0; i < STATION.COUNTS.pilastersPerWall; i++) {
      const x = DIM.columnMargin + i * DIM.columnSpacing
      paint.quad(
        [x, pilasterFaceY, BRAND.plateZ],
        [side * BRAND.plateWidth / 2, 0, 0],
        [0, 0, BRAND.plateHeight / 2],
        branding.signs.tablet,
      )
    }

    // MIND THE GAP, laid flat inboard of the safety stripe on both platform edges. `up` on
    // the floor is the direction a reader standing on the platform is facing.
    const edgeY = side * BRAND.stencilY
    for (let i = 0; i < BRAND.stencilCount; i++) {
      const x = BRAND.stencilFirstX + i * BRAND.stencilSpacing
      paint.quad(
        [x, edgeY, BRAND.stencilZ],
        [side * BRAND.stencilWidth / 2, 0, 0],
        [0, side * BRAND.stencilHeight / 2, 0],
        branding.signs.gap,
      )
    }
  }

  // Hanging exit signs at both ends of the hall: one face pointing back down the platform,
  // one pointing at the way out. They are the only lit thing above head height that is not
  // a lamp, so they carry the eye to the vanishing point in every shot down the length.
  const exitHalfW = BRAND.exitWidth / 2
  const exitHalfH = BRAND.exitHeight / 2
  BRAND.exitXs.forEach((x, i) => {
    const toward = i === 0 ? -1 : 1 // which end of the station this sign belongs to
    for (const face of [1, -1]) {
      // WAY OUT faces back down the platform, TO TRAINS faces the stairs and the gates.
      const rect = branding.signs.exits[face !== toward ? 0 : 1]
      lit.quad(
        [x + face * 3.2, 0, BRAND.exitZ],
        [0, face * exitHalfW, 0],
        [0, 0, exitHalfH],
        rect,
      )
    }
    // The box between the two faces, and the drop rods holding it off the ceiling.
    housings.quad([x, 0, BRAND.exitZ + exitHalfH], [3.2, 0, 0], [0, exitHalfW, 0], FULL_RECT)
    housings.quad([x, 0, BRAND.exitZ - exitHalfH], [3.2, 0, 0], [0, -exitHalfW, 0], FULL_RECT)
    // Drop rods. Every camera in this game looks ALONG the platform, so a rod modelled as
    // a quad in the X plane is edge-on in every shot and may as well not exist; these face
    // +/-X, which is where the lens is.
    const rodZ = (BRAND.exitZ + exitHalfH + LEVELS.wallTopZ) / 2
    const rodHalfH = (LEVELS.wallTopZ - BRAND.exitZ - exitHalfH) / 2
    for (const dy of [-1, 1]) {
      for (const outward of [1, -1]) {
        housings.quad(
          [x, dy * (exitHalfW - BRAND.hangerInset), rodZ],
          [0, outward * BRAND.hangerRadius, 0],
          [0, 0, rodHalfH],
          FULL_RECT,
        )
      }
    }
  })

  const adsMap = branding.ads?.texture ?? null
  const signMap = branding.signs?.texture ?? null

  const posterMaterial = new THREE.MeshStandardMaterial({
    color: adsMap ? 0xffffff : STATION.COLORS.signageHex,
    map: adsMap,
    emissive: new THREE.Color(adsMap ? 0xffffff : STATION.COLORS.signageHex),
    emissiveMap: adsMap,
    // A backlit diorama is the brightest surface on the wall by a wide margin; that is the
    // whole reason it gives the tile a rhythm instead of an even wash.
    emissiveIntensity: 1.55,
    roughness: 0.34,
    metalness: 0.0,
  })

  // One texture, two materials. The wall signage is lit from behind; the platform stencils
  // and the enamel plates are paint, and paint only CATCHES light. alphaTest rather than
  // transparency, so MIND THE GAP is worn paint on concrete instead of a black rectangle
  // lying on the slab, and the whole set still sorts in the opaque pass.
  const litMaterial = new THREE.MeshStandardMaterial({
    color: signMap ? 0xffffff : STATION.COLORS.signageHex,
    map: signMap,
    emissive: new THREE.Color(signMap ? 0xffffff : STATION.COLORS.signageHex),
    emissiveMap: signMap,
    emissiveIntensity: 1.25,
    roughness: 0.38,
    metalness: 0.05,
    // Low: the atlas is mipped, and a boundary that bleeds a neighbouring cell's alpha
    // across at distance will nibble the edge off whatever sits next to it.
    alphaTest: 0.3,
  })
  const paintMaterial = new THREE.MeshStandardMaterial({
    color: signMap ? 0xffffff : STATION.COLORS.safetyStripeHex,
    map: signMap,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: signMap,
    emissiveIntensity: 0.16,
    roughness: 0.62,
    metalness: 0.05,
    alphaTest: 0.3,
  })
  const housingMaterial = new THREE.MeshStandardMaterial({
    color: 0x191c21,
    roughness: 0.5,
    metalness: 0.62,
  })
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: branding.halo,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Fogged, so a panel eight bays away sinks into the haze with the wall it is bolted to
    // instead of burning through it.
    fog: true,
    toneMapped: true,
    opacity: 0.55,
  })

  const geometries = []
  const plan = [
    { soup: housings, material: housingMaterial, name: 'branding-housings', receive: true },
    { soup: posters, material: posterMaterial, name: 'branding-posters', receive: true },
    { soup: lit, material: litMaterial, name: 'branding-signs', receive: true },
    { soup: paint, material: paintMaterial, name: 'branding-paint', receive: true },
    { soup: halos, material: haloMaterial, name: 'branding-halos', render: 2 },
  ]
  for (const entry of plan) {
    if (entry.soup.vertices === 0) continue
    const geometry = entry.soup.build()
    geometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, entry.material)
    mesh.name = entry.name
    mesh.castShadow = false
    mesh.receiveShadow = Boolean(entry.receive)
    if (entry.render) mesh.renderOrder = entry.render
    frame.add(mesh)
  }

  // Real lamps in three of the eight bays per wall. See BRAND.lampBays.
  const lamps = []
  const lampIntensity =
    STATION.LIGHTING.ambientFill.intensity * FX.LIGHT_INTENSITY_SCALE * BRAND.lampIntensityFraction
  for (const side of [1, -1]) {
    for (const bay of BRAND.lampBays) {
      const lamp = new THREE.PointLight(BRAND.lampColorHex, lampIntensity, BRAND.lampDistance, 2)
      lamp.castShadow = false
      lamp.position.set(bays[bay], side * (wallY - BRAND.lampStandoff), BRAND.adCentreZ)
      frame.add(lamp)
      lamps.push(lamp)
    }
  }

  scene.add(group)

  const materials = plan.map((entry) => entry.material)
  console.info(
    `[branding] ${posters.vertices / 4} ad panels, ${lit.vertices / 4} lit signs, ` +
      `${paint.vertices / 4} painted markings, ${lamps.length} lamps, ${geometries.length} draw calls`,
  )

  return {
    group,
    dispose() {
      scene.remove(group)
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      branding.dispose()
    },
  }
}

/**
 * @param {THREE.Scene} scene
 * @param {object} [options] see the Train constructor
 * @returns {Train} parked at its staging point with the doors shut
 */
export function createTrain(scene, options = {}) {
  const train = new Train(scene, options)
  train.reset()
  // The platform dressing is built here rather than in the Train constructor so it is
  // obvious it is not part of the carriage — it is the station, temporarily lodging with
  // the module that owns the brand. See the note above createPlatformBranding.
  train.branding = createPlatformBranding(scene)
  return train
}
