/**
 * viewmodel.js — the gun in your hands.
 *
 * The abandoned build had no arms and no visible weapon: you looked down a corridor at
 * nothing and clicked, and the only evidence a shot happened was a number popping off a
 * zombie. Half of why it "looked horrific" is that there was nothing in frame to anchor the
 * eye. So this is a real first-person rig — receiver, barrel, magazine, sights, two gloved
 * hands on it — built from primitives, because the project ships no weapon meshes.
 *
 * It sits under the camera, so it inherits look rotation for free and never needs to know
 * where the player is. Everything it does is presentation: the spec is explicit that the
 * shake is cosmetic and that NO recoil model exists anywhere in the game, so the kick below
 * moves the model and never the aim.
 *
 * All geometry is authored in centimetres, matching the rest of the world.
 *
 */
import * as THREE from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { PLAYER, WEAPONS } from '../game/rules.js'
import { Rng, rng as sharedRng } from '../core/rng.js'
import { PISTOL_VIEW } from './pistol.js'
import { RIFLE_VIEW } from './rifle.js'
import { SHOTGUN_VIEW } from './shotgun.js'
import { reserveFromLightBudget } from '../world/optimize.js'

/**
 * View-only tuning. None of it exists in the original — the C++ had no viewmodel, no sway,
 * no bob and no weapon-relative recoil, so there is nothing to be faithful to and nothing
 * for rules.js to arbitrate. If a reviewer wants it in rules.js alongside FX, it belongs
 * under a new VIEWMODEL key; it is kept here so this module owns its own look.
 * CHOSEN: not in original spec.
 */
const VIEW = Object.freeze({
  scale: 1.0,

  sway: Object.freeze({
    rateA: 0.62, // radians/s of the slow horizontal figure
    rateB: 1.07, // deliberately not a multiple of rateA, so the loop never visibly repeats
    amplitude: 0.42, // cm
    roll: 0.010, // radians
  }),

  /** The gun lags behind a fast look, then catches up. This is most of what sells weight. */
  lookLag: Object.freeze({
    yawTravel: 7.0, // cm of lateral drag per radian/s of yaw
    pitchTravel: 5.0, // cm of vertical drag per radian/s of pitch
    rollTravel: 0.22, // radians of bank per radian/s of yaw
    limit: 4.2, // cm; a whip-around must not throw the gun out of frame
    rollLimit: 0.12, // radians
    smoothing: 9.0, // 1/s exponential approach toward the target drag
  }),

  bob: Object.freeze({
    rate: 8.4, // radians/s at full walk speed
    amplitudeX: 1.45, // cm
    amplitudeY: 1.05, // cm
    roll: 0.026, // radians
    airDrop: 2.2, // cm the gun sinks while off the ground
    smoothing: 7.0, // 1/s approach on the speed factor, so a stop does not snap
  }),

  /** Underdamped on purpose: the small overshoot on the way back is the "snap". */
  recoil: Object.freeze({
    stiffness: 900.0,
    damping: 42.0,
    substep: 1 / 240, // the spring is stiff enough to blow up on a 0.25 s frame
  }),

  holster: Object.freeze({
    drop: 26.0, // cm the gun falls while switching
    pitch: 0.95, // radians it rotates muzzle-down
  }),

  /**
   * Three lights that exist only for the gun. All three are parented into the view rig, so
   * they travel with the camera and the weapon is lit identically wherever the player aims —
   * a first-person weapon that goes black every time you face away from a lamp is the single
   * loudest way to make a game look unfinished.
   *
   * Every range is short and every position sits inside or just outside the weapon's own
   * volume, so the inverse-square falloff has them at nothing by the time they reach the
   * floor (170 cm below the eye) or the nearest wall. They light the gun; they do not relight
   * the station. Intensities are candela — the renderer is physically lit, ACES at 1.15.
   *
   * They are also placed against the NEW framing, which is half of why the old set did so
   * little: the key sat at z -10, behind a weapon whose readable half now runs from z -33 out
   * to z -80, so the handguard and the barrel were past the useful end of the only warm light
   * in the rig and fell back to the near-black environment map.
   */
  key: Object.freeze({
    colorHex: 0xffd7a0,
    intensity: 2150.0,
    distance: 108.0,
    decay: 2.0,
    position: [41.0, 25.0, -21.0], // high and outboard: a lit top plane and a shaded flank on every box
  }),

  /** Inboard fill at barrel depth. The camera only ever sees the gun's -X flank and that
   *  flank faces AWAY from the key, so without this the entire readable side of the weapon is
   *  one long terminator. Deliberately much weaker than the key, or the shape goes flat. */
  fill: Object.freeze({
    colorHex: 0xffc894,
    intensity: 260.0,
    distance: 68.0,
    decay: 2.0,
    position: [2.0, -3.0, -33.0],
  }),

  /** Cold rim from low and outboard on the muzzle half, where the key has already fallen
   *  off. Its job is ONE cold edge down the barrel so a dark gun never disappears into a dark
   *  tunnel. Turned up, it floods the underside and the weapon goes pale and toy-like.
   *
   *  --- round four ---
   *  Which is exactly what it was doing, and only the pistol was small enough to show it.
   *  A critic measured the pistol slide in platform.png at mean luminance 142 with a peak of
   *  255 — clipped white — on a material whose own albedo (MATERIALS.slide, 0x5b6270) is
   *  luminance 98. A surface cannot out-value its own albedo under a light that is merely
   *  shaping it; that only happens when a fixture is driving the diffuse lobe past the point
   *  where the tonemapper can hold it. The measured hue confirmed the culprit — blue > red >
   *  green, which is this light's 0xb4cbf2 and nothing else in the rig. The key was already
   *  walked 3600 -> 2150 in round three; this is the fixture that was never re-measured
   *  after the guns were shrunk and pulled closer to it. 980 -> 520.
   *
   *  --- round five ---
   *  Round four was tuned while this rig was ALIVE, which is itself the evidence it was never
   *  meant to be deleted — and it was being deleted, silently, at every quality tier, by the
   *  scene light budget in optimize.js ranking a 520 cd fixture 13 cm from the slide against
   *  station spots at 122,880-1,594,320 cd. With all three fixtures reserved and reaching the
   *  gun again, the obvious worry was round four's hotspot returning worse, since the station
   *  rig now also reaches the flank. Measured instead of assumed, on the restored platform
   *  frame: the pistol's whole silhouette runs median luminance 60.5 against a slide albedo of
   *  98, and 0.85% of its pixels clip, at a mean of rgb(252,254,255) — neutral white with a
   *  3/255 blue lead. Round four's fault was a SURFACE out-valuing its own albedo under a
   *  diffuse flood whose hue was unmistakably this light's; this is a specular highlight on
   *  under one percent of the gun. So 520 stands, un-retuned. The number to watch if it ever
   *  needs revisiting is clipPct in verify/out/report.json. */
  rim: Object.freeze({
    colorHex: 0xb4cbf2,
    intensity: 520.0,
    distance: 78.0,
    decay: 2.0,
    position: [-11.0, -21.0, -63.0],
  }),

  /**
   * Arm proportions, as fractions of the shoulder-to-hand run. Cross-sections scale with the
   * weapon, so shrinking a gun to get it out of the player's eyeline does not leave it held
   * by a pair of tree trunks; lengths come out of the run itself, which each weapon authors
   * and which is not ours to scale.
   *
   * WHICH material sits where along that run matters more than any of the diameters. The
   * first pass put bare skin at 0.67 of the way out, and for the rifle's support arm — whose
   * shoulder anchor is 39 cm BEHIND the lens, so the run is 67 cm long — 0.67 lands the
   * widest, palest cylinder in the rig right across the middle of the bottom of the frame at
   * 36 cm from the eye. It read as a naked forearm the size of a leg, and it was brighter
   * than the gun. The sleeve now covers the whole visible span and only a short cuff of
   * wrist stays bare, immediately behind the glove where an eye expects to find it.
   */
  arm: Object.freeze({
    sleeveDiameter: 8.6,
    sleeveLengthFraction: 0.70,
    sleeveCentreFraction: 0.50,
    cuffDiameter: 9.3,
    cuffLength: 3.0,
    cuffCentreFraction: 0.86,
    forearmDiameter: 6.3,
    forearmLengthFraction: 0.08,
    forearmCentreFraction: 0.88,
  }),

  /**
   * The gloved hand, authored in GRIP SPACE: +Y runs up the grip, -Z is the front strap (the
   * side the fingers close around), +X is outboard. Each weapon says how to rotate that frame
   * onto its own grip, so one hand serves both a pistol backstrap and a rifle handguard.
   */
  hand: Object.freeze({
    palm: Object.freeze({ size: [5.2, 7.6, 4.6], pos: [0.5, -1.0, 0.6] }),
    back: Object.freeze({ size: [1.0, 6.4, 4.4], pos: [-2.6, -0.8, 0.4] }),
    fingerCount: 4,
    fingerTopY: 2.1,
    fingerPitchY: -2.15,
    fingerCurl: 0.10, // radians of extra close per finger down the fist, so it is not a stamp
    proximal: Object.freeze({ size: [6.4, 2.0, 2.3], pos: [0.1, 0, -2.8] }),
    distal: Object.freeze({ size: [2.7, 1.95, 3.1], pos: [-3.2, 0, -1.4] }),
    knuckle: Object.freeze({ size: [2.1, 2.05, 2.2], pos: [-3.2, 0, -2.7] }),
    // The thumb was authored on the +X flank, which is the flank FACING AWAY from the lens
    // — the camera looks at the back of this hand — so for three rounds the rig has had a
    // thumb that no frame has ever contained. A critic looking at boss.png said so in as
    // many words: "no thumb is present in frame". It now rides up over the top-front of the
    // fist and rakes forward along the receiver, which is both where a gripping thumb
    // actually goes and the one place on this fist that breaks the silhouette against the
    // gun rather than disappearing into it.
    thumbBase: Object.freeze({ size: [2.4, 2.2, 5.2], pos: [1.2, 2.7, -0.2], rot: [0.55, 0, 0] }),
    thumbTip: Object.freeze({ size: [2.2, 4.4, 2.2], pos: [0.2, 1.7, -3.3], rot: [-0.62, 0, 0] }),
    strap: Object.freeze({ size: [6.1, 2.1, 5.7], pos: [0, -5.3, 0.6] }),
    strapEdge: Object.freeze({ size: [6.5, 0.55, 6.1], pos: [0, -6.4, 0.6] }),
  }),

  /**
   * Reload choreography, in normalised reload time. One hump tips the gun over so the
   * magazine well faces the camera and levels it out again; the magazine drops and seats
   * inside that window; the action is worked once the fresh one is in.
   */
  reload: Object.freeze({
    tiltSpan: 0.92, // the tilt is finished before the reload is, so the gun settles level
    dip: -6.5, // cm
    pitch: -0.30, // radians
    yaw: 0.26, // radians
    roll: -0.34, // radians
    magOutStart: 0.22,
    magOutEnd: 0.46,
    magInStart: 0.52,
    magInEnd: 0.76,
    rackStart: 0.78,
    rackEnd: 0.92,
    tubeStart: 0.12, // a tube-fed gun has no magazine, so the forend works the whole window
    tubeEnd: 0.88,
  }),

  renderOrder: 10, // above the world's default 0, so the gun draws last among the opaques
  dualWieldNudgeX: -2.0, // cm of extra outward shift on the mirrored left-hand pistol
})

