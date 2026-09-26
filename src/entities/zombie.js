/**
 * zombie.js — all five archetypes off one class, plus the pool that draws them.
 *
 * Simulation is spec/zombies.md. The original is one C++ class stamped by
 * `ConfigureForWave(type, wave)`, with a controller that has no behaviour tree, no blackboard,
 * no perception and no idle state. That is reproduced here in order, including the details that
 * look like mistakes: armor is never wave-scaled, the Spitter's 150 cm melee reach is set and
 * never read, a melee swing lands with zero wind-up, and the melee cooldown is only consumed
 * when damage actually reaches a health pool.
 *
 * Two shipped bugs, and what this port does about them (spec §9 item 8 asks for the decision
 * to be stated rather than silently made):
 *
 *   1. The swipe sound played BEFORE the cooldown guard, so a zombie standing in range
 *      retriggered it every frame — about sixty overlapping plays a second, per zombie.
 *      ZOMBIES.SOUND.swipeGatedByCooldown moves it inside the guard. Flip that flag to false
 *      in rules.js to hear the original.
 *   2. The aggro latch (`onHeardShot`) was written and never read, so a zombie chased from
 *      spawn, at any distance, forever. That is the default here too. `aggroGated: true` on
 *      the pool turns the latch into the idle/alert gate the plumbing was clearly built for.
 *
 * LOOK: there is no skeletal mesh. Every archetype is a procedural rig of primitives merged
 * per bone, so one InstancedMesh per (bone, material) draws every zombie of that archetype in
 * one call — forty-plus bodies cost about sixty draws total, not six hundred. The walk is
 * driven by sine offsets per limb at a deliberately low cadence with a heavy shoulder roll and
 * one dragging leg, because a commuter's stride reads as a pedestrian, not a corpse.
 *
 * Coordinate convention: Z is up, +X is forward, 1 unit = 1 cm, matching rules.js.
 * ZOMBIES.MESH.zOffset (-90) and ZOMBIES.MESH.yawOffset (-90) are deliberately NOT applied:
 * they exist to compensate for SKM_Manny_Simple being authored sideways with its origin at the
 * head, and this rig is authored at the capsule origin already facing +X.
 */

import * as THREE from 'three/webgpu'
import { abs, dot, normalView, positionViewDirection, oneMinus, pow, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { ZOMBIES, WAVES, HEALTH, STATION } from '../game/rules.js'
import { HealthPool } from '../game/health.js'
import { Rng, rng } from '../core/rng.js'
import { bus, EV } from '../core/events.js'
import { ProjectilePool } from './projectile.js'

const ARCHETYPES = ZOMBIES.ARCHETYPES
const AI = ZOMBIES.AI
const MOVE = ZOMBIES.MOVEMENT
const CORPSE = ZOMBIES.CORPSE
const SFX = ZOMBIES.SOUND
const TELEGRAPH = ZOMBIES.ANIM
const SHARED = ZOMBIES.SHARED_DEFAULTS

const TAU = Math.PI * 2
const DEG = Math.PI / 180

/**
 * Pure mesh-construction proportions and animation amplitudes. None of these are gameplay
 * tunables — no simulation value reads them — so they stay out of rules.js, which is reserved
 * for numbers a reviewer diffs against the original C++. The original defined no per-archetype
 * appearance at all (all five shared one mannequin and one material), so every value here is
 * new work whose only job is to make an archetype identifiable by silhouette at 900 cm.
 *
 * Lengths are fractions of the archetype's own capsule, so a Tank at scale 1.45 and a Zerg at
 * 0.55 stay proportioned without a second table.
 */
/**
 * `lean`, `reach`, `kneeLock` and `headCounter` are the four numbers that decide whether a
 * body is a zombie or a shop dummy, and they are all POSE, not geometry — an outline has to
 * survive a standstill, because a stopped zombie is one in melee range with the player looking
 * straight at it, and that is where the first pass left six figures standing to attention.
 *
 *   lean        forward pitch of the chest, in radians, multiplied per body by `slump`. It can
 *               only live on the chest: the legs hang off the pelvis, so pitching the pelvis
 *               to get the same hunch walks the feet off the floor.
 *   headCounter fraction of that lean the neck gives back. Below 1 the head finishes LOWER
 *               than the shoulders, which is the shape; at 1 the head rides level and the
 *               zombie reads as a man leaning over to look at something.
 *   reach       the live arm, raised toward the player. Negative Y swings a hanging limb
 *               forward, so this is stored positive and negated at the joint.
 *   kneeLock    bend the dragging knee never comes out of, moving or stopped.
 */
const SHAPES = Object.freeze({
  base: Object.freeze({
    stance: 'upright',
    limb: 1.0, shoulder: 1.05, torso: 1.0, head: 1.0, neck: 0.84,
    strideCm: 95, idleHz: 0.26,
    legSwing: 0.55, kneeBend: 0.85, armSwing: 0.26, armHang: 0.62, armOut: 0.30,
    roll: 0.17, lean: 0.74, headTilt: 0.34, dragAmp: 0.42, dragBias: 0.22,
    bob: 5, limp: 0.55,
    headCounter: 1.08, reach: 1.30, reachElbow: 0.36, kneeLock: 0.62, hipDrop: 0.07,
  }),
  zerg: Object.freeze({
    stance: 'crawl',
    limb: 0.88, shoulder: 0.9, torso: 1.0, head: 1.15, neck: 1.0,
    strideCm: 55, idleHz: 0.55,
    legSwing: 0.72, kneeBend: 1.05, armSwing: 0.82, armHang: 0.0, armOut: 0.26,
    roll: 0.09, lean: 0.0, headTilt: 0.10, dragAmp: 0.85, dragBias: 0.06,
    bob: 3.5, limp: 0.20,
    headCounter: 1.0, reach: 0, reachElbow: 0, kneeLock: 0, hipDrop: 0,
  }),
  ranged: Object.freeze({
    // Stooped almost double so the bile gut leads the silhouette, with the neck craned back
    // out of it — the one archetype whose head is ABOVE the line of its own spine.
    stance: 'upright',
    limb: 0.78, shoulder: 0.9, torso: 1.0, head: 1.0, neck: 1.45,
    strideCm: 105, idleHz: 0.22,
    legSwing: 0.42, kneeBend: 0.60, armSwing: 0.18, armHang: 0.38, armOut: 0.25,
    roll: 0.22, lean: 0.92, headTilt: -0.07, dragAmp: 0.30, dragBias: 0.30,
    bob: 6, limp: 0.70,
    headCounter: 1.30, reach: 0.62, reachElbow: 0.85, kneeLock: 0.48, hipDrop: 0.10,
  }),
  tank: Object.freeze({
    // Shoulders twice a Shambler's, a head sunk almost to the collarbone, and arms carried so
    // far off the ribs the gap between arm and body is part of the outline. At 1.45 scale the
    // point is that a player reads TANK from the proportions before the armour resolves.
    stance: 'upright',
    limb: 1.62, shoulder: 2.05, torso: 1.55, head: 0.80, neck: 0.46,
    strideCm: 140, idleHz: 0.18,
    legSwing: 0.40, kneeBend: 0.50, armSwing: 0.16, armHang: 0.72, armOut: 0.86,
    roll: 0.13, lean: 0.56, headTilt: 0.30, dragAmp: 0.55, dragBias: 0.16,
    bob: 7, limp: 0.35,
    headCounter: 1.15, reach: 0.78, reachElbow: 0.62, kneeLock: 0.44, hipDrop: 0.05,
  }),
  boss: Object.freeze({
    // `limb` was 1.18 and `reachElbow` 0.42, and together they built something nobody can
    // unsee. At 1.18 a boss limb segment is 2.3:1 length-to-diameter where a human arm is
    // about 3:1, and at 0.42 the raised arm comes up nearly collinear with the view vector, so
    // the two segments telescope into one and the elbow ball (JOINT.elbow, 0.96 of limbR)
    // becomes a bulb on the end of a ribbed shaft — 300 px of it, centre-right of frame, the
    // brightest thing on a 352 cm character. 0.88 gives the segment human proportions and 0.95
    // (the Spitter already runs 0.85) folds the elbow hard enough that the arm reads as
    // shoulder, elbow, fist — three things, at three depths, in that order.
    stance: 'upright',
    limb: 0.88, shoulder: 1.46, torso: 1.22, head: 1.0, neck: 1.0,
    strideCm: 190, idleHz: 0.16,
    legSwing: 0.46, kneeBend: 0.55, armSwing: 0.22, armHang: 0.38, armOut: 0.22,
    roll: 0.15, lean: 0.34, headTilt: 0.12, dragAmp: 0.60, dragBias: 0.14,
    bob: 9, limp: 0.40,
    headCounter: 1.00, reach: 1.06, reachElbow: 0.95, kneeLock: 0.38, hipDrop: 0.04,
  }),
})

/** Surface response. The original gave every zombie the default lit material, which is most of
 *  why the build read as grey boxes; damp flesh under a sodium lamp needs a low-ish roughness. */
const SURFACE = Object.freeze({
  fleshRoughness: 0.76,
  fleshMetalness: 0.04,
  plateRoughness: 0.56,
  plateMetalness: 0.40,
  plateDarken: 0.42,
  // --- Albedo floors ------------------------------------------------------------------------
  //
  // The Conductor measured #0c0807 (L=8.4) over his whole coat and read as a black cutout
  // pasted over the wall. That is not a lighting failure and no rim gain fixes it: his tint is
  // 0x1c1418, linear luminance 0.0069, and `plateDarken` takes the coat to 0.0029. A surface
  // with three thousandths of a reflectance returns nothing no matter how hard the station
  // lights it, so the only thing left to carry him was the rim — which is exactly the "bright
  // outline around a hole" failure the rim was introduced to end.
  //
  // So every body surface gets a floor on its LINEAR LUMINANCE, lifted toward neutral so the
  // hue survives. The Shambler (0.124), Crawler and Spitter are already well clear and are not
  // touched; this moves the Conductor's coat by ~14x and the Tank's armour by ~2.5x, which are
  // the two archetypes a player was measurably unable to see.
  fleshFloorLuminance: 0.030,
  plateFloorLuminance: 0.040,
  // A commuter suit, deliberately off-hue from the khaki skin: under a sodium lamp two warm
  // greys merge into one clay silhouette, and a cold one separates. This is what stops the
  // crowd reading as shop-window dummies.
  // Lifted from 0x2e3440 alongside the darker skin bake below. Cloth is multiplied by the same
  // albedo map the flesh uses, so halving that map halved the garment too; at the old value a
  // jacket came out near enough to black to be a hole in the body rather than a garment on it.
  // It stays well under the skin — a torn coat must read DARKER than what is torn out of it.
  clothColor: 0x3b4353,
  clothRoughness: 0.92,
  // The Conductor's uniform. It used to be built out of `plate`, which is the TANK's armour:
  // metalness 0.62, roughness 0.38. A conductor's greatcoat is wool, and the moment the chest
  // was big enough to face the camera squarely that 0.62 metalness caught the whole environment
  // and the boss came back with a pale plastic bib on. Same colour family as the coat, matte,
  // essentially dielectric — the hard metal is reserved for his cap peak, his spikes and his
  // gauntlet knuckles, which is where hard metal belongs.
  coatRoughness: 0.86,
  coatMetalness: 0.05,
  coatFloorLuminance: 0.030,
  // Sockets, open jaws, matted hair and torn-open wounds. Near-black on purpose — a hole in a
  // body is read by the light that is MISSING from it, not by a colour.
  woundColor: 0x1c0a08,
  woundRoughness: 0.50,
  woundMetalness: 0.18,
  skinEmissiveMaxLuminance: 0.02,
  // Was 1.35 with `toneMapped: false`, which put the Spitter's gut at L=183.8 — brighter than
  // the wet floor beside it and the brightest thing on a body that is otherwise near-black.
  // The glow is tone-mapped now, so scene exposure governs it like everything else, and the
  // ceiling is raised to compensate: still the hottest thing on the platform, no longer a
  // sticker that ignores the grade.
  glowCeiling: 1.9,
  tintJitter: 0.14,
  flashSeconds: 0.09,
  flashGain: 3.2,

  // --- Silhouette light -------------------------------------------------------------------
  //
  // The finding that this file's second pass turns on. rules.js hands the Shambler, Crawler
  // and Tank a dark accent and an emissiveIntensity of 9, and the first pass put that straight
  // on `material.emissive`. A constant emissive adds the SAME radiance to every pixel of a
  // body regardless of which way it faces, so the lamps stop deciding anything: the crowd came
  // out as six evenly-lit green plastic figures with no value structure at all, which is the
  // "smooth pale mannequin" verdict almost by construction.
  //
  // The same energy at a grazing angle instead draws the OUTLINE. A body standing in front of
  // brick at the same luminance is separated by a bright edge a couple of pixels wide, exactly
  // the way a real wet body catches a wall wash, and the interior is handed back to the sodium
  // lamps so the hunch, the reaching arm and the sunken face can be read as form.
  //
  // `rimFloor` is the one flat part that survives — a sliver, so a body in a lamp's shadow is
  // still not a black hole, and far below the old constant.
  // Measured: at power 2.4 and gain 1.55 the term was still 0.3-0.8 over most of a rounded
  // shoulder, so it stopped being an edge and became a coat of paint — the crowd came back as
  // mint-green wireframe ghosts and the Conductor as a lavender balloon. Power 5.2 collapses it
  // to roughly the outer eighth of a curved surface, which is where a rim belongs.
  //
  // 5.2 was still not enough, and the reason is geometric rather than aesthetic: a body is ~60
  // OVERLAPPING ellipsoids, and every one of them has its own grazing band wherever it
  // protrudes from its neighbour. At 5.2 the term was measurably drawing about twenty separate
  // closed loops on one Shambler — head dome, goggle band, each shoulder, every limb segment,
  // every finger — which is an x-ray shader, not light on a body. 10.2 narrows the band to
  // sub-pixel on anything as small as a finger or a seam while leaving the body's true outline
  // intact, and the flesh gain comes down with it because flesh is where all twenty loops were.
  // It can be pushed this far now only because of the albedo floors above: the rim used to be
  // the ONLY thing drawing a dark body, so thinning it would have deleted the body. Now the
  // lamps draw the body and the rim is free to go back to being an edge.
  rimPower: 10.2,
  rimFleshGain: 0.38,
  // Plate goes UP rather than down, against the shape of the other two. The Conductor's coat
  // and the Tank's pauldrons are plate, they are ONE large form each rather than a stack of
  // small ones, and they are the two silhouettes a player could not find. Plate has no internal
  // seam problem to solve, so it gets the strongest edge of the three.
  rimPlateGain: 0.52,
  rimClothGain: 0.34,
  rimFloor: 0.016,
  // How much of the archetype's own accent survives in the rim. The rest is the station's own
  // cold wall wash: a pure-accent edge reads as a neon outline, a mostly-cold one reads as
  // LIGHT landing on a body, and the residual hue is still enough to tell a Tank from a
  // Shambler across the platform.
  //
  // 0.36 was what made the crowd MINT: the Shambler accent 0x0b2910 normalises to (0.26, 1.00,
  // 0.24), and a third of the way from the cold wall wash toward pure green lands at #7ccf9f.
  // 0.16 keeps a species hue you can still name at distance and hands the edge back to the
  // station.
  rimAccentMix: 0.16,
  // The Spitter and the Conductor are the two archetypes whose accent is a LAMP colour rather
  // than a grime warmth, so they take a separate, much stronger mix. This is the fix for the
  // Conductor reading as a value-identical black mass against the wall: at 0.36 * 0.35 = 0.126
  // his furnace red never reached his own edge, and the only thing separating boss from
  // background was the chest logo. His coat is the whole silhouette and it is entitled to burn.
  //
  // It is faded out against the BODY's own colour rather than applied flat, because the two
  // archetypes want opposite things from it. The Conductor is near-black (tint luminance
  // 0.0069) and his edge has to carry his entire identity, so he takes nearly all of it and
  // comes out furnace red instead of the mauve that half a mix of red into a cold blue wash
  // produces. The Spitter is already a legible bile green and takes the floor of a quarter,
  // because a full-strength green outline on him reads as the spit tell firing two seconds
  // early and costs the gut its whole job.
  rimLampAccentMix: 0.72,
  rimAccentFadeLuminance: 0.09,
  rimLampAccentFloor: 0.25,
  rimColdHex: 0x9db3d6,
})

const BONE = Object.freeze({
  ROOT: 0, PELVIS: 1, CHEST: 2, HEAD: 3,
  ARM_UL: 4, ARM_FL: 5, ARM_UR: 6, ARM_FR: 7,
  LEG_UL: 8, LEG_FL: 9, LEG_UR: 10, LEG_FR: 11,
})
const BONE_PARENT = Object.freeze([-1, 0, 1, 2, 2, 4, 2, 6, 1, 8, 1, 10])
const BONE_COUNT = BONE_PARENT.length

/**
 * Segment radii at each joint, as multiples of the archetype's own `limbR`. They are a
 * continuous descending series down each chain (shoulder > elbow > wrist, hip > knee > ankle),
 * which is both what a gaunt limb does and what guarantees the sphere at a joint is never
 * narrower than the segment arriving at it.
 */
const JOINT = Object.freeze({
  shoulder: 1.24, elbow: 0.96, wrist: 0.70,
  hip: 1.54, knee: 1.14, ankle: 0.80,
})

const ARM_BONES = Object.freeze([BONE.ARM_UL, BONE.ARM_UR])
const FOREARM_BONES = Object.freeze([BONE.ARM_FL, BONE.ARM_FR])
const THIGH_BONES = Object.freeze([BONE.LEG_UL, BONE.LEG_UR])
const SHIN_BONES = Object.freeze([BONE.LEG_FL, BONE.LEG_FR])

// ---------------------------------------------------------------------------
// Geometry helpers. Each returns a primitive already positioned in its bone's local frame,
// because everything is baked and merged once per archetype and never transformed again.
// ---------------------------------------------------------------------------

/**
 * One tile of skin covers this many centimetres. Every primitive arrives from three with its
 * UVs normalised to 0..1, so a head sphere and a thigh capsule would each get the whole flesh
 * texture stretched over them and the crowd would read as clay at two different scales.
 * Rescaling each primitive's UVs by its own size fixes the density.
 */
const FLESH_TEXEL_CM = 52

/**
 * `aroundCm` is the axis that WRAPS (three already duplicated the seam vertices there), so it
 * is rounded to a whole number of repeats or the two halves of the seam land on different
 * parts of the tile and the limb splits down one side.
 */
function fitUV(g, aroundCm, alongCm) {
  const uv = g.attributes.uv
  if (!uv) return g
  const u = Math.max(1, Math.round(aroundCm / FLESH_TEXEL_CM))
  const v = Math.max(0.4, alongCm / FLESH_TEXEL_CM)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v)
  uv.needsUpdate = true
  return g
}