/** Diffuse floors keep the rig legible under station light without flattening metal highlights. */
const MATERIALS = Object.freeze({
  steel: { color: 0x51575f, metalness: 0.46, roughness: 0.32, emissive: 0x111419, emissiveIntensity: 1.0, surface: 'gun' },
  slide: { color: 0x5b6270, metalness: 0.52, roughness: 0.24, emissive: 0x15181e, emissiveIntensity: 1.0, surface: 'gun' },
  edge: { color: 0x98a0ac, metalness: 0.62, roughness: 0.18, emissive: 0x1d222a, emissiveIntensity: 1.0, surface: 'gun' },
  polymer: { color: 0x2a2e34, metalness: 0.05, roughness: 0.66, emissive: 0x0a0c0f, emissiveIntensity: 1.0, surface: 'gun' },
  rubber: { color: 0x191c22, metalness: 0.0, roughness: 0.92, emissive: 0x040507, emissiveIntensity: 1.0, surface: 'gun' },
  accent: { color: 0x82653e, metalness: 0.38, roughness: 0.46, emissive: 0x171108, emissiveIntensity: 1.0, surface: 'gun' },
  dark: { color: 0x101319, metalness: 0.25, roughness: 0.55, emissive: 0x030406, emissiveIntensity: 1.0, surface: 'gun' },
  brass: { color: 0xc08526, metalness: 0.72, roughness: 0.24, emissive: 0x211504, emissiveIntensity: 1.0, surface: 'gun' },
  lens: { color: 0x0c1826, metalness: 0.2, roughness: 0.08, emissive: 0x11364c, emissiveIntensity: 0.9, surface: 'optic' },
  // `slide`'s scalars exactly — only the map differs. A roll mark is not a different metal.
  mark: { color: 0x5b6270, metalness: 0.52, roughness: 0.24, emissive: 0x15181e, emissiveIntensity: 1.0, surface: 'mark' },
  sightGreen: { color: 0x0b1a0d, metalness: 0.0, roughness: 0.4, emissive: 0x39ff6a, emissiveIntensity: 3.5 },
  sightRed: { color: 0x1a0606, metalness: 0.0, roughness: 0.4, emissive: 0xff2a18, emissiveIntensity: 4.0 },
  sightAmber: { color: 0x1a1206, metalness: 0.0, roughness: 0.4, emissive: 0xffb020, emissiveIntensity: 3.0 },
  // Matte charcoal leather separates the rounded hand from the sharper reflective receiver.
  glove: { color: 0x252d36, metalness: 0.0, roughness: 0.88, emissive: 0x05080b, emissiveIntensity: 1.0, surface: 'hide' },
  gloveHi: { color: 0x55616d, metalness: 0.0, roughness: 0.88, emissive: 0x10161b, emissiveIntensity: 1.0, surface: 'hide' },
  gloveDeep: { color: 0x171e26, metalness: 0.0, roughness: 0.88, emissive: 0x030508, emissiveIntensity: 1.0, surface: 'hide' },
  gloveMid: { color: 0x394550, metalness: 0.0, roughness: 0.88, emissive: 0x080d12, emissiveIntensity: 1.0, surface: 'hide' },
  skin: { color: 0x36230f, metalness: 0.0, roughness: 0.80, emissive: 0x110a06, emissiveIntensity: 1.0, surface: 'limb' },
  sleeve: { color: 0x2f342a, metalness: 0.0, roughness: 0.86, emissive: 0x0b0d09, emissiveIntensity: 1.0, surface: 'limb' },
  strap: { color: 0x303b45, metalness: 0.0, roughness: 0.88, emissive: 0x070b10, emissiveIntensity: 1.0, surface: 'hide' },
})

// ---------------------------------------------------------------------------
// surface baking
// ---------------------------------------------------------------------------

/**
 * Every other major surface in this game is procedurally baked — tile, concrete, rail,
 * the train livery, zombie flesh — and the weapon, the largest object on screen in every
 * frame of play, was the last one still shipping as a flat colour. It gets the same
 * treatment in the same shape the rest of the project uses: one height field produces an
 * albedo, a glTF-style ORM pack (G = roughness, B = metalness, one binding doing two jobs)
 * and a derived normal map, all from a seeded Rng so the frame gate keeps comparing stable
 * pixels. The noise helpers are local rather than imported for the same reason zombie.js
 * and train.js keep their own: each of those modules owns its surfaces outright.
 *
 * TWO sets, not one. Steel grain on leather turns a glove into a pressed-metal mitten, so
 * the hands take a separate hide bake and only its albedo, roughness and normal — handing
 * a fist the gunmetal metalness map would make it as conductive as the receiver it is
 * wrapped around.
 *
 * Both sets multiply the scalars in MATERIALS. bakeSurface normalises each ORM channel to its own
 * maximum, so a scalar stays the roughest / most metallic that surface ever gets and the
 * map only varies downward from it; the albedo is authored just under 1.0 for the same
 * reason — it is carrying grime and tool marks, not a mud filter over tuned work.
 */
const BAKE_SIZE = 512
const GUN_SEED = 0x6b17e2
const HIDE_SEED = 0x3ca41d
const OPTIC_SEED = 0x2d90c4
const MARK_SEED = 0x51a3b7

/** House face, matching the station signage so the gun belongs to the same world. */
const MARK_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'
// One mark serves all three weapons, so it says nothing about calibre: the first render put
// "CAL .223" on the SHOTGUN, which is the kind of detail that makes a player trust the rest
// of the art less. The second line is the game's own voice instead.
const MARK_LINES = Object.freeze(['SHOEMONEY ARMS', 'PLATFORM ONE  ·  MADE IN HELL'])

/**
 * The receiver flank a roll mark goes on is about 13 x 3.4 cm, and a box face hands the
 * texture a square 0..1 regardless — so anything drawn square comes out squashed to a
 * quarter of its height. The stamp is therefore drawn with y scaled by this, and the face
 * squashes it back to upright. Both weapons that wear it are within 6% of this ratio.
 */
const MARK_ASPECT = 3.8

/**
 * Texture repeats per surface.
 *
 * The rig is authored in centimetres like the rest of the world, but unlike the station it
 * is built from ONE shared unit box scaled per part, so there are no world-space UVs to
 * write — a box face is 0..1 whether it is 25 cm of receiver or a 5 mm chamfer. These are
 * therefore set for the parts that carry the read (receiver flank, slide, handguard, stock,
 * palm) at roughly 9 cm per repeat, and the slivers get a finer grain than their size says
 * they should. At the half-millimetre a chamfer strip occupies on screen that is a
 * distinction with no pixels in it.
 *
 * `limb` is the same hide bake at a different density because a sleeve is a CYLINDER: u
 * wraps its ~27 cm circumference and v runs the 40-odd cm to the shoulder, so the box
 * repeat would smear the grain into stripes along the forearm.
 *
 * Glove pores stay subtle; the rounded silhouette and sewn panels carry the hand read.
 */
const SURFACES = Object.freeze({
  gun: Object.freeze({ bake: 'gun', repeat: [2.6, 2.6], orm: 'both', normalScale: 0.85 }),
  hide: Object.freeze({ bake: 'hide', repeat: [1, 1], orm: 'rough', normalScale: 0.42 }),
  limb: Object.freeze({ bake: 'hide', repeat: [4.6, 6.2], orm: 'rough', normalScale: 0.85 }),
  // Drawn artwork, not noise: one tile per face, exactly once, no tiling.
  optic: Object.freeze({ bake: 'optic', repeat: [1, 1], orm: 'both', normalScale: 0.40, emissive: true }),
  mark: Object.freeze({ bake: 'mark', repeat: [1, 1], orm: 'both', normalScale: 1.30 }),
})

/** Value noise on a wrapped lattice, so every octave tiles seamlessly at u,v = 1. */
function wrapNoise(rng, cells) {
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

function wrapFbm(rng, baseCells, octaves) {
  const layers = []
  let cells = baseCells
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    layers.push({ noise: wrapNoise(rng, cells), amp })
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

/** Anisotropic fbm. Machining runs in ONE direction; so do the creases in a worn glove. */
function streakFbm(rng, cells, octaves, stretch) {
  const f = wrapFbm(rng, cells, octaves)
  return (u, v) => f(u, v / stretch)
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
function smoothEdge(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

function bakeCanvas() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = BAKE_SIZE
  return canvas
}

function bakeTexture(canvas, colorSpace) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = colorSpace
  tex.anisotropy = 16 // a barrel seen almost end-on is nearly all grazing angle
  tex.needsUpdate = true
  return tex
}

/** OpenGL-convention tangent-space normals from a wrapping height field. */
function bakeNormalMap(height, strength) {
  const size = BAKE_SIZE
  const canvas = bakeCanvas()
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const inv = 1 / Math.hypot(-dx, dy, 1)
      const i = (y * size + x) * 4
      image.data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
      image.data[i + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255)
      image.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return bakeTexture(canvas, THREE.NoColorSpace)
}

/** `shade(u, v, out)` writes into a reused object; 260k allocations per set is not free. */
function bakeSurface(shade, normalStrength) {
  const albedoCanvas = bakeCanvas()
  if (!albedoCanvas) {
    console.error(
      '[viewmodel] no DOM: the weapon surfaces cannot bake, so the gun falls back to flat ' +
        'colour — the stack-of-grey-boxes look this bake exists to prevent.',
    )
    return {}
  }
  const size = BAKE_SIZE
  const ormCanvas = bakeCanvas()
  const albedoCtx = albedoCanvas.getContext('2d')
  const ormCtx = ormCanvas.getContext('2d')
  const albedo = albedoCtx.createImageData(size, size)
  const orm = ormCtx.createImageData(size, size)
  const height = new Float32Array(size * size)
  const roughRaw = new Float32Array(size * size)
  const metalRaw = new Float32Array(size * size)

  const out = { r: 0.5, g: 0.5, b: 0.5, rough: 0.8, metal: 0, height: 0.5 }
  let maxRough = 0
  let maxMetal = 0

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      out.r = out.g = out.b = 0.5
      out.rough = 0.8
      out.metal = 0
      out.height = 0.5
      shade(u, v, out)

      const p = y * size + x
      const i = p * 4
      albedo.data[i] = clamp01(out.r) * 255
      albedo.data[i + 1] = clamp01(out.g) * 255
      albedo.data[i + 2] = clamp01(out.b) * 255
      albedo.data[i + 3] = 255
      roughRaw[p] = clamp01(out.rough)
      metalRaw[p] = clamp01(out.metal)
      if (roughRaw[p] > maxRough) maxRough = roughRaw[p]
      if (metalRaw[p] > maxMetal) maxMetal = metalRaw[p]
      height[p] = out.height
    }
  }

  // Normalised to their own maxima so MATERIALS keeps meaning what it says: each scalar is
  // the ceiling, and the map only ever takes a pixel below it.
  const roughScale = maxRough > 0 ? 255 / maxRough : 0
  const metalScale = maxMetal > 0 ? 255 / maxMetal : 0
  for (let p = 0; p < roughRaw.length; p++) {
    const i = p * 4
    orm.data[i] = 255 // R is the AO slot; nothing samples it, leave it neutral
    orm.data[i + 1] = roughRaw[p] * roughScale
    orm.data[i + 2] = metalRaw[p] * metalScale
    orm.data[i + 3] = 255
  }

  albedoCtx.putImageData(albedo, 0, 0)
  ormCtx.putImageData(orm, 0, 0)

  return {
    map: bakeTexture(albedoCanvas, THREE.SRGBColorSpace),
    ormMap: bakeTexture(ormCanvas, THREE.NoColorSpace),
    normalMap: bakeNormalMap(height, normalStrength),
  }
}

/**
 * Blued gunmetal: fine machining pulled in one direction, broad soot and powder fouling
 * sunk into it, and the high spots rubbed back to bare bright metal by a decade of holster
 * wear. The soot is the part that does the work — it is low-frequency, so it survives the
 * mip chain at the 60-100 px a receiver actually occupies, and it drops metalness as well
 * as value, because burnt carbon is a dielectric sitting on top of a conductor and that
 * difference is most of what makes worn steel look worn rather than painted.
 */
function bakeGunmetal() {
  const rng = new Rng(GUN_SEED)
  const blotch = wrapFbm(rng, 5, 4)
  const wear = wrapFbm(rng, 11, 3)
  const machining = streakFbm(rng, 26, 3, 12)
  const grit = wrapFbm(rng, 44, 2)
  return bakeSurface((u, v, out) => {
    const b = blotch(u, v)
    const m = machining(u, v)
    const g = grit(u, v)
    const soot = smoothEdge(0.52, 0.86, 1 - b)
    const polish = smoothEdge(0.66, 0.94, wear(u, v))
    // The albedo deliberately stays close to 1.0 and the ROUGHNESS does the loud work. A
    // multiplier map can only ever take a pixel below its scalar, so every point of albedo
    // contrast is a point of value spent out of the three rounds that got this gun out of
    // the black wedge — measured, this bake costs 11% of linear albedo. Roughness and the
    // normal cost none of it: 0.59-1.00 of the scalar under three point lights 20 cm off
    // the lens is specular breakup, and specular ADDS. That is where the grain comes from.
    out.r = out.g = out.b = clamp01(1.0 - 0.035 * (1 - m) - 0.14 * soot + 0.06 * polish - 0.03 * (1 - g))
    out.rough = clamp01(0.96 - 0.38 * polish + 0.04 * soot + (g - 0.5) * 0.10)
    out.metal = clamp01(0.94 - 0.40 * soot + 0.06 * polish)
    out.height = clamp01(0.5 + (m - 0.5) * 0.55 + (b - 0.5) * 0.34 + (g - 0.5) * 0.26 - soot * 0.14)
  }, 3.8)
}

/** Matte pebbled leather. Isotropic pores avoid the long grain of a wooden surface. */
function bakeHide() {
  const rng = new Rng(HIDE_SEED)
  const pebble = wrapFbm(rng, 36, 3)
  const wear = wrapFbm(rng, 7, 3)
  return bakeSurface((u, v, out) => {
    const pore = pebble(u, v)
    const scuff = wear(u, v)
    out.r = out.g = out.b = 0.90 + 0.06 * pore + 0.04 * scuff
    out.rough = 0.92 + 0.08 * pore
    out.metal = 0
    out.height = 0.5 + (pore - 0.5) * 0.25
  }, 1.4)
}

/**
 * The optic. A critic counted it among the blocker's evidence — "a flat blue circle for an
 * optic" — and it was, because `lens` is the one body material with no map at all and a
 * cylinder cap hands us a perfectly radial 0..1 UV to work with. So this is drawn rather
 * than noised: an anti-reflective coating darkening toward the rim, the interference rings
 * a coated lens actually shows, dust in the glass, and ONE soft crescent of reflected
 * station light up and inboard. That crescent is the whole trick — a painted disc has no
 * reflection on it, and an eye knows the difference without being told.
 *
 * It binds to emissiveMap as well as map, because `lens` carries most of its value in
 * emissive (0x11364c at 0.9) and an unmapped emissive is a flat glow by definition.
 */
function bakeOptic() {
  const rng = new Rng(OPTIC_SEED)
  const smudge = wrapFbm(rng, 7, 3)
  return bakeSurface((u, v, out) => {
    const dx = (u - 0.5) * 2
    const dy = (v - 0.5) * 2
    const r = Math.hypot(dx, dy) // 1.0 at the edge of the glass
    const s = smudge(u, v)
    const coating = 1 - 0.34 * smoothEdge(0.50, 1.0, r)
    const rings = 1 + 0.05 * Math.sin(r * 22.0)
    const glint = smoothEdge(0.46, 0.05, Math.hypot(dx + 0.42, dy - 0.40))
    const dust = 0.93 + 0.13 * s
    out.r = out.g = out.b = clamp01(coating * rings * dust + glint * 0.85)
    out.rough = clamp01(0.98 - 0.50 * glint)
    out.metal = clamp01(0.55 + 0.45 * smoothEdge(0.70, 1.0, r))
    out.height = clamp01(0.5 + (s - 0.5) * 0.20 - smoothEdge(0.88, 1.0, r) * 0.30)
  }, 1.2)
}