function ellipsoid(rx, ry, rz, x = 0, y = 0, z = 0, segW = 12, segH = 9) {
  const g = new THREE.SphereGeometry(1, segW, segH)
  g.scale(rx, ry, rz)
  fitUV(g, Math.PI * (rx + ry), Math.PI * rz)
  g.translate(x, y, z)
  return g
}

function slab(dx, dy, dz, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(dx, dy, dz)
  fitUV(g, dx + dy, dz)
  g.translate(x, y, z)
  return g
}

/** A limb hanging from its bone origin down the local -Z, so a bone rotation swings it. */
function limb(radius, length) {
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 3, 10)
  fitUV(g, TAU * radius, length)
  g.rotateX(Math.PI / 2)
  g.translate(0, 0, -length / 2)
  return g
}

/**
 * A limb that is THICKER at the joint it hangs from than at the one it ends on, capped with a
 * sphere at each end.
 *
 * The boss frame is what forced this. A uniform capsule whose length is only two and a half
 * times its diameter is a pill, and four pills in a row down an arm read as four separate
 * objects — at scale 2.0 the Conductor came out as a stack of disconnected ovoids, which is
 * the "floating pieces" finding, and it was never a parenting bug: every bone was attached
 * exactly as intended and the SHAPES still read as loose. A taper gives the eye a continuous
 * line to follow from shoulder to wrist, and the end spheres are sized to whatever joins them,
 * so no bend in the pose ranges can open a step at a joint.
 *
 * @param {number} rTop radius at the bone origin @param {number} rBottom radius at the far end
 */
function taperedLimb(rTop, rBottom, length, segW = 10, segH = 7) {
  const parts = []
  const side = new THREE.CylinderGeometry(rTop, rBottom, length, segW, 1, true)
  fitUV(side, Math.PI * (rTop + rBottom), length)
  side.rotateX(Math.PI / 2)
  side.translate(0, 0, -length / 2)
  parts.push(side)
  parts.push(ellipsoid(rTop, rTop, rTop, 0, 0, 0, segW, segH))
  parts.push(ellipsoid(rBottom, rBottom, rBottom, 0, 0, -length, segW, segH))
  const merged = mergeGeometries(parts, false)
  if (!merged) return limb((rTop + rBottom) * 0.5, length)
  for (const p of parts) p.dispose()
  return merged
}

/**
 * A limb small enough that nobody will ever count its facets — fingers, sleeve tongues. Six
 * sides instead of ten, and it matters: there are eighteen of these on every body, every body
 * is one InstancedMesh draw regardless, and the bill that IS paid per body is vertex count.
 */
const tinyLimb = (rTop, rBottom, length) => taperedLimb(rTop, rBottom, length, 6, 4)

/** Cone with its base at the origin and its apex at +Z, then pitched and placed. */
function spike(radius, length, pitch, x, y, z) {
  const g = new THREE.ConeGeometry(radius, length, 6)
  fitUV(g, TAU * radius, length)
  g.rotateX(Math.PI / 2)
  g.translate(0, 0, length / 2)
  if (pitch) g.rotateY(pitch)
  g.translate(x, y, z)
  return g
}

/** Flat disc lying in the XY plane — cap brims, shoulder pads. */
function disc(radius, thickness, x = 0, y = 0, z = 0) {
  const g = new THREE.CylinderGeometry(radius, radius, thickness, 14)
  fitUV(g, TAU * radius, radius * 2)
  g.rotateX(Math.PI / 2)
  g.translate(x, y, z)
  return g
}

/** Deterministic value noise. Never rng: baked geometry must be identical on every run. */
function hash3(x, y, z) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
  return v - Math.floor(v)
}

/**
 * Bakes grime into vertex colours: dirt pools at the floor and the light finds the shoulders.
 * Without it a zombie is one flat albedo under one lamp, which is precisely the look the
 * original build was abandoned over. STATION.MATERIALS.grimeStrength is the station's own
 * constant for exactly this kind of darkening, so the crowd and the concrete agree.
 *
 * `boneZ` is the bone's rest height above the capsule centre, summed down the hierarchy
 * ignoring rest rotations — exact for the upright rigs, close enough for the Crawler.
 */
function applyGrime(geometry, boneZ, dims) {
  const position = geometry.attributes.position
  const colors = new Float32Array(position.count * 3)
  const span = dims.H * 2
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = boneZ + position.getZ(i)
    const up = clamp((z + dims.H) / span, 0, 1)
    const dirt = 1 - STATION.MATERIALS.grimeStrength * (1 - up) * (1 - up)
    const grain = 0.92 + 0.08 * hash3(x, y, z)
    const shade = dirt * grain
    // Dried blood and bruising, painted into the same vertex colours the dirt gradient is
    // already writing: no extra geometry, no extra draw call, no extra texture binding. The
    // bias leaves roughly a third of the surface marked, so a body reads as DAMAGED rather
    // than as a red body — a zombie that has taken four rifle rounds should not look showroom.
    const gore = clamp(blotch3(x, y, z, 11) * 2.7 - 1.32, 0, 1)
    // A second, coarser field: bruising, which is DARK rather than red and pools where a body
    // has been hit. Without it the blood reads as paint, because real damage takes value out
    // of a surface before it puts colour into it.
    const bruise = clamp(blotch3(x * 0.42, y * 0.42, z * 0.42 + 40, 17) * 2.1 - 1.02, 0, 1)
    const damaged = shade * (1 - 0.46 * bruise)
    colors[i * 3] = damaged * (1 + 0.10 * gore)
    colors[i * 3 + 1] = damaged * (0.96 - 0.62 * gore) * (1 - 0.10 * bruise)
    colors[i * 3 + 2] = damaged * (0.90 - 0.70 * gore)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/** Truncated cone hanging down the local -Z — coat skirts, necks. */
function tube(radiusTop, radiusBottom, length, x = 0, y = 0, z = 0) {
  const g = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 14, 1, true)
  fitUV(g, Math.PI * (radiusTop + radiusBottom), length)
  g.rotateX(Math.PI / 2)
  g.translate(x, y, z - length / 2)
  return g
}

/** `tube` flattened front-to-back, so a jacket hem reads as cloth over a torso and not as a
 *  barrel hooped round it. */
function hem(radiusTop, radiusBottom, length, squashX, x = 0, y = 0, z = 0) {
  const g = tube(radiusTop, radiusBottom, length)
  g.scale(squashX, 1, 1)
  g.translate(x, y, z)
  return g
}


// ---------------------------------------------------------------------------
// The flesh surface.
//
// This is the finding the whole rebuild turns on. The enemy the player shoots twenty-seven
// times a run had NO texture of any kind: one flat khaki multiplied by a curvature gradient,
// which is precisely the "clay mannequin" verdict the Unreal build died on. materials.js keeps
// its bakers private to the station and tiles them for a 6000 cm wall, so the character set
// bakes here at its own texel density — same architecture though: one albedo, one packed ORM
// (G = roughness, B = metalness, the glTF convention three samples natively) and one normal
// derived from the same height field, so a body costs three bindings instead of four.
//
// Seeded from a constant, never Math.random(): the frame gate diffs real pixels between runs
// and a texture that changed on reload would make every capture a false negative.
// ---------------------------------------------------------------------------

const FLESH_BAKE_SIZE = 512
const FLESH_SEED = 0x5f1e5b

const mix01 = (a, b, t) => a + (b - a) * t
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smoothEdge = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

/** Value noise that wraps in both axes, so the tile has no seam when a limb repeats it. */
function wrapNoise(r, cells) {
  const grid = new Float32Array(cells * cells)
  for (let i = 0; i < grid.length; i++) grid[i] = r.next()
  return (u, v) => {
    const x = u * cells
    const y = v * cells
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const sx = (x - x0) * (x - x0) * (3 - 2 * (x - x0))
    const sy = (y - y0) * (y - y0) * (3 - 2 * (y - y0))
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

function wrapFbm(r, baseCells, octaves) {
  const layers = []
  let cells = baseCells
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    layers.push({ noise: wrapNoise(r, cells), amp })
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

function fleshCanvas() {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = c.height = FLESH_BAKE_SIZE
  return c
}

function fleshTexture(canvas, colorSpace) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = colorSpace
  tex.anisotropy = 16 // a limb seen edge-on across the platform is nearly all grazing angle
  tex.needsUpdate = true
  return tex
}

/** OpenGL-convention tangent-space normals from a wrapping height field. */
function fleshNormalMap(height, strength) {
  const size = FLESH_BAKE_SIZE
  const canvas = fleshCanvas()
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
  return fleshTexture(canvas, THREE.NoColorSpace)
}

let _fleshMaps = null

/**
 * Dead skin: uneven sallow base, necrotic blotches sunk into it, and dried blood running DOWN
 * out of the blotches because that is the direction it ran when the body was still upright.
 * The wounds come out low-roughness and slightly conductive so they read WET against dry skin,
 * which is the whole reason a zombie in a lit station stops looking like moulded plastic.
 */
function bakeFlesh() {
  if (_fleshMaps) return _fleshMaps
  const albedoCanvas = fleshCanvas()
  if (!albedoCanvas) {
    console.error(
      '[zombie] no DOM: the flesh texture cannot bake, so every body falls back to one flat ' +
      'tint — the exact clay-mannequin look this rig exists to prevent.',
    )
    _fleshMaps = {}
    return _fleshMaps
  }

  const size = FLESH_BAKE_SIZE
  const ormCanvas = fleshCanvas()
  const albedoCtx = albedoCanvas.getContext('2d')
  const ormCtx = ormCanvas.getContext('2d')
  const albedo = albedoCtx.createImageData(size, size)
  const encodedAlbedo = new THREE.Color()
  const orm = ormCtx.createImageData(size, size)
  const height = new Float32Array(size * size)

  const r = new Rng(FLESH_SEED)
  const skinField = wrapFbm(r, 6, 4)
  const blotchField = wrapFbm(r, 14, 4)
  const runField = wrapFbm(r, 11, 4)
  const poreField = wrapFbm(r, 44, 2)

  let maxRough = 0
  let maxMetal = 0
  const rough = new Float32Array(size * size)
  const metal = new Float32Array(size * size)

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const s = skinField(u, v)
      // Widened from 0.58-0.76. At the old threshold necrosis covered about a sixth of the
      // surface and a body was mostly clean skin with a few spots; at 0.44 it covers nearer
      // half, which is what makes a crowd read as MOTTLED at the distance it is seen from
      // rather than as one flat tone with detail nobody can resolve.
      const rot = smoothEdge(0.44, 0.72, blotchField(u, v))
      // Stretched eight to one along v: blood runs, it does not pool in circles.
      const run = smoothEdge(0.50, 0.82, runField(u, v / 8)) * (0.25 + 0.75 * rot)
      const pore = 0.88 + 0.26 * poreField(u, v)

      // Linear reflectance modulation retains pores and rot beneath the archetype tint.
      // Encoding these values as sRGB below avoids decoding and darkening them twice.
      let cr = (0.38 + 0.20 * s) * pore
      let cg = (0.34 + 0.17 * s) * pore
      let cb = (0.27 + 0.14 * s) * pore
      // Necrosis and dried blood now go most of the way to black. Against a base that is half
      // what it was, a blotch that only reached 0.16 would have stopped being a blotch.
      cr = mix01(cr, 0.075, rot); cg = mix01(cg, 0.052, rot); cb = mix01(cb, 0.044, rot)
      cr = mix01(cr, 0.155, run); cg = mix01(cg, 0.028, run); cb = mix01(cb, 0.024, run)

      const p = y * size + x
      const i = p * 4
      // Reflectance is linear; the color texture is decoded from sRGB by the renderer.
      encodedAlbedo.setRGB(clamp01(cr), clamp01(cg), clamp01(cb), THREE.LinearSRGBColorSpace).convertLinearToSRGB()
      albedo.data[i] = encodedAlbedo.r * 255
      albedo.data[i + 1] = encodedAlbedo.g * 255
      albedo.data[i + 2] = encodedAlbedo.b * 255
      albedo.data[i + 3] = 255

      const wet = Math.max(rot * 0.65, run)
      rough[p] = mix01(0.72, 0.24, wet)
      metal[p] = 0.03 + 0.19 * run
      if (rough[p] > maxRough) maxRough = rough[p]
      if (metal[p] > maxMetal) maxMetal = metal[p]
      height[p] = rot * 0.62 + run * 0.14 + s * 0.24
    }
  }

  // Both channels normalise to their own maximum, because three MULTIPLIES the map by
  // material.roughness / material.metalness — so SURFACE.fleshRoughness stays the roughest
  // this skin ever gets and the map only ever varies downward from it.
  const roughScale = maxRough > 0 ? 255 / maxRough : 0
  const metalScale = maxMetal > 0 ? 255 / maxMetal : 0
  for (let p = 0; p < rough.length; p++) {
    const i = p * 4
    orm.data[i] = 255 // AO slot, unsampled — left neutral
    orm.data[i + 1] = rough[p] * roughScale
    orm.data[i + 2] = metal[p] * metalScale
    orm.data[i + 3] = 255
  }

  albedoCtx.putImageData(albedo, 0, 0)
  ormCtx.putImageData(orm, 0, 0)

  _fleshMaps = {
    map: fleshTexture(albedoCanvas, THREE.SRGBColorSpace),
    ormMap: fleshTexture(ormCanvas, THREE.NoColorSpace),
    normalMap: fleshNormalMap(height, 5.0),
  }
  return _fleshMaps
}

/**
 * Smoothed value noise on a `cellCm` lattice, in the body's own local space.
 * `hash3` on its own is per-vertex speckle; a bruise or a dried splatter is ten centimetres
 * across, which spans several vertices, so it has to be interpolated to read as a blotch.
 */
function blotch3(x, y, z, cellCm) {
  const fx = x / cellCm
  const fy = y / cellCm
  const fz = z / cellCm
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const z0 = Math.floor(fz)
  const ease = (t) => t * t * (3 - 2 * t)
  const tx = ease(fx - x0)
  const ty = ease(fy - y0)
  const tz = ease(fz - z0)
  const lerp = (a, b, t) => a + (b - a) * t
  const c = (i, j, k) => hash3(x0 + i, y0 + j, z0 + k)
  const z00 = lerp(c(0, 0, 0), c(1, 0, 0), tx)
  const z10 = lerp(c(0, 1, 0), c(1, 1, 0), tx)
  const z01 = lerp(c(0, 0, 1), c(1, 0, 1), tx)
  const z11 = lerp(c(0, 1, 1), c(1, 1, 1), tx)
  return lerp(lerp(z00, z10, ty), lerp(z01, z11, ty), tz)
}

// ---------------------------------------------------------------------------
// Rig construction — bone rest pose plus the primitives bolted to each bone.
// ---------------------------------------------------------------------------

/** Body measurements derived from the archetype's own collision capsule, pre-scale. */
function dimensionsFor(arch, shape) {
  const H = arch.capsuleHalfHeight
  const R = arch.capsuleRadius
  const T = H * 2
  const d = {
    H, R, T,
    hipZ: -H + T * 0.46,
    shoulderZ: -H + T * 0.80,
    headZ: -H + T * 0.905,
    headR: T * 0.075 * shape.head,
    thigh: T * 0.23,
    shin: T * 0.23,
    upperArm: T * 0.195,
    foreArm: T * 0.185,
    limbR: T * 0.036 * shape.limb,
    shoulderY: R * 0.62 * shape.shoulder,
    hipY: R * 0.40,
    torsoW: R * 0.55 * shape.torso,
    torsoD: R * 0.36 * shape.torso,
  }
  if (shape.stance === 'crawl') {
    // A crawler's spine runs along +X instead of +Z: the chest sits forward of the hips, the
    // head is slung low in front of it, and all four limbs reach the floor from that spine.
    d.hipZ = -H + T * 0.50
    d.spineRun = T * 0.34
    d.neckRun = T * 0.20
    d.thigh = T * 0.30
    d.shin = T * 0.26
    d.upperArm = T * 0.30
    d.foreArm = T * 0.28
    d.torsoW = R * 0.70
    d.torsoD = R * 0.62
  }
  // The head sinks toward the shoulders on a no-neck archetype and rides high on a long one.
  d.headZ = d.shoulderZ + (d.headZ - d.shoulderZ) * shape.neck
  d.torsoLen = d.shoulderZ - d.hipZ
  return d
}

function restPose(shape, d) {
  const pos = new Float32Array(BONE_COUNT * 3)
  const rot = new Float32Array(BONE_COUNT * 3)
  const setP = (b, x, y, z) => { pos[b * 3] = x; pos[b * 3 + 1] = y; pos[b * 3 + 2] = z }
  const setR = (b, x, y, z) => { rot[b * 3] = x; rot[b * 3 + 1] = y; rot[b * 3 + 2] = z }

  if (shape.stance === 'crawl') {
    setP(BONE.PELVIS, 0, 0, d.hipZ)
    setP(BONE.CHEST, d.spineRun, 0, d.T * 0.06)
    setP(BONE.HEAD, d.neckRun, 0, -d.T * 0.05)
    setP(BONE.ARM_UL, d.T * 0.04, d.shoulderY, -d.T * 0.02)
    setP(BONE.ARM_UR, d.T * 0.04, -d.shoulderY, -d.T * 0.02)
    setP(BONE.ARM_FL, 0, 0, -d.upperArm)
    setP(BONE.ARM_FR, 0, 0, -d.upperArm)
    setP(BONE.LEG_UL, -d.T * 0.02, d.hipY, 0)
    setP(BONE.LEG_UR, -d.T * 0.02, -d.hipY, 0)
    setP(BONE.LEG_FL, 0, 0, -d.thigh)
    setP(BONE.LEG_FR, 0, 0, -d.thigh)
    // Forelimbs rake forward, hind legs splay outward and back: an insectile crouch, so the
    // Crawler never silhouettes as a small upright man.
    setR(BONE.ARM_UL, 0.34, -0.55, 0)
    setR(BONE.ARM_UR, -0.34, -0.55, 0)
    setR(BONE.ARM_FL, -0.30, 0.95, 0)
    setR(BONE.ARM_FR, 0.30, 0.95, 0)
    setR(BONE.LEG_UL, 0.62, 0.70, 0)
    setR(BONE.LEG_UR, -0.62, 0.70, 0)
    setR(BONE.LEG_FL, -0.30, -1.15, 0)
    setR(BONE.LEG_FR, 0.30, -1.15, 0)
    return { pos, rot }
  }

  setP(BONE.PELVIS, 0, 0, d.hipZ)
  setP(BONE.CHEST, 0, 0, d.torsoLen)
  setP(BONE.HEAD, 0, 0, d.headZ - d.shoulderZ)
  setP(BONE.ARM_UL, 0, d.shoulderY, -d.limbR * 0.4)
  setP(BONE.ARM_UR, 0, -d.shoulderY, -d.limbR * 0.4)
  setP(BONE.ARM_FL, 0, 0, -d.upperArm)
  setP(BONE.ARM_FR, 0, 0, -d.upperArm)
  setP(BONE.LEG_UL, 0, d.hipY, 0)
  setP(BONE.LEG_UR, 0, -d.hipY, 0)
  setP(BONE.LEG_FL, 0, 0, -d.thigh)
  setP(BONE.LEG_FR, 0, 0, -d.thigh)
  return { pos, rot }
}

/**
 * A head that is not a shop dummy.
 *
 * This is the three-metre moment the whole game rests on, and a smooth egg with two bright
 * pips glued to the front of it reads as a department-store mannequin no matter how good the
 * lighting behind it is. What actually sells a face at that range, in that order: a BROW that
 * throws a shadow, a SOCKET darker than the skin around it, and a GAP where the jaw separates.
 * The pupil is the smallest part of it and it sits INSIDE the socket, not proud of the cheek —
 * a glowing sphere at 86 % of the head radius is a button sewn on, which is what was there.
 *
 * `rx, ry, rz` are the cranium's half-axes in units of headR, so the long flat crawler skull
 * and the upright one both place their features on their own surface off one function.
 */
function faceParts(add, headR, rx, ry, rz) {
  const R = headR

  // The brow first, because everything else is read against the shadow it throws. It is an
  // ellipsoid rather than the slab that was here, so its top edge is a lit curve and its
  // underside is a hard dark line; and it carries right out to the temples, where a real
  // supraorbital ridge turns the corner and the cranium falls away behind it.
  add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.27, R * ry * 0.92, R * rz * 0.17, R * rx * 0.74, 0, R * rz * 0.35))

  for (const s of [1, -1]) {
    // The socket is nearly a third of the head deep and it sits BEHIND the brow, so the ridge
    // above overhangs it by about a quarter of the head's radius. Additive geometry cannot cut
    // a hole, so a sunken eye has to be built the way a sculptor builds one: a dark mass at
    // the surface, with lit bone proud of it on three sides.
    add(BONE.HEAD, 'wound', ellipsoid(R * rx * 0.30, R * ry * 0.33, R * rz * 0.33, R * rx * 0.62, s * R * ry * 0.40, R * rz * 0.02))
    // The pupil, small and well back inside the socket. The first pass put an R*0.11 sphere at
    // 0.88 of the head radius, which is a bead sewn onto the cheek — the light in a dead eye
    // has to come out of a hole or it reads as a doll.
    add(BONE.HEAD, 'glow', ellipsoid(R * 0.085, R * 0.085, R * 0.085, R * rx * 0.76, s * R * ry * 0.40, R * rz * 0.02))
    // Cheekbone. The one piece of lit bone under the eye is what makes a face read as GAUNT
    // rather than smooth, and it is the only feature on this head visible in pure rim light.
    add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.24, R * ry * 0.27, R * rz * 0.21, R * rx * 0.70, s * R * ry * 0.54, -R * rz * 0.22))
    // The hollow above it, where the temple has sunk in.
    add(BONE.HEAD, 'wound', ellipsoid(R * rx * 0.16, R * ry * 0.20, R * rz * 0.26, R * rx * 0.34, s * R * ry * 0.82, R * rz * 0.22))
    add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.10, R * ry * 0.12, R * rz * 0.22, R * rx * 0.02, s * R * ry * 0.96, R * rz * 0.06))
  }

  // Nose: a bridge running down off the brow, and the cavity where the rest of it rotted away.
  add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.20, R * ry * 0.11, R * rz * 0.26, R * rx * 0.84, 0, R * rz * 0.06))
  add(BONE.HEAD, 'wound', ellipsoid(R * rx * 0.14, R * ry * 0.15, R * rz * 0.12, R * rx * 0.88, 0, -R * rz * 0.22))

  // The open mouth, in three pieces: an upper gum line still attached to the skull, a cavity
  // black enough to read as a hole at twenty metres, and a mandible hanging below it with
  // daylight between the two. The GAP is the point — a closed mouth is a line, and a line
  // disappears at range, where a notch out of the jaw line does not.
  add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.20, R * ry * 0.46, R * rz * 0.09, R * rx * 0.76, 0, -R * rz * 0.42))
  add(BONE.HEAD, 'wound', ellipsoid(R * rx * 0.26, R * ry * 0.50, R * rz * 0.24, R * rx * 0.62, 0, -R * rz * 0.60))

  // Matted hair. A bare cranium is the single strongest mannequin cue on a human silhouette —
  // but the first pass sat this nearly concentric with the skull at 0.98 of its radius, and it
  // ate the entire face: every head in the capture was a brown cap with a chin under it. It is
  // a CAP on the back of the crown now, pulled back far enough that the brow is clear.
  add(BONE.HEAD, 'wound', ellipsoid(R * rx * 0.82, R * ry * 0.90, R * rz * 0.60, -R * rx * 0.42, 0, R * rz * 0.52))
}

/**
 * The lower jaw, hung off the skull with the mouth cavity between them.
 *
 * Separate from `faceParts` because a Crawler's mandible sits at the front of a long flat
 * skull and an upright one sits under it, and both want the same three lumps in the same
 * proportions — only the frame they are placed in differs.
 */
function jawParts(add, headR, rx, ry, rz) {
  const R = headR
  add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.30, R * ry * 0.52, R * rz * 0.19, R * rx * 0.64, 0, -R * rz * 0.86))
  add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.20, R * ry * 0.26, R * rz * 0.16, R * rx * 0.78, 0, -R * rz * 0.92))
  // The two rami running back up to the hinge, so the jaw is attached to something.
  for (const s of [1, -1]) {
    add(BONE.HEAD, 'flesh', ellipsoid(R * rx * 0.13, R * ry * 0.13, R * rz * 0.30, R * rx * 0.24, s * R * ry * 0.62, -R * rz * 0.62))
  }
}

/**
 * The clothes he died in.
 *
 * Bare capsule limbs are the loudest mannequin cue in the frame and no amount of skin tint
 * fixes them: the garment has to be a different HUE from the flesh, and it has to END
 * somewhere ragged. Sleeves stop mid-bicep and trousers above the knee, so the silhouette
 * reads torn rather than tailored and there is still bare forearm and shin to bleed on.
 */
function clothParts(add, d) {
  const { limbR, torsoW, torsoD, torsoLen, upperArm, thigh } = d
  add(BONE.CHEST, 'cloth', ellipsoid(torsoD * 1.14, torsoW * 1.12, torsoLen * 0.44, 0, 0, -torsoLen * 0.32))
  add(BONE.CHEST, 'cloth', hem(torsoW * 1.04, torsoW * 0.88, torsoLen * 0.42, 0.74, 0, 0, -torsoLen * 0.04))
  add(BONE.CHEST, 'cloth', slab(torsoD * 0.42, torsoW * 1.85, torsoLen * 0.13, torsoD * 0.58, 0, -torsoLen * 0.05))

  // Sleeves and trouser legs that END RAGGED. A garment that stops on a clean circle is a
  // tailored garment, and a tailored garment on a corpse puts the silhouette straight back in
  // the shop window. Three overlapping tongues of different lengths per limb, in a value well
  // under the skin, so the outline breaks twice on the way down every arm and leg.
  for (const b of ARM_BONES) {
    add(b, 'cloth', taperedLimb(limbR * 1.34, limbR * 1.16, upperArm * 0.58))
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4
      const tongue = tinyLimb(limbR * 0.62, limbR * 0.40, upperArm * (0.22 + 0.16 * (i % 2)))
      tongue.translate(Math.cos(a) * limbR * 0.92, Math.sin(a) * limbR * 0.92, -upperArm * 0.52)
      add(b, 'cloth', tongue)
    }
  }
  for (const b of THIGH_BONES) {
    add(b, 'cloth', taperedLimb(limbR * 1.58, limbR * 1.32, thigh * 0.70))
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU
      const tongue = tinyLimb(limbR * 0.74, limbR * 0.46, thigh * (0.20 + 0.18 * (i % 2)))
      tongue.translate(Math.cos(a) * limbR * 1.06, Math.sin(a) * limbR * 1.06, -thigh * 0.64)
      add(b, 'cloth', tongue)
    }
  }
}

/**
 * Bite and exit wounds, in the `wound` material so they sit under the lamp as dark wet holes.
 * Deliberately placed OUTSIDE whatever garment covers that bone, because a wound under a
 * jacket is a wound nobody ever sees.
 */
function woundParts(add, d) {
  const { limbR, torsoW, torsoD, torsoLen, upperArm, foreArm, shin } = d

  // FLATTENED against the surface, not bulging out of it. The first pass gave these a full
  // radius on the outward axis, so on a Conductor at scale 2.0 they came back as perfectly
  // round black spheres stuck to the shoulders — portholes in a balloon. A wound is a dent
  // with a lip, so the outward axis is a quarter of the others and the lens breaks the skin
  // by a couple of centimetres instead of hanging off it.
  const gash = (bone, out, along, across, deep, x, y, z) =>
    add(bone, 'wound', ellipsoid(deep, across, along, x, y, z))

  gash(BONE.CHEST, 0, torsoLen * 0.13, torsoW * 0.30, torsoD * 0.12, torsoD * 1.02, torsoW * 0.28, -torsoLen * 0.38)
  gash(BONE.CHEST, 0, torsoLen * 0.15, torsoW * 0.16, torsoD * 0.10, torsoD * 0.52, -torsoW * 0.92, -torsoLen * 0.22)
  gash(BONE.ARM_UL, 0, limbR * 0.74, limbR * 0.48, limbR * 0.16, limbR * 1.06, 0, -upperArm * 0.30)
  gash(BONE.ARM_FR, 0, limbR * 0.66, limbR * 0.40, limbR * 0.13, limbR * 0.76, 0, -foreArm * 0.45)
  gash(BONE.LEG_FR, 0, limbR * 0.80, limbR * 0.44, limbR * 0.15, limbR * 0.94, 0, -shin * 0.42)
}