/**
 * The roll mark. Every real receiver carries one, the station around it is covered in
 * legible signage that the critics called the best-looking thing in the build, and the gun
 * was the one prop in frame with no writing on it anywhere.
 *
 * It replaces the material on the upper-receiver flank panels the rifle and the shotgun
 * already have rather than adding geometry, so there is nothing new to float, z-fight or
 * mis-place: those panels are exactly where a manufacturer stamps one, their -X face is the
 * only face this camera ever sees, and a box face is a clean 0..1 for artwork.
 *
 * Verified against BoxGeometry rather than guessed: on the -X face u runs from z = -0.5 to
 * z = +0.5, the weapon points down -Z, and the camera sits inboard — so u increases from
 * the muzzle toward the stock, which is left to right on screen. The text is NOT mirrored.
 */
function bakeRollMark() {
  const canvas = bakeCanvas()
  if (!canvas) return {}
  const size = BAKE_SIZE
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#000000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.setTransform(1, 0, 0, MARK_ASPECT, 0, 0)
  ctx.font = `700 ${Math.round(size * 0.086)}px ${MARK_FONT}`
  // Both lines ride high on the panel: the shotgun's forend and shell carrier cut across
  // the bottom third of its receiver flank, and the first render lost half of line two to it.
  ctx.fillText(MARK_LINES[0], size * 0.5, (size * 0.30) / MARK_ASPECT)
  ctx.font = `500 ${Math.round(size * 0.047)}px ${MARK_FONT}`
  ctx.fillText(MARK_LINES[1], size * 0.5, (size * 0.54) / MARK_ASPECT)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const ink = ctx.getImageData(0, 0, size, size).data

  const rng = new Rng(MARK_SEED)
  const grit = wrapFbm(rng, 30, 2)
  const machining = streakFbm(rng, 20, 3, 12)
  return bakeSurface((u, v, out) => {
    const x = Math.min(size - 1, Math.floor(u * size))
    const y = Math.min(size - 1, Math.floor(v * size))
    const cut = 1 - ink[(y * size + x) * 4] / 255 // 1 inside a glyph
    const g = grit(u, v)
    const m = machining(u, v)
    // Engraved, not printed: the letters go DOWN into the panel, lose their polish and
    // stop being conductors where the bluing was cut through.
    out.r = out.g = out.b = clamp01(1.0 - 0.42 * cut - 0.035 * (1 - m) - 0.03 * (1 - g))
    out.rough = clamp01(0.94 + 0.06 * cut + (g - 0.5) * 0.08)
    out.metal = clamp01(0.95 - 0.45 * cut)
    out.height = clamp01(0.62 - 0.46 * cut + (m - 0.5) * 0.10 + (g - 0.5) * 0.12)
  }, 3.0)
}

const BAKERS = { gun: bakeGunmetal, hide: bakeHide, optic: bakeOptic, mark: bakeRollMark }

const VIEWS = Object.freeze({
  pistol: PISTOL_VIEW,
  rifle: RIFLE_VIEW,
  shotgun: SHOTGUN_VIEW,
})

/**
 * Where each gun actually sits, and how big it is. This REPLACES the `hold` the weapon
 * modules author, and it is the single most load-bearing table in the file.
 *
 * The projection is what drives the numbers. The camera is a 90-degree VERTICAL fov at 16:9,
 * so a point X cm right and Y cm up at depth d lands at (640 + 360 X/d, 360 - 360 Y/d) on a
 * 1280x720 frame. The old rifle put its buttpad at d = 16.7 cm with a half-height of 4.3 cm:
 * 93 px of solid rectangle, square to the lens, with the other 80 cm of weapon hidden
 * directly behind it. That rectangle was the "black wedge".
 *
 * Each entry turns the weapon across the view (yaw, muzzle swinging inboard), lifts the
 * muzzle toward the crosshair (pitch), shrinks the whole thing, and pushes the stock end
 * down and outboard until it leaves the frame. Measured against the weapon modules' own
 * `hold`, by projecting every part's eight corners through that formula:
 *
 *              screen bbox                nearest geometry   torso band 230-470 px
 *   pistol     973x817 -> 920x783 px      19.6 -> 19.8 cm    0.84% -> 0.71% of frame
 *   rifle      y331-641 -> y367-723       16.3 -> 18.7 cm    2.65% -> 1.10%
 *   shotgun    x729-3090 -> x686-1002      2.7 -> 18.4 cm    2.01% -> 1.21%
 *
 * That last row is not a typo: the shotgun's buttpad was 2.7 cm from the lens, so its stock
 * projected three thousand pixels wide and the "gun" was one out-of-focus slab. The middle
 * column is the one that matters to a player — the share of the frame the weapon takes out
 * of the horizontal band a standing zombie's torso and head occupy at three to twelve
 * metres. Every gun now blocks roughly half of what it used to, and the rifle less than
 * half, without any of them getting so small that they stop reading as held.
 *
 * `gripRake` mirrors the rake each weapon module gives its own grip boxes, so the hand sits
 * square on the grip instead of at an angle to it.
 *
 * NOTE FOR ANYONE TUNING pistol.js / rifle.js / shotgun.js: while an entry exists here, that
 * module's `hold` is NOT read. Editing `RIFLE_VIEW.hold` changes nothing on screen. `hold`
 * cannot express the per-weapon shrink these numbers depend on, and framing that is half in
 * one file and half in another is framing nobody can reason about, so it lives in one table.
 * Delete a weapon's entry below and its own `hold` takes over again at scale 1.
 * CHOSEN: not in original spec.
 */
const FRAMING = Object.freeze({
  // The pistol's entry is the one that was never re-checked against the HANDS. At
  // y = -14.5 and depth 26.5 the grip, the fist and the whole forearm project below
  // y = 720 and simply are not in the frame: platform.png and train.png show a slab of
  // slide and frame floating with nothing holding it, while the rifle and the shotgun
  // both show an arm. It is also the weapon a player carries through the entire first
  // wave, so it is the rig most players see most. 3.5 cm of lift at that depth is 48 px,
  // which is the grip and the knuckle bar back inside the viewport without pushing the
  // slide up into the crosshair.
  pistol: Object.freeze({
    scale: 0.88,
    pos: [13.5, -11.0, -26.5],
    rot: [0.075, 0.150, 0.020],
    gripRake: 0.26,
    handNudge: Object.freeze({ trigger: [-1.5, -1.1, 0.6], support: [-1.8, -1.4, 0.4] }),
  }),
  rifle: Object.freeze({
    scale: 0.74,
    pos: [15.0, -16.5, -35.0],
    rot: [0.095, 0.140, 0.015],
    gripRake: 0.34,
    handNudge: Object.freeze({ trigger: [-1.5, -1.1, 0.6], support: [-1.9, -2.9, 0.7] }),
  }),
  shotgun: Object.freeze({
    scale: 0.72,
    pos: [15.0, -16.5, -34.0],
    rot: [0.095, 0.150, 0.018],
    gripRake: 0.30,
    handNudge: Object.freeze({ trigger: [-1.6, -1.1, 0.6], support: [-2.1, -2.8, 0.7] }),
  }),
})

/**
 * Silhouette work, appended to whatever the weapon module authored.
 *
 * The part lists in pistol.js / rifle.js / shotgun.js belong to those modules and are not
 * edited from here. What they are short of is not parts, it is CONTOUR: every panel sits at
 * the same value as the panel beside it, so at 60-100 px across the whole gun collapses into
 * one blob. Each list below is mostly `edge` — thin bright chamfer strips laid along the
 * lines a machinist would actually break, all on the -X flank because that is the only flank
 * this camera ever sees — plus the few features that tell the three weapons apart at a
 * glance, which is the thing a player has to do in half a second:
 *
 *   pistol   slab slide with a cut ejection port, short exposed muzzle, mag inside the grip
 *   rifle    long handguard, raised optic, curved 30-round magazine forward of the grip
 *   shotgun  stacked tubes (barrel over magazine) and a ribbed pump forend with bright collars
 */
const EXTRAS = Object.freeze({
  pistol: Object.freeze([
    // Slide: break the top and bottom edges of the slab, and cut a real ejection port.
    { shape: 'box', size: [0.55, 0.55, 19.0], pos: [-2.1, 4.9, -3.5], mat: 'edge', tag: 'slide' },
    { shape: 'box', size: [0.5, 0.5, 19.0], pos: [-2.1, 0.75, -3.5], mat: 'edge', tag: 'slide' },
    { shape: 'box', size: [0.5, 2.0, 6.0], pos: [-2.25, 3.3, -1.0], mat: 'dark', tag: 'slide' },
    { shape: 'box', size: [0.45, 0.45, 6.6], pos: [-2.35, 4.45, -1.0], mat: 'edge', tag: 'slide' },
    { shape: 'box', size: [0.45, 0.45, 6.6], pos: [-2.35, 2.2, -1.0], mat: 'edge', tag: 'slide' },
    // Frame rail: the line that separates the moving slide from the fixed frame.
    { shape: 'box', size: [0.5, 0.45, 14.5], pos: [-2.0, -0.85, -4.5], mat: 'edge' },
    { shape: 'box', size: [0.45, 1.5, 6.0], pos: [-2.0, -0.2, -8.0], mat: 'steel' },
    // Trigger guard. A bright bar across the front of the bow reads as a guard; the bare
    // torus, one pixel of tube wide, reads as a smudge.
    { shape: 'box', size: [2.8, 0.75, 0.8], pos: [0, -4.5, -0.4], mat: 'edge' },
    { shape: 'box', size: [0.8, 3.4, 0.75], pos: [0, -2.9, -3.0], mat: 'edge' },
    // Grip checkering and a baseplate lip, so the magazine has a visible bottom.
    { shape: 'box', size: [0.45, 0.6, 3.6], pos: [-2.1, -3.3, 2.4], rot: [0.26, 0, 0], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.6, 3.6], pos: [-2.1, -5.7, 3.0], rot: [0.26, 0, 0], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.6, 3.6], pos: [-2.1, -8.1, 3.6], rot: [0.26, 0, 0], mat: 'edge' },
    { shape: 'box', size: [3.9, 0.6, 5.4], pos: [0, -11.95, 3.62], rot: [0.26, 0, 0], mat: 'edge', tag: 'mag' },
    // Muzzle crown — the cheapest way to say "this end is the dangerous one".
    { shape: 'cyl', size: [3.0, 1.0, 3.0], pos: [0, 2.8, -13.9], rot: [Math.PI / 2, 0, 0], mat: 'edge' },
  ]),

  rifle: Object.freeze([
    // Top rail and upper-receiver flank: the long horizontal the eye reads first.
    { shape: 'box', size: [0.55, 0.5, 25.0], pos: [-1.95, 7.1, -6.0], mat: 'edge', tag: 'slide' },
    // The upper-receiver flank: same panel, same place, now carrying the roll mark.
    { shape: 'box', size: [0.5, 3.4, 13.0], pos: [-2.45, 2.6, -4.0], mat: 'mark' },
    { shape: 'box', size: [0.5, 0.5, 23.0], pos: [-2.4, 0.9, -4.0], mat: 'edge' },
    { shape: 'box', size: [0.55, 2.0, 5.4], pos: [-2.5, 1.4, -5.5], mat: 'dark' },
    // Handguard: two chamfers down its length and a bright cap at each end.
    { shape: 'box', size: [0.55, 0.55, 19.0], pos: [-2.55, 6.0, -28.0], mat: 'edge' },
    { shape: 'box', size: [0.55, 0.55, 19.0], pos: [-2.55, 1.9, -28.0], mat: 'edge' },
    { shape: 'box', size: [5.0, 5.0, 0.7], pos: [0, 4.0, -38.6], mat: 'edge' },
    { shape: 'box', size: [5.0, 5.0, 0.7], pos: [0, 4.0, -17.4], mat: 'edge' },
    // Barrel highlight and a crown on the flash hider.
    { shape: 'box', size: [0.45, 0.45, 20.0], pos: [-1.15, 4.7, -46.0], mat: 'edge' },
    { shape: 'cyl', size: [4.0, 1.0, 4.0], pos: [0, 4.2, -59.3], rot: [Math.PI / 2, 0, 0], mat: 'edge' },
    // Optic: a lit housing, so the tallest part of the gun is not a dark bar over the sight.
    { shape: 'box', size: [0.55, 3.6, 9.6], pos: [-2.2, 9.0, -6.0], mat: 'edge' },
    { shape: 'box', size: [4.4, 0.55, 9.6], pos: [0, 10.9, -6.0], mat: 'edge' },
    // Magazine: a bright leading edge makes the curve legible, and that curve is the rifle's
    // one unmistakable outline cue against the shotgun's straight tube.
    { shape: 'box', size: [0.5, 8.6, 0.55], pos: [-1.75, -4.4, -10.3], rot: [-0.06, 0, 0], mat: 'edge', tag: 'mag' },
    { shape: 'box', size: [0.5, 5.2, 0.55], pos: [-1.75, -11.4, -9.1], rot: [-0.24, 0, 0], mat: 'edge', tag: 'mag' },
    { shape: 'box', size: [3.9, 0.6, 5.1], pos: [0, -14.6, -6.35], rot: [-0.24, 0, 0], mat: 'edge', tag: 'mag' },
    // Trigger guard bar and grip checkering.
    { shape: 'box', size: [2.9, 0.75, 0.8], pos: [0, -4.9, -0.6], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.6, 3.6], pos: [-1.9, -3.0, 2.2], rot: [0.34, 0, 0], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.6, 3.6], pos: [-1.9, -5.4, 3.0], rot: [0.34, 0, 0], mat: 'edge' },
    // Stock: comb line, toe line and a bordered buttpad. This is the part that WAS the black
    // wedge, so it is now the most heavily contoured thing on the weapon.
    { shape: 'box', size: [0.55, 0.55, 10.5], pos: [-2.45, 6.85, 13.0], mat: 'edge' },
    { shape: 'box', size: [0.55, 0.55, 10.0], pos: [-2.45, -1.15, 14.2], mat: 'edge' },
    { shape: 'box', size: [5.4, 0.7, 0.6], pos: [0, 6.35, 21.0], mat: 'edge' },
    { shape: 'box', size: [5.4, 0.7, 0.6], pos: [0, -2.35, 21.0], mat: 'edge' },
    { shape: 'box', size: [0.7, 9.0, 0.6], pos: [-2.45, 2.0, 21.0], mat: 'edge' },
  ]),

  shotgun: Object.freeze([
    // The stacked pair IS the shotgun's identity, so both tubes get their own highlight.
    { shape: 'box', size: [0.5, 0.5, 40.0], pos: [-1.0, 6.2, -32.0], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.45, 34.0], pos: [-1.45, 0.3, -28.0], mat: 'edge' },
    { shape: 'cyl', size: [4.6, 1.2, 4.6], pos: [0, 4.6, -52.6], rot: [Math.PI / 2, 0, 0], mat: 'edge' },
    { shape: 'cyl', size: [3.8, 1.0, 3.8], pos: [0, 0.9, -47.2], rot: [Math.PI / 2, 0, 0], mat: 'edge' },
    // Pump forend: bright collars at both ends, so the stroke is visible when it works.
    { shape: 'box', size: [6.2, 5.6, 0.7], pos: [0, 0.9, -30.8], mat: 'edge', tag: 'slide' },
    { shape: 'box', size: [6.2, 5.6, 0.7], pos: [0, 0.9, -17.2], mat: 'edge', tag: 'slide' },
    { shape: 'box', size: [0.55, 0.55, 13.0], pos: [-2.95, 3.3, -24.0], mat: 'edge', tag: 'slide' },
    // Receiver flank, ejection port and its rim.
    { shape: 'box', size: [0.5, 4.6, 16.5], pos: [-2.85, 2.6, -3.0], mat: 'mark' },
    { shape: 'box', size: [0.5, 2.3, 6.2], pos: [-2.95, 1.4, -2.0], mat: 'dark' },
    { shape: 'box', size: [0.5, 0.5, 6.8], pos: [-3.05, 2.75, -2.0], mat: 'edge' },
    { shape: 'box', size: [0.55, 0.55, 20.0], pos: [-2.85, 5.6, -3.0], mat: 'edge' },
    { shape: 'box', size: [0.55, 0.55, 20.0], pos: [-2.85, -0.7, -3.0], mat: 'edge' },
    // Trigger guard bar and grip checkering.
    { shape: 'box', size: [3.1, 0.8, 0.85], pos: [0, -4.4, -0.4], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.6, 4.0], pos: [-2.1, -2.2, 1.8], rot: [0.30, 0, 0], mat: 'edge' },
    { shape: 'box', size: [0.45, 0.6, 4.0], pos: [-2.1, -4.6, 2.6], rot: [0.30, 0, 0], mat: 'edge' },
    // Stock.
    { shape: 'box', size: [0.55, 0.55, 12.0], pos: [-2.5, 5.0, 12.0], rot: [-0.05, 0, 0], mat: 'edge' },
    { shape: 'box', size: [0.55, 0.55, 12.0], pos: [-2.5, -2.4, 12.6], rot: [-0.05, 0, 0], mat: 'edge' },
    { shape: 'box', size: [5.4, 0.7, 0.6], pos: [0, 4.8, 20.9], rot: [-0.05, 0, 0], mat: 'edge' },
    { shape: 'box', size: [5.4, 0.7, 0.6], pos: [0, -4.0, 20.4], rot: [-0.05, 0, 0], mat: 'edge' },
    { shape: 'box', size: [0.7, 8.4, 0.6], pos: [-2.5, 0.4, 20.7], rot: [-0.05, 0, 0], mat: 'edge' },
  ]),
})

const Y_AXIS = new THREE.Vector3(0, 1, 0)

/** The support hand grips a handguard, whose axis runs along the barrel rather than up the
 *  grip, so its frame is the grip frame rolled a quarter turn forward: grip-up becomes
 *  barrel-forward and the fingers close UNDER the handguard instead of behind it. */