/** @returns {Array<{bone:number, role:string, geometry:THREE.BufferGeometry}>} */
function partsFor(id, shape, d) {
  const out = []
  const add = (bone, role, geometry) => out.push({ bone, role, geometry })
  const { limbR, torsoW, torsoD, torsoLen, headR, upperArm, foreArm, thigh, shin, shoulderY } = d

  if (shape.stance === 'crawl') {
    add(BONE.PELVIS, 'flesh', ellipsoid(torsoD * 1.0, torsoW * 1.0, torsoD * 0.85))
    add(BONE.CHEST, 'flesh', ellipsoid(d.spineRun * 0.62, torsoW * 1.05, torsoD * 0.95, -d.spineRun * 0.30, 0, 0))
    add(BONE.CHEST, 'flesh', ellipsoid(d.spineRun * 0.34, torsoW * 0.82, torsoD * 0.78, d.spineRun * 0.18, 0, 0))
    for (const s of [1, -1]) {
      add(BONE.CHEST, 'plate', spike(torsoD * 0.30, torsoD * 1.25, -0.9, -d.spineRun * 0.25, s * torsoW * 0.45, torsoD * 0.5))
      add(BONE.CHEST, 'plate', spike(torsoD * 0.24, torsoD * 1.0, -1.1, -d.spineRun * 0.62, s * torsoW * 0.38, torsoD * 0.45))
    }
    add(BONE.CHEST, 'cloth', ellipsoid(d.spineRun * 0.56, torsoW * 1.16, torsoD * 1.08, -d.spineRun * 0.26, 0, torsoD * 0.06))
    add(BONE.CHEST, 'wound', ellipsoid(d.spineRun * 0.20, torsoW * 0.30, torsoD * 0.26, -d.spineRun * 0.10, torsoW * 0.62, torsoD * 0.72))
    add(BONE.HEAD, 'flesh', ellipsoid(headR * 1.25, headR * 0.80, headR * 0.80))
    faceParts(add, headR, 1.25, 0.80, 0.80)
    jawParts(add, headR, 1.25, 0.80, 0.80)
  } else {
    add(BONE.PELVIS, 'flesh', ellipsoid(torsoD * 0.95, torsoW * 0.95, torsoLen * 0.22, 0, 0, torsoLen * 0.10))
    add(BONE.CHEST, 'flesh', ellipsoid(torsoD, torsoW, torsoLen * 0.40, 0, 0, -torsoLen * 0.34))
    add(BONE.CHEST, 'flesh', ellipsoid(torsoD * 0.85, torsoW * 0.78, torsoLen * 0.24, 0, 0, -torsoLen * 0.72))
    add(BONE.CHEST, 'flesh', ellipsoid(torsoD * 0.80, torsoW * 1.05, torsoLen * 0.14, 0, 0, -torsoLen * 0.04))
    add(BONE.CHEST, 'flesh', tube(limbR * 1.0, limbR * 1.25, (d.headZ - d.shoulderZ) * 1.05, 0, 0, (d.headZ - d.shoulderZ) * 1.05))
    for (const s of [1, -1]) add(BONE.CHEST, 'flesh', ellipsoid(limbR * 1.32, limbR * 1.38, limbR * 1.25, 0, s * shoulderY, -limbR * 0.45))
    add(BONE.HEAD, 'flesh', ellipsoid(headR * 1.05, headR * 0.88, headR))
    faceParts(add, headR, 1.05, 0.88, 1.0)
    jawParts(add, headR, 1.05, 0.88, 1.0)
  }

  // Every segment runs PAST its joint and every joint carries a ball. A capsule that stops
  // exactly where its child begins opens a wedge of background the instant the joint bends,
  // which is the "stack of floating pills" the boss frame was failing on — the body came apart
  // at range into disconnected spheres. The overlap is ~30 % of the limb radius, enough that
  // no bend inside the pose ranges below can prise it open.
  // Every segment is thicker where it hangs from than where it ends, and the sphere capping
  // each end is sized to whatever meets it there, so the arm is one tapering line from
  // shoulder to knuckle instead of four pills in a column. See `taperedLimb`.
  for (const b of ARM_BONES) {
    add(b, 'flesh', taperedLimb(limbR * JOINT.shoulder, limbR * JOINT.elbow, upperArm + limbR * 0.40))
  }
  for (const b of FOREARM_BONES) {
    add(b, 'flesh', taperedLimb(limbR * JOINT.elbow, limbR * JOINT.wrist, foreArm + limbR * 0.22))
    add(b, 'flesh', ellipsoid(limbR * 0.92, limbR * 0.58, limbR * 1.00, limbR * 0.10, 0, -foreArm - limbR * 0.62))
    // Three fingers, curled forward. They are two centimetres of geometry that nobody will
    // ever consciously see, and they are worth it: the reaching arm is the highest thing in
    // the silhouette and a hand that ENDS IN A POINT is the difference between a corpse
    // reaching for you and a coat rack.
    for (let i = -1; i <= 1; i++) {
      const finger = tinyLimb(limbR * 0.26, limbR * 0.12, limbR * 1.60)
      finger.rotateY(-1.10)
      finger.translate(limbR * 0.62, i * limbR * 0.44, -foreArm - limbR * 0.98)
      add(b, 'flesh', finger)
    }
  }
  for (const b of THIGH_BONES) {
    add(b, 'flesh', taperedLimb(limbR * JOINT.hip, limbR * JOINT.knee, thigh + limbR * 0.45))
  }
  for (const b of SHIN_BONES) {
    add(b, 'flesh', taperedLimb(limbR * JOINT.knee, limbR * JOINT.ankle, shin))
    // A boot, not a bare stump: the ankle ball is what stops the leg ending in mid-air.
    add(b, 'cloth', ellipsoid(limbR * 1.04, limbR * 1.04, limbR * 1.04, 0, 0, -shin))
    add(b, 'cloth', slab(limbR * 3.6, limbR * 2.0, limbR * 1.30, limbR * 0.95, 0, -shin - limbR * 0.52))
  }

  // The Conductor used to be excluded here, on the reasoning that a peaked cap and a
  // floor-length coat already dressed him and his oversized right arm would swallow a sleeve.
  // The cost of that exclusion was the single worst frame in the build: he was the ONE
  // archetype whose arms were bare `flesh` against a `plate` coat, and bare flesh measured
  // #423c41 (L=61.8) against a coat at #0c0807 (L=8.4) — seven times the luminance of the body
  // they belong to, so a raised arm was the only thing the eye could find on him. He gets
  // sleeves like everyone else now; the big arm gets its own coat sleeve in the boss block
  // below, cut wide enough to actually cover it.
  if (shape.stance !== 'crawl') clothParts(add, d)
  woundParts(add, d)

  if (id === 'base') {
    // A commuter who never made it off the platform, still wearing the badge that got him
    // through the barrier. The lanyard is cloth so it separates from the jacket under it.
    add(BONE.CHEST, 'cloth', slab(torsoD * 0.22, torsoW * 0.22, torsoLen * 0.54, torsoD * 1.22, 0, -torsoLen * 0.30))
    add(BONE.CHEST, 'plate', slab(torsoD * 0.12, torsoW * 0.46, torsoLen * 0.18, torsoD * 1.30, 0, -torsoLen * 0.56))
  }

  if (id === 'ranged') {
    // The distended bile gut is the Spitter's whole silhouette, and it is what reads at 900 cm.
    // It used to BE the glow — one unlit ellipsoid at torsoW * 0.96 half-width, nearly twice
    // the torso's own width, measuring L=183.8 in the firefight frame: brighter than the wet
    // floor beside it and the brightest thing on the body. That is a neon band across a
    // pelvis, not an organ. The gut is a lit FLESH mass now, at the size that made the
    // silhouette work, with a hot core burning inside the front of it at a third the area.
    // Same tell, same distance, and it is finally attached to a body.
    add(BONE.PELVIS, 'flesh', ellipsoid(torsoD * 0.88, torsoW * 0.96, torsoLen * 0.22, torsoD * 0.34, 0, -torsoLen * 0.04))
    add(BONE.PELVIS, 'glow', ellipsoid(torsoD * 0.52, torsoW * 0.52, torsoLen * 0.20, torsoD * 0.60, 0, -torsoLen * 0.04))
    // And the gullet. This was an ellipsoid 104% x 84% of the head's own frontal diameter,
    // sitting on a head that SHAPES.ranged deliberately cranes back (neck 1.45, headCounter
    // 1.30) so that it points straight down the lens — so the one archetype a player is meant
    // to pick out of a crowd had its entire face replaced by a flat neon disc, erasing every
    // feature faceParts builds. It is a throat now: small, set deep behind the jaw line.
    add(BONE.HEAD, 'glow', ellipsoid(headR * 0.20, headR * 0.24, headR * 0.16, headR * 0.84, 0, -headR * 0.66))
    for (const s of [1, -1]) {
      add(BONE.CHEST, 'plate', spike(limbR * 0.7, torsoD * 1.5, -2.5, -torsoD * 0.7, s * torsoW * 0.4, -torsoLen * 0.25))
      add(BONE.CHEST, 'plate', spike(limbR * 0.6, torsoD * 1.2, -2.5, -torsoD * 0.7, s * torsoW * 0.5, -torsoLen * 0.55))
    }
  }

  if (id === 'tank') {
    // 900 HP and 200 armour that a player cannot find in a crowd is 900 HP of nothing, and the
    // measured frames said the Tank was indistinguishable from a Shambler at range. Three
    // things fix that, in the order they resolve as a player backs away:
    //
    //   1. WIDTH. A pauldron shelf carried out past the arms, so the outline is a trapezoid
    //      with no neck in it. This reads first and it reads at any distance.
    //   2. A HUNCHED SLAB where the back and skull should be, so there is no head above the
    //      shoulder line to break the trapezoid.
    //   3. SEAMS. Six furnace lines, the same trick the Conductor uses, at a fraction of his
    //      brightness — enough to say "the armoured one" through smoke.
    for (const s of [1, -1]) {
      add(BONE.CHEST, 'plate', ellipsoid(torsoD * 1.30, limbR * 2.9, limbR * 1.45, 0, s * shoulderY * 1.06, limbR * 0.24))
      add(BONE.CHEST, 'plate', ellipsoid(torsoD * 0.95, limbR * 1.5, limbR * 1.2, 0, s * shoulderY * 1.62, -limbR * 0.30))
      add(BONE.CHEST, 'plate', spike(limbR * 0.9, limbR * 3.1, -1.85, -torsoD * 0.4, s * shoulderY * 1.10, limbR * 1.05))
      add(BONE.CHEST, 'plate', spike(limbR * 0.7, limbR * 2.2, -2.05, -torsoD * 0.5, s * shoulderY * 1.55, limbR * 0.55))
      add(BONE.CHEST, 'glow', slab(torsoD * 0.20, limbR * 0.30, limbR * 1.30, 0, s * shoulderY * 1.34, limbR * 0.30))
    }
    // The hump. A Tank has no neck by construction (SHAPES.tank.neck is 0.12) and this is what
    // fills the space the head vacated, so the shoulder line runs unbroken across the top.
    add(BONE.CHEST, 'plate', ellipsoid(torsoD * 1.05, torsoW * 1.35, torsoLen * 0.30, -torsoD * 0.55, 0, limbR * 0.60))
    add(BONE.CHEST, 'plate', slab(torsoD * 0.55, torsoW * 1.7, torsoLen * 0.58, -torsoD * 1.10, 0, -torsoLen * 0.30))
    for (let i = 0; i < 3; i++) {
      add(BONE.CHEST, 'glow', slab(torsoD * 0.16, torsoW * (0.95 - i * 0.22), torsoLen * 0.045, torsoD * 1.04, 0, -torsoLen * (0.16 + i * 0.13)))
    }
    // Gauntlets, tapered like the arm under them so the forearm does not step out to a box.
    for (const b of FOREARM_BONES) {
      add(b, 'plate', taperedLimb(limbR * 2.15, limbR * 1.55, foreArm * 0.72))
      add(b, 'plate', slab(limbR * 1.1, limbR * 3.0, limbR * 1.1, limbR * 1.5, 0, -foreArm * 0.30))
    }
  }

  if (id === 'boss') {
    // A conductor still in uniform: peaked cap, long coat, and a furnace where the chest was.
    add(BONE.HEAD, 'coat', disc(headR * 1.12, headR * 0.78, 0, 0, headR * 0.82))
    add(BONE.HEAD, 'plate', disc(headR * 1.45, headR * 0.12, headR * 0.38, 0, headR * 0.50))
    // The tunic. `clothParts` now dresses him like every other commuter, which is right for his
    // legs and his off arm and wrong for his chest twice over: it is the wrong garment for a
    // conductor, and it is the wrong VALUE — a cold blue-grey island in the middle of his own
    // coat. This buries it in the coat's material and then puts the two things on it that make
    // a uniform read as a uniform rather than a barrel: lapels opening in a V off the collar,
    // and a double row of buttons down the breast.
    add(BONE.CHEST, 'coat', ellipsoid(torsoD * 1.18, torsoW * 1.16, torsoLen * 0.46, 0, 0, -torsoLen * 0.34))
    for (const s of [1, -1]) {
      const lapel = slab(torsoD * 0.34, torsoW * 0.50, torsoLen * 0.52)
      lapel.rotateX(s * 0.40)
      lapel.translate(torsoD * 1.10, s * torsoW * 0.46, -torsoLen * 0.26)
      add(BONE.CHEST, 'coat', lapel)
      // Buttons ride at 1.16 of the torso depth, just inside the tunic's own 1.18, so the
      // lowest of the three still has its back inside the garment instead of hanging in front
      // of a chest that has already started curving away.
      for (let i = 0; i < 3; i++) {
        add(BONE.CHEST, 'glow', ellipsoid(torsoD * 0.12, torsoW * 0.06, torsoW * 0.06, torsoD * 1.16, s * torsoW * 0.26, -torsoLen * (0.28 + i * 0.12)))
      }
    }
    // A near-black body needs its silhouette drawn by light: a furnace grate, a cap badge and
    // two shoulder vents put six red marks on an otherwise unreadable shape. The grate sits at
    // 1.38 rather than 0.92 of the torso depth because the tunic above is 1.18 deep and would
    // otherwise swallow the one feature that is doing the most work on this character.
    for (let i = 0; i < 3; i++) {
      add(BONE.CHEST, 'glow', slab(torsoD * 0.16, torsoW * (0.78 - i * 0.14), torsoLen * 0.045, torsoD * 1.24, 0, -torsoLen * (0.22 + i * 0.10)))
    }
    add(BONE.HEAD, 'glow', ellipsoid(headR * 0.10, headR * 0.26, headR * 0.20, headR * 0.98, 0, headR * 0.82))
    for (const s of [1, -1]) {
      add(BONE.CHEST, 'glow', slab(torsoD * 0.60, limbR * 0.28, limbR * 0.55, 0, s * shoulderY * 1.12, limbR * 0.55))
    }
    // The coat. A single smooth truncated cone came back reading as a lampshade, so the hem is
    // broken into overlapping panels at slightly different radii and lengths — the vertical
    // seams between them are what make it hang as CLOTH under a raking lamp.
    add(BONE.PELVIS, 'coat', tube(torsoW * 0.98, torsoW * 1.46, torsoLen * 1.05, 0, 0, torsoLen * 0.12))
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU
      const panel = tube(torsoW * 0.30, torsoW * 0.46, torsoLen * (0.84 + 0.18 * (i % 3) / 2))
      // Flattened radially, then turned to face out: a shallow arc riding on the cone rather
      // than a pipe strapped to it. The seams between seven of them are what break a
      // floor-length coat out of reading as one smooth lampshade under a raking lamp.
      panel.scale(0.42, 1, 1)
      panel.rotateZ(a)
      panel.translate(Math.cos(a) * torsoW * 1.06, Math.sin(a) * torsoW * 1.06, torsoLen * 0.02)
      add(BONE.PELVIS, 'coat', panel)
    }
    for (const s of [1, -1]) {
      add(BONE.CHEST, 'coat', ellipsoid(torsoD * 1.05, limbR * 1.9, limbR * 1.5, 0, s * shoulderY * 1.05, limbR * 0.4))
      add(BONE.CHEST, 'plate', spike(limbR * 0.75, torsoD * 1.9, -2.6, -torsoD * 0.85, s * torsoW * 0.35, -torsoLen * 0.18))
      add(BONE.CHEST, 'plate', spike(limbR * 0.62, torsoD * 1.5, -2.6, -torsoD * 0.85, s * torsoW * 0.30, -torsoLen * 0.48))
    }
    // One oversized arm, so even a backlit silhouette is asymmetric and unmistakably the boss.
    // Tapered like every other limb: at scale 2.0 a straight 23 cm-thick cylinder was the
    // single worst offender in the "stack of floating ovoids" frame.
    add(BONE.ARM_UR, 'flesh', taperedLimb(limbR * 1.62, limbR * 1.28, upperArm * 1.05))
    add(BONE.ARM_FR, 'flesh', taperedLimb(limbR * 1.30, limbR * 1.02, foreArm * 1.10))
    // The coat sleeve over it. `clothParts` cuts a sleeve at 1.34 of limbR, which the 1.62 arm
    // above genuinely would swallow, so the big arm carries its own in the coat's material —
    // wide enough to clear the flesh under it, ending in three ragged cuffs so it reads as a
    // torn uniform sleeve rather than a pipe. This, not the rim, is what stops the raised arm
    // being a pale shaft: it puts the arm at the coat's value, where it belongs.
    add(BONE.ARM_UR, 'coat', taperedLimb(limbR * 1.86, limbR * 1.52, upperArm * 0.92))
    add(BONE.ARM_FR, 'coat', taperedLimb(limbR * 1.54, limbR * 1.24, foreArm * 0.70))
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.6
      const cuff = tinyLimb(limbR * 0.66, limbR * 0.42, foreArm * (0.16 + 0.12 * (i % 2)))
      cuff.translate(Math.cos(a) * limbR * 1.08, Math.sin(a) * limbR * 1.08, -foreArm * 0.62)
      add(BONE.ARM_FR, 'coat', cuff)
    }
    // The fist. A single ellipsoid at 2.0 x 1.5 x 2.3 limbR on the end of a foreshortened arm
    // is a BULB, and a bulb on the end of a shaft is the read this frame cannot afford. A real
    // clenched hand is wider across the knuckles than it is deep, and it is FLAT and HARD-EDGED
    // on the striking face where a sphere is round everywhere — so it is a box, sized and
    // placed so the three curled fingers the forearm already carries stand proud of its front
    // face as knuckles instead of poking out of a bulb as nubs, with a thumb wrapped round one
    // side. A cube with fingers on it is a fist; nothing else on this character is.
    // The mitt itself is wool like the rest of him, so the raised arm can never again be the
    // brightest thing in the frame; only the knuckle bar is metal, which is the one highlight
    // a swinging fist is allowed and the thing that says it will hurt.
    const fistZ = -foreArm * 1.10 - limbR * 0.70
    add(BONE.ARM_FR, 'coat', slab(limbR * 1.90, limbR * 2.30, limbR * 1.85, limbR * 0.10, 0, fistZ))
    add(BONE.ARM_FR, 'coat', ellipsoid(limbR * 0.60, limbR * 0.50, limbR * 0.98, limbR * 0.80, limbR * 1.42, fistZ - limbR * 0.15))
    add(BONE.ARM_FR, 'plate', slab(limbR * 0.34, limbR * 2.34, limbR * 0.52, limbR * 1.10, 0, fistZ - limbR * 0.46))
  }

  return out
}

/**
 * Bakes every part into one merged geometry per (bone, material role) so the whole archetype
 * draws in roughly a dozen instanced calls no matter how many bodies are alive.
 */
function buildRig(id) {
  const arch = ARCHETYPES[id]
  const shape = SHAPES[id]
  const d = dimensionsFor(arch, shape)
  const rest = restPose(shape, d)
  const parts = partsFor(id, shape, d)

  const buckets = new Map()
  for (const part of parts) {
    const key = `${part.bone}:${part.role}`
    if (!buckets.has(key)) buckets.set(key, { bone: part.bone, role: part.role, geometries: [] })
    buckets.get(key).geometries.push(part.geometry)
  }

  const restZ = new Float32Array(BONE_COUNT)
  for (let b = 1; b < BONE_COUNT; b++) restZ[b] = restZ[BONE_PARENT[b]] + rest.pos[b * 3 + 2]

  const groups = []
  for (const bucket of buckets.values()) {
    const merged = bucket.geometries.length === 1
      ? bucket.geometries[0]
      : mergeGeometries(bucket.geometries, false)
    if (!merged) {
      console.error(`[zombie] ${id}: could not merge ${bucket.geometries.length} parts on bone ${bucket.bone} (${bucket.role}) — that limb will be missing`)
      continue
    }
    if (bucket.geometries.length > 1) for (const g of bucket.geometries) g.dispose()
    // Glow parts are unlit accents; dirtying them would just make the tell harder to read.
    if (bucket.role !== 'glow') applyGrime(merged, restZ[bucket.bone], d)
    merged.computeBoundingSphere()
    groups.push({ bone: bucket.bone, role: bucket.role, geometry: merged })
  }

  // A knee that never straightens is a leg that is permanently SHORTER, and this rig has no
  // IK to notice: the root sits at the capsule centre and the feet hang a fixed distance below
  // it, so a locked knee lifts that boot off the slab and the body walks on one foot. Dropping
  // the pelvis by exactly the shortfall puts the bent leg back on the floor and pushes the
  // straight one a couple of centimetres into it, which is the right way round — concrete
  // hides a foot, air does not.
  const kneeSink = shape.stance === 'crawl'
    ? 0
    : d.shin * (1 - Math.cos(shape.kneeBend * shape.kneeLock))

  return { id, arch, shape, dims: d, rest, groups, kneeSink }
}

/**
 * A grazing-angle emissive: the archetype's accent, thrown only where the surface turns away
 * from the camera. `normalView · positionViewDirection` is 1 facing the lens and 0 at the
 * silhouette edge, which is the same term materials.js already uses to dissolve a haze cone,
 * run the other way up.
 */
function rimNode(rimColor, gain) {
  const facing = abs(dot(normalView, positionViewDirection))
  return vec3(rimColor.r, rimColor.g, rimColor.b)
    .mul(pow(oneMinus(facing), SURFACE.rimPower).mul(gain).add(SURFACE.rimFloor))
}

/** Linear (not sRGB) luminance, the same weights the emissive gate above uses. */
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

/**
 * A body surface's albedo, with a floor under it.
 *
 * A rim light draws an EDGE. It cannot make an interior, and on a surface whose reflectance is
 * three thousandths it is the only thing there is — which is how the Conductor ended up as a
 * bright outline around a black hole, the exact "cutout pasted over the frame" the station's
 * own lighting comments say killed the previous build. The answer is not more rim and it is
 * certainly not more lamps: it is giving the surface something for the lamps to land on.
 *
 * The lift goes toward neutral rather than scaling the colour, so a hue that is already dark
 * AND saturated does not come back as a bright version of itself — the Conductor's coat lands
 * as very dark warm charcoal, not maroon.
 */