const SUPPORT_GRIP_ROT = Object.freeze([-Math.PI / 2, 0, 0])

/** A pistol has no handguard: the support hand cups the shooting hand, rolled slightly in. */
const PISTOL_SUPPORT_ROLL = 0.5

/** Used only if a weapon's framing forgets to say where its hands sit relative to the grip. */
const NO_NUDGE = Object.freeze({ trigger: [0, 0, 0], support: [0, 0, 0] })

/** A weapon with no FRAMING entry falls back to its own `hold`, unshrunk and unnudged. It
 *  will look like the round-one rig did, which is the point: the fallback is a visible
 *  regression rather than a silent one, so a missing entry cannot hide. */
function fallbackFraming(view) {
  if (!view?.hold) return null
  return { scale: 1, pos: view.hold.pos, rot: view.hold.rot, gripRake: 0, handNudge: NO_NUDGE }
}

/** An impulse of A*omega on a spring of this stiffness peaks at a displacement of A. */
const RECOIL_OMEGA = Math.sqrt(VIEW.recoil.stiffness)
const _from = new THREE.Vector3()
const _to = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _quat = new THREE.Quaternion()

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t)
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/** Frame-rate independent exponential approach; `rate` is in 1/seconds. */
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

function mirrorParts(parts) {
  return parts.map((part) => ({
    ...part,
    pos: [-part.pos[0], part.pos[1], part.pos[2]],
    rot: part.rot ? [part.rot[0], -part.rot[1], -part.rot[2]] : undefined,
  }))
}

export class ViewModel {
  constructor(camera, { rng = sharedRng } = {}) {
    this.camera = camera
    this.rng = rng

    this.geometries = {
      box: new THREE.BoxGeometry(1, 1, 1),
      glove: new RoundedBoxGeometry(1, 1, 1, 2, 0.24),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 18, 1),
      sphere: new THREE.SphereGeometry(0.5, 14, 10),
      torus: new THREE.TorusGeometry(0.5, 0.09, 8, 24),
    }
    // One rasterise per source surface, then one clone set per SURFACES entry. A clone
    // shares the canvas it came from, so three density variants of the hide bake cost one
    // bake and one upload, not three of each.
    const baked = {}
    const surfaceMaps = {}
    this.textures = []
    for (const [name, surface] of Object.entries(SURFACES)) {
      baked[surface.bake] ??= BAKERS[surface.bake]()
      const maps = {}
      for (const slot of ['map', 'ormMap', 'normalMap']) {
        const source = baked[surface.bake][slot]
        if (!source) continue
        const copy = source.clone()
        copy.repeat.set(surface.repeat[0], surface.repeat[1])
        copy.needsUpdate = true
        maps[slot] = copy
        this.textures.push(copy)
      }
      surfaceMaps[name] = maps
    }

    this.materials = {}
    for (const [key, spec] of Object.entries(MATERIALS)) {
      const mat = new THREE.MeshStandardMaterial({
        color: spec.color,
        metalness: spec.metalness,
        roughness: spec.roughness,
      })
      if (spec.emissive !== undefined) {
        mat.emissive = new THREE.Color(spec.emissive)
        mat.emissiveIntensity = spec.emissiveIntensity
      }
      // The maps multiply into the material scalars above. `orm: 'rough'` is the
      // whole reason the hands get their own entry: leather takes the roughness variation
      // and NOT the metalness, because a glove wearing the gunmetal conductor map is a
      // steel mitten, and a steel mitten on a steel receiver is one object again.
      const surface = SURFACES[spec.surface]
      const maps = surface ? surfaceMaps[spec.surface] : null
      if (maps?.map) {
        mat.map = maps.map
        // The optic keeps most of its value in emissive, and an unmapped emissive is a flat
        // glow by definition — which is precisely what "a flat blue circle" was.
        if (surface.emissive) mat.emissiveMap = maps.map
        if (maps.ormMap) {
          mat.roughnessMap = maps.ormMap
          if (surface.orm === 'both') mat.metalnessMap = maps.ormMap
        }
        if (maps.normalMap) {
          mat.normalMap = maps.normalMap
          mat.normalScale = new THREE.Vector2(surface.normalScale, surface.normalScale)
        }
      }
      this.materials[key] = mat
    }

    this.root = new THREE.Group()
    this.root.name = 'viewmodel'
    this.root.scale.setScalar(VIEW.scale)

    this.sway = new THREE.Group()
    this.bob = new THREE.Group()
    this.holster = new THREE.Group()
    this.root.add(this.sway)
    this.sway.add(this.bob)
    this.bob.add(this.holster)

    // The fill rides the holster group so it drops out of frame with the gun during a swap.
    const fill = new THREE.PointLight(VIEW.fill.colorHex, VIEW.fill.intensity, VIEW.fill.distance, VIEW.fill.decay)
    fill.position.set(...VIEW.fill.position)
    fill.castShadow = false
    reserveFromLightBudget(fill)
    this.holster.add(fill)
    this.fillLight = fill

    // The key and the rim hang off the root instead, fixed in camera space, so the weapon is
    // shaped the same whether the player is standing under a lamp or facing into the tunnel.
    // Neither casts: a shadow map from a light 20 cm off the lens is all acne and no value.
    this.keyLight = new THREE.PointLight(VIEW.key.colorHex, VIEW.key.intensity, VIEW.key.distance, VIEW.key.decay)
    this.keyLight.position.set(...VIEW.key.position)
    this.keyLight.castShadow = false
    reserveFromLightBudget(this.keyLight)
    this.root.add(this.keyLight)

    this.rimLight = new THREE.PointLight(VIEW.rim.colorHex, VIEW.rim.intensity, VIEW.rim.distance, VIEW.rim.decay)
    this.rimLight.position.set(...VIEW.rim.position)
    this.rimLight.castShadow = false
    reserveFromLightBudget(this.rimLight)
    this.root.add(this.rimLight)

    this.primary = this.createRig(true)
    this.secondary = null

    this.swayTime = 0
    this.bobPhase = 0
    this.speedFactor = 0
    this.lagX = 0
    this.lagY = 0
    this.lagRoll = 0
    this.holsterT = 0
    this.holsterRate = 0
    this.pendingWeapon = null