function floored(color, minLuminance) {
  const l = lum(color)
  if (l >= minLuminance) return color
  const t = l <= 1e-6 ? 1 : 1 - l / minLuminance
  return color.lerp(new THREE.Color(minLuminance, minLuminance, minLuminance), t)
}

function buildMaterials(id) {
  const arch = ARCHETYPES[id]
  const tint = new THREE.Color().setHex(arch.tintHex)
  const emissive = new THREE.Color().setHex(arch.emissiveHex)

  // rules.js gives each archetype one emissive colour, and it is doing two different jobs. For
  // the Shambler, Crawler and Tank it is a near-black grime warmth meant for the skin
  // (0x140a06, 0x1e0f00, 0x2a0800). For the Spitter and the Boss it is a lamp colour meant for
  // one organ (0x39ff6a "the tell that a spit is coming", 0xff2008 "the only red-hot thing on
  // the platform"). Putting a lamp colour on the skin costs the Boss its silhouette entirely —
  // it renders as a glowing red man against a near-white platform. So the skin only takes the
  // accent when the accent is dark enough to have been meant for it; the bright ones stay on
  // the glow parts, where the archetype's own comment says they belong.
  //
  // The body's share of it is now the RIM rather than a flat add (see SURFACE.rimPower), so a
  // dark accent is normalised to unit peak first: 0x0b2910's own radiance is three thousandths
  // and would draw nothing at all on an edge. What rules.js is actually specifying here is a
  // HUE per archetype; the brightness of it was always this file's decision.
  const accentOnSkin = lum(emissive) <= SURFACE.skinEmissiveMaxLuminance

  const hue = emissive.clone()
  hue.multiplyScalar(1 / Math.max(hue.r, hue.g, hue.b, 1e-4))
  const rimColor = new THREE.Color().setHex(SURFACE.rimColdHex)
  // The Spitter and the Boss keep their lamp colour on their ORGANS, but their EDGE is the
  // only thing that tells them from the wall, so they take the strong mix. The old 0.35
  // multiplier on an already-halved base put the Conductor's furnace red at a 12% trace of the
  // cold wash — a black coat with a slightly-less-cold edge, which is no edge at all.
  const lampFade = clamp(1 - lum(tint) / SURFACE.rimAccentFadeLuminance, SURFACE.rimLampAccentFloor, 1)
  rimColor.lerp(hue, accentOnSkin ? SURFACE.rimAccentMix : SURFACE.rimLampAccentMix * lampFade)

  // The archetype tint stays as the MULTIPLIER on the baked albedo rather than being replaced
  // by it, so Shambler khaki, Spitter green and Tank iron still separate at 900 cm — the bake
  // supplies the rot, the blood and the pores, the tint supplies the identity.
  const skin = bakeFlesh()

  const flesh = new THREE.MeshStandardNodeMaterial({
    color: floored(tint.clone(), SURFACE.fleshFloorLuminance),
    roughness: SURFACE.fleshRoughness,
    metalness: SURFACE.fleshMetalness,
    map: skin.map ?? null,
    roughnessMap: skin.ormMap ?? null,
    metalnessMap: skin.ormMap ?? null,
    normalMap: skin.normalMap ?? null,
    vertexColors: true,
  })
  flesh.emissiveNode = rimNode(rimColor, SURFACE.rimFleshGain)

  // Plate takes the albedo and the relief but NOT the packed ORM: the G/B channels were baked
  // for damp skin, and feeding them to a 0.62-metalness surface would strip the Tank's shoulder
  // armour and the Boss's coat of the only thing making them read as hard.
  const plate = new THREE.MeshStandardNodeMaterial({
    color: floored(tint.clone().multiplyScalar(SURFACE.plateDarken), SURFACE.plateFloorLuminance),
    roughness: SURFACE.plateRoughness,
    metalness: SURFACE.plateMetalness,
    map: skin.map ?? null,
    normalMap: skin.normalMap ?? null,
    vertexColors: true,
  })
  plate.emissiveNode = rimNode(rimColor, SURFACE.rimPlateGain)

  // Wool, for the one archetype wearing a uniform rather than armour. Same construction as
  // plate — albedo and relief, no ORM — but matte and dielectric, so a lamp rakes across it
  // instead of bouncing the whole station off it.
  const coat = new THREE.MeshStandardNodeMaterial({
    color: floored(tint.clone(), SURFACE.coatFloorLuminance),
    roughness: SURFACE.coatRoughness,
    metalness: SURFACE.coatMetalness,
    map: skin.map ?? null,
    normalMap: skin.normalMap ?? null,
    vertexColors: true,
  })
  coat.emissiveNode = rimNode(rimColor, SURFACE.rimPlateGain)

  // Torn-open wounds, eye sockets, open jaws, matted hair. Near-black and slightly wet: a hole
  // in a body is read by the light MISSING from it, and the gloss is what stops it reading as
  // a painted-on decal when a lamp sweeps across it.
  const wound = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color().setHex(SURFACE.woundColor),
    roughness: SURFACE.woundRoughness,
    metalness: SURFACE.woundMetalness,
    normalMap: skin.normalMap ?? null,
    vertexColors: true,
  })

  // Cloth is the one surface on the body that must NOT take the archetype tint as a hue: a
  // commuter suit that drifts khaki with the skin merges back into one clay silhouette, which
  // is the whole finding. It keeps the albedo (blood soaks into cloth) and drops the ORM.
  const cloth = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color().setHex(SURFACE.clothColor),
    roughness: SURFACE.clothRoughness,
    metalness: 0.0,
    map: skin.map ?? null,
    normalMap: skin.normalMap ?? null,
    vertexColors: true,
  })
  // Cloth gets the weakest rim of the three. It still needs one: a dark garment against a dark
  // wall is where a silhouette goes missing, and the torn hems are half the outline.
  cloth.emissiveNode = rimNode(rimColor, SURFACE.rimClothGain)

  // Eyes, the Spitter's gullet and gut core, the Tank's seams and the Boss's furnace: the only
  // parts meant to survive the haze at the far end of the platform. Normalising to the accent's
  // peak channel first is what gives the Shambler amber eyes out of a 0x140a06 that would
  // otherwise render as two black holes.
  //
  // `toneMapped: false` was the mistake. It puts these outside the scene grade entirely, so no
  // exposure anywhere can hold them, which is how a Spitter's pelvis measured L=183.8 — hotter
  // than the wet floor under a sodium lamp. They are tone-mapped now and the ceiling is raised
  // to keep them hot through the grade instead of around it.
  const accent = emissive.clone()
  const peak = Math.max(accent.r, accent.g, accent.b, 1e-3)
  accent.multiplyScalar(clamp(arch.emissiveIntensity, 1.0, SURFACE.glowCeiling) / peak)
  const glow = new THREE.MeshBasicNodeMaterial({ color: accent, toneMapped: true })

  return { flesh, plate, glow, wound, cloth, coat }
}

/**
 * Steering gains for the column-avoidance pass. The original had no obstacle avoidance of any
 * kind — its comment says the controller was "deliberately dumb and behavior-tree-free so it
 * works with no navmesh" — so none of this comes from the spec. All three are multiples of the
 * zombie's own body radius or of the obstacle's, so a Boss at scale 2.0 gives a column a wider
 * berth than a Crawler without a second table.
 */
const AVOID = Object.freeze({
  lookaheadBodies: 6,
  corridorFactor: 1.6,
  turnGain: 2.2,
})

/**
 * Hitbox padding for the bullet trace. The original traced against the mannequin's actual
 * skinned bones and read a bone NAME to pick the zone (spec §2.4); a procedural rig has no
 * bone names, so these decide how much of the silhouette counts as head and as chest. They
 * are the only numbers in this file that change how the game plays — a wider head padding is
 * a more generous x5.0 headshot — so they are named rather than buried inside the trace.
 */
const HITBOX = Object.freeze({
  headPadding: 1.15,
  chestPadding: 1.15,
  chestLengthFraction: 0.6,
})

/**
 * Timings for the procedural performance. The simulation reads exactly one of these, and only
 * indirectly: `attackSeconds` sets where the swing's wind-up peaks, and
 * ZOMBIES.ANIM.telegraphLeadSeconds in rules.js is that peak expressed as a lead time, which
 * _tickMelee uses to start the clip ahead of the damaging frame. Change `attackSeconds` and the
 * lead in rules.js has to move with it. Nothing else here is read outside this file.
 */
const ANIM = Object.freeze({
  collapseSeconds: 0.55,
  attackSeconds: 0.42,
  flashSeconds: 0.09,
  flashGain: 3.2,
})

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _t3 = new THREE.Vector3()
const _capA = new THREE.Vector3()
const _capB = new THREE.Vector3()
const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()
const _quatB = new THREE.Quaternion()
const _mat = new THREE.Matrix4()
const _one = new THREE.Vector3(1, 1, 1)
const _scaleV = new THREE.Vector3()
const _up = new THREE.Vector3(0, 0, 1)

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

/** iq's capsule intersection. @returns {number} distance along `rd`, or -1 for a miss. */
function rayCapsule(ro, rd, pa, pb, radius) {
  const ba = _t1.subVectors(pb, pa)
  const oa = _t2.subVectors(ro, pa)
  const baba = ba.dot(ba)
  const bard = ba.dot(rd)
  const baoa = ba.dot(oa)
  const rdoa = rd.dot(oa)
  const oaoa = oa.dot(oa)
  const a = baba - bard * bard
  let b = baba * rdoa - baoa * bard
  let c = baba * oaoa - baoa * baoa - radius * radius * baba
  let h = b * b - a * c
  if (h < 0) return -1
  let y = 0
  if (Math.abs(a) > 1e-8) {
    const t = (-b - Math.sqrt(h)) / a
    y = baoa + t * bard
    if (y > 0 && y < baba) return t
  }
  const oc = y <= 0 ? oa : _t3.subVectors(ro, pb)
  b = rd.dot(oc)
  c = oc.dot(oc) - radius * radius
  h = b * b - c
  if (h <= 0) return -1
  return -b - Math.sqrt(h)
}

function raySphere(ro, rd, centre, radius) {
  const oc = _t1.subVectors(ro, centre)
  const b = oc.dot(rd)
  const c = oc.dot(oc) - radius * radius
  const h = b * b - c
  if (h < 0) return -1
  return -b - Math.sqrt(h)
}

/**
 * @typedef {object} ZombieWorld  Everything the AI reads. Only `player` is required.
 * @property {{position:THREE.Vector3, health?:object}|null} player
 * @property {Array<{x:number, y:number, radius:number}>} [obstacles] station columns and props
 * @property {(from:THREE.Vector3, to:THREE.Vector3)=>boolean} [hasLineOfSight] blocked by level geometry
 * @property {(zombie:Zombie, target:THREE.Vector3, acceptance:number)=>boolean} [moveTo] navmesh request; false latches direct steering
 * @property {{minX:number, maxX:number, minY:number, maxY:number}} [bounds] walkable rectangle
 */

/**
 * One zombie. Blank until `configureForWave` stamps an archetype onto it, exactly as the
 * original did — there is no subclass per archetype and the numeric archetype id is load-bearing.
 */
export class Zombie {
  /** @param {ZombiePool} pool */
  constructor(pool) {
    this.pool = pool
    this.health = this._makeHealthPool(HEALTH.ZOMBIE_DEFAULTS.maxHealth, 0)

    this.typeId = 'base'
    this.archetype = ARCHETYPES.base
    this.shape = SHAPES.base
    this.rig = null

    this.position = new THREE.Vector3()
    this.velocity = new THREE.Vector3()
    this.yaw = 0
    this.state = 'idle'
    this.band = 'hold'
    this.active = false
    this.expired = false

    this.scale = SHARED.scale
    this.maxSpeed = 0
    this.meleeDamage = SHARED.meleeDamage
    this.projectileDamage = SHARED.projectileDamage
    this.attackRange = SHARED.attackRange
    this.attackCooldown = SHARED.attackCooldown
    this.desiredRange = SHARED.desiredRange
    this.timeUntilNextAttack = SHARED.timeUntilNextAttack
    this.turnRate = ARCHETYPES.base.turnRate

    this.timeUntilRepath = 0
    this.usingDirectSteering = true
    this.isAlerted = false
    this.alertLocation = new THREE.Vector3()

    this.age = 0
    this.phase = rng.range(0, TAU)
    this.attackT = 1
    // No previous distance sample yet, so _startTelegraph measures no closure on frame one.
    this._telegraphDistance = Number.NaN
    this.deathT = 0
    this.corpseAge = 0
    this.flashT = 0
    this.glowLevel = 1
    this.dragSide = 1
    this.deadArm = 1
    this.slump = 1
    this.headLoll = 0
    this.shoulderTilt = 0
    this.spineTwist = 0
    this.collapseDir = 0
    this.collapseSign = 1
    this.lastHitZone = null
    this._pendingZone = null
    /** Lets the projectile pool tell a friendly-fire hit from a hit on the player. */
    this.isZombie = true
    this.groundZ = STATION.LEVELS.platformTopZ

    this.bones = []
    for (let i = 0; i < BONE_COUNT; i++) this.bones.push(new THREE.Matrix4())
    this._pose = new Float32Array(BONE_COUNT * 6)
    this._desired = new THREE.Vector3()
    this._separation = new THREE.Vector3()
    this._tintBase = new THREE.Color(1, 1, 1)
    this.tintColor = new THREE.Color(1, 1, 1)
    this.glowColor = new THREE.Color(1, 1, 1)
  }

  get isDead() { return this.health.isDead }

  /**
   * Effective, POST-scale collision capsule — what a projectile, a bullet trace and the
   * player's push-out measure against. `capsuleRadius`/`capsuleHalfHeight` are the names
   * player.js reads and it documents them as effective, so both spellings resolve the same.
   * The pre-scale numbers the spec tabulates stay on `archetype`.
   */
  get radius() { return this.archetype.capsuleRadius * this.scale }
  get halfHeight() { return this.archetype.capsuleHalfHeight * this.scale }
  get capsuleRadius() { return this.radius }
  get capsuleHalfHeight() { return this.halfHeight }
  get type() { return this.typeId }

  /**
   * §1.1 steps 9-11 and §2.1. maxHealth is the resolved value, so overhealCap lifts with it and
   * a Boss's 4000 is never clipped to 200 — the original relied on BeginPlay running before
   * ConfigureForWave for that, and init order is a bad thing to depend on. maxArmor stays at
   * the shared 200, which is what makes the Boss's 300 bleed back down over 40 s.
   */
  _makeHealthPool(resolvedHealth, archetypeArmor) {
    return new HealthPool({
      maxHealth: resolvedHealth,
      health: resolvedHealth,
      // Step 10: the Boss raises the hard ceiling to its own armor. A no-op at 300 vs 300, but
      // it is in the source so a future cap change cannot silently clip it.
      overArmorCap: Math.max(HEALTH.overArmorCap, archetypeArmor),
      owner: this,
      onChanged: ({ delta, instigator }) => { if (delta < 0) this.onHealthChanged(-delta, instigator) },
      onDied: ({ instigator }) => this.die(instigator),
    })
  }

  /**
   * spec/zombies.md §1.1, in its exact order. The reset in step 4 matters: an archetype that
   * does not name attackRange / attackCooldown / desiredRange inherits these, which is the only
   * reason the Spitter carries a 150 cm melee reach it never uses.
   *
   * @param {'base'|'zerg'|'ranged'|'tank'|'boss'} typeId
   * @param {{waveNumber:number, healthScale:number, speedScale:number, damageScale:number}} wave
   */
  configureForWave(typeId, wave = WAVES.COMPOSITION_DEFAULTS) {
    const arch = ARCHETYPES[typeId]
    if (!arch) throw new Error(`[zombie] unknown archetype "${typeId}" — expected one of ${ZOMBIES.ORDER.join(', ')}`)

    // §1.1 step 2 is the spawn growl, and it is deliberately NOT emitted here. waveDirector.js
    // is what fires EV.ZOMBIE_SPAWN (it owns the queue and the payload shape), and audio.js
    // binds that event to sound.zombieGrowl with the rules.js volume and pitch range. Emitting
    // it a second time from the zombie would growl twice for every body out of the doors.
    this.typeId = typeId
    this.archetype = arch
    this.shape = SHAPES[typeId]
    this.rig = this.pool?.rigs?.[typeId] ?? null

    const healthScale = wave.healthScale ?? 1
    const speedScale = wave.speedScale ?? 1
    const damageScale = wave.damageScale ?? 1

    // Step 4 — reset the three shared combat fields BEFORE the archetype switch, plus the
    // attack timer, which starts at 0 so a zombie can swing on its first frame in range.
    this.attackRange = SHARED.attackRange
    this.attackCooldown = SHARED.attackCooldown
    this.desiredRange = SHARED.desiredRange
    this.timeUntilNextAttack = SHARED.timeUntilNextAttack

    // Step 5 — the archetype switch. rules.js spells "this case did not override it" as 0, so
    // a zero here leaves the step-4 value standing. That is how the Spitter ends up carrying a
    // 150 cm melee reach it never reads, and how the four melee archetypes end up carrying a
    // 900 cm stand-off range that only the Spitter's AI branch ever looks at.
    if (arch.attackRange > 0) this.attackRange = arch.attackRange
    if (arch.attackCooldown > 0) this.attackCooldown = arch.attackCooldown
    if (arch.desiredRange > 0) this.desiredRange = arch.desiredRange
    this.scale = arch.scale
    this.turnRate = arch.turnRate

    this.meleeDamage = arch.meleeDamage * damageScale
    this.projectileDamage = arch.projectileDamage * damageScale
    this.maxSpeed = arch.speed * speedScale

    // Armor, reach, cooldown, stand-off range and body scale are deliberately NOT wave-scaled.
    this.health = this._makeHealthPool(arch.health * healthScale, arch.armor)
    this.health.addArmor(arch.armor)

    this.state = 'chase'
    this.band = 'hold'
    this.active = true
    this.expired = false
    this.age = 0
    this.corpseAge = 0
    this.deathT = 0
    this.flashT = 0
    this.attackT = 1
    // No previous distance sample yet, so _startTelegraph measures no closure on frame one.
    this._telegraphDistance = Number.NaN
    this.glowLevel = 1
    this.isAlerted = false
    this.usingDirectSteering = true
    this.timeUntilRepath = 0
    this.velocity.set(0, 0, 0)
    this._desired.set(0, 0, 0)
    this._separation.set(0, 0, 0)
    this.phase = rng.range(0, TAU)
    this.dragSide = rng.chance(0.5) ? 1 : -1
    // Asymmetry that survives a standstill. Every other variation in the rest pose is
    // multiplied by moveBlend and therefore vanishes the moment a zombie stops — which is
    // exactly when it is in melee range and the player is looking straight at it. Without
    // these three, eight stopped zombies snap into one identical pose: a rack of dummies.
    // The Boss's dead side is forced so his oversized RIGHT arm is always the one reaching.
    this.deadArm = typeId === 'boss' ? 1 : (rng.chance(0.5) ? 1 : -1)
    // Narrower than the old 0.7-1.35: the base lean is half again as deep now, and the top of
    // that old range folded a Shambler's chest past 55 degrees, which stops reading as a hunch
    // and starts reading as a body snapped at the waist.
    this.slump = rng.range(0.82, 1.18)
    this.headLoll = rng.range(-0.42, 0.42)
    this.shoulderTilt = rng.range(-0.20, 0.20)
    this.spineTwist = rng.range(-0.26, 0.26)
    this.collapseDir = rng.range(0, TAU)
    this.collapseSign = rng.chance(0.5) ? 1 : -1
    this.lastHitZone = null
    this._pendingZone = null

    // A crowd of identical corpses reads as a copy-paste. The old jitter was three independent
    // wobbles on R, G and B, which is a BRIGHTNESS spread wearing a costume: six bodies came
    // out the same hue at six exposures, and at the distance the crowd is actually seen from
    // that is indistinguishable from one model stamped six times.
    //
    // This is one axis instead, and it is the axis a body actually dies along — jaundiced and
    // warm at one end, drained grey-blue at the other — with value riding on top of it. Two
    // adjacent Shamblers now differ by about a third in their red-to-blue ratio, which
    // survives being 900 cm away in sodium light.
    const decay = rng.range(-1, 1)
    const value = 1 + rng.range(-SURFACE.tintJitter, SURFACE.tintJitter)
    this._tintBase.setRGB(
      value * (1 + 0.17 * decay),
      value * (1 + 0.04 * decay),
      value * (1 - 0.21 * decay),
    )

    return this
  }

  placeAt(x, y, groundZ) {
    this.groundZ = groundZ
    this.position.set(x, y, groundZ + this.halfHeight)
    this._composeBones()
    return this
  }

  /**
   * The damage entry point for weapons. Going through here rather than straight to the pool is
   * what lets EV.ZOMBIE_HIT and EV.ZOMBIE_DEATH carry the zone, which is what hud.js draws its
   * headshot marker from and scoring.js credits. The zone multiplier itself belongs to
   * src/game/damage.js — `amount` is expected to arrive already resolved.
   */
  hit(amount, { zone = 'body', ignoresArmor = false, instigator = null } = {}) {
    this._pendingZone = zone
    return this.health.applyDamage(amount, ignoresArmor, instigator)
  }

  onHeardShot(location) {
    if (this.isAlerted) return
    this.alertLocation.copy(location)
    this.isAlerted = true
  }

  onHealthChanged(dealt, instigator) {
    if (dealt <= 0) return
    this.flashT = ANIM.flashSeconds
    // Only hit() carries a zone. A burn tick, a friendly spit and an explosion have none, and
    // must not inherit the zone of whatever bullet landed before them.
    this.lastHitZone = this._pendingZone
    this._pendingZone = null
    bus.emit(EV.ZOMBIE_HIT, {
      zombie: this,
      archetype: this.typeId,
      zone: this.lastHitZone,
      damage: dealt,
      instigator,
      position: this.position,
    })
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /** @param {number} dt @param {ZombieWorld} world */
  update(dt, world) {
    this.age += dt
    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt)

    if (this.state === 'dead') {
      this.corpseAge += dt
      this.deathT = Math.min(1, this.deathT + dt / ANIM.collapseSeconds)
      if (this.corpseAge >= CORPSE.lifeSpan) this.expired = true
      this._animate(dt)
      this._composeBones()
      return
    }

    this.health.tick(dt)
    // A burn tick can kill mid-update. Returning leaves this frame drawn in the last living
    // pose, which is a better first frame of a collapse than snapping straight to the rest pose.
    if (this.state === 'dead') return

    if (this.timeUntilNextAttack > 0) this.timeUntilNextAttack -= dt

    this._tickAi(dt, world)
    this._integrate(dt, world)
    this._face(dt, world)
    this._animate(dt)
    this._composeBones()
  }

  /** §3.1. The distance checks are full 3D, including Z, because that is what the source did. */
  _tickAi(dt, world) {
    const player = world.player
    if (!player) {
      /**
       * §3.5: the shipped AI simply returned here, leaving the zombie mid-stride. An explicit
       * idle state exists so a scenario with no player pawn still renders a breathing crowd.
       *
       * But a crowd that FREEZES also looks like a bug, and worse: on the player's death the
       * whole wave has already converged on one spot, so freezing leaves a motionless pile
       * exactly where the camera is looking. Reported on sight: "a bunch of zombies in a pile
       * not moving... is that just for testing?"
       *
       * They mill instead. Each body drifts on its own slow heading, seeded from its index so
       * the crowd does not sway in unison, which reads as a horde that has lost interest
       * rather than a scene that stopped updating.
       */
      this.state = 'idle'
      // Seed the heading from where this body happens to be standing, once. `this.index`
      // does not exist on a body — using it produced NaN, and a NaN steering vector reads
      // exactly like the freeze it was meant to fix.
      if (this._idlePhase === undefined) this._idlePhase = (this.position.x + this.position.y) * 0.013
      this._idlePhase += dt * AI.idleWanderRate
      // _desired is a normalised steering input scaled by AI.steerInputScale (see
      // _requestChase), NOT a velocity. Feeding it cm/s silently did nothing.
      this._desired
        .set(Math.cos(this._idlePhase), Math.sin(this._idlePhase * 0.7), 0)
        .normalize()
        .multiplyScalar(AI.steerInputScale * AI.idleWanderScale)
      return
    }

    if (this.pool?.aggroGated && !this.isAlerted) {
      if (this.position.distanceTo(player.position) > ZOMBIES.AGGRO.hearingRadius) {
        this.state = 'idle'
        this._desired.set(0, 0, 0)
        return
      }
      this.isAlerted = true
    }

    if (this.typeId === 'ranged') this._tickRanged(dt, world, player)
    else this._tickMelee(dt, world, player)
  }

  /** Melee contact requires reach and an unobstructed segment between capsule centers. */
  _tickMelee(dt, world, player) {
    const distance = this.position.distanceTo(player.position)
    if (distance <= this.attackRange && (!world.hasLineOfSight || world.hasLineOfSight(this.position, player.position))) {
      this._stopMovement()
      this.state = 'attack'
      this._startTelegraph(distance, dt)
      this._tryMeleeAttack(player)
      return
    }
    this.state = 'chase'
    this._startTelegraph(distance, dt)
    this._requestChase(dt, world, player.position, this.attackRange * AI.meleeAcceptanceFactor)
  }

  /**
   * Start the swing clip AHEAD of the frame that will deal damage.
   *
   * §4.1 owns when damage lands and this touches none of it — `timeUntilNextAttack` is only
   * read here, never written, and nothing below can cause or suppress a hit. All it decides is
   * when `attackT` leaves 1, which is the only thing _poseAttack looks at.
   *
   * Two gates can open, and the swing has to lead whichever one is about to:
   *
   *   - COOLDOWN-LED, hits two onward. The zombie is already in reach and waiting out
   *     `attackCooldown`. In steady state a clip runs from lead-before one hit to 0.42 s minus
   *     lead after it, so the arm is idle for (cooldown - 0.42 s) between swings whatever the
   *     lead is: 0.78 s on a Shambler, 0.18 s on a Runner, 1.38 s on a Tank, 1.58 s on the Boss.
   *     Every melee cooldown is longer than the clip, so none of them can overlap.
   *   - APPROACH-LED, hit one. SHARED_DEFAULTS.timeUntilNextAttack is 0.0, so a zombie that has
   *     never swung hits on its first frame inside `attackRange` and a cooldown-only lead would
   *     miss it entirely. Predict time-to-in-range from the gap and the rate the gap is actually
   *     closing at, measured off last frame's distance.
   *
   * BOTH AT ONCE IS THE COMMON CASE, NOT AN EDGE, AND IT IS WHY THIS TAKES A MAX RATHER THAN
   * BRANCHING. A player backing away — the first thing anyone does with a zombie on them —
   * produces exactly that: the zombie stops the instant it is inside its reach, the retreat
   * pushes it back out during the cooldown, and it re-enters reach with time still on the clock.
   * Neither gate leads that hit alone, because the cooldown expires out of reach and the gap
   * closes under cooldown. Treating the cooldown as a reason to stop looking at the gap blinded
   * the lead for the whole of it and put the clip's start three frames before contact.
   *
   * MEASURED CLOSURE, NOT `maxSpeed`, AND THE DIFFERENCE IS NOT COSMETIC. The archetype's
   * configured top speed is what it would like to be doing, not what it is doing, and the two
   * come apart badly: stepped from 600 cm, the Shambler, Tank and Boss all reach 96-99% of
   * theirs, while the Crawler peaks at 225 cm/s against a configured 520 — 43%. Predicting a
   * Crawler's arrival from 520 fires the clip 650 ms out, so the 420 ms clip ENDS 14 frames
   * before contact and the hit it was supposed to announce lands on a resting arm. That is a
   * separate simulation defect (the Crawler cannot reach its own speed, and fixing that moves
   * §4.1 damage frames, so it is not touched here) — but the telegraph must not be built on top
   * of it, and reading the gap's real closure rate is what makes this independent of it.
   *
   * It is also the whole reason a stalled zombie stays still. A gap that is not shrinking
   * predicts no contact, so a zombie held just outside its reach — by geometry, by a body in the
   * doorway, or by a player backing away at exactly max range — starts no clip at all rather
   * than swinging at the air every time the previous swing ends. `attackT >= 1` alone does not
   * get you that: it blocks a restart INSIDE a clip and not at the clip boundary, which is a
   * swing every 26 frames, 24 of them in ten seconds, none of them landing. The rate is clamped
   * to `maxSpeed` so a stale sample — the first tick after an aggro gate opens — can at worst
   * fall back to the old over-eager estimate, never to a wilder one.
   */
  _startTelegraph(distance, dt) {
    const previousDistance = this._telegraphDistance
    this._telegraphDistance = distance
    if (this.attackT < 1) return
    const lead = TELEGRAPH.telegraphLeadSeconds
    if (lead <= 0) return

    const gap = distance - this.attackRange
    let timeUntilInRange = 0
    if (gap > 0) {
      const closingSpeed = Math.min((previousDistance - distance) / dt, this.maxSpeed)
      // Negated rather than `<= 0` so the NaN of a first, unsampled frame returns here too.
      if (!(closingSpeed > 0)) return
      timeUntilInRange = gap / closingSpeed
    }

    // A hit needs BOTH gates open, so the swing leads the one that opens LAST. A gate already
    // open contributes zero and the other one decides, which is what makes this the same
    // schedule as before in the two cases that only have one gate left to open.
    const timeUntilHit = Math.max(this.timeUntilNextAttack, timeUntilInRange)
    // Nothing left to lead: the hit is available on this very frame, and _tryMeleeAttack —
    // which runs immediately after this on the in-reach path — owns the clip.
    if (timeUntilHit <= 0) return
    if (timeUntilHit <= lead) this.attackT = 0
  }

  /** §3.3. Holds an 800-1000 cm band and fires whenever it has a sightline, in any band. */
  _tickRanged(dt, world, player) {
    const distance = this.position.distanceTo(player.position)
    const far = this.desiredRange + AI.rangedTolerance
    const near = this.desiredRange - AI.rangedTolerance

    if (distance > far) {
      this.band = 'advance'
      this._requestChase(dt, world, player.position, AI.rangedAcceptanceRadius)
    } else if (distance < near) {
      this.band = 'retreat'
      this._stopMovement()
      // `position * 2 - target` is a point the same distance beyond the zombie, so the steering
      // direction is exactly (zombie - player). It does not pathfind, so it will grind on a wall.
      _v1.copy(this.position).multiplyScalar(2).sub(player.position)
      this._steerToward(_v1, world)
    } else {
      this.band = 'hold'
      this._stopMovement()
    }

    const canSee = this._lineOfSight(world, player)
    this.state = canSee ? 'attack' : 'chase'
    if (canSee) this._tryRangedAttack(player)
  }

  /** §3.4. Repath every 0.25 s; `usingDirectSteering` latches and is only re-evaluated then. */
  _requestChase(dt, world, target, acceptanceRadius) {
    this.timeUntilRepath -= dt
    if (this.timeUntilRepath <= 0) {
      this.timeUntilRepath = AI.repathInterval
      // With no navmesh in the level the request always fails, which is the branch the original
      // was written to survive. A world that grows one can return true from moveTo.
      this.usingDirectSteering = world.moveTo ? !world.moveTo(this, target, acceptanceRadius) : true
    }
    if (this.usingDirectSteering) this._steerToward(target, world)
  }

  _steerToward(targetPoint, world) {
    _v2.set(targetPoint.x - this.position.x, targetPoint.y - this.position.y, 0)
    if (_v2.lengthSq() < 1e-6) { this._desired.set(0, 0, 0); return }
    _v2.normalize()
    this._avoidObstacles(_v2, world)
    this._desired.copy(_v2).normalize().multiplyScalar(AI.steerInputScale)
  }

  /**
   * Station columns are the only thing between a zombie and the player, and without a navmesh
   * nothing else would route around them. Each column ahead contributes a lateral push away
   * from its centre, strongest when it sits squarely on the approach line.
   */
  _avoidObstacles(direction, world) {
    const obstacles = world.obstacles
    if (!obstacles || obstacles.length === 0) return
    const body = this.radius
    // Far enough ahead to start turning before the column is unavoidable, and it grows with
    // speed so a wave-scaled Crawler at 1040 cm/s does not run straight into one.
    const lookahead = body * AVOID.lookaheadBodies + this.maxSpeed * AI.repathInterval

    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]
      const dx = o.x - this.position.x
      const dy = o.y - this.position.y
      const ahead = dx * direction.x + dy * direction.y
      if (ahead <= 0 || ahead > lookahead) continue

      const lateral = dx * -direction.y + dy * direction.x
      const corridor = (o.radius + body) * AVOID.corridorFactor
      if (Math.abs(lateral) > corridor) continue