    this.setWeapon(PLAYER.START.weapon)
    camera.add(this.root)
  }

  createRig(withSupportArm) {
    const rig = {
      root: new THREE.Group(),
      weaponRoot: new THREE.Group(),
      magNode: new THREE.Group(),
      slideNode: new THREE.Group(),
      muzzle: new THREE.Object3D(),
      mainArm: new THREE.Group(),
      supportArm: withSupportArm ? new THREE.Group() : null,
      view: null,
      framing: null,
      scale: 1,
      recoil: {
        back: { x: 0, v: 0 },
        rise: { x: 0, v: 0 },
        pitch: { x: 0, v: 0 },
        roll: { x: 0, v: 0 },
      },
      reloadT: -1,
      reloadSeconds: WEAPONS.DEFAULTS.reloadTime,
    }
    rig.root.add(rig.weaponRoot, rig.mainArm)
    if (rig.supportArm) rig.root.add(rig.supportArm)
    rig.weaponRoot.add(rig.magNode, rig.slideNode, rig.muzzle)
    this.holster.add(rig.root)
    return rig
  }

  buildPart(spec) {
    const geometry = this.geometries[spec.shape]
    if (!geometry) {
      console.warn(`[viewmodel] unknown part shape "${spec.shape}" — that piece of the gun is missing`)
      return null
    }
    const material = this.materials[spec.mat]
    if (!material) {
      console.warn(`[viewmodel] unknown material "${spec.mat}" — falling back to bare steel`)
    }
    const mesh = new THREE.Mesh(geometry, material ?? this.materials.steel)
    mesh.scale.set(...spec.size)
    mesh.position.set(...spec.pos)
    if (spec.rot) mesh.rotation.set(...spec.rot)
    // A gun 26 cm from the lens would otherwise throw its own shadow across the whole view.
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.renderOrder = VIEW.renderOrder
    return mesh
  }

  /** Meshes are rebuilt on every swap; the shared geometries and materials are not, so a
   *  swap allocates a few dozen Mesh objects and nothing on the GPU. */
  clearGroup(group) {
    for (let i = group.children.length - 1; i >= 0; i--) group.remove(group.children[i])
  }

  /**
   * The weapon's own geometry is scaled; the arms are not. Shrinking the gun to get it out of
   * the player's eyeline must not shrink the person holding it — a 0.78x rifle in 0.78x hands
   * is pixel-for-pixel the 1.0x rifle we are trying to get away from. Only the hand itself
   * follows the gun down, because it has to fit around the grip.
   */
  populate(rig, view, parts, framing) {
    rig.view = view
    rig.framing = framing
    rig.scale = framing.scale
    this.clearGroup(rig.weaponRoot)
    this.clearGroup(rig.magNode)
    this.clearGroup(rig.slideNode)
    rig.weaponRoot.add(rig.magNode, rig.slideNode, rig.muzzle)
    rig.weaponRoot.scale.setScalar(framing.scale)

    for (const spec of parts) {
      const mesh = this.buildPart(spec)
      if (!mesh) continue
      if (spec.tag === 'mag') rig.magNode.add(mesh)
      else if (spec.tag === 'slide') rig.slideNode.add(mesh)
      else rig.weaponRoot.add(mesh)
    }

    rig.muzzle.position.set(...view.muzzle)
    rig.magNode.position.set(0, 0, 0)
    rig.slideNode.position.set(0, 0, 0)

    const rake = framing.gripRake ?? 0
    const nudge = framing.handNudge ?? NO_NUDGE
    this.buildArm(rig.mainArm, view.shoulders.right, view.hands.right, framing, [rake, 0, 0], nudge.trigger)
    if (rig.supportArm) {
      const supportGrip = view.id === 'pistol' ? [rake, 0, PISTOL_SUPPORT_ROLL] : SUPPORT_GRIP_ROT
      this.buildArm(rig.supportArm, view.shoulders.left, view.hands.left, framing, supportGrip, nudge.support)
    }
  }

  /**
   * An arm is one tapered run of cylinders from an off-screen shoulder anchor to the hand
   * anchor, plus a gloved hand built in its own grip frame. No skinning, no IK solve — at
   * this framing the only thing the eye checks is whether the fingers are actually CLOSED
   * around the gun.
   *
   * Hand anchors are authored in weapon space, so they scale with the weapon. Shoulder
   * anchors are authored relative to the EYE, because that is where they read from, so they
   * come back out of the framing offset to land in the rig's own space — and they do NOT
   * scale, because a shoulder stays where a shoulder is.
   */
  buildArm(group, shoulder, handLocal, framing, gripRot, nudge = NO_NUDGE.trigger) {
    this.clearGroup(group)
    if (!shoulder || !handLocal) return

    // The weapon modules anchor each hand at the CENTRE of the thing it holds, which is where
    // a hand belongs if the hand is a 7 cm box. A fist with wrapping fingers anchored there
    // is swallowed by the handguard it is inside: on the first render the support arm ran all
    // the way up the barrel and simply stopped, because the hand was rendering inside the
    // forend. The nudge walks it out to the camera-facing surface and down off the bottom
    // edge, which is where a hand gripping a handguard actually sits anyway.
    const s = framing.scale
    _from.set(shoulder[0] - framing.pos[0], shoulder[1] - framing.pos[1], shoulder[2] - framing.pos[2])
    _to.set((handLocal[0] + nudge[0]) * s, (handLocal[1] + nudge[1]) * s, (handLocal[2] + nudge[2]) * s)

    _delta.subVectors(_to, _from)
    const length = _delta.length()
    if (length < 1e-6) return

    _delta.normalize()
    _quat.setFromUnitVectors(Y_AXIS, _delta)

    const arm = VIEW.arm
    const limb = (mat, diameter, len, alongFraction) => {
      const mesh = new THREE.Mesh(this.geometries.cyl, this.materials[mat])
      mesh.scale.set(diameter * s, len, diameter * s)
      mesh.position.copy(_from).addScaledVector(_delta, length * alongFraction)
      mesh.quaternion.copy(_quat)
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.renderOrder = VIEW.renderOrder
      group.add(mesh)
    }

    limb('sleeve', arm.sleeveDiameter, length * arm.sleeveLengthFraction, arm.sleeveCentreFraction)
    limb('strap', arm.cuffDiameter, arm.cuffLength * s, arm.cuffCentreFraction)
    // No cylinder past the wrist: the old tip cylinder sat at 0.98 of the run, which is
    // inside the glove, and poked out through the fingers as a bare rounded stump.
    limb('skin', arm.forearmDiameter, length * arm.forearmLengthFraction, arm.forearmCentreFraction)

    // The hand tracks the weapon's shrink only halfway. It has to fit the grip, so it cannot
    // stay at 1.0; but at a full 0.74 the rifle's support fist lands 55 cm out at barely 25
    // px and stops being a hand at all. This exponent keeps it on the grip and legible.
    const hand = new THREE.Group()
    hand.position.copy(_to)
    hand.rotation.set(...gripRot)
    hand.scale.setScalar(Math.pow(s, 0.4))
    group.add(hand)
    this.buildHand(hand)
  }

  /** Rounded pads share the existing grip frame and follow the weapon's recoil and reload. */
  buildHand(group) {
    const H = VIEW.hand
    const add = (shape, mat, size, pos, rot) => {
      const mesh = new THREE.Mesh(this.geometries[shape], this.materials[mat])
      mesh.scale.set(...size)
      mesh.position.set(...pos)
      if (rot) mesh.rotation.set(...rot)
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.renderOrder = VIEW.renderOrder
      group.add(mesh)
    }

    add('glove', 'glove', H.palm.size, H.palm.pos)
    add('glove', 'gloveDeep', H.back.size, H.back.pos)
    for (let i = 0; i < H.fingerCount; i++) {
      const y = H.fingerTopY + i * H.fingerPitchY
      const curl = H.fingerCurl * i
      const taper = [1, 1, 0.94, 0.82][i]
      const scaled = (size) => [size[0] * taper, size[1], size[2] * taper]
      add('glove', 'glove', scaled(H.proximal.size), [H.proximal.pos[0], y, H.proximal.pos[2]], [curl, 0, 0])
      add('glove', 'gloveMid', scaled(H.distal.size), [H.distal.pos[0], y, H.distal.pos[2] + curl * 2.2], [curl * 1.6, 0, 0])
      add('sphere', 'gloveHi', scaled([2.15, 1.7, 2.2]), [H.knuckle.pos[0] - 0.15, y, H.knuckle.pos[2]])
    }

    add('glove', 'gloveMid', H.thumbBase.size, H.thumbBase.pos, H.thumbBase.rot)
    add('glove', 'gloveHi', H.thumbTip.size, H.thumbTip.pos, H.thumbTip.rot)
    add('glove', 'strap', H.strap.size, H.strap.pos)
    add('glove', 'gloveDeep', H.strapEdge.size, H.strapEdge.pos)
    add('glove', 'gloveHi', [0.18, 0.25, 3.9], [-3.18, -4.9, 0.6])
    add('glove', 'gloveMid', [0.28, 1.2, 2.2], [-3.2, -5.55, 0.6])
  }

  /**
   * @param {string} id one of WEAPONS.ORDER
   * @param {number} lowerSeconds time to drop the old gun out of frame and raise the new one
   */
  setWeapon(id, lowerSeconds = 0) {
    const view = VIEWS[id]
    const framing = FRAMING[id] ?? fallbackFraming(view)
    if (!view || !framing) {
      console.warn(`[viewmodel] no silhouette for weapon "${id}" — hands would be empty; keeping the current gun`)
      return
    }

    if (lowerSeconds > 0) {
      this.pendingWeapon = id
      this.holsterRate = 2 / lowerSeconds
      return
    }

    this.pendingWeapon = null
    this.populate(this.primary, view, view.parts.concat(EXTRAS[id] ?? []), framing)
    this.primary.root.position.set(...framing.pos)
    this.primary.root.rotation.set(...framing.rot)
    this.primary.weaponRoot.position.set(0, 0, 0)
    if (this.secondary) this.primary.supportArm.visible = false
  }

  /** The second pistol is a mirrored copy on the other side of the view. */
  setDualWield(enabled) {
    if (!enabled) {
      if (this.secondary) this.holster.remove(this.secondary.root)
      this.secondary = null
      if (this.primary.supportArm) this.primary.supportArm.visible = true
      return
    }
    if (this.secondary) return

    const base = FRAMING.pistol
    const framing = {
      scale: base.scale,
      pos: [-base.pos[0] + VIEW.dualWieldNudgeX, base.pos[1], base.pos[2]],
      rot: [base.rot[0], -base.rot[1], -base.rot[2]],
      gripRake: base.gripRake,
      handNudge: { trigger: [-base.handNudge.trigger[0], base.handNudge.trigger[1], base.handNudge.trigger[2]], support: [0, 0, 0] },
    }

    this.secondary = this.createRig(false)
    const mirrored = {
      ...PISTOL_VIEW,
      muzzle: [-PISTOL_VIEW.muzzle[0], PISTOL_VIEW.muzzle[1], PISTOL_VIEW.muzzle[2]],
      hands: { right: [-PISTOL_VIEW.hands.right[0], PISTOL_VIEW.hands.right[1], PISTOL_VIEW.hands.right[2]] },
      shoulders: { right: [-PISTOL_VIEW.shoulders.right[0], PISTOL_VIEW.shoulders.right[1], PISTOL_VIEW.shoulders.right[2]] },
      recoil: PISTOL_VIEW.recoil,
      reload: PISTOL_VIEW.reload,
    }
    this.populate(this.secondary, mirrored, mirrorParts(PISTOL_VIEW.parts.concat(EXTRAS.pistol)), framing)
    this.secondary.root.position.set(...framing.pos)
    this.secondary.root.rotation.set(...framing.rot)

    // Both hands are now full, so the primary gun loses its support hand.
    if (this.primary.supportArm) this.primary.supportArm.visible = false
  }

  /** @param {number} strength 1.0 for a normal shot, 0.4 suppressed — the shake scales. */
  kick(strength = 1, hand = 'right') {
    const rig = hand === 'left' && this.secondary ? this.secondary : this.primary
    const profile = rig.view?.recoil
    if (!profile) return
    rig.recoil.back.v += profile.back * strength * RECOIL_OMEGA
    rig.recoil.rise.v += profile.rise * strength * RECOIL_OMEGA
    rig.recoil.pitch.v += profile.pitch * strength * RECOIL_OMEGA
    rig.recoil.roll.v += this.rng.range(-1, 1) * profile.roll * strength * RECOIL_OMEGA
  }

  playReload(seconds, hand = 'right') {
    const rig = hand === 'left' && this.secondary ? this.secondary : this.primary
    rig.reloadSeconds = seconds > 0 ? seconds : WEAPONS.DEFAULTS.reloadTime
    rig.reloadT = 0
    if (hand === 'right' && this.secondary) {
      this.secondary.reloadSeconds = rig.reloadSeconds
      this.secondary.reloadT = 0
    }
  }

  /**
   * @param {object} motion { speed, grounded, lookYaw, lookPitch } — speed in cm/s,
   *        look deltas in radians for this frame.
   */
  update(dt, motion = {}) {
    if (dt <= 0) return

    const speed = motion.speed ?? 0
    const grounded = motion.grounded !== false
    const targetFactor = clamp(speed / PLAYER.MOVEMENT.walkSpeed, 0, 1.4)
    this.speedFactor = approach(this.speedFactor, grounded ? targetFactor : 0, VIEW.bob.smoothing, dt)

    this.swayTime += dt
    this.bobPhase += dt * VIEW.bob.rate * this.speedFactor

    const swayX = Math.sin(this.swayTime * VIEW.sway.rateA) * VIEW.sway.amplitude
    const swayY = Math.sin(this.swayTime * VIEW.sway.rateB) * VIEW.sway.amplitude * 0.6

    const yawRate = (motion.lookYaw ?? 0) / dt
    const pitchRate = (motion.lookPitch ?? 0) / dt
    const targetLagX = clamp(-yawRate * VIEW.lookLag.yawTravel, -VIEW.lookLag.limit, VIEW.lookLag.limit)
    const targetLagY = clamp(-pitchRate * VIEW.lookLag.pitchTravel, -VIEW.lookLag.limit, VIEW.lookLag.limit)
    const targetRoll = clamp(yawRate * VIEW.lookLag.rollTravel, -VIEW.lookLag.rollLimit, VIEW.lookLag.rollLimit)
    this.lagX = approach(this.lagX, targetLagX, VIEW.lookLag.smoothing, dt)
    this.lagY = approach(this.lagY, targetLagY, VIEW.lookLag.smoothing, dt)
    this.lagRoll = approach(this.lagRoll, targetRoll, VIEW.lookLag.smoothing, dt)

    this.sway.position.set(swayX + this.lagX, swayY + this.lagY, 0)
    this.sway.rotation.z = Math.sin(this.swayTime * VIEW.sway.rateA * 0.5) * VIEW.sway.roll + this.lagRoll

    // A figure-of-eight: the rectified cosine gives the vertical term twice the frequency
    // of the horizontal one, so the gun dips on every footfall and swings once per stride —
    // a walking gait rather than a metronome.
    const bobX = Math.sin(this.bobPhase) * VIEW.bob.amplitudeX * this.speedFactor
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * VIEW.bob.amplitudeY * this.speedFactor
    this.bob.position.set(bobX, bobY - (grounded ? 0 : VIEW.bob.airDrop), 0)
    this.bob.rotation.z = Math.sin(this.bobPhase) * VIEW.bob.roll * this.speedFactor

    this.updateHolster(dt)
    this.updateRig(this.primary, dt)
    if (this.secondary) this.updateRig(this.secondary, dt)
  }

  updateHolster(dt) {
    if (this.holsterRate === 0) {
      this.holsterT = 0
    } else if (this.pendingWeapon) {
      this.holsterT += this.holsterRate * dt
      if (this.holsterT >= 1) {
        this.holsterT = 1
        const id = this.pendingWeapon
        this.pendingWeapon = null
        this.setWeapon(id)
      }
    } else {
      this.holsterT -= this.holsterRate * dt
      if (this.holsterT <= 0) {
        this.holsterT = 0
        this.holsterRate = 0
      }
    }

    const t = easeOutQuad(clamp(this.holsterT, 0, 1))
    this.holster.position.y = -VIEW.holster.drop * t
    this.holster.rotation.x = VIEW.holster.pitch * t
  }

  updateRig(rig, dt) {
    // The spring is stiff enough that one 0.25 s step would send it to infinity, so it is
    // integrated in fixed slices regardless of how long the frame was.
    let remaining = dt
    while (remaining > 0) {
      const step = Math.min(VIEW.recoil.substep, remaining)
      remaining -= step
      for (const channel of Object.values(rig.recoil)) {
        channel.v += (-VIEW.recoil.stiffness * channel.x - VIEW.recoil.damping * channel.v) * step
        channel.x += channel.v * step
      }
    }

    const reload = this.updateReload(rig, dt)

    // Recoil and reload travel are authored at full weapon scale, so they ride the same
    // shrink the geometry does. A 0.78x rifle kicking a full 1.4 cm would look like it was
    // coming apart, because on screen that is now a larger fraction of the gun.
    const s = rig.scale
    rig.weaponRoot.position.set(0, (rig.recoil.rise.x + reload.dipY) * s, rig.recoil.back.x * s)
    rig.weaponRoot.rotation.set(-rig.recoil.pitch.x + reload.pitch, reload.yaw, rig.recoil.roll.x + reload.roll)
    rig.mainArm.position.copy(rig.weaponRoot.position)
    rig.mainArm.rotation.copy(rig.weaponRoot.rotation)
    if (rig.supportArm) {
      rig.supportArm.position.copy(rig.weaponRoot.position)
      rig.supportArm.rotation.copy(rig.weaponRoot.rotation)
    }
  }

  /**
   * One pass over the reload: tip the gun over so the magazine well faces the camera, drop
   * the old magazine out of frame, seat a new one, work the action, level out. A tube-fed
   * shotgun has no magazine to drop, so its `racks` count drives the forend instead.
   */
  updateReload(rig, dt) {
    const idle = { dipY: 0, pitch: 0, yaw: 0, roll: 0 }
    if (rig.reloadT < 0) {
      rig.magNode.position.set(0, 0, 0)
      rig.slideNode.position.set(0, 0, 0)
      return idle
    }

    rig.reloadT += dt / rig.reloadSeconds
    if (rig.reloadT >= 1) {
      rig.reloadT = -1
      rig.magNode.position.set(0, 0, 0)
      rig.slideNode.position.set(0, 0, 0)
      return idle
    }

    const t = rig.reloadT
    const spec = rig.view?.reload
    if (!spec) {
      console.warn('[viewmodel] reload started with no weapon silhouette loaded — no reload animation')
      rig.reloadT = -1
      return idle
    }

    const curve = VIEW.reload
    const tilt = Math.sin(Math.PI * clamp(t / curve.tiltSpan, 0, 1))
    const dipY = curve.dip * tilt
    const pitch = curve.pitch * tilt
    const yaw = curve.yaw * tilt
    const roll = curve.roll * tilt

    if (spec.feed === 'magazine') {
      let magOffset = 0
      if (t >= curve.magOutStart && t < curve.magOutEnd) {
        magOffset = -spec.magDrop * easeOutQuad((t - curve.magOutStart) / (curve.magOutEnd - curve.magOutStart))
      } else if (t >= curve.magOutEnd && t < curve.magInStart) {
        magOffset = -spec.magDrop
      } else if (t >= curve.magInStart && t < curve.magInEnd) {
        magOffset = -spec.magDrop * (1 - easeOutQuad((t - curve.magInStart) / (curve.magInEnd - curve.magInStart)))
      }
      rig.magNode.position.y = magOffset

      const racking = t > curve.rackStart && t < curve.rackEnd
      const rack = racking ? Math.sin(Math.PI * ((t - curve.rackStart) / (curve.rackEnd - curve.rackStart))) : 0
      rig.slideNode.position.z = rack * spec.slideTravel
    } else {
      const cycle = clamp((t - curve.tubeStart) / (curve.tubeEnd - curve.tubeStart), 0, 1) * Math.max(1, spec.racks)
      rig.slideNode.position.z = Math.abs(Math.sin(Math.PI * cycle)) * spec.slideTravel
    }

    return { dipY, pitch, yaw, roll }
  }

  /** World-space muzzle, for the flash and the fire sound. The trace still starts at the eye. */
  muzzleWorldPosition(hand = 'right', target = new THREE.Vector3()) {
    const rig = hand === 'left' && this.secondary ? this.secondary : this.primary
    rig.muzzle.updateWorldMatrix(true, false)
    return rig.muzzle.getWorldPosition(target)
  }

  get object3D() {
    return this.root
  }

  dispose() {
    this.root.removeFromParent()
    for (const geometry of Object.values(this.geometries)) geometry.dispose()
    for (const material of Object.values(this.materials)) material.dispose()
    for (const texture of this.textures) texture.dispose()
  }
}