      const urgency = 1 - ahead / lookahead
      // Turn away from whichever side the column already sits on, so a head-on approach picks
      // a side instead of stalling on a perfectly symmetric push.
      const side = lateral >= 0 ? -1 : 1
      const push = side * urgency * (1 - Math.abs(lateral) / corridor)
      const pushX = -direction.y * push * AVOID.turnGain
      const pushY = direction.x * push * AVOID.turnGain
      direction.x += pushX
      direction.y += pushY
      direction.z = 0
      direction.normalize()
    }
  }

  _stopMovement() {
    this._desired.set(0, 0, 0)
    this.usingDirectSteering = false
  }

  _integrate(dt, world) {
    const hasInput = this._desired.lengthSq() > 1e-6
    if (hasInput) {
      this.velocity.addScaledVector(this.velocity, -Math.min(1, MOVE.groundFriction * dt))
      this.velocity.addScaledVector(this._desired, MOVE.maxAcceleration * dt)
    } else {
      const speed = this.velocity.length()
      if (speed > 0) {
        const next = Math.max(0, speed - MOVE.brakingDeceleration * dt)
        this.velocity.multiplyScalar(next / speed)
      }
    }

    if (this._separation.lengthSq() > 1e-6) {
      this.velocity.addScaledVector(this._separation, MOVE.separationStrength * dt)
    }

    this.velocity.z = 0
    const speed = this.velocity.length()
    if (speed > this.maxSpeed) this.velocity.multiplyScalar(this.maxSpeed / speed)

    this.position.addScaledVector(this.velocity, dt)

    const bounds = world.bounds
    if (bounds) {
      this.position.x = clamp(this.position.x, bounds.minX, bounds.maxX)
      this.position.y = clamp(this.position.y, bounds.minY, bounds.maxY)
    }
    // Zombies never steer vertically and never leave the slab they were released onto.
    this.position.z = this.groundZ + this.halfHeight
  }

  _face(dt, world) {
    let want = this.yaw
    if (this.state === 'attack' && world.player) {
      want = Math.atan2(world.player.position.y - this.position.y, world.player.position.x - this.position.x)
    } else if (this.velocity.lengthSq() > 1) {
      want = Math.atan2(this.velocity.y, this.velocity.x)
    } else {
      return
    }
    let diff = (want - this.yaw) % TAU
    if (diff > Math.PI) diff -= TAU
    if (diff < -Math.PI) diff += TAU
    const step = this.turnRate * DEG * dt
    this.yaw += clamp(diff, -step, step)
  }

  // -------------------------------------------------------------------------
  // Attacks
  // -------------------------------------------------------------------------

  /**
   * §4.1. Damage is instant, the cooldown is only spent if it lands, and the SIMULATION still
   * has no wind-up: nothing here waits for the clip. What changed is that the clip is normally
   * already running by now, started by _startTelegraph one lead-time ago, so the arm is mid-swing
   * on the frame the damage arrives instead of starting to cock afterwards.
   */
  _tryMeleeAttack(player) {
    // The original played zombie_attack_swipe HERE, ahead of the cooldown guard, so a zombie
    // standing in range retriggered the clip about sixty times a second. This port always gates
    // it, and cannot do otherwise: the swipe reaches audio.js through EV.PLAYER_HIT, which also
    // drives the HUD's red damage flash, so replaying it per frame would strobe the screen.
    // ZOMBIES.SOUND.swipeGatedByCooldown records the decision rather than switching it.
    if (!SFX.swipeGatedByCooldown) {
      this.pool?._warnOnce('swipe-gate', '[zombie] ZOMBIES.SOUND.swipeGatedByCooldown is false, but the port cannot un-gate the swipe: it shares EV.PLAYER_HIT with the HUD damage flash. Swings stay gated.')
    }

    if (this.timeUntilNextAttack > 0) return

    // §4.1: a target with no health pool consumes no cooldown, so a zombie swinging at a
    // corpse or a prop keeps trying every frame rather than pausing for 1.2 s.
    const targetHealth = player.health
    if (!targetHealth) return

    const dealt = targetHealth.applyDamage(this.meleeDamage, false, this)
    this.timeUntilNextAttack = this.attackCooldown
    // Only restart the clip if no telegraph is in flight. Resetting unconditionally is what used
    // to throw the lead away every single time. The fallback still matters: a body teleported
    // into reach, or spawned on top of the player, gets a visible swing rather than a silent hit.
    if (this.attackT >= 1) this.attackT = 0
    this._emitPlayerHit(player, dealt)
  }

  /** audio.js reads `melee`/`archetype` to pick the swipe; hud.js flashes; gameState scores. */
  _emitPlayerHit(player, damage) {
    bus.emit(EV.PLAYER_HIT, {
      melee: true,
      kind: 'melee',
      archetype: this.typeId,
      damage,
      instigator: this,
      position: this.position,
      health: player.health?.health,
      armor: player.health?.armor,
    })
  }

  /** §4.2. Silent and flashless by design, and it always spawns, even inside geometry. */
  _tryRangedAttack(player) {
    if (this.timeUntilNextAttack > 0) return
    const projectiles = this.pool?.projectiles
    if (!projectiles) {
      this.pool?._warnOnce('projectiles', '[zombie] no ProjectilePool wired — Spitters cannot fire')
      return
    }

    // The assigned mesh has no socket named "Muzzle", so the original fell back to the capsule
    // origin and aimed at the player's capsule centre, not at the head or the camera.
    _v3.subVectors(player.position, this.position)
    if (_v3.lengthSq() < 1e-6) return

    projectiles.spawn({
      position: this.position,
      direction: _v3.normalize(),
      damage: this.projectileDamage,
      owner: this,
    })
    this.timeUntilNextAttack = this.attackCooldown
    this.attackT = 0
  }

  /** §3.3: a ray from the zombie's own viewpoint, which on this rig is literally its head. */
  _lineOfSight(world, player) {
    if (!world.hasLineOfSight) {
      this.pool?._warnOnce('los', '[zombie] no hasLineOfSight() in the world — Spitters will fire through columns and walls')
      return true
    }
    return world.hasLineOfSight(this.headPoint(_v1), player.position)
  }

  // -------------------------------------------------------------------------
  // Death
  // -------------------------------------------------------------------------

  /** §5. Idempotent: the health pool can call this from a burn tick and from a bullet. */
  die(killer = null) {
    if (this.state === 'dead') return
    // State first: killing the pool re-enters here through its onDied hook, and this is the guard.
    this.state = 'dead'
    if (!this.health.isDead) this.health.kill(killer)
    this.velocity.set(0, 0, 0)
    this._desired.set(0, 0, 0)
    this.deathT = 0
    this.corpseAge = 0

    // gameState counts the kill and drains the wave queue off this, hud draws the kill marker
    // from `zone`, and audio plays zombie_death_1..2 at the rules.js gain. §5's own sound call
    // is therefore this emit, not a second playback path.
    bus.emit(EV.ZOMBIE_DEATH, {
      zombie: this,
      archetype: this.typeId,
      zone: this.lastHitZone,
      position: this.position.clone(),
      killer,
    })
  }

  // -------------------------------------------------------------------------
  // Hitboxes
  // -------------------------------------------------------------------------

  /** World-space head centre, read off the posed skeleton rather than guessed from the capsule. */
  headPoint(out = new THREE.Vector3()) {
    return out.setFromMatrixPosition(this.bones[BONE.HEAD])
  }

  chestPoint(out = new THREE.Vector3()) {
    return out.setFromMatrixPosition(this.bones[BONE.CHEST])
  }

  /**
   * §2.4 in geometry instead of bone names: the zone a trace lands in decides the multiplier,
   * and only this module knows where the head actually is on a procedural rig.
   *
   * @returns {{distance:number, zone:'head'|'chest'|'body', point:THREE.Vector3}|null}
   */
  raycast(origin, direction, maxDistance = Infinity) {
    if (!this.rig) return null
    const s = this.scale

    const headR = this.rig.dims.headR * HITBOX.headPadding * s
    this.headPoint(_capA)
    let t = raySphere(origin, direction, _capA, headR)
    if (t >= 0 && t <= maxDistance) {
      return { distance: t, zone: 'head', point: _capA.copy(direction).multiplyScalar(t).add(origin).clone() }
    }

    this.chestPoint(_capA)
    _capB.copy(_capA).addScaledVector(_up, -this.rig.dims.torsoLen * HITBOX.chestLengthFraction * s)
    t = rayCapsule(origin, direction, _capA, _capB, this.rig.dims.torsoW * HITBOX.chestPadding * s)
    if (t >= 0 && t <= maxDistance) {
      return { distance: t, zone: 'chest', point: _capA.copy(direction).multiplyScalar(t).add(origin).clone() }
    }

    const spine = Math.max(0, this.halfHeight - this.radius)
    _capA.set(this.position.x, this.position.y, this.position.z - spine)
    _capB.set(this.position.x, this.position.y, this.position.z + spine)
    t = rayCapsule(origin, direction, _capA, _capB, this.radius)
    if (t >= 0 && t <= maxDistance) {
      return { distance: t, zone: 'body', point: _capA.copy(direction).multiplyScalar(t).add(origin).clone() }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Procedural performance
  //
  // There is no skeletal animation and no montage in this project; the original drove one
  // locomotion-only blend from owner velocity and had no attack animation at all. Everything
  // below is sine offsets per limb, tuned away from a commuter's walk: a low cadence, a heavy
  // shoulder roll, and one leg that never fully lifts.
  // -------------------------------------------------------------------------

  _rot(bone, x, y, z) {
    const i = bone * 6
    this._pose[i + 3] = x
    this._pose[i + 4] = y
    this._pose[i + 5] = z
  }

  _addRot(bone, x, y, z) {
    const i = bone * 6
    this._pose[i + 3] += x
    this._pose[i + 4] += y
    this._pose[i + 5] += z
  }

  _offset(bone, x, y, z) {
    const i = bone * 6
    this._pose[i] = x
    this._pose[i + 1] = y
    this._pose[i + 2] = z
  }

  _animate(dt) {
    this._pose.fill(0)
    const shape = this.shape
    const dead = this.state === 'dead'
    const speed = Math.hypot(this.velocity.x, this.velocity.y)
    const moveBlend = dead ? 0 : clamp(speed / Math.max(1, this.maxSpeed * 0.4), 0, 1)

    // Stride length scales with the body, so a Boss at scale 2.0 covers ground in fewer,
    // heavier steps instead of trotting.
    const hz = dead ? 0 : Math.max(shape.idleHz, speed / (2 * shape.strideCm * this.scale))
    this.phase = (this.phase + hz * TAU * dt) % TAU

    if (this.attackT < 1) this.attackT = Math.min(1, this.attackT + dt / ANIM.attackSeconds)

    if (dead) this._poseCorpse()
    else if (shape.stance === 'crawl') this._poseCrawl(moveBlend)
    else this._poseUpright(moveBlend)

    if (!dead) this._poseAttack()
    this._updateColors()
  }

  _poseUpright(moveBlend) {
    const sh = this.shape
    const p = this.phase
    const leadLeg = this.dragSide > 0 ? BONE.LEG_UL : BONE.LEG_UR
    const dragLeg = this.dragSide > 0 ? BONE.LEG_UR : BONE.LEG_UL
    const leadShin = leadLeg === BONE.LEG_UL ? BONE.LEG_FL : BONE.LEG_FR
    const dragShin = dragLeg === BONE.LEG_UL ? BONE.LEG_FL : BONE.LEG_FR

    // A positive pitch about Y swings a downward limb backward, so a forward step is negative.
    const swingLead = sh.legSwing * Math.sin(p) * moveBlend
    const swingDrag = sh.legSwing * sh.dragAmp * Math.sin(p + Math.PI) * moveBlend
      + sh.dragBias * (0.35 + 0.65 * moveBlend)
    this._rot(leadLeg, 0, -swingLead, 0)
    this._rot(dragLeg, 0, -swingDrag, 0)
    this._rot(leadShin, 0, sh.kneeBend * Math.max(0, Math.sin(p + 0.6)) * moveBlend, 0)
    // The dragging leg stays half-folded and barely clears the floor — that is the scuff.
    this._rot(dragShin, 0, sh.kneeBend * (0.30 + 0.25 * Math.max(0, Math.sin(p + Math.PI + 0.6)) * moveBlend), 0)

    // The dragging knee never straightens. Written after the swing above so it is a floor the
    // stride adds to rather than a term the stride can cancel — a leg that locks out at the
    // bottom of every step is a WALK, and the whole job of this rig is that it never is one.
    const lockIndex = dragShin * 6 + 4
    this._pose[lockIndex] = Math.max(this._pose[lockIndex], sh.kneeBend * sh.kneeLock)

    // Arms. The dead one and the reaching one are set outright rather than mirrored, because
    // the asymmetry has to survive a standstill: mirrored hangs plus a swing that multiplies
    // out at moveBlend 0 is exactly how eight stopped bodies snap into one identical pose.
    const swing = sh.armSwing * moveBlend
    const deadUpper = this.deadArm > 0 ? BONE.ARM_UL : BONE.ARM_UR
    const deadFore = this.deadArm > 0 ? BONE.ARM_FL : BONE.ARM_FR
    const liveUpper = this.deadArm > 0 ? BONE.ARM_UR : BONE.ARM_UL
    const liveFore = this.deadArm > 0 ? BONE.ARM_FR : BONE.ARM_FL
    const side = this.deadArm > 0 ? 1 : -1

    // Dead side: hangs off a slack shoulder, trailing behind the hip, swinging on its own
    // slower beat because nothing is driving it.
    this._rot(deadUpper, side * (sh.armOut * 0.55), sh.armHang * 0.30 + 0.26 + swing * 0.55 * Math.sin(p + Math.PI), side * 0.18)
    this._rot(deadFore, 0, 0.30 + 0.12 * Math.sin(p * 0.6), 0)

    // Live side: up and out toward whatever it is walking at. This is the pose the whole
    // silhouette rests on — an outline with one arm out in front of it is a zombie at any
    // distance, in any light, and an outline with two arms down is a mannequin.
    this._rot(liveUpper, -side * sh.armOut, -sh.reach + swing * Math.sin(p), -side * 0.12)
    this._rot(liveFore, 0, -sh.reachElbow + 0.16 * Math.sin(p - 0.9) * moveBlend, 0)

    // The hunch, plus a shoulder carried permanently higher than the other one and a rib cage
    // twisted off the hips. Both are per-body constants, so a crowd never lines up square.
    const lean = sh.lean * this.slump
    const chestX = this.shoulderTilt + sh.roll * Math.sin(p) * moveBlend
    const chestY = lean + 0.07 * Math.sin(2 * p) * moveBlend
      + 0.035 * Math.sin(this.age * 1.35) * (1 - moveBlend)
    this._rot(BONE.CHEST, chestX, chestY, this.spineTwist + 0.10 * Math.sin(p + 1.1) * moveBlend)

    // THE SPINE PIVOTS AT THE WAIST, NOT THE SHOULDER — and this is the bug behind the
    // "bodies come apart into floating pieces" finding, which was never a parenting mistake.
    //
    // BONE.CHEST's origin is the SHOULDER: every rib, belly and jacket primitive hangs DOWN
    // from it to the hips. Rotating that bone therefore swings the abdomen backward while the
    // head goes forward, and at the first pass's 0.52 lean the belly ellipsoid had already
    // travelled 21 cm behind a pelvis only 11 cm wide — the torso was hanging in space behind
    // the hips with daylight between them, on every upright zombie in the game. The deeper
    // hunch this pass needs would have torn it clean off.
    //
    // Re-parenting the chest to the waist would mean re-authoring every offset on it,
    // including the Tank's plates and the Conductor's coat. Translating it instead is exact
    // and costs two sines: put back whatever displacement the rotation gave the waist end, so
    // the bone spins about the hips while its geometry stays authored from the shoulder.
    const L = this.rig?.dims.torsoLen ?? 0
    const cy = Math.cos(chestY)
    this._offset(BONE.CHEST, L * Math.sin(chestY), -L * cy * Math.sin(chestX), L * (cy * Math.cos(chestX) - 1))
    // headCounter below 1 leaves the skull finishing LOWER than the shoulders it is slung
    // between, which is the read; the loll rolls it onto one shoulder so the face is never
    // square to the camera. It stays well short of 1.0 * lean — the eye glow is the archetype
    // tell and a head pitched all the way down aims it at the player's boots.
    // The head's WORLD pitch is `headTilt + lean * (1 - headCounter)`, and getting that wrong
    // is how the first capture of this pass came back with six crowns and no faces: at
    // headCounter 0.62 under a 0.74 hunch the skull finished 48 degrees nose-down, aimed at
    // the player's boots. headCounter above 1 cranes the neck back OUT of the hunch, which is
    // both the classic shape and the only way the eye glow points anywhere useful.
    this._rot(
      BONE.HEAD,
      0.16 * Math.sin(p * 0.53 + 0.7) - this.shoulderTilt * 0.5,
      sh.headTilt - lean * sh.headCounter + 0.05 * Math.sin(p * 0.81),
      this.headLoll + 0.18 * Math.sin(p * 0.37 + 2.0)
    )

    // A hip that has dropped on the dragging side and never came back up. Applied as a pelvis
    // roll, so the whole leg column tips with it rather than the joint pulling open.
    const bob = -sh.bob * (0.5 - 0.5 * Math.cos(2 * p)) * moveBlend
      - sh.bob * sh.limp * Math.max(0, Math.sin(p)) * moveBlend
    this._offset(BONE.PELVIS, 0, 0, bob - (this.rig?.kneeSink ?? 0))
    this._rot(
      BONE.PELVIS,
      this.dragSide * sh.hipDrop - sh.roll * 0.5 * Math.sin(p) * moveBlend,
      0,
      0.08 * Math.sin(p + Math.PI) * moveBlend
    )
  }

  /** Diagonal-pair gallop with a flexing spine: the Crawler must never read as a small man. */
  _poseCrawl(moveBlend) {
    const sh = this.shape
    const p = this.phase
    const a = Math.sin(p)
    const b = Math.sin(p + Math.PI)

    this._rot(BONE.ARM_UL, sh.armOut, -sh.legSwing * a * moveBlend, 0)
    this._rot(BONE.ARM_UR, -sh.armOut, -sh.legSwing * b * moveBlend, 0)
    this._rot(BONE.ARM_FL, 0, sh.kneeBend * 0.5 * Math.max(0, a) * moveBlend, 0)
    this._rot(BONE.ARM_FR, 0, sh.kneeBend * 0.5 * Math.max(0, b) * moveBlend, 0)
    this._rot(BONE.LEG_UL, 0, -sh.legSwing * sh.dragAmp * b * moveBlend, 0)
    this._rot(BONE.LEG_UR, 0, -sh.legSwing * sh.dragAmp * a * moveBlend, 0)
    this._rot(BONE.LEG_FL, 0, sh.kneeBend * 0.45 * Math.max(0, b) * moveBlend, 0)
    this._rot(BONE.LEG_FR, 0, sh.kneeBend * 0.45 * Math.max(0, a) * moveBlend, 0)

    this._rot(BONE.CHEST, sh.roll * a * moveBlend, 0.20 * Math.sin(2 * p) * moveBlend, 0.12 * a * moveBlend)
    this._rot(BONE.HEAD, 0.12 * Math.sin(p * 0.7), sh.headTilt + 0.10 * Math.sin(2 * p) * moveBlend, 0.15 * Math.sin(p * 0.45))
    this._offset(BONE.PELVIS, 0, 0, -sh.bob * (0.5 - 0.5 * Math.cos(2 * p)) * moveBlend)
  }

  /** Wind up, then slam. Damage already landed on frame one; this is the tell, not the hit. */
  _poseAttack() {
    if (this.attackT >= 1) return
    const a = this.attackT
    const settle = a < 0.85 ? 1 : (1 - a) / 0.15
    const wind = a < 0.32 ? a / 0.32 : 1
    const strike = a < 0.32 ? 0 : (a - 0.32) / 0.68

    if (this.typeId === 'ranged') {
      this._addRot(BONE.HEAD, 0, (-0.95 * wind + 1.85 * strike) * settle, 0)
      this._addRot(BONE.CHEST, 0, (-0.30 * wind + 0.60 * strike) * settle, 0)
      return
    }

    // The swing comes off the live side, never the dead one the rest pose left trailing.
    const leadArm = this.deadArm > 0 ? BONE.ARM_UR : BONE.ARM_UL
    const leadFore = leadArm === BONE.ARM_UR ? BONE.ARM_FR : BONE.ARM_FL
    const twist = leadArm === BONE.ARM_UR ? 1 : -1
    this._addRot(leadArm, 0, (1.30 * wind - 2.55 * strike) * settle, 0)
    this._addRot(leadFore, 0, -0.35 * settle * (1 - strike), 0)
    this._addRot(BONE.CHEST, 0, (0.10 + 0.22 * strike) * settle, (0.42 * wind - 0.85 * strike) * settle * twist)
  }

  /**
   * The original ragdolled the mesh under real physics. There is no rigid-body solver here, so
   * the corpse settles through a scripted collapse instead — the root tips over (see
   * _composeBones) while the limbs go slack in a direction drawn once at spawn.
   */
  _poseCorpse() {
    const f = easeOut(this.deathT)
    const s = this.collapseSign
    this._rot(BONE.CHEST, 0.25 * f * s, 0.35 * f, 0)
    this._rot(BONE.HEAD, 0.40 * f * s, 0.50 * f, 0.30 * f * s)
    this._rot(BONE.ARM_UL, 0.90 * f, -0.60 * f, 0)
    this._rot(BONE.ARM_UR, -0.90 * f, -0.50 * f, 0)
    this._rot(BONE.ARM_FL, 0, 0.90 * f, 0)
    this._rot(BONE.ARM_FR, 0, 0.70 * f, 0)
    this._rot(BONE.LEG_UL, 0.35 * f, 0.50 * f, 0)
    this._rot(BONE.LEG_UR, -0.35 * f, -0.25 * f, 0)
    this._rot(BONE.LEG_FL, 0, 0.90 * f, 0)
    this._rot(BONE.LEG_FR, 0, 0.50 * f, 0)
  }

  /** 0 while the corpse is fresh, 1 the instant before the pool reclaims it. */
  _fadeAmount() {
    if (this.state !== 'dead') return 0
    const start = CORPSE.lifeSpan - CORPSE.fadeSeconds
    if (this.corpseAge <= start) return 0
    return clamp((this.corpseAge - start) / CORPSE.fadeSeconds, 0, 1)
  }

  _updateColors() {
    const fade = 1 - this._fadeAmount()
    const flash = this.flashT > 0 ? (this.flashT / ANIM.flashSeconds) * ANIM.flashGain : 0
    this.tintColor.copy(this._tintBase).multiplyScalar(fade * (1 + flash))

    // How close the archetype's own attack timer is to firing, 0 right after a hit lands (or a
    // spit is thrown) up to 1 the instant before the next one — read from `timeUntilNextAttack`
    // / `attackCooldown`, the same pair `_tryMeleeAttack`/`_tryRangedAttack` already maintain.
    // This is a tell, not a clock: it carries no information the AI doesn't already have.
    const charge = this.attackCooldown > 0
      ? 1 - clamp(this.timeUntilNextAttack / this.attackCooldown, 0, 1)
      : 1

    let glow = 1
    if (this.typeId === 'ranged') {
      // The gut brightens as the 2 s cooldown runs out, so a player can read an incoming spit.
      glow = 0.30 + 0.70 * charge * charge
    } else if (this.typeId === 'boss') {
      // Flat and dim on cooldown; the pulse's amplitude grows in step with the charge so it
      // only swells bright as the swing gets close, and collapses back to the floor the frame
      // the hit lands and the cooldown resets.
      glow = 0.44 + 0.56 * charge * (0.5 + 0.5 * Math.sin(this.age * 3.1))
    } else if (this.typeId === 'tank') {
      glow = 0.20 + 0.80 * charge * (0.5 + 0.5 * Math.sin(this.age * 1.6))
    }
    if (this.state === 'dead') glow *= Math.max(0, 1 - this.deathT)
    this.glowLevel = glow
    this.glowColor.setScalar(glow * fade)
  }

  /** Root transform, then one matrix multiply per bone down the hierarchy. */
  _composeBones() {
    const rig = this.rig
    if (!rig) return

    const fall = this.state === 'dead' ? easeOut(this.deathT) : 0
    // A corpse lies with its spine about one capsule radius off the slab, not floating at
    // standing height; the last second of its life it also sinks out of sight.
    const standing = this.halfHeight
    const lying = this.radius * 0.9
    const z = this.groundZ + standing + (lying - standing) * fall - this._fadeAmount() * this.halfHeight * 2.4

    _v1.set(this.position.x, this.position.y, z)
    _quat.setFromAxisAngle(_up, this.yaw)
    if (fall > 0) {
      _v2.set(Math.cos(this.collapseDir), Math.sin(this.collapseDir), 0)
      _quatB.setFromAxisAngle(_v2, 1.48 * fall * this.collapseSign)
      _quat.multiply(_quatB)
    }
    _scaleV.setScalar(this.scale)
    this.bones[BONE.ROOT].compose(_v1, _quat, _scaleV)

    const pos = rig.rest.pos
    const rot = rig.rest.rot
    const pose = this._pose
    for (let b = 1; b < BONE_COUNT; b++) {
      const p3 = b * 3
      const p6 = b * 6
      _v2.set(pos[p3] + pose[p6], pos[p3 + 1] + pose[p6 + 1], pos[p3 + 2] + pose[p6 + 2])
      _euler.set(rot[p3] + pose[p6 + 3], rot[p3 + 1] + pose[p6 + 4], rot[p3 + 2] + pose[p6 + 5])
      _quatB.setFromEuler(_euler)
      _mat.compose(_v2, _quatB, _one)
      this.bones[b].multiplyMatrices(this.bones[BONE_PARENT[b]], _mat)
    }
  }
}

/**
 * Owns the rigs, the materials, the instanced draw calls and the recycling.
 *
 * A dead zombie keeps its slot for the full 8 s corpse life (spec §5), then the object itself
 * is handed back to its archetype's free list — the meshes are never created or destroyed at
 * runtime, only re-pointed, which is what keeps a wave-16 crowd of sixty inside frame budget.
 */
export class ZombiePool {
  /**
   * @param {THREE.Object3D} parent
   * @param {{capacity?:number, groundZ?:number, projectiles?:ProjectilePool,
   *          aggroGated?:boolean, castShadow?:boolean}} [opts]
   */
  constructor(parent, opts = {}) {
    if (!parent) throw new Error('[zombie] ZombiePool needs a parent Object3D to render into')

    this.parent = parent
    this.capacity = Math.max(8, opts.capacity ?? WAVES.maxLiveZombies)
    this.groundZ = opts.groundZ ?? STATION.LEVELS.platformTopZ
    this.aggroGated = opts.aggroGated ?? false
    this.castShadow = opts.castShadow ?? true

    this.group = new THREE.Group()
    this.group.name = 'zombies'
    parent.add(this.group)

    this.projectiles = opts.projectiles ?? new ProjectilePool(parent)
    // A spit that lands on another zombie is friendly fire and stays silent; one that lands on
    // the player is the only thing in the game that emits a non-melee EV.PLAYER_HIT.
    this.projectiles.onHit = (pawn, damage, owner) => {
      if (pawn.isZombie) return
      bus.emit(EV.PLAYER_HIT, {
        melee: false,
        kind: 'projectile',
        archetype: owner?.typeId ?? ARCHETYPES.ranged.id,
        damage,
        instigator: owner,
        position: pawn.position,
        health: pawn.health?.health,
        armor: pawn.health?.armor,
      })
    }

    this.rigs = {}
    this.materials = {}
    this.meshes = {}
    this._free = {}
    this._counts = {}
    for (const id of ZOMBIES.ORDER) {
      this.rigs[id] = buildRig(id)
      this.materials[id] = buildMaterials(id)
      this.meshes[id] = this._buildMeshes(id, this.capacity)
      this._free[id] = []
      this._counts[id] = 0
    }

    this.bodies = []
    this._pawnScratch = []
    this._warned = new Set()
  }

  _buildMeshes(id, capacity) {
    const rig = this.rigs[id]
    const mats = this.materials[id]
    const out = []
    for (const group of rig.groups) {
      const mesh = new THREE.InstancedMesh(group.geometry, mats[group.role], capacity)
      mesh.name = `zombie-${id}-${group.bone}-${group.role}`
      mesh.count = 0
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // Instances are spread across 6000 cm of platform; the source geometry's bounding sphere
      // describes one limb at the origin, so per-mesh culling would delete the whole crowd.
      mesh.frustumCulled = false
      // Wounds are flattened lenses sunk a couple of centimetres into a body that is already
      // casting its own shadow, so they cannot change a silhouette by one pixel — but each one
      // is an InstancedMesh drawn again in every one of the four shadow passes. Skipping them
      // buys back a fifth of the crowd's shadow cost for nothing.
      mesh.castShadow = this.castShadow && group.role !== 'glow' && group.role !== 'wound'
      mesh.receiveShadow = group.role !== 'glow'
      this.group.add(mesh)
      out.push({ bone: group.bone, role: group.role, mesh })
    }
    return out
  }

  _grow(id, next) {
    console.info(`[zombie] ${id}: growing instance capacity ${this.capacity} -> ${next}`)
    this.capacity = next
    for (const other of ZOMBIES.ORDER) {
      for (const g of this.meshes[other]) { this.group.remove(g.mesh); g.mesh.dispose() }
      this.meshes[other] = this._buildMeshes(other, next)
    }
  }

  _warnOnce(key, message) {
    if (this._warned.has(key)) return
    this._warned.add(key)
    console.warn(message)
  }

  /**
   * @param {'base'|'zerg'|'ranged'|'tank'|'boss'} typeId
   * @param {{waveNumber:number, healthScale:number, speedScale:number, damageScale:number}} wave
   */
  spawn(typeId, wave, x, y, groundZ = this.groundZ) {
    if (!ARCHETYPES[typeId]) throw new Error(`[zombie] cannot spawn unknown archetype "${typeId}"`)

    if (this._counts[typeId] + 1 > this.capacity) this._grow(typeId, this.capacity * 2)

    // Recycled bodies are reused in place; the meshes never churn, only the slot they occupy.
    const zombie = this._free[typeId].pop() ?? new Zombie(this)
    // Position before configure: configureForWave resolves the archetype, and only then is
    // halfHeight known, so placeAt is what finally seats the capsule on the slab.
    zombie.position.set(x, y, groundZ)
    zombie.groundZ = groundZ
    zombie.configureForWave(typeId, wave)
    zombie.placeAt(x, y, groundZ)
    // Facing is not seeded from the door because the door's world rotation belongs to the
    // train; a random heading that the turn rate corrects within a second reads as a crowd
    // stumbling out rather than a rank stepping off in formation.
    zombie.yaw = rng.range(0, TAU)

    this.bodies.push(zombie)
    this._counts[typeId] += 1
    return zombie
  }

  /** @param {number} dt @param {ZombieWorld} world */
  update(dt, world = {}) {
    if (world.player && (typeof world.player.radius !== 'number' || typeof world.player.halfHeight !== 'number')) {
      this._warnOnce('pawn-shape', '[zombie] world.player is missing a numeric radius/halfHeight — Spitter projectiles will pass straight through it')
    }
    if (world.obstacles === undefined) {
      this._warnOnce('obstacles', '[zombie] no world.obstacles supplied — zombies will walk through the station columns')
    }

    this._separate()
    for (let i = 0; i < this.bodies.length; i++) this.bodies[i].update(dt, world)

    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const zombie = this.bodies[i]
      if (!zombie.expired) continue
      this.bodies.splice(i, 1)
      zombie.active = false
      this._counts[zombie.typeId] -= 1
      this._free[zombie.typeId].push(zombie)
    }

    this.projectiles.update(dt, this._pawns(world))
    this.sync()
  }

  /**
   * Crowd separation, which the original had none of: sixty pathless zombies all steering at
   * one point otherwise converge into a single stack of bodies at the player's feet.
   */
  _separate() {
    const bodies = this.bodies
    const n = bodies.length
    for (let i = 0; i < n; i++) bodies[i]._separation.set(0, 0, 0)

    for (let i = 0; i < n; i++) {
      const a = bodies[i]
      if (a.state === 'dead') continue
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j]
        if (b.state === 'dead') continue
        const dx = b.position.x - a.position.x
        const dy = b.position.y - a.position.y
        const threshold = (a.radius + b.radius) * MOVE.separationRadiusFactor * 0.5
        const d2 = dx * dx + dy * dy
        if (d2 >= threshold * threshold) continue
        if (d2 < 1e-6) {
          // Exactly co-located bodies have no direction to push along; break the tie the same
          // way every run rather than drawing from the rng and desyncing the soak.
          a._separation.x -= 1
          b._separation.x += 1
          continue
        }
        const d = Math.sqrt(d2)
        const push = (1 - d / threshold) / d
        a._separation.x -= dx * push
        a._separation.y -= dy * push
        b._separation.x += dx * push
        b._separation.y += dy * push
      }
    }

    for (let i = 0; i < n; i++) {
      const s = bodies[i]._separation
      const len = Math.hypot(s.x, s.y)
      if (len > 1) { s.x /= len; s.y /= len }
    }
  }

  /** Everything a spit can hit: the player plus every living zombie, the shooter excepted. */
  _pawns(world) {
    const out = this._pawnScratch
    out.length = 0
    if (world.player) out.push(world.player)
    for (let i = 0; i < this.bodies.length; i++) {
      const zombie = this.bodies[i]
      if (zombie.state !== 'dead') out.push(zombie)
    }
    return out
  }

  sync() {
    const seen = {}
    for (const id of ZOMBIES.ORDER) seen[id] = 0

    for (let i = 0; i < this.bodies.length; i++) {
      const zombie = this.bodies[i]
      const slot = seen[zombie.typeId]++
      if (slot >= this.capacity) {
        // _grow() at spawn time should make this unreachable. If it ever fires, a zombie is
        // simulating and damaging the player while being invisible, which is the worst
        // possible way to fail, so it says so.
        this._warnOnce('overflow', `[zombie] more live ${zombie.typeId} bodies than the ${this.capacity} instance slots — the overflow is NOT being drawn`)
        continue
      }
      const groups = this.meshes[zombie.typeId]
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g]
        group.mesh.setMatrixAt(slot, zombie.bones[group.bone])
        group.mesh.setColorAt(slot, group.role === 'glow' ? zombie.glowColor : zombie.tintColor)
      }
    }

    for (const id of ZOMBIES.ORDER) {
      for (const group of this.meshes[id]) {
        group.mesh.count = seen[id]
        group.mesh.instanceMatrix.needsUpdate = true
        if (group.mesh.instanceColor) group.mesh.instanceColor.needsUpdate = true
      }
    }
  }

  /**
   * Nearest zombie a bullet trace reaches, with the hit zone that selects the damage
   * multiplier. Corpses are skipped: the original left a ragdoll blocking the visibility
   * channel, so a pile of bodies ate rounds meant for the thing walking behind them.
   *
   * @returns {{zombie:Zombie, distance:number, zone:'head'|'chest'|'body', point:THREE.Vector3}|null}
   */
  raycast(origin, direction, maxDistance = Infinity) {
    let best = null
    for (let i = 0; i < this.bodies.length; i++) {
      const zombie = this.bodies[i]
      if (zombie.state === 'dead') continue
      const hit = zombie.raycast(origin, direction, maxDistance)
      if (!hit) continue
      if (best && hit.distance >= best.distance) continue
      hit.zombie = zombie
      best = hit
    }
    return best
  }

  /** §3.5: the weapon's unsilenced-shot sweep. The latch only matters when aggroGated is on. */
  alertNearby(origin) {
    const reach = ZOMBIES.AGGRO.hearingRadius * ZOMBIES.AGGRO.hearingRadius
    for (let i = 0; i < this.bodies.length; i++) {
      const zombie = this.bodies[i]
      if (zombie.state === 'dead') continue
      if (zombie.position.distanceToSquared(origin) <= reach) zombie.onHeardShot(origin)
    }
  }

  /** Living zombies, which is the number the HUD and the wave director care about. */
  get aliveCount() {
    let n = 0
    for (let i = 0; i < this.bodies.length; i++) if (this.bodies[i].state !== 'dead') n += 1
    return n
  }

  /** Living bodies plus corpses still on the floor — what is actually being drawn. */
  get bodyCount() { return this.bodies.length }

  /** Drop everyone where they stand, corpses included. Used between waves and on restart. */
  clear() {
    for (const zombie of this.bodies) {
      zombie.active = false
      this._free[zombie.typeId].push(zombie)
    }
    this.bodies.length = 0
    for (const id of ZOMBIES.ORDER) this._counts[id] = 0
    this.projectiles.clear()
    this.sync()
  }

  dispose() {
    this.clear()
    for (const id of ZOMBIES.ORDER) {
      for (const group of this.meshes[id]) {
        group.mesh.dispose()
        this.group.remove(group.mesh)
      }
      for (const group of this.rigs[id].groups) group.geometry.dispose()
      // Every role, not a hand-listed three — adding a material role should never silently
      // start leaking one. The baked flesh textures are module-level and shared by every
      // archetype and every pool, so they deliberately outlive this.
      for (const material of Object.values(this.materials[id])) material.dispose()
    }
    this.projectiles.dispose()
    this.group.removeFromParent()
  }
}

export default Zombie
