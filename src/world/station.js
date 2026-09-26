/**
 * station.js — the subway platform, built procedurally to the spec's exact dimensions.
 *
 * ## Coordinate frame
 *
 * The spec is Z-up (X along the platform, Y across it, Z up, Z=0 = the walkable floor).
 * three.js is Y-up. This module is the single place that bridge happens:
 *
 *     three = (spec.x, spec.z, -spec.y)
 *
 * which is a -90 degree rotation about X, so handedness and yaw both carry over
 * unchanged: a spec yaw of theta is a three `rotation.y` of theta, and "facing +X"
 * means facing +X in both frames. Everything this module RETURNS — colliders, spawn
 * points, the player start, the train stops, the bounds — is already in three
 * coordinates, so no other module has to know the spec frame exists. `specToThree`
 * is exported for the modules that still want to place something from a spec number.
 *
 * ## Why it is built this way
 *
 * 140 boxes and cylinders is 140 draw calls if you make 140 meshes, so geometry is
 * appended straight into shared vertex buffers, one per material family — 13 meshes
 * for the whole station. Two things ride along in those buffers that a stock
 * BoxGeometry could not carry:
 *
 * - **World-space UVs.** Every surface is textured at a fixed centimetres-per-repeat,
 *   so a 6000 cm wall and a 30 cm turnstile post show the same size tile instead of the
 *   turnstile showing one enormous smeared one.
 * - **Baked grime in vertex colours.** The original had no AO and no dirt, which is
 *   most of why it read as grey boxes. Soot darkens toward the track pits, the ceiling
 *   and the tunnel ends, and it multiplies the spec's flat colour rather than replacing
 *   it, so the authored colours are still diffable against the spec.
 */

import * as THREE from 'three/webgpu'
import { FX, STATION, TRAIN, PLAYER } from '../game/rules.js'
import { createStationMaterials, loadLogoTexture, TEXTURE_CM } from './materials.js'
import { createLighting } from './lighting.js'
import { buildSummit } from './summit.js'
import { Rng } from '../core/rng.js'

const DIM = STATION.DIMENSIONS
const LEVELS = STATION.LEVELS
const COUNTS = STATION.COUNTS
const TRACK = STATION.TRACK
const STRIPE = STATION.STRIPE
const PROPS = STATION.PROPS
const POINTS = STATION.PICKUP_POINTS
const DESIGNED = STATION.DESIGNED
const GRIME = STATION.MATERIALS.grimeStrength

const deg = Math.PI / 180

/** Unreal candelas assume metres; this world is centimetres. Same knob lighting.js uses. */
const candela = (unrealIntensity) => unrealIntensity * FX.LIGHT_INTENSITY_SCALE

/**
 * One spec number rules.js has no field for. It is not an invention — spec section 2.5
 * gives the pilaster half-extent as (50, 50, 360) against the wall's 350, so each rib
 * stands 10 cm proud of the wall at top and bottom. Fold it into `STATION.DIMENSIONS`
 * next time rules.js is edited; this module does not own that file, so it keeps one
 * labelled copy here rather than reaching across and clobbering another agent's work.
 */
const SPEC_GAPS = Object.freeze({
  pilasterHalfHeight: 360.0, // spec/world-subway-station.md section 2.5
})

/**
 * The trackway, and why the spec's track datum could not be kept.
 *
 * The spec lays the rails on the pit floor at Z -250, 250 cm below the platform. Two
 * things make that invisible rather than merely dark:
 *
 * 1. **No camera can see it.** A sightline grazing the platform lip at (700, 0) from a
 *    standing eye drops 0.4 cm per centimetre of reach, so at the far pit wall — the
 *    deepest thing in frame — it has only fallen to Z -201. Every rail, sleeper and
 *    ballast surface at Z -250 sits below that line from ANY eye height on the slab.
 *    They were being built, lit and drawn, and then clipped away by the platform's own
 *    edge. Lighting them harder would not have moved them one pixel.
 * 2. **The carriage is not in the pit.** game.js re-seats the run to the platform's own
 *    floor line — see its TRAIN_DOCK_Y/TRAIN_DOCK_Z note — because the spec's 160 cm
 *    greybox parked at Z -230 finishes its ROOF 70 cm BELOW the lip. So the docked car's
 *    running gear reaches down only to Z -20, and rails 210 cm beneath it are not track
 *    the train runs on, they are scenery in a different room. That is precisely what the
 *    rendered frame showed: a carriage hanging in the air with lit brick under it.
 *
 * So the pit keeps its 250 cm excavation and the track rides a bed poured inside it.
 * Every TRACK.* cross-section, gauge, tie spacing and tie count is used unchanged — only
 * the datum moves, and it moves to the one height that is not a guess: the platform floor
 * line minus the carriage's own running-gear clearance, which train.js calls
 * BOGIE_CLEARANCE and derives from the same two spec numbers used here. The car's wheels
 * then stand on the rail crowns instead of hovering over a void.
 *
 * The bed spans the full pit width because occlusion is the entire point: a bed top at
 * Z -48 intercepts the lip sightline at Y 819, which is INSIDE the carriage's own
 * footprint (700..860), so the gap under the car closes completely and no background
 * survives in it from any standing camera.
 */
const BOGIE_CLEARANCE = DESIGNED.trainStopZ - LEVELS.trackFloorZ

const RAIL_CROWN_Z = LEVELS.platformTopZ - BOGIE_CLEARANCE
const SLEEPER_TOP_Z = RAIL_CROWN_Z - TRACK.railHalfHeight * 2
const BED_TOP_Z = SLEEPER_TOP_Z - TRACK.sleeperHalfHeight * 2

/**
 * The third rail and the cable bench are new — the spec has neither, and a track with
 * nothing but two running rails reads as a model railway. They earn their place as
 * DEPTH: from the platform the inner running rail falls under the lip sightline (visible
 * only to Z -2 at Y 705, and its crown is at -20), so without them the trackway offers
 * exactly one converging line. With them it offers four — safety stripe, outer rail,
 * protection board, cable bench — all running to the same vanishing point.
 */
const TRACKWAY = Object.freeze({
  /** The docked carriage's centreline, derived the way game.js derives it. */
  centreY: DIM.platformHalfWidth + TRAIN.bodyHalfExtent[1],
  railCentreZ: RAIL_CROWN_Z - TRACK.railHalfHeight,
  sleeperCentreZ: SLEEPER_TOP_Z - TRACK.sleeperHalfHeight,
  bedCentreZ: (BED_TOP_Z + LEVELS.trackFloorZ) * 0.5,
  bedHalfHeight: (BED_TOP_Z - LEVELS.trackFloorZ) * 0.5,

  thirdRailOffset: 230.0, // cm outboard of the track centreline — 155 cm off the outer running rail
  thirdRailHalfWidth: 6.0, // cm; a conductor rail is a fatter section than a running rail
  thirdRailCentreZ: RAIL_CROWN_Z - 6 - TRACK.railHalfHeight, // crown 6 cm under the running crown
  boardHalfWidth: 22.0, // cm; the timber guard plank over the live rail
  boardHalfThickness: 3.0,
  boardCentreZ: RAIL_CROWN_Z + 3, // clears the conductor rail by 4 cm on its brackets

  ductCentreY: LEVELS.wallInnerY - 50, // cm; 5 cm clear of the wall face so no two faces are coplanar
  ductHalfWidth: 45.0,
  ductCentreZ: (BED_TOP_Z + (LEVELS.platformTopZ - 8)) * 0.5,
  ductHalfHeight: (LEVELS.platformTopZ - 8 - BED_TOP_Z) * 0.5,

  /**
   * The rail foot. A bare 8 cm rail head is a HAIRLINE at track distance — measured on the
   * first render it came out as a one-pixel dark thread that read as another gap between
   * ties, not as a rail. A real rail sits on a continuous steel foot four times its width,
   * and at the 5-8 degree depression angle the camera looks down the trough at, that foot
   * is the only part of the running gear with enough horizontal area to catch a lamp.
   */
  footHalfWidth: 16.0, // cm; 32 cm across, four rail-widths
  footHalfHeight: 3.5,
  footCentreZ: SLEEPER_TOP_Z + 3.5, // seated on the tie tops

  /**
   * Soot boosts. The trackway is a ballast trough under a century of brake dust and it must
   * not read as the clean paving the first render made of it — the tie tops measured L=50
   * against a platform floor of L=30, which put the brightest thing in the lower frame on
   * the track instead of on the train. Dirt is warm in grimeAt, so these also pull the
   * cool wall-wash bias out of the trough. The rails get none: they are the one thing down
   * there allowed to shine.
   */
  bedSoot: 0.24,
  tieSoot: 0.27,
  boardSoot: 0.2,
  ductSoot: 0.18,

  /**
   * Vertex-colour gain on everything in the rail family — see MeshBuilder.gain for why a
   * 0.1 base colour is a unit mismatch on a 0.9-metalness surface and not a dark rail.
   * 4.4 puts F0 at about 0.44 against real steel's 0.56 — still short of the real metal,
   * and enough that the crowns pick the sodium lamps up as travelling glints down the
   * length of the trough instead of reading as one more gap between ties.
   */
  railPolish: 4.4,
})

/**
 * The stairwell, and why it stopped being a box.
 *
 * The extracted level builds two solid masses at the west end and calls them architecture:
 * a 440 x 520 x 230 block (spec section 2.8, "Stairwell block ... Solid") and a 520 x 600
 * slab overhanging it at Z 220..250, "Mezzanine slab". Neither can be climbed, stood on or
 * entered. They are a set dressing of a staircase — the same class of defect as the trains
 * that teleport onto the platform: the intent is unmistakable and the implementation never
 * arrived.
 *
 * So the mass is replaced by the building it was standing in for, and every dimension comes
 * out of the two spec boxes rather than being invented beside them:
 *
 * - The stair SHAFT is the stairwell block's own footprint, X 80..520 by Y +/-260.
 * - The deck sits at the mezzanine slab's own top, Z 250, and is its own 30 cm thick.
 * - The mezzanine slab is 40 cm proud of the stairwell block on every side, and 40 cm is
 *   `DIM.wallThickness` exactly. That is not a coincidence worth ignoring: the slab's extra
 *   footprint IS the thickness of the shaft walls it was drawn over. So the flanking walls
 *   stand at Y 260..300 and the head wall at X 40..80, and the spec's mezzanine outline is
 *   reproduced exactly — as the outside of a stairwell instead of as a lid on one.
 *
 * What is genuinely new is the balcony east of the shaft and the light well above it, and
 * both are called out below. rules.js has no section for a building the original never
 * built, and this module does not own that file, so they live in one labelled block here
 * the way `TRACKWAY` and `SPEC_GAPS` already do.
 */
const SHAFT_MIN_X = PROPS.stairwell.centre[0] - PROPS.stairwell.halfExtent[0]
const SHAFT_MAX_X = PROPS.stairwell.centre[0] + PROPS.stairwell.halfExtent[0]
const DECK_TOP_Z = PROPS.mezzanine.centre[2] + PROPS.mezzanine.halfExtent[2]

const STAIRS = Object.freeze({
  minX: SHAFT_MIN_X, // 80 — the stairwell block's west face
  maxX: SHAFT_MAX_X, // 520 — its east face, and the mouth of the stair
  halfWidth: PROPS.stairwell.halfExtent[1], // 260
  topZ: DECK_TOP_Z, // 250 — the mezzanine slab's walking surface
  deckThickness: PROPS.mezzanine.halfExtent[2] * 2, // 30 — the slab's own depth
  deckUnderZ: DECK_TOP_Z - PROPS.mezzanine.halfExtent[2] * 2, // 220 — the soffit you walk under

  /** The shaft's enclosure, which is exactly the mezzanine slab's overhang. See above. */
  wallOuterY: PROPS.mezzanine.halfExtent[1], // 300
  wallMinX: PROPS.mezzanine.centre[0] - PROPS.mezzanine.halfExtent[0], // 40

  /**
   * A switchback, not a single run. 250 cm in one straight flight inside a 440 cm footprint
   * is a 30 degree ramp with no landing, which is a fire escape, not a station stair. Two
   * flights around a central spine give the climb a turn in it — you lose sight of the
   * platform on the way up and get it all back at the top — and it is what every subway
   * stairwell of this footprint actually is.
   */
  landingDepth: 120.0, // cm of the footprint given to the half-landing at the west end
  treadsPerFlight: 10,

  /**
   * The spine between the two flights. 55 cm of half-width because the centre column at
   * X = 400 (DIM.columnMargin, the first of the nine) stands inside this footprint with a
   * 45 cm radius: the spine is built 10 cm fatter than the column so the column disappears
   * into it instead of standing in the middle of a flight. The original parked its solid
   * block straight over that column and never noticed.
   */
  newelHalfY: DIM.columnRadius + 10.0,

  /**
   * How far the balcony reaches back over the platform. One column bay, so the second
   * column (X = 1000) carries its east end the way the first carries the shaft — a
   * cantilevered 600 cm deck with nothing under it reads as a shelf, not as a building.
   */
  deckReach: DIM.columnSpacing,
  /** Depth of the solid cross-piece at the head of the stair, before the deck opens up. */
  deckThreshold: 140.0,
  /**
   * How far east of the stair mouth the balcony's SOUTH edge has to start, and the one
   * number here that was measured rather than chosen.
   *
   * The first version ran the deck full-width from X 520, which put its 220 cm soffit over
   * the bottom of the flight — and a climber is 192 cm tall, so from the third tread up
   * their head is inside it. player.js refuses a step whose landing has no headroom
   * (`_headroomOver`), correctly, so the staircase stopped dead two steps up: driven
   * through __SHOE__ the pawn reached Z 25 and stayed there for twenty-two seconds.
   *
   * Two capsule radii east of the mouth clears it: a climber whose head is still under
   * deck height stands at most one radius inside the mouth, and the capsule reaches one
   * more radius past that. The mouth of the stair is therefore open to the full 450 cm
   * ceiling, which is what a stair mouth should be anyway.
   */
  deckMouthClearance: PLAYER.capsuleRadius * 2,
  /**
   * The void down the middle of the balcony. Sized off the hanging signs, which are 160 cm
   * across and hang at Z 330..390 — the one at X = 800 lands inside the balcony, and a sign
   * at chest height on a walkway is a mistake. The void is 30 cm clear of it on each side,
   * so the sign hangs FREE in the opening and the player reads it at eye level on the way
   * past instead of walking through it. It is also the whole point of a mezzanine: you can
   * look straight down on the platform through the hole.
   */
  voidHalfY: PROPS.hangingSign.halfExtent[1] + 30.0,

  /**
   * Railings. 112 cm is waist-high on a 192 cm pawn: too tall to clear with the 45 cm step
   * (PLAYER.MOVEMENT.maxStepHeight) or the 90 cm jump apex, so the balcony contains you,
   * and low enough to shoot over from a standing eye at 160 cm. That trade IS the level
   * design — up here melee cannot reach you and the floor under the lip cannot be seen.
   */
  railHeight: 112.0,
  railKerb: 22.0, // solid plinth at the bottom of every run
  railThickness: 8.0,
  railTopDepth: 9.0, // the capping rail's own section
  railCapOverhang: 2.5, // how far the cap stands proud of the run it sits on
  postSpacing: 150.0,

  handrailHeight: 95.0, // cm above the tread nosing — the height a hand actually falls at
  handrailRadius: 5.0,
  handrailStandoff: 7.0, // clear of the wall or spine it is bracketed to

  /**
   * The light well. The stairs go somewhere, and the cheapest way to say so is to open the
   * ceiling over them and let the street in: daylight is the only cold, bright, directional
   * source in a station lit entirely by warm sodium, so it reads as OUTSIDE at a glance and
   * gives the platform a bright anchor at the end that had none.
   */
  wellTopZ: 940.0, // cm; the pavement grating, five metres above the ceiling line
  wellCapThickness: 40.0,

  /**
   * How far EAST of the stair the ceiling stays open, and the second number here that was
   * measured rather than chosen.
   *
   * The first cut opened the ceiling over the stair shaft alone. It lit the stairwell
   * beautifully and was invisible from the platform: the shaft is a walled box, so all the
   * daylight landed inside it and the thing a player actually sees from the hall was a
   * dark mass with a lit slot in it — the exact opposite of "a bright anchor at one end".
   *
   * Carrying the opening east over the head of the balcony and the west end of its void
   * fixes it at the architectural level rather than by turning a lamp up: daylight now
   * falls down the stairs, across the balcony head, THROUGH the void and onto the platform
   * slab, which is both what a pavement grating over a mezzanine actually does and a
   * straight column of cold light standing in a hall lit entirely by warm sodium.
   *
   * It stops 120 cm into the void because the hanging sign at X = 800 hangs from this
   * ceiling, and a sign suspended from an opening is a sign suspended from nothing.
   */
  wellReachEast: 120.0,

  /**
   * Daylight brightness, as a MULTIPLE OF WHAT A CEILING SPOT PUTS ON THE FLOOR — not as
   * candelas — and the daylight heads run on a linear falloff rather than the rig's
   * inverse square. Both of those are deliberate and both were forced by renders.
   *
   * An inverse-square lamp cannot light a stairwell. Hung at the ceiling it threw a pool
   * at the bottom of the stair and nothing on the platform; hung at the grating and turned
   * up until the platform answered, it delivered fourteen times a sodium spot onto the
   * half-landing 3.6 m under it and burned the tile to flat white — the rendered frame was
   * a white rectangle with a sign in it. The ratio across a 9 m shaft is the problem, and
   * no intensity fixes a ratio.
   *
   * Real daylight has no falloff worth modelling over nine metres, so these carry
   * `decay: 1`. From the grating the half-landing then sees 1.17x what the platform sees
   * instead of 3.4x, which is what daylight through a hole actually looks like.
   */
  skyFloorMultiple: 3.0, // x a ceiling spot's floor irradiance, at the bottom of the well
  /**
   * And the one that carries daylight OUT of the shaft and down the hall.
   *
   * Measured, again, against a render: with the heads alone the stairwell was a lit room
   * with a dark doorway, because a downlight over a stair throws a pool at the bottom of
   * the stair and nothing else. A station entrance does not look like that — the light
   * comes out of the mouth and lies along the floor, and from three bays away that cold
   * slab on warm sodium IS the anchor. Aimed 10 m east at a shallow angle so it grazes the
   * slab rather than pooling on it, which is also what makes the wet floor answer.
   */
  mouthSpillMultiple: 0.9, // same units, grazing east along the slab
  shaftHaze: 0.34, // additive gain on the visible beams; the sodium cones sit near 0.35
  skyColorHex: 0xbed6ff,
  skyEmissiveHex: 0xdfeaff,

  /** Nosings. Yellow safety strips on every tread — 20 bright converging lines that say STAIR. */
  nosingHalfDepth: 4.0,
  nosingHalfHeight: 1.5,
})

/** Derived stair geometry, kept out of the frozen literal so each line can show its work. */
const STAIR_LANDING_MAX_X = STAIRS.minX + STAIRS.landingDepth // 200
const STAIR_RUN = STAIRS.maxX - STAIR_LANDING_MAX_X // 320 cm of run per flight
const STAIR_TREAD = STAIR_RUN / STAIRS.treadsPerFlight // 32 cm
const STAIR_RISER = STAIRS.topZ / (STAIRS.treadsPerFlight * 2) // 12.5 cm over 20 risers
const STAIR_LANDING_Z = STAIRS.topZ * 0.5 // 125 — the half-landing, by construction
const DECK_MIN_X = STAIRS.maxX
const DECK_MAX_X = STAIRS.maxX + STAIRS.deckReach // 1120
const DECK_VOID_MIN_X = STAIRS.maxX + STAIRS.deckThreshold // 660
const DECK_MOUTH_CLEAR_X = STAIRS.maxX + STAIRS.deckMouthClearance // 604 — see deckMouthClearance
const WELL_MAX_X = DECK_VOID_MIN_X + STAIRS.wellReachEast // 780 — see wellReachEast
const DECK_HALF_Y = STAIRS.wallOuterY // the balcony is as wide as the shaft's outside

/** Tread `k` of the lower (south) flight, counted up from the mouth at X = maxX. */
const lowerTreadTopZ = (k) => (k + 1) * STAIR_RISER
/** Tread `j` of the upper (north) flight, counted up from the landing. */
const upperTreadTopZ = (j) => STAIR_LANDING_Z + (j + 1) * STAIR_RISER

const treadIndex = (offset) =>
  Math.max(0, Math.min(STAIRS.treadsPerFlight - 1, Math.floor(offset / STAIR_TREAD)))

const _surfaces = []

/** Every walkable surface directly above/below (x, y), in spec centimetres. */
function walkableSurfacesAt(x, y, out) {
  out.length = 0

  const inShaft =
    x >= STAIRS.minX && x <= STAIRS.maxX && Math.abs(y) <= STAIRS.halfWidth
  if (inShaft) {
    if (x <= STAIR_LANDING_MAX_X) {
      out.push(STAIR_LANDING_Z)
    } else {
      // The spine band belongs to BOTH flights: a body cutting the corner at the turn is
      // offered the tread on either side of it and the caller picks the one it can reach.
      if (y <= STAIRS.newelHalfY) out.push(lowerTreadTopZ(treadIndex(STAIRS.maxX - x)))
      if (y >= -STAIRS.newelHalfY) out.push(upperTreadTopZ(treadIndex(x - STAIR_LANDING_MAX_X)))
    }
  } else {
    out.push(LEVELS.platformTopZ)
  }

  if (isOverMezzanine(x, y)) out.push(STAIRS.topZ)

  return out
}

/**
 * The walkable Z under a point — the level's floor query, and the reason anything other
 * than the player can use the stairs at all.
 *
 * It is 2.5D on purpose. A single "highest surface" answer would put a zombie standing on
 * the platform under the balcony onto the balcony, and a single "lowest" answer would drop
 * one that is already up there through the deck. `fromZ` says which storey the query is
 * standing on and `reach` is how far up it may claim — one step height, the same number the
 * player's own step-up uses — so the balcony is reachable from the top tread and from
 * nowhere else. That is the whole flanking mechanic, expressed as a floor query.
 *
 * @param {number} x spec centimetres
 * @param {number} y spec centimetres
 * @param {number} fromZ the querier's current feet height
 * @param {number} reach how far above `fromZ` still counts as steppable
 */
export function floorHeightAt(x, y, fromZ = LEVELS.platformTopZ, reach = PLAYER.MOVEMENT.maxStepHeight) {
  const surfaces = walkableSurfacesAt(x, y, _surfaces)
  let lowest = Infinity
  let best = -Infinity
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i]
    if (s < lowest) lowest = s
    if (s <= fromZ + reach && s > best) best = s
  }
  return best > -Infinity ? best : lowest
}

/**
 * True when a point is over the balcony deck — the "you are upstairs" test, and the plan
 * of the deck itself. An L at the head of the stair (kept clear of the mouth on the south
 * side, see `deckMouthClearance`) opening into two arms down either side of the void.
 */
export function isOverMezzanine(x, y) {
  if (x < DECK_MIN_X || x > DECK_MAX_X || Math.abs(y) > DECK_HALF_Y) return false
  if (x >= DECK_VOID_MIN_X) return Math.abs(y) > STAIRS.voidHalfY // the two arms
  if (y >= -STAIRS.newelHalfY) return true // the head of the stair, north of the spine line
  return x >= DECK_MOUTH_CLEAR_X // and the apron that joins it to the south arm
}

/** The deck's walking height, so game.js never has to restate 250. */
export const MEZZANINE_TOP_Z = STAIRS.topZ

/**
 * The climb, as a plan anything outside this module can place something against.
 *
 * `floorHeightAt` answers "how high is the floor HERE", which is the right question for a
 * body that already knows where it is walking. It is the wrong question for a caller that
 * wants to put something a third of the way up the flight and has no business knowing that
 * a flight is ten treads of 32 cm starting at X 520. Both flights are expressed as a
 * parametric 0..1 climb so a caller states intent and this module keeps the arithmetic.
 */
export const STAIR_PLAN = Object.freeze({
  /** X of the bottom step, where the flight meets the platform slab. */
  mouthX: STAIRS.maxX,
  /** X of the half-landing's east edge — the top of the lower flight. */
  landingX: STAIR_LANDING_MAX_X,
  landingZ: STAIR_LANDING_Z,
  /**
   * Centre line of each flight's tread width. The two flights sit either side of the
   * spine, so a body on the lower one is offset south and reads against the balustrade
   * rather than disappearing behind it.
   */
  lowerFlightY: -(STAIRS.newelHalfY + STAIRS.halfWidth) * 0.5,
  upperFlightY: (STAIRS.newelHalfY + STAIRS.halfWidth) * 0.5,
})

/**
 * A point `climb` of the way up the lower flight, on the tread rather than through it.
 * The Z comes back through the same 2.5D query the AI walks on, so a body placed here is
 * standing on exactly the surface it would have stepped onto.
 */
export function stairPointAt(climb, y = STAIR_PLAN.lowerFlightY) {
  const x = STAIR_PLAN.mouthX + (STAIR_PLAN.landingX - STAIR_PLAN.mouthX) * climb
  return { x, y, z: floorHeightAt(x, y, LEVELS.platformTopZ, STAIRS.topZ) }
}

// ---------------------------------------------------------------------------
// the stairwell's own art: name boards and daylight
// ---------------------------------------------------------------------------

/**
 * These bake here rather than in materials.js for one reason: materials.js belongs to
 * another agent this round. Reaching across to add two canvases there would either be
 * clobbered or clobber. Nothing below is imported from it, so the two files cannot
 * collide; fold these into its bakery next time it is quiet.
 */
const BOARD_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'

function boardCanvas(width, height) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * Transit type is CONDENSED, and no webfont is loaded in this build, so the squeeze is
 * applied on the canvas transform rather than wished for in a font stack.
 */
function condensed(ctx, text, x, y, size, { weight = 700, squeeze = 0.78, color = '#f2f6fb', track = 0 } = {}) {
  ctx.save()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${weight} ${Math.max(1, Math.round(size))}px ${BOARD_FONT}`
  if (track) {
    try {
      ctx.letterSpacing = `${track}px`
    } catch {
      // Chrome 99+; tracking is a refinement, never a requirement
    }
  }
  ctx.translate(x, y)
  ctx.scale(squeeze, 1)
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

/**
 * A vitreous enamel platform name board: white type on a near-black ground inside a thin
 * white rule, the way every real platform name board on earth is laid out. Not a joke and
 * not a logo — the station is named, the way a station is named, and that is the whole of
 * the brief's "tasteful and typographic".
 */
function bakeNameBoard(name, strapline, { width = 2048, height = 256 } = {}) {
  const canvas = boardCanvas(width, height)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#0b0f16'
  ctx.fillRect(0, 0, width, height)

  // a faint vertical sheen: enamel is glossy and never reads as flat paper
  const sheen = ctx.createLinearGradient(0, 0, 0, height)
  sheen.addColorStop(0, 'rgba(255,255,255,0.16)')
  sheen.addColorStop(0.42, 'rgba(255,255,255,0.03)')
  sheen.addColorStop(1, 'rgba(0,0,0,0.34)')
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, width, height)

  const inset = height * 0.1
  ctx.strokeStyle = 'rgba(236,244,255,0.85)'
  ctx.lineWidth = Math.max(2, height * 0.028)
  ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2)

  const hasStrap = Boolean(strapline)
  condensed(ctx, name, width * 0.5, hasStrap ? height * 0.42 : height * 0.5, height * (hasStrap ? 0.40 : 0.48), {
    weight: 800,
    track: height * 0.045,
  })
  if (hasStrap) {
    condensed(ctx, strapline, width * 0.5, height * 0.755, height * 0.145, {
      weight: 500,
      color: '#8fb4de',
      track: height * 0.05,
    })
  }

  // chipped enamel, so it belongs to the same century as the brick behind it
  const rng = new Rng(0x5ade1a)
  ctx.globalCompositeOperation = 'source-atop'
  for (let i = 0; i < 90; i++) {
    const r = rng.range(1, height * 0.035)
    ctx.fillStyle = `rgba(20,24,32,${rng.range(0.1, 0.45).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(rng.range(0, width), rng.range(0, height), r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 16
  tex.needsUpdate = true
  return tex
}

/** The pavement grating at the top of the well: bright in the middle, dirty at the edges. */
function bakeStreetOpening(size = 512) {
  const canvas = boardCanvas(size, size)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')

  const glow = ctx.createRadialGradient(size * 0.5, size * 0.44, size * 0.05, size * 0.5, size * 0.5, size * 0.62)
  glow.addColorStop(0, '#ffffff')
  glow.addColorStop(0.45, '#cfe0ff')
  glow.addColorStop(0.82, '#6d86ad')
  glow.addColorStop(1, '#1d2635')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  // the grating itself — the bars are what say STREET rather than "a white rectangle"
  ctx.strokeStyle = 'rgba(12,16,24,0.82)'
  ctx.lineWidth = size * 0.022
  for (let i = 1; i < 14; i++) {
    const x = (i / 14) * size
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size)
    ctx.stroke()
  }
  ctx.lineWidth = size * 0.05
  for (const t of [0.26, 0.74]) {
    ctx.beginPath()
    ctx.moveTo(0, t * size)
    ctx.lineTo(size, t * size)
    ctx.stroke()
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

/**
 * The visible shaft of daylight, as a four-sided frustum seen from the inside.
 *
 * Same trick lighting.js uses for the sodium cones and for the same reason: a light with
 * nothing in the air between it and the floor is a light you cannot see, and a stairwell
 * whose whole job is to say THERE IS AN OUTSIDE needs the beam, not just the pool. Wider
 * at the bottom than the top because that is what a cone of light through a hole does, and
 * brightest at the top because that is where the air is thickest with it.
 */
function buildDaylightShaftGeometry(topSpan, bottomSpan, topZ, bottomZ, color, gain) {
  const positions = []
  const normals = []
  const uvs = []
  const colors = []
  const indices = []

  const height = topZ - bottomZ
  const segments = 10

  // spec (x, y) corners, counter-clockwise, as fractions of each ring's span
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]

  const ringAt = (t) => {
    const sx = bottomSpan[0] + (topSpan[0] - bottomSpan[0]) * t
    const sy = bottomSpan[1] + (topSpan[1] - bottomSpan[1]) * t
    const cx = bottomSpan[2] + (topSpan[2] - bottomSpan[2]) * t
    const z = bottomZ + height * t
    // straight into three coordinates: spec (x, y, z) -> three (x, z, -y)
    return corners.map(([u, v]) => [cx + u * sx, z, -(v * sy)])
  }

  for (let i = 0; i < segments; i++) {
    const t0 = i / segments
    const t1 = (i + 1) / segments
    const r0 = ringAt(t0)
    const r1 = ringAt(t1)
    const f0 = Math.pow(t0, 1.7) * gain
    const f1 = Math.pow(t1, 1.7) * gain

    for (let c = 0; c < 4; c++) {
      const d = (c + 1) % 4
      const quad = [r0[c], r0[d], r1[d], r1[c]]
      const fades = [f0, f0, f1, f1]
      const e1 = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1], quad[1][2] - quad[0][2]]
      const e2 = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1], quad[3][2] - quad[0][2]]
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const nl = Math.hypot(n[0], n[1], n[2]) || 1
      const base = positions.length / 3
      for (let q = 0; q < 4; q++) {
        positions.push(quad[q][0], quad[q][1], quad[q][2])
        normals.push(n[0] / nl, n[1] / nl, n[2] / nl)
        uvs.push(q === 1 || q === 2 ? 1 : 0, q >= 2 ? 1 : 0)
        colors.push(color.r * fades[q], color.g * fades[q], color.b * fades[q])
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Tessellation. Purely how finely a box is diced, with no gameplay meaning: the station's
 * grime and AO live in vertex colours, and a 6000 cm wall drawn as two triangles would
 * render that gradient as one long linear ramp instead of soot pooling at the ends.
 * A value of 1 anywhere below means "this face is small enough, leave it alone".
 */
const TESS = Object.freeze({
  alongStation: 48,
  acrossPlatform: 12,
  acrossCeiling: 16,
  acrossPit: 4,
  wallHeight: 10,
  pilasterHeight: 8,
  slab: 2,
  prop: 4,
  columnRadial: 20,
  columnHeight: 8,
  binRadial: 16,
  binHeight: 2,
})

/** Spec (Z-up) position to three (Y-up) position. */
export function specToThree(x, y, z, target = new THREE.Vector3()) {
  return target.set(x, z, -y)
}

/** The inverse, for anything that needs to report a position back in spec terms. */
export function threeToSpec(x, y, z, target = new THREE.Vector3()) {
  return target.set(x, -z, y)
}

const specPos = (p) => [p[0], p[2], -p[1]]
const specHalf = (h) => [h[0], h[2], h[1]]
const specSeg = (s) => [s[0], s[2], s[1]]

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
function smooth01(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

/**
 * Soot and water staining, evaluated per vertex in three coordinates.
 *
 * Three sources, taken at their maximum rather than summed so a corner that is both low
 * and near a tunnel does not go pure black: the track pits (everything below knee height
 * is filthy), the ceiling vault (a century of brake dust), and the tunnel mouths.
 * Dirt is warm, so blue is pulled down harder than red as it thickens.
 */
function grimeAt(x, y, z, out, soot = 0) {
  const low = 1 - smooth01(LEVELS.trackFloorZ - 60, LEVELS.platformTopZ + 170, y)
  const high = smooth01(LEVELS.wallTopZ - 180, LEVELS.wallTopZ + 40, y)
  const ends = 1 - smooth01(0, DIM.columnSpacing * 2, Math.min(x, DIM.length - x))
  const flanks = smooth01(DIM.platformHalfWidth, LEVELS.wallInnerY, Math.abs(z))
  // Clamped at 0.78 so the blue term (x1.2) can never reach 1 and flip a surface to pure
  // black — a vertex colour of zero kills the texture underneath it as well as the light.
  const dirt = Math.min(0.78, GRIME * Math.max(low * 0.9, high * 0.78, ends * 0.8, flanks * 0.3) + soot)
  out[0] = 1 - dirt
  out[1] = 1 - dirt * 1.08
  out[2] = 1 - dirt * 1.2
}

// ---------------------------------------------------------------------------
// geometry accumulation
// ---------------------------------------------------------------------------

/**
 * Six faces, each with a horizontal `u` axis and a vertical-ish `v` axis chosen so that
 * `u cross v === n`. That keeps the winding correct without a per-face sign test, and
 * keeps texture `u` running horizontally on every wall in the station.
 */
const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]

const axisIndex = (axis) => (axis[0] !== 0 ? 0 : axis[1] !== 0 ? 1 : 2)
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

class MeshBuilder {
  /** @param uvScale centimetres of world surface per texture repeat; unused under box UVs. */
  constructor(uvScale = 1) {
    this.uvScale = uvScale
    this.positions = []
    this.normals = []
    this.uvs = []
    this.colors = []
    this.indices = []
    this.primitives = 0
    this.tint = [1, 1, 1]
    /**
     * Extra dirt for the primitive currently being appended, on top of what its position
     * already earns. It exists for the trackway: a tie sitting 44 cm under the platform
     * is only mildly low by grimeAt's curve, but a tie is a creosoted timber in a ballast
     * trough and should read filthier than the wall behind it. Set by `box`, reset after.
     */
    this.soot = 0
    /**
     * Vertex-colour gain above 1, for the running rails alone.
     *
     * COLORS.railLinear is [0.1, 0.1, 0.11]. In the Unreal original that was the DIFFUSE
     * colour of a non-metal material and 10% grey is a perfectly reasonable dark steel.
     * The port gave the rail metalness 0.9, and for a metal that same number stops being
     * albedo and becomes F0 — and no metal on earth reflects 10%. Steel is about 56%. A
     * rail built from it therefore renders as a black thread in a dark pit no matter how
     * much light you throw at it, which is exactly what the first render showed.
     *
     * rules.js and materials.js belong to other agents this round, so the correction is
     * applied where this module already owns the pixel: vertex colour, which multiplies
     * the base colour before it reaches F0. It stops well short of real steel — this is
     * correcting a unit mismatch, not inventing a shiny rail.
     */
    this.gain = 1
  }

  #vertex(p, n, u, v, boxUv) {
    const i = this.positions.length / 3
    this.positions.push(p[0], p[1], p[2])
    this.normals.push(n[0], n[1], n[2])
    this.uvs.push(u, v)
    if (boxUv) {
      this.colors.push(1, 1, 1)
    } else {
      grimeAt(p[0], p[1], p[2], this.tint, this.soot)
      this.colors.push(this.tint[0] * this.gain, this.tint[1] * this.gain, this.tint[2] * this.gain)
    }
    return i
  }

  #quad(corners, n, uvs, boxUv) {
    const a = this.#vertex(corners[0], n, uvs[0][0], uvs[0][1], boxUv)
    const b = this.#vertex(corners[1], n, uvs[1][0], uvs[1][1], boxUv)
    const c = this.#vertex(corners[2], n, uvs[2][0], uvs[2][1], boxUv)
    const d = this.#vertex(corners[3], n, uvs[3][0], uvs[3][1], boxUv)
    this.indices.push(a, b, c, a, c, d)
  }

  /**
   * @param centre three-space centre
   * @param half three-space half extents
   * @param seg three-space subdivision counts; only needed where a face is big enough
   *            that a four-corner grime gradient would read as a linear ramp
   * @param boxUv true to emit 0..1 per-face UVs instead of world-space ones (signage art)
   */
  addBox(centre, half, { seg = [1, 1, 1], boxUv = false } = {}) {
    const scale = this.uvScale
    for (const face of FACES) {
      const hn = Math.abs(dot3(face.n, half))
      const hu = Math.abs(dot3(face.u, half))
      const hv = Math.abs(dot3(face.v, half))
      const base = [
        centre[0] + face.n[0] * hn,
        centre[1] + face.n[1] * hn,
        centre[2] + face.n[2] * hn,
      ]
      const su = Math.max(1, seg[axisIndex(face.u)])
      const sv = Math.max(1, seg[axisIndex(face.v)])

      for (let j = 0; j < sv; j++) {
        for (let i = 0; i < su; i++) {
          const u0 = (i / su) * 2 - 1
          const u1 = ((i + 1) / su) * 2 - 1
          const v0 = (j / sv) * 2 - 1
          const v1 = ((j + 1) / sv) * 2 - 1
          const corners = [
            [u0, v0],
            [u1, v0],
            [u1, v1],
            [u0, v1],
          ].map(([cu, cv]) => [
            base[0] + face.u[0] * cu * hu + face.v[0] * cv * hv,
            base[1] + face.u[1] * cu * hu + face.v[1] * cv * hv,
            base[2] + face.u[2] * cu * hu + face.v[2] * cv * hv,
          ])
          const uvs = boxUv
            ? [
                [(u0 + 1) * 0.5, (v0 + 1) * 0.5],
                [(u1 + 1) * 0.5, (v0 + 1) * 0.5],
                [(u1 + 1) * 0.5, (v1 + 1) * 0.5],
                [(u0 + 1) * 0.5, (v1 + 1) * 0.5],
              ]
            : corners.map((p) => [dot3(p, face.u) / scale, dot3(p, face.v) / scale])
          this.#quad(corners, face.n, uvs, boxUv)
        }
      }
    }
    this.primitives++
  }

  /** Axis along three +Y, pivot at the middle of the height, matching the spec's convention. */
  addCylinder(centre, radius, height, { radial = 24, heightSeg = 4 } = {}) {
    const scale = this.uvScale
    const halfH = height * 0.5
    const twoPi = Math.PI * 2

    for (let s = 0; s < radial; s++) {
      const a0 = (s / radial) * twoPi
      const a1 = ((s + 1) / radial) * twoPi
      const c0 = Math.cos(a0)
      const s0 = Math.sin(a0)
      const c1 = Math.cos(a1)
      const s1 = Math.sin(a1)
      // one shared normal per strip keeps the column faceted, which is how a painted
      // steel column under a hard spot actually reads
      const n = [(c0 + c1) * 0.5, 0, (s0 + s1) * 0.5]
      const inv = 1 / Math.hypot(n[0], n[2])
      n[0] *= inv
      n[2] *= inv

      for (let h = 0; h < heightSeg; h++) {
        const y0 = centre[1] - halfH + (h / heightSeg) * height
        const y1 = centre[1] - halfH + ((h + 1) / heightSeg) * height
        const corners = [
          [centre[0] + c0 * radius, y0, centre[2] + s0 * radius],
          [centre[0] + c0 * radius, y1, centre[2] + s0 * radius],
          [centre[0] + c1 * radius, y1, centre[2] + s1 * radius],
          [centre[0] + c1 * radius, y0, centre[2] + s1 * radius],
        ]
        const uA = (a0 * radius) / scale
        const uB = (a1 * radius) / scale
        this.#quad(corners, n, [
          [uA, y0 / scale],
          [uA, y1 / scale],
          [uB, y1 / scale],
          [uB, y0 / scale],
        ], false)
      }
    }

    for (const dir of [1, -1]) {
      const y = centre[1] + halfH * dir
      const n = [0, dir, 0]
      const centreUv = [centre[0] / scale, (-dir * centre[2]) / scale]
      for (let s = 0; s < radial; s++) {
        const a0 = (s / radial) * twoPi
        const a1 = ((s + 1) / radial) * twoPi
        const p0 = [centre[0] + Math.cos(a0) * radius, y, centre[2] + Math.sin(a0) * radius]
        const p1 = [centre[0] + Math.cos(a1) * radius, y, centre[2] + Math.sin(a1) * radius]
        const cp = [centre[0], y, centre[2]]
        const uv0 = [p0[0] / scale, (-dir * p0[2]) / scale]
        const uv1 = [p1[0] / scale, (-dir * p1[2]) / scale]
        const a = this.#vertex(cp, n, centreUv[0], centreUv[1], false)
        // a top cap winds the opposite way from a bottom cap
        const b = this.#vertex(dir > 0 ? p1 : p0, n, dir > 0 ? uv1[0] : uv0[0], dir > 0 ? uv1[1] : uv0[1], false)
        const c = this.#vertex(dir > 0 ? p0 : p1, n, dir > 0 ? uv0[0] : uv1[0], dir > 0 ? uv0[1] : uv1[1], false)
        this.indices.push(a, b, c)
      }
    }
    this.primitives++
  }

  /**
   * A square-section bar between two arbitrary three-space points.
   *
   * `addBox` cannot make a handrail. A rail following a 21 degree flight out of stacked
   * axis-aligned boxes is a staircase of little bricks, which is the tell that the stair
   * was assembled rather than built. This sweeps one cross-section along the run instead,
   * so the rail is a single continuous sloping member with mitred ends.
   *
   * @param a three-space start of the CENTRELINE
   * @param b three-space end
   * @param halfW half-width across the run
   * @param halfH half-height
   */
  addBar(a, b, halfW, halfH) {
    const scale = this.uvScale
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const length = Math.hypot(d[0], d[1], d[2])
    if (length < 1e-4) return
    d[0] /= length
    d[1] /= length
    d[2] /= length

    // Side is the horizontal perpendicular; up is whatever is left, so a sloping bar keeps
    // a level top face rather than rolling about its own axis.
    let s = [d[2], 0, -d[0]]
    let sl = Math.hypot(s[0], s[2])
    if (sl < 1e-4) {
      s = [1, 0, 0]
      sl = 1
    }
    s[0] /= sl
    s[2] /= sl
    const v = [
      s[1] * d[2] - s[2] * d[1],
      s[2] * d[0] - s[0] * d[2],
      s[0] * d[1] - s[1] * d[0],
    ]

    const corner = (p, su, sv) => [
      p[0] + s[0] * su * halfW + v[0] * sv * halfH,
      p[1] + s[1] * su * halfW + v[1] * sv * halfH,
      p[2] + s[2] * su * halfW + v[2] * sv * halfH,
    ]

    const signs = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]
    const ring = (p) => signs.map(([su, sv]) => corner(p, su, sv))
    const ringA = ring(a)
    const ringB = ring(b)

    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      const quad = [ringA[i], ringB[i], ringB[j], ringA[j]]
      const e1 = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1], quad[1][2] - quad[0][2]]
      const e2 = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1], quad[3][2] - quad[0][2]]
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const nl = Math.hypot(n[0], n[1], n[2]) || 1
      n[0] /= nl
      n[1] /= nl
      n[2] /= nl
      const uvs = [
        [0, 0],
        [length / scale, 0],
        [length / scale, (halfW + halfH) / scale],
        [0, (halfW + halfH) / scale],
      ]
      this.#quad(quad, n, uvs, false)
    }

    const capUvs = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, w]) => [
      (u * halfW * 2) / scale,
      (w * halfH * 2) / scale,
    ])
    for (const [ringP, dir] of [[ringA, -1], [ringB, 1]]) {
      const n = [d[0] * dir, d[1] * dir, d[2] * dir]
      const order = dir > 0 ? [0, 1, 2, 3] : [3, 2, 1, 0]
      this.#quad(order.map((i) => ringP[i]), n, capUvs, false)
    }
    this.primitives++
  }

  build() {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.setIndex(this.indices)
    geometry.computeBoundingSphere()
    return geometry
  }
}

// ---------------------------------------------------------------------------
// the build
// ---------------------------------------------------------------------------

/**
 * Build the whole station into `scene`.
 *
 * @returns {{
 *   group: THREE.Group,
 *   colliders: Array,
 *   spawnPoints: Array,
 *   pickupPoints: THREE.Vector3[],
 *   playerStart: { position: THREE.Vector3, yaw: number, eyeHeight: number },
 *   trainStop: object,
 *   bounds: THREE.Box3,
 *   lighting: object,
 *   update: (dt: number) => void,
 *   dispose: () => void,
 * }}
 *
 * `update(dt)` must be pumped from the game loop; it is what drives the failing tube.
 */
export function buildStation(scene) {
  const materials = createStationMaterials()
  const group = new THREE.Group()
  group.name = 'station'

  const colliders = []
  /** Materials and textures this module makes itself — the stairwell's signage and daylight. */
  const stairwellDisposables = []

  // One vertex buffer per material family. `sign` and `board` carry artwork addressed
  // with per-face 0..1 UVs, so their world-space scale is never consulted.
  const families = {
    platform: new MeshBuilder(TEXTURE_CM.wetConcrete),
    stripe: new MeshBuilder(TEXTURE_CM.stripe),
    concrete: new MeshBuilder(TEXTURE_CM.concrete),
    tile: new MeshBuilder(TEXTURE_CM.tile),
    column: new MeshBuilder(TEXTURE_CM.column),
    rail: new MeshBuilder(TEXTURE_CM.rail),
    sleeper: new MeshBuilder(TEXTURE_CM.sleeper),
    portal: new MeshBuilder(TEXTURE_CM.portal),
    furniture: new MeshBuilder(TEXTURE_CM.furniture),
    bin: new MeshBuilder(TEXTURE_CM.trashBin),
    sign: new MeshBuilder(),
    board: new MeshBuilder(),
  }

  /**
   * Primitives this module adds that the extracted level never had. They are tracked so
   * the spec-count assertion below still compares like with like — a new piece of art is
   * not evidence that the station drifted away from the level it came from.
   */
  let addedPrimitives = 0

  /** Add a box given in SPEC coordinates, optionally registering it as a collider. */
  function box(family, name, centre, half, { seg = [1, 1, 1], boxUv = false, solid = false, added = false, soot = 0, gain = 1 } = {}) {
    const c = specPos(centre)
    const h = specHalf(half)
    families[family].soot = soot
    families[family].gain = gain
    families[family].addBox(c, h, { seg: specSeg(seg), boxUv })
    families[family].soot = 0
    families[family].gain = 1
    if (added) addedPrimitives++
    if (solid) {
      const center = new THREE.Vector3(c[0], c[1], c[2])
      const halfExtent = new THREE.Vector3(h[0], h[1], h[2])
      colliders.push({
        name,
        type: 'box',
        center,
        halfExtent,
        box: new THREE.Box3(center.clone().sub(halfExtent), center.clone().add(halfExtent)),
      })
    }
  }

  /** Add a Z-axis cylinder given in SPEC coordinates. */
  function cylinder(family, name, centre, radius, height, { radial = 24, heightSeg = 4, solid = false } = {}) {
    const c = specPos(centre)
    families[family].addCylinder(c, radius, height, { radial, heightSeg })
    if (solid) {
      const center = new THREE.Vector3(c[0], c[1], c[2])
      const halfExtent = new THREE.Vector3(radius, height * 0.5, radius)
      colliders.push({
        name,
        type: 'cylinder',
        center,
        radius,
        halfHeight: height * 0.5,
        halfExtent,
        box: new THREE.Box3(center.clone().sub(halfExtent), center.clone().add(halfExtent)),
      })
    }
  }

  /** A collider with no geometry, for a guard rail whose art is a kerb, a cap and six posts. */
  function blocker(name, centre, half) {
    const c = specPos(centre)
    const h = specHalf(half)
    const center = new THREE.Vector3(c[0], c[1], c[2])
    const halfExtent = new THREE.Vector3(h[0], h[1], h[2])
    colliders.push({
      name,
      type: 'box',
      center,
      halfExtent,
      box: new THREE.Box3(center.clone().sub(halfExtent), center.clone().add(halfExtent)),
    })
  }

  /** Add a swept bar between two SPEC points. Always an addition — the spec had no rails. */
  function bar(family, from, to, halfW, halfH, { soot = 0 } = {}) {
    families[family].soot = soot
    families[family].addBar(specPos(from), specPos(to), halfW, halfH)
    families[family].soot = 0
    addedPrimitives++
  }

  /** Add a box from its SPEC min/max spans, which is how a building is actually dimensioned. */
  function spanBox(family, name, xs, ys, zs, opts = {}) {
    box(
      family,
      name,
      [(xs[0] + xs[1]) * 0.5, (ys[0] + ys[1]) * 0.5, (zs[0] + zs[1]) * 0.5],
      [(xs[1] - xs[0]) * 0.5, (ys[1] - ys[0]) * 0.5, (zs[1] - zs[0]) * 0.5],
      opts,
    )
  }

  // --- 1. platform slab and safety stripes ---------------------------------
  box('platform', 'platform-slab', [DIM.length * 0.5, 0, LEVELS.platformBottomZ * 0.5], [DIM.length * 0.5, DIM.platformHalfWidth, DIM.platformThickness * 0.5], {
    seg: [TESS.alongStation, TESS.acrossPlatform, TESS.slab],
    solid: true,
  })

  for (const side of [1, -1]) {
    box('stripe', `safety-stripe-${side > 0 ? 'n' : 's'}`, [DIM.length * 0.5, STRIPE.centreY * side, STRIPE.halfHeight], [DIM.length * 0.5, STRIPE.halfWidth, STRIPE.halfHeight], {
      seg: [TESS.alongStation, 1, 1],
    })
  }

  // --- 2. the trackway: pit floor, bed, ties, running rails, third rail, duct --
  // Built bottom-up, the way it would be laid: structure, bed, ties, rail. See TRACKWAY
  // for why the datum is the carriage's floor line and not the spec's pit floor.
  const pitFloorCentreZ = (LEVELS.trackFloorZ + LEVELS.pitFloorBottomZ) * 0.5
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    const pitY = LEVELS.pitCentreY * side
    const trackY = TRACKWAY.centreY * side
    const thirdRailY = (TRACKWAY.centreY + TRACKWAY.thirdRailOffset) * side

    box('concrete', `pit-floor-${tag}`, [DIM.length * 0.5, pitY, pitFloorCentreZ], [DIM.length * 0.5, DIM.trackBedWidth * 0.5, DIM.pitFloorThickness * 0.5], {
      seg: [TESS.alongStation, TESS.acrossPit, 1],
      solid: true,
    })

    // The bed is deliberately not a collider. The pit floor beneath it already is, so a
    // player who somehow leaves the slab still lands where the level says they land.
    box('concrete', `track-bed-${tag}`, [DIM.length * 0.5, pitY, TRACKWAY.bedCentreZ], [DIM.length * 0.5, DIM.trackBedWidth * 0.5, TRACKWAY.bedHalfHeight], {
      seg: [TESS.alongStation, TESS.acrossPit, TESS.slab],
      added: true,
      soot: TRACKWAY.bedSoot,
    })

    // The spec tie is 400 cm across a 500 cm bed, so pulling the track in against the
    // platform buries its inboard 120 cm inside the platform slab. That is cheaper and
    // more honest than editing a spec half-extent to hide the overhang: the tie keeps its
    // authored size and the slab simply covers the end, exactly as a real tie's end is
    // covered by the platform it runs under.
    for (let i = 0; i < COUNTS.sleepersPerSide; i++) {
      const x = TRACK.sleeperFirstX + i * TRACK.sleeperSpacing
      box('sleeper', `sleeper-${tag}-${i}`, [x, trackY, TRACKWAY.sleeperCentreZ], [TRACK.sleeperHalfThickness, DIM.trackBedWidth * TRACK.sleeperWidthFactor, TRACK.sleeperHalfHeight], {
        soot: TRACKWAY.tieSoot,
      })
    }

    // Polished crowns on a 0.9-metalness material: the only specular lines in the pit,
    // and the depth cue the train frame had none of — they converge on the tunnel mouth
    // exactly where the safety stripe does. `outward` is signed by the side so +1 is the
    // rail further from the platform on BOTH sides and the names stay true. 48 segments
    // along 6000 cm so the soot gradient toward each portal reads as soot, not a ramp.
    for (const outward of [-1, 1]) {
      const railY = trackY + TRACK.railGaugeHalf * outward * side
      const label = `${tag}-${outward > 0 ? 'out' : 'in'}`
      box('rail', `rail-foot-${label}`, [DIM.length * 0.5, railY, TRACKWAY.footCentreZ], [DIM.length * 0.5, TRACKWAY.footHalfWidth, TRACKWAY.footHalfHeight], {
        seg: [TESS.alongStation, 1, 1],
        added: true,
        gain: TRACKWAY.railPolish,
      })
      box('rail', `rail-${label}`, [DIM.length * 0.5, railY, TRACKWAY.railCentreZ], [DIM.length * 0.5, TRACK.railHalfWidth, TRACK.railHalfHeight], {
        seg: [TESS.alongStation, 1, 1],
        gain: TRACKWAY.railPolish,
      })
    }

    box('rail', `third-rail-${tag}`, [DIM.length * 0.5, thirdRailY, TRACKWAY.thirdRailCentreZ], [DIM.length * 0.5, TRACKWAY.thirdRailHalfWidth, TRACK.railHalfHeight], {
      seg: [TESS.alongStation, 1, 1],
      added: true,
      gain: TRACKWAY.railPolish,
    })

    box('sleeper', `third-rail-board-${tag}`, [DIM.length * 0.5, thirdRailY, TRACKWAY.boardCentreZ], [DIM.length * 0.5, TRACKWAY.boardHalfWidth, TRACKWAY.boardHalfThickness], {
      seg: [TESS.alongStation, 1, 1],
      added: true,
      soot: TRACKWAY.boardSoot,
    })

    box('concrete', `cable-duct-${tag}`, [DIM.length * 0.5, TRACKWAY.ductCentreY * side, TRACKWAY.ductCentreZ], [DIM.length * 0.5, TRACKWAY.ductHalfWidth, TRACKWAY.ductHalfHeight], {
      seg: [TESS.alongStation, 1, TESS.slab],
      added: true,
      soot: TRACKWAY.ductSoot,
    })
  }

  // --- 3. far walls and pilasters ------------------------------------------
  const wallCentreZ = (LEVELS.trackFloorZ + LEVELS.wallTopZ) * 0.5
  const wallHalfHeight = (LEVELS.wallTopZ - LEVELS.trackFloorZ) * 0.5
  const pilasterHalfHeight = SPEC_GAPS.pilasterHalfHeight
  for (const side of [1, -1]) {
    const wallY = (LEVELS.wallInnerY + DIM.wallThickness * 0.5) * side
    box('tile', `wall-${side > 0 ? 'n' : 's'}`, [DIM.length * 0.5, wallY, wallCentreZ], [DIM.length * 0.5, DIM.wallThickness * 0.5, wallHalfHeight], {
      seg: [TESS.alongStation, 1, TESS.wallHeight],
      solid: true,
    })

    for (let i = 0; i < COUNTS.pilastersPerWall; i++) {
      const x = DIM.columnMargin + i * DIM.columnSpacing
      box('tile', `pilaster-${side > 0 ? 'n' : 's'}-${i}`, [x, wallY, wallCentreZ], [DIM.pilasterHalfWidth, DIM.pilasterHalfWidth, pilasterHalfHeight], {
        seg: [1, 1, TESS.pilasterHeight],
        solid: true,
      })
    }
  }

  // --- 4. centre columns ----------------------------------------------------
  const columnHeight = LEVELS.wallTopZ - LEVELS.platformTopZ
  for (let i = 0; i < COUNTS.columns; i++) {
    const x = DIM.columnMargin + i * DIM.columnSpacing
    cylinder('column', `column-${i}`, [x, 0, LEVELS.platformTopZ + columnHeight * 0.5], DIM.columnRadius, columnHeight, {
      radial: TESS.columnRadial,
      heightSeg: TESS.columnHeight,
      solid: true,
    })
  }

  // --- 5. tunnel mouths -----------------------------------------------------
  const portalHalfDepth = DIM.tunnelMouthDepth * 0.5
  for (const side of [1, -1]) {
    for (const x of [portalHalfDepth, DIM.length - portalHalfDepth]) {
      box('portal', `tunnel-portal-${side > 0 ? 'n' : 's'}-${x}`, [x, LEVELS.pitCentreY * side, wallCentreZ], [portalHalfDepth, DIM.trackBedWidth * 0.5, wallHalfHeight])
    }
  }

  // --- 6. furniture ---------------------------------------------------------
  const bench = PROPS.bench
  for (let i = 0; i < bench.count; i++) {
    const x = bench.firstX + i * bench.spacing
    const y = i % 2 === 0 ? bench.yOffset : -bench.yOffset
    box('furniture', `bench-seat-${i}`, [x, y, bench.seatCentreZ], bench.seatHalfExtent, { solid: true })
    box('furniture', `bench-back-${i}`, [x, y - Math.sign(y) * bench.backrestInsetY, bench.backrestCentreZ], bench.backrestHalfExtent, { solid: true })
  }

  // --- 6b. the stairwell: two flights, a half-landing, and a balcony over the platform ---
  // See the STAIRS block for why the spec's two solid boxes are gone and where every
  // dimension below comes from. Built the way it would be poured: landing, flights,
  // spine, enclosure, then the deck it all leads to.

  // The half-landing. This is the piece that stands in for the spec's `Stairwell block`,
  // so it is the one piece of the stair NOT counted as an addition.
  spanBox('concrete', 'stair-landing', [STAIRS.minX, STAIR_LANDING_MAX_X], [-STAIRS.halfWidth, STAIRS.halfWidth], [LEVELS.platformTopZ, STAIR_LANDING_Z], {
    seg: [TESS.prop, TESS.prop, TESS.prop],
    solid: true,
  })

  /**
   * Every tread is a solid mass from the platform slab up to its own top, not a plank on
   * legs. That is both what a poured concrete stair is and what makes the flight climbable:
   * the player's step-up (player.js `_resolveHorizontal`) waves through anything no taller
   * than PLAYER.MOVEMENT.maxStepHeight and the vertical pass then seats the capsule on the
   * box top, so a 12.5 cm riser is walked up at full speed with no jump and no gaps to fall
   * into between the steps.
   */
  for (let k = 0; k < STAIRS.treadsPerFlight; k++) {
    // South flight: the mouth is at the east end and the climb runs west, toward the turn.
    const leadX = STAIRS.maxX - k * STAIR_TREAD
    const backX = leadX - STAIR_TREAD
    const topZ = lowerTreadTopZ(k)
    spanBox('concrete', `stair-tread-s-${k}`, [backX, leadX], [-STAIRS.halfWidth, -STAIRS.newelHalfY], [LEVELS.platformTopZ, topZ], {
      solid: true,
      added: true,
    })
    spanBox('stripe', `stair-nosing-s-${k}`, [leadX - STAIRS.nosingHalfDepth * 2, leadX + 0.6], [-STAIRS.halfWidth, -STAIRS.newelHalfY], [topZ - STAIRS.nosingHalfHeight * 2, topZ + 0.6], {
      added: true,
    })

    // North flight: out of the turn, climbing back east to the deck.
    const riseX = STAIR_LANDING_MAX_X + k * STAIR_TREAD
    const overX = riseX + STAIR_TREAD
    const upZ = upperTreadTopZ(k)
    spanBox('concrete', `stair-tread-n-${k}`, [riseX, overX], [STAIRS.newelHalfY, STAIRS.halfWidth], [LEVELS.platformTopZ, upZ], {
      solid: true,
      added: true,
    })
    spanBox('stripe', `stair-nosing-n-${k}`, [riseX - 0.6, riseX + STAIRS.nosingHalfDepth * 2], [STAIRS.newelHalfY, STAIRS.halfWidth], [upZ - STAIRS.nosingHalfHeight * 2, upZ + 0.6], {
      added: true,
    })
  }

  /**
   * The spine, in two heights, and the step between them is not a flourish.
   *
   * It has to be carried a guard-rail height above the deck at its EAST end: stopped at
   * deck level it is a 110 cm wide ledge flush with the balcony, and the first thing any
   * player does with a waist-high ledge beside a walkway is stand on it and walk out over
   * the stairwell. Carried up it is the central balustrade a switchback needs anyway, and
   * the column at X = 400 disappears inside it.
   *
   * It cannot be carried up at its WEST end, because the hall's hanging exit sign is slung
   * on rods at X = 300 across the full width of the stairwell, Z 264 upward. A full-height
   * spine runs straight through it and the rendered frame showed a sign with its middle
   * missing. So the spine rises after the fifth tread, which puts the sign over the low
   * half with 14 cm of daylight under it — and leaves the climber nothing to step onto,
   * because the highest tread that touches the low half tops out 62 cm below it, well past
   * the 45 cm step.
   */
  const spineTopZ = STAIRS.topZ + STAIRS.railHeight
  const spineRiseX = STAIR_LANDING_MAX_X + STAIR_TREAD * 5
  spanBox('tile', 'stair-spine-low', [STAIR_LANDING_MAX_X, spineRiseX], [-STAIRS.newelHalfY, STAIRS.newelHalfY], [LEVELS.platformTopZ, STAIRS.topZ], {
    seg: [TESS.prop, 1, TESS.pilasterHeight],
    solid: true,
    added: true,
  })
  spanBox('tile', 'stair-spine', [spineRiseX, STAIRS.maxX], [-STAIRS.newelHalfY, STAIRS.newelHalfY], [LEVELS.platformTopZ, spineTopZ - STAIRS.railTopDepth], {
    seg: [TESS.prop, 1, TESS.pilasterHeight],
    solid: true,
    added: true,
  })
  spanBox('furniture', 'stair-spine-coping', [spineRiseX - 6, STAIRS.maxX + 6], [-STAIRS.newelHalfY - 6, STAIRS.newelHalfY + 6], [spineTopZ - STAIRS.railTopDepth, spineTopZ], {
    seg: [TESS.prop, 1, 1],
    solid: true,
    added: true,
  })
  spanBox('furniture', 'stair-spine-low-coping', [STAIR_LANDING_MAX_X - 6, spineRiseX], [-STAIRS.newelHalfY - 6, STAIRS.newelHalfY + 6], [STAIRS.topZ - 8, STAIRS.topZ], {
    seg: [TESS.prop, 1, 1],
    added: true,
  })

  // The enclosure. Exactly the mezzanine slab's 40 cm overhang, stood up as wall.
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    const ys = side > 0 ? [STAIRS.halfWidth, STAIRS.wallOuterY] : [-STAIRS.wallOuterY, -STAIRS.halfWidth]
    spanBox('tile', `stair-wall-${tag}`, [STAIRS.wallMinX, STAIRS.maxX], ys, [LEVELS.platformTopZ, LEVELS.wallTopZ], {
      seg: [TESS.prop * 2, 1, TESS.wallHeight],
      solid: true,
      added: true,
    })
  }
  spanBox('tile', 'stair-head-wall', [STAIRS.wallMinX, STAIRS.minX], [-STAIRS.wallOuterY, STAIRS.wallOuterY], [LEVELS.platformTopZ, LEVELS.wallTopZ], {
    seg: [1, TESS.prop, TESS.wallHeight],
    solid: true,
    added: true,
  })

  // Handrails: one continuous sloping member per side per flight. See MeshBuilder.addBar.
  const railInsetY = STAIRS.halfWidth - STAIRS.handrailStandoff
  const spineRailY = STAIRS.newelHalfY + STAIRS.handrailStandoff
  bar('furniture', [STAIRS.maxX, -spineRailY, STAIRS.handrailHeight], [STAIR_LANDING_MAX_X, -spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)
  bar('furniture', [STAIRS.maxX, -railInsetY, STAIRS.handrailHeight], [STAIR_LANDING_MAX_X, -railInsetY, STAIR_LANDING_Z + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)
  bar('furniture', [STAIR_LANDING_MAX_X, spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], [STAIRS.maxX, spineRailY, STAIRS.topZ + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)
  bar('furniture', [STAIR_LANDING_MAX_X, railInsetY, STAIR_LANDING_Z + STAIRS.handrailHeight], [STAIRS.maxX, railInsetY, STAIRS.topZ + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)
  // and round the turn, along the head wall, so the hand never leaves the rail
  bar('furniture', [STAIR_LANDING_MAX_X, -spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], [STAIRS.minX + 10, -spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)
  bar('furniture', [STAIRS.minX + 10, -spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], [STAIRS.minX + 10, spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)
  bar('furniture', [STAIRS.minX + 10, spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], [STAIR_LANDING_MAX_X, spineRailY, STAIR_LANDING_Z + STAIRS.handrailHeight], STAIRS.handrailRadius, STAIRS.handrailRadius)

  // --- 6c. the balcony ------------------------------------------------------
  // A U in plan: a solid threshold at the head of the stair, then two arms down either
  // side of a void. The void is what makes it a mezzanine rather than a shelf — you can
  // look, shoot and drop straight through it onto the platform, and the hanging sign that
  // would otherwise be at chest height on the walkway hangs free in the middle of it.

  // The head of the stair stands in for the spec's `Mezzanine slab`, so it is the one
  // piece of the balcony not counted as an addition. It stops at the spine line on the
  // south side; the apron behind it picks the deck up again clear of the mouth.
  spanBox('concrete', 'mezzanine', [DECK_MIN_X, DECK_VOID_MIN_X], [-STAIRS.newelHalfY, DECK_HALF_Y], [STAIRS.deckUnderZ, STAIRS.topZ], {
    seg: [TESS.prop, TESS.prop, 1],
    solid: true,
  })
  spanBox('concrete', 'mezzanine-apron-s', [DECK_MOUTH_CLEAR_X, DECK_VOID_MIN_X], [-DECK_HALF_Y, -STAIRS.newelHalfY], [STAIRS.deckUnderZ, STAIRS.topZ], {
    seg: [TESS.prop, TESS.prop, 1],
    solid: true,
    added: true,
  })
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    const ys = side > 0 ? [STAIRS.voidHalfY, DECK_HALF_Y] : [-DECK_HALF_Y, -STAIRS.voidHalfY]
    spanBox('concrete', `mezzanine-arm-${tag}`, [DECK_VOID_MIN_X, DECK_MAX_X], ys, [STAIRS.deckUnderZ, STAIRS.topZ], {
      seg: [TESS.prop, TESS.prop, 1],
      solid: true,
      added: true,
    })
  }

  /**
   * The plate the station's name is screwed to. It hangs BELOW the deck edge rather than
   * being painted on its 30 cm lip: 30 cm of board six metres away is a smudge, 44 cm on a
   * plate standing proud of the slab is a sign. The bottom edge sits at Z 206, which leaves
   * 14 cm over a 192 cm pawn walking the platform underneath, and it carries no collider,
   * so it cannot catch anyone.
   *
   * It is appended HERE and not with the signage further down, because everything in this
   * module goes into one shared vertex buffer per material and those buffers are built
   * before the signage runs. Added after the build it was counted, disposed and never
   * drawn — two primitives of pure accounting, which is how the spec-count assertion
   * caught it.
   */
  const fasciaBottomZ = STAIRS.deckUnderZ - 14
  const fasciaMid = (fasciaBottomZ + STAIRS.topZ) * 0.5
  const fasciaHeight = STAIRS.topZ - fasciaBottomZ - 5
  const fasciaWidth = DECK_MAX_X - DECK_MOUTH_CLEAR_X - 30
  for (const side of [1, -1]) {
    const outer = DECK_HALF_Y * side
    const ys = side > 0 ? [outer, outer + 6] : [outer - 6, outer]
    spanBox('furniture', `mezzanine-fascia-${side > 0 ? 'n' : 's'}`, [DECK_MOUTH_CLEAR_X, DECK_MAX_X], ys, [fasciaBottomZ, STAIRS.topZ], {
      added: true,
    })
  }

  /**
   * One run of guard rail: a plinth, a mid rail, a capping rail and posts, plus a SINGLE
   * collider spanning the lot. Modelling each member as a collider would let a player
   * wedge into the gap between the kerb and the mid rail; one box is what the rail means.
   */
  function railRun(name, xs, ys, { solid = true } = {}) {
    const base = STAIRS.topZ
    const top = base + STAIRS.railHeight
    const alongX = xs[1] - xs[0] >= ys[1] - ys[0]
    const thin = STAIRS.railThickness

    const lip = STAIRS.railCapOverhang
    spanBox('concrete', `${name}-kerb`, xs, ys, [base, base + STAIRS.railKerb], { added: true })
    spanBox('furniture', `${name}-mid`, xs, ys, [base + STAIRS.railHeight * 0.5 - 3, base + STAIRS.railHeight * 0.5 + 3], { added: true })
    spanBox('furniture', `${name}-cap`, [xs[0] - lip, xs[1] + lip], [ys[0] - lip, ys[1] + lip], [top - STAIRS.railTopDepth, top], { added: true })

    const span = alongX ? xs[1] - xs[0] : ys[1] - ys[0]
    const posts = Math.max(1, Math.round(span / STAIRS.postSpacing))
    for (let i = 0; i <= posts; i++) {
      const t = i / posts
      const at = (alongX ? xs[0] : ys[0]) + t * span
      const px = alongX ? [at - thin * 0.5, at + thin * 0.5] : xs
      const py = alongX ? ys : [at - thin * 0.5, at + thin * 0.5]
      spanBox('furniture', `${name}-post-${i}`, px, py, [base + STAIRS.railKerb, top - STAIRS.railTopDepth], { added: true })
    }

    if (solid) {
      blocker(
        name,
        [(xs[0] + xs[1]) * 0.5, (ys[0] + ys[1]) * 0.5, (base + top) * 0.5],
        [(xs[1] - xs[0]) * 0.5, (ys[1] - ys[0]) * 0.5, (top - base) * 0.5],
      )
    }
  }

  const railT = STAIRS.railThickness
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    const outer = DECK_HALF_Y * side
    const ys = side > 0 ? [outer - railT, outer] : [outer, outer + railT]
    // The north edge runs from the head of the stair; the south one starts at the apron.
    railRun(`mezzanine-rail-${tag}`, [side > 0 ? DECK_MIN_X : DECK_MOUTH_CLEAR_X, DECK_MAX_X], ys)

    const vy = STAIRS.voidHalfY * side
    const vys = side > 0 ? [vy, vy + railT] : [vy - railT, vy]
    railRun(`mezzanine-void-rail-${tag}`, [DECK_VOID_MIN_X, DECK_MAX_X], vys)
  }
  railRun('mezzanine-void-rail-w', [DECK_VOID_MIN_X, DECK_VOID_MIN_X + railT], [-STAIRS.voidHalfY, STAIRS.voidHalfY])
  railRun('mezzanine-rail-e-n', [DECK_MAX_X - railT, DECK_MAX_X], [STAIRS.voidHalfY, DECK_HALF_Y])
  // The apron's own west edge — a 250 cm drop straight down onto the stair mouth.
  railRun('mezzanine-rail-w', [DECK_MOUTH_CLEAR_X, DECK_MOUTH_CLEAR_X + railT], [-DECK_HALF_Y, -STAIRS.newelHalfY])

  /**
   * The south arm's east end is deliberately UNRAILED, and chained instead.
   *
   * A balcony whose only exit is the stair it came off is a trap, and a trap that the
   * player cannot see is a bug report. A 190 cm opening with two hazard chains across it
   * reads as "closed off, not walled off": the chains are drawn and are NOT colliders, so
   * the player steps over them and takes the 250 cm drop back onto the platform. Nothing
   * in the game does fall damage above the track pit, so it costs momentum, not health —
   * which is exactly the price a second exit should carry.
   */
  const chainY = [-DECK_HALF_Y, -STAIRS.voidHalfY]
  spanBox('stripe', 'mezzanine-gap-kerb', [DECK_MAX_X - railT, DECK_MAX_X], chainY, [STAIRS.topZ, STAIRS.topZ + 6], { added: true })
  for (const h of [45, 90]) {
    bar('furniture', [DECK_MAX_X - railT * 0.5, chainY[0], STAIRS.topZ + h], [DECK_MAX_X - railT * 0.5, chainY[1], STAIRS.topZ + h], 2.5, 2.5)
  }


  const turnstile = PROPS.turnstile
  for (let i = 0; i < COUNTS.turnstiles; i++) {
    const y = turnstile.firstY + i * turnstile.spacingY
    box('furniture', `turnstile-${i}`, [turnstile.x, y, turnstile.centreZ], turnstile.halfExtent, { solid: true })
  }

  PROPS.vending.positions.forEach((position, i) => {
    box('furniture', `vending-${i}`, position, PROPS.vending.halfExtent, { seg: [1, 1, TESS.slab], solid: true })
  })

  const bin = PROPS.trashBin
  for (let i = 0; i < COUNTS.trashBins; i++) {
    const x = bin.firstX + i * bin.spacing
    const y = i % 2 === 0 ? -bin.yOffset : bin.yOffset
    cylinder('bin', `trash-bin-${i}`, [x, y, bin.centreZ], bin.radius, bin.height, { radial: TESS.binRadial, heightSeg: TESS.binHeight, solid: true })
  }

  // --- 7. signage -----------------------------------------------------------
  const sign = PROPS.hangingSign
  for (let i = 0; i < COUNTS.hangingSigns; i++) {
    const x = sign.firstX + i * sign.spacing
    box('sign', `hanging-sign-${i}`, [x, 0, sign.centreZ], sign.halfExtent, { boxUv: true })
  }
  /**
   * The original buries its own signage. It derives the board's Y as `NorthWallY - 8`,
   * treating 1220 as the wall's FACE when 1220 is the wall's CENTRE — the slab runs
   * Y 1200..1240, so the board (1206..1218) and the logo quad (1205) both end up inside
   * it and never render. Same class of defect as the trains that teleport onto the
   * platform (spec section 3.5): the intent is unmistakable, so the port mounts both on
   * the wall's inner face and keeps the authored 7 cm gap between board and logo.
   */
  const boardStandoff = PROPS.wallBoard.halfExtent[1]
  const boardY = LEVELS.wallInnerY - boardStandoff
  const logoGap = PROPS.wallBoard.centre[1] - PROPS.logo.anchor[1]
  box('board', 'wall-board', [PROPS.wallBoard.centre[0], boardY, PROPS.wallBoard.centre[2]], PROPS.wallBoard.halfExtent, { boxUv: true })

  // --- 8. ceiling slab, with a hole in it ----------------------------------
  /**
   * The slab is built as four pieces around an opening over the stairwell instead of as
   * one 6000 x 2480 lid. A stair that climbs 250 cm and then stops under a concrete ceiling
   * goes nowhere, and "goes nowhere" is what the spec's solid block already said. The hole
   * is the stairwell block's own footprint, so the shaft walls carry straight through it.
   *
   * The east piece keeps the name `ceiling-slab` and the spec's primitive slot; the other
   * three are counted as additions.
   */
  const ceilingSpan = [LEVELS.wallTopZ, LEVELS.ceilingTopZ]
  const ceilingHalfY = DIM.ceilingSlabHalfWidth
  spanBox('concrete', 'ceiling-slab', [WELL_MAX_X, DIM.length], [-ceilingHalfY, ceilingHalfY], ceilingSpan, {
    seg: [TESS.alongStation, TESS.acrossCeiling, 1],
    solid: true,
  })
  spanBox('concrete', 'ceiling-slab-west', [0, STAIRS.minX], [-ceilingHalfY, ceilingHalfY], ceilingSpan, {
    seg: [1, TESS.acrossCeiling, 1],
    solid: true,
    added: true,
  })
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    const ys = side > 0 ? [STAIRS.halfWidth, ceilingHalfY] : [-ceilingHalfY, -STAIRS.halfWidth]
    spanBox('concrete', `ceiling-slab-${tag}-of-well`, [STAIRS.minX, WELL_MAX_X], ys, ceilingSpan, {
      seg: [TESS.prop, TESS.prop, 1],
      solid: true,
      added: true,
    })
  }

  // --- 9. the light well ----------------------------------------------------
  // Five metres of tiled shaft between the ceiling line and the pavement. It is what the
  // daylight arrives through, and — because a lamp with nothing between it and the floor
  // is a lamp you cannot see — it is also what makes the beam legible from the platform.
  const wellEastX = WELL_MAX_X + DIM.wallThickness
  const wellSpan = [LEVELS.wallTopZ, STAIRS.wellTopZ]
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    const ys = side > 0 ? [STAIRS.halfWidth, STAIRS.wallOuterY] : [-STAIRS.wallOuterY, -STAIRS.halfWidth]
    spanBox('tile', `light-well-${tag}`, [STAIRS.wallMinX, wellEastX], ys, wellSpan, {
      seg: [TESS.prop, 1, TESS.wallHeight],
      added: true,
    })
  }
  spanBox('tile', 'light-well-w', [STAIRS.wallMinX, STAIRS.minX], [-STAIRS.wallOuterY, STAIRS.wallOuterY], wellSpan, {
    seg: [1, TESS.prop, TESS.wallHeight],
    added: true,
  })
  spanBox('tile', 'light-well-e', [WELL_MAX_X, wellEastX], [-STAIRS.wallOuterY, STAIRS.wallOuterY], wellSpan, {
    seg: [1, TESS.prop, TESS.wallHeight],
    added: true,
  })
  /**
   * The cap that used to close the top of this well is gone, and summit.js builds the
   * pavement in its place — same Z 940..980, same thickness, but with a stair pit cut
   * through it so the shaft reaches a real street instead of a painted one. A blind lid
   * over a seven-metre room is what made the mezzanine the top of the level.
   */

  // --- assemble the meshes --------------------------------------------------
  // Only the props cast: the walls, floor and ceiling ARE the room, and shadow-mapping a
  // 6000 cm slab from a 124-degree spot buys acne, not depth. Columns casting down the
  // platform is the shadow that actually matters.
  const meshPlan = [
    { key: 'platform', material: materials.wetConcrete, receive: true },
    { key: 'stripe', material: materials.safetyStripe, receive: true },
    { key: 'concrete', material: materials.concrete, receive: true, cast: true },
    { key: 'tile', material: materials.tile, receive: true },
    { key: 'column', material: materials.column, receive: true, cast: true },
    { key: 'rail', material: materials.rail, receive: true },
    { key: 'sleeper', material: materials.sleeper, receive: true },
    { key: 'portal', material: materials.tunnelPortal },
    { key: 'furniture', material: materials.furniture, receive: true, cast: true },
    { key: 'bin', material: materials.trashBin, receive: true, cast: true },
    { key: 'sign', material: materials.hangingSign },
    { key: 'board', material: materials.wallBoard },
  ]

  const geometries = []
  let primitives = 0
  for (const plan of meshPlan) {
    const builder = families[plan.key]
    primitives += builder.primitives
    const geometry = builder.build()
    geometries.push(geometry)
    const node = new THREE.Mesh(geometry, plan.material)
    node.name = `station-${plan.key}`
    node.castShadow = Boolean(plan.cast)
    node.receiveShadow = Boolean(plan.receive)
    group.add(node)
  }

  // --- the logo panel, a textured quad in front of the backlit board --------
  // The spec anchors it facing -Y (toward the platform), which is +Z in three — exactly
  // where an unrotated PlaneGeometry already looks, so no rotation is needed.
  const logoGeometry = new THREE.PlaneGeometry(PROPS.logo.width, PROPS.logo.height)
  const logoMesh = new THREE.Mesh(logoGeometry, materials.logo)
  logoMesh.name = 'station-logo'
  logoMesh.position.copy(specToThree(PROPS.logo.anchor[0], boardY - logoGap, PROPS.logo.anchor[2]))
  group.add(logoMesh)
  geometries.push(logoGeometry)
  const logoReady = loadLogoTexture(materials.logo)

  // --- the stairwell's own art and its own rig -----------------------------
  // Everything below is a standalone mesh or light rather than another box in a shared
  // vertex buffer: signage carries artwork, the daylight shaft is additive, and the five
  // lights are the reason any of it reads at all.

  // Centred on the full-width part of the balcony, not on its northern head.
  const deckMidX = (DECK_MOUTH_CLEAR_X + DECK_MAX_X) * 0.5
  const skyColor = new THREE.Color(STAIRS.skyColorHex)

  /** The street opening, seen looking straight up the well from the foot of the stairs. */
  const openingTexture = bakeStreetOpening()
  const openingMaterial = new THREE.MeshBasicMaterial({
    // Just under 1 in linear space, and that is the whole correction. Measured down from
    // 2.4/2.6/3.0 and then from 1.5/1.66/2.0: every one of those clipped, and a clipped
    // plane plus toneMappingExposure 1.15 plus the additive shafts does not LIGHT the
    // tile beside it, it ERASES it — summit.png came back as a single flat pink wash with
    // no tread, no handrail and no tile in it at all. Below 1 the opening still tops every
    // other surface in the scene by a wide margin, still reads as daylight because it is
    // cold against sodium, and still feeds the bloom — it just stops taking the stairwell
    // with it.
    color: new THREE.Color().setRGB(0.78, 0.86, 1.05, THREE.LinearSRGBColorSpace),
    map: openingTexture ?? null,
    fog: false,
    toneMapped: true,
  })
  const openingGeometry = new THREE.PlaneGeometry(wellEastX - STAIRS.wallMinX, STAIRS.wallOuterY * 2)
  const opening = new THREE.Mesh(openingGeometry, openingMaterial)
  opening.name = 'street-opening'
  opening.position.copy(specToThree((STAIRS.wallMinX + wellEastX) * 0.5, 0, STAIRS.wellTopZ - 2))
  opening.rotation.x = Math.PI / 2 // an unrotated plane faces three +Z; this turns it to face down
  group.add(opening)
  geometries.push(openingGeometry)
  stairwellDisposables.push(openingMaterial)
  if (openingTexture) stairwellDisposables.push(openingTexture)

  /**
   * The beams. See buildDaylightShaftGeometry for why a light needs one at all — and see
   * `wellReachEast` for why there are two. The wide one falls down the stair shaft and is
   * read from inside it; the narrow one drops through the balcony's void and is the only
   * part of any of this that a player standing in the middle of the platform can see.
   */
  const shaftMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // BackSide for the same reason lighting.js gives its sodium cones: an additive volume
    // you can walk inside must not add twice, and seeing only its far wall reads as depth.
    side: THREE.BackSide,
    fog: false,
    toneMapped: true,
  })
  stairwellDisposables.push(shaftMaterial)

  const voidMidX = (DECK_VOID_MIN_X + WELL_MAX_X) * 0.5
  const beams = [
    {
      name: 'daylight-shaft-stair',
      top: [(STAIRS.maxX - STAIRS.minX) * 0.44, STAIRS.halfWidth * 0.8, (STAIRS.minX + STAIRS.maxX) * 0.5 - 20],
      bottom: [(STAIRS.maxX - STAIRS.minX) * 0.6, STAIRS.halfWidth * 0.98, (STAIRS.minX + STAIRS.maxX) * 0.5 + 40],
      gain: STAIRS.shaftHaze,
    },
    {
      // Kept inside the void's own 220 cm width, or the beam clips through the deck arms
      // it is supposed to be falling between.
      name: 'daylight-shaft-void',
      top: [(WELL_MAX_X - DECK_VOID_MIN_X) * 0.42, STAIRS.voidHalfY * 0.82, voidMidX],
      bottom: [(WELL_MAX_X - DECK_VOID_MIN_X) * 0.54, STAIRS.voidHalfY * 0.94, voidMidX + 30],
      gain: STAIRS.shaftHaze * 1.35,
    },
  ]
  for (const beam of beams) {
    const geometry = buildDaylightShaftGeometry(beam.top, beam.bottom, STAIRS.wellTopZ - 20, LEVELS.platformTopZ, skyColor, beam.gain)
    const mesh = new THREE.Mesh(geometry, shaftMaterial)
    mesh.name = beam.name
    mesh.renderOrder = 3
    group.add(mesh)
    geometries.push(geometry)
  }

  /**
   * The name boards. A real platform names itself on a plate you can read from a train
   * window, so the two big ones ride the balcony fascia facing out over the platform, one
   * per side, and the third faces the climber at the head of the stair.
   */
  function nameBoard(name, spec, yaw, width, height, texture) {
    if (!texture) return null
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      emissive: 0xffffff,
      emissiveMap: texture,
      emissiveIntensity: PROPS.wallBoard.emissiveIntensity * 0.7,
      roughness: 0.28, // vitreous enamel: glossier than anything else on the platform
      metalness: 0.0,
    })
    const geometry = new THREE.PlaneGeometry(width, height)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    mesh.position.copy(specToThree(spec[0], spec[1], spec[2]))
    mesh.rotation.y = yaw
    group.add(mesh)
    geometries.push(geometry)
    stairwellDisposables.push(material)
    if (!stairwellDisposables.includes(texture)) stairwellDisposables.push(texture)
    return mesh
  }

  // An unrotated plane looks down three +Z, which is spec -Y — the same fact the logo
  // panel below relies on, so a board facing the platform from the north side needs the
  // half turn and one facing it from the south side needs nothing.
  const fasciaText = bakeNameBoard('SHOEMONEY STATION', null, { width: 2048, height: 128 })
  const approachText = bakeNameBoard('SHOEMONEY SQ', null, { width: 1024, height: 128 })
  nameBoard('mezzanine-name-s', [deckMidX, -(DECK_HALF_Y + 9), fasciaMid], 0, fasciaWidth, fasciaHeight, fasciaText)
  nameBoard('mezzanine-name-n', [deckMidX, DECK_HALF_Y + 9, fasciaMid], Math.PI, fasciaWidth, fasciaHeight, fasciaText)

  /**
   * The approach boards. The two fascia plates face out across the platform, which means
   * nobody walking UP the platform toward the stair ever sees one — and the whole platform
   * spends the game looking down its own length. So each balcony arm carries the name on
   * its east end as well, square to the hall, which is the face every camera in the game
   * is already pointed at.
   */
  for (const side of [1, -1]) {
    nameBoard(
      `mezzanine-approach-${side > 0 ? 'n' : 's'}`,
      [DECK_MAX_X + 3, ((STAIRS.voidHalfY + DECK_HALF_Y) * 0.5) * side, fasciaMid],
      Math.PI / 2, // +90 about three Y turns a +Z-facing plane to face +X, down the platform
      DECK_HALF_Y - STAIRS.voidHalfY - 24,
      fasciaHeight,
      approachText,
    )
  }

  // The big one, read on the way up: it sits ABOVE the central spine's coping so the
  // balustrade does not cut it in half from the platform.
  nameBoard(
    'stair-head-name',
    [STAIRS.minX + 3, 0, (STAIRS.topZ + STAIRS.railHeight + LEVELS.wallTopZ) * 0.5],
    Math.PI / 2,
    440.0,
    LEVELS.wallTopZ - (STAIRS.topZ + STAIRS.railHeight) - 10,
    bakeNameBoard('SHOEMONEY SQ', 'STREET LEVEL  ·  EXIT', { width: 1024, height: 220 }),
  )

  /** Soffit fixtures, so the pools of light under the balcony have something making them. */
  const soffitGeometry = new THREE.BoxGeometry(
    STATION.LIGHTING.lightStrip.halfExtent[0] * 2,
    STATION.LIGHTING.lightStrip.halfExtent[2] * 2,
    STATION.LIGHTING.lightStrip.halfExtent[1] * 2,
  )
  geometries.push(soffitGeometry)

  const stairLights = []
  for (const side of [1, -1]) {
    const y = 190 * side
    const fixture = new THREE.Mesh(soffitGeometry, materials.lightStrip)
    fixture.name = `mezzanine-soffit-${side > 0 ? 'n' : 's'}`
    fixture.position.copy(specToThree(deckMidX, y, STAIRS.deckUnderZ - 4))
    group.add(fixture)

    /**
     * Pointed straight down at the slab. The balcony's whole tactical value is the dead
     * ground under its lip, and dead ground the player cannot SEE is not a trade-off, it
     * is a black hole with zombies in it.
     */
    const down = new THREE.SpotLight(
      new THREE.Color(STATION.LIGHTING.ceilingSpot.colorHex),
      candela(STATION.LIGHTING.ceilingSpot.intensity * 0.28),
      700,
      58 * deg,
      0.45,
      2,
    )
    down.name = `mezzanine-downlight-${side > 0 ? 'n' : 's'}`
    down.position.copy(specToThree(deckMidX, y, STAIRS.deckUnderZ - 10))
    down.target.position.copy(specToThree(deckMidX, y, LEVELS.platformTopZ))
    down.castShadow = false
    group.add(down)
    group.add(down.target)
    stairLights.push(down)
  }

  /**
   * The flight's own fitting, and the direction it points is the whole of it.
   *
   * Everything else in this rig lights the stairwell from ABOVE — the daylight heads at the
   * grating, the landing fill, the deck lamp. Measured on a frame with three bodies standing
   * on the treads, that rig renders the climb as a dark slot with silhouettes in it: the
   * nosings read, the risers read, and the things using the stairs are black cut-outs. A
   * staircase whose occupants cannot be seen is a staircase nobody will ever choose to
   * fight on.
   *
   * The fix is not more light, it is light from the other end. Anything coming DOWN faces
   * east, into the hall, so a fitting hung over the mouth and aimed back up the flight
   * strikes the descending face rather than the back of the head — and on the way it rakes
   * all ten treads at a shallow angle, which is what makes twenty yellow nosings converge
   * instead of flatten. Warm, because the well above it is cold: the climb then reads as
   * the station's own light giving out to daylight somewhere over the top step.
   *
   * The DIRECTION above is right; the first magnitude was not. At 0.62 these two fittings
   * measured 257,920 cd each — the brightest thing in the station bar the moon key — and
   * they solved the silhouette by deleting the thing casting it: the stair mouth ran mean
   * L 204.7 with 15.6% of its pixels fully clipped, and the two zombies descending it, the
   * brick, the ten treads, the yellow nosings, the handrail and the SHOEMONEY SQ board
   * were all bleached to flat white. At 0.22 the same region measures mean 140.7 with 1.8%
   * clipped and every one of those comes back. A rake light is aimed, not loud.
   */
  for (const flight of [
    { tag: 's', y: -(STAIRS.newelHalfY + STAIRS.halfWidth) * 0.5, aimZ: STAIR_LANDING_Z },
    { tag: 'n', y: (STAIRS.newelHalfY + STAIRS.halfWidth) * 0.5, aimZ: STAIRS.topZ },
  ]) {
    const fromZ = LEVELS.wallTopZ - 30
    const wash = new THREE.SpotLight(
      new THREE.Color(STATION.LIGHTING.ceilingSpot.colorHex),
      candela(STATION.LIGHTING.ceilingSpot.intensity * 0.22),
      1100,
      54 * deg,
      0.62,
      2,
    )
    wash.name = `stair-wash-${flight.tag}`
    wash.position.copy(specToThree(STAIRS.maxX - 25, flight.y, fromZ))
    wash.target.position.copy(specToThree(STAIR_LANDING_MAX_X, flight.y, flight.aimZ))
    wash.castShadow = false
    group.add(wash)
    group.add(wash.target)
    stairLights.push(wash)

    // A lamp with nothing to see it by is a lamp you cannot see — the same reason the well
    // carries beams. This is the fitting the wash comes out of, on the head wall over the mouth.
    const fixture = new THREE.Mesh(soffitGeometry, materials.lightStrip)
    fixture.name = `stair-fixture-${flight.tag}`
    fixture.position.copy(specToThree(STAIRS.maxX - 25, flight.y, fromZ))
    group.add(fixture)
  }

  /**
   * Daylight. Cold, bright and directional in a hall lit entirely by warm sodium, which is
   * why it reads as OUTSIDE from anywhere on the platform without a single word of signage.
   *
   * Two heads at the ceiling line rather than one at the grating, and that is not a
   * shortcut. A single source 880 cm up on an inverse-square falloff has to be made
   * blinding at the top of the well to be worth anything at the bottom of it, which is
   * exactly what the first attempt rendered: a molten white shaft and a platform that
   * could not tell the difference. Hung at the ceiling these throw the same 450-odd cm the
   * sodium spots do, at a known multiple of them, and the beams above carry the eye up to
   * the grating instead of the lamp trying to.
   */
  /** What one ceiling spot lands on the platform directly under it. The unit above. */
  const spotFloorIrradiance =
    candela(STATION.LIGHTING.ceilingSpot.intensity) / (STATION.LIGHTING.ceilingSpot.z - LEVELS.platformTopZ) ** 2

  for (const head of [
    // The grating itself: hung high, aimed a little east so the pool lands ACROSS the
    // mouth rather than stopping at the bottom step, and wide enough to take the whole
    // shaft plus the head of the balcony.
    {
      tag: 'shaft',
      from: [(STAIRS.minX + STAIRS.maxX) * 0.5, STAIRS.wellTopZ - 40],
      aim: DECK_VOID_MIN_X,
      cone: 48,
      penumbra: 0.55,
      multiple: STAIRS.skyFloorMultiple,
    },
    // A second, tighter head over the void, so the column of light that drops through the
    // balcony onto the slab is brighter than the room it passes through.
    {
      tag: 'void',
      from: [voidMidX, STAIRS.wellTopZ - 40],
      aim: voidMidX + 30,
      cone: 26,
      penumbra: 0.4,
      multiple: STAIRS.skyFloorMultiple * 1.3,
    },
    // And the spill: low, shallow and pointed down the hall. This is the one a player
    // three bays away actually sees — a cold slab lying on wet warm-lit concrete.
    {
      tag: 'spill',
      from: [STAIRS.maxX + 40, LEVELS.platformTopZ + 300],
      aim: DIM.columnMargin + DIM.columnSpacing * 2.5,
      cone: 40,
      penumbra: 0.7,
      multiple: STAIRS.mouthSpillMultiple,
    },
  ]) {
    const throwDistance = Math.hypot(head.aim - head.from[0], head.from[1] - LEVELS.platformTopZ)
    const daylight = new THREE.SpotLight(
      skyColor,
      spotFloorIrradiance * head.multiple * throwDistance, // decay 1: irradiance = I / d
      STAIRS.wellTopZ * 2.6,
      head.cone * deg,
      head.penumbra,
      1,
    )
    daylight.name = `stairwell-daylight-${head.tag}`
    daylight.position.copy(specToThree(head.from[0], 0, head.from[1]))
    daylight.target.position.copy(specToThree(head.aim, 0, LEVELS.platformTopZ))
    daylight.castShadow = false
    group.add(daylight)
    group.add(daylight.target)
    stairLights.push(daylight)
  }

  /**
   * The bounce out of the mouth. Everything above lights the INSIDE of the shaft, so from
   * the hall the enclosure was a black mass standing next to a brightly lit floor — all
   * the daylight and none of the building. This is the light the slab throws back at it.
   */
  const mouthBounce = new THREE.PointLight(skyColor, candela(STATION.LIGHTING.ambientFill.intensity * 1.4), 820, 2)
  mouthBounce.name = 'stairwell-mouth-bounce'
  mouthBounce.position.copy(specToThree(DECK_VOID_MIN_X, 0, LEVELS.platformTopZ + 150))
  group.add(mouthBounce)
  stairLights.push(mouthBounce)

  // A cool fill at the turn: the half-landing is the one part of the climb the beam
  // cannot reach down into, and a black landing halfway up reads as a dead end.
  const landingFill = new THREE.PointLight(skyColor, candela(STATION.LIGHTING.ambientFill.intensity * 0.7), 900, 2)
  landingFill.name = 'stairwell-landing-fill'
  landingFill.position.copy(specToThree(STAIRS.minX + 90, 0, STAIR_LANDING_Z + 250))
  group.add(landingFill)
  stairLights.push(landingFill)

  // And one warm lamp over the balcony, so the deck is a place rather than a silhouette.
  const deckLamp = new THREE.PointLight(
    new THREE.Color(STATION.LIGHTING.ceilingSpot.colorHex),
    candela(STATION.LIGHTING.ambientFill.intensity * 1.2),
    700,
    2,
  )
  deckLamp.name = 'mezzanine-lamp'
  deckLamp.position.copy(specToThree(deckMidX, 0, LEVELS.wallTopZ - 30))
  group.add(deckLamp)
  stairLights.push(deckLamp)

  // The level above the level — three more pitches out of the mezzanine to a street at
  // Z 980, open to the sky. It appends to these same arrays, so nothing else changes.
  const summit = buildSummit(scene, { group, materials, colliders, geometries, disposables: stairwellDisposables })

  scene.add(group)

  const lighting = createLighting(scene, materials)

  const totalPrimitives = primitives - addedPrimitives + lighting.specPrimitives
  if (totalPrimitives !== COUNTS.totalGeometryInstances) {
    console.warn(
      `[station] built ${totalPrimitives} spec primitives, expected ${COUNTS.totalGeometryInstances}. ` +
        'The station no longer matches the level it was extracted from.',
    )
  }
  console.info(
    `[station] ${totalPrimitives} spec + ${addedPrimitives} added primitives in ` +
      `${group.children.length + lighting.group.children.length} nodes, ${colliders.length} colliders`,
  )

  // --- what the rest of the game needs out of the level --------------------
  // Not the level's placed marker at (0,0,220) — that one sits inside the west end wall.
  const playerStart = {
    position: specToThree(PLAYER.SPAWN.x, PLAYER.SPAWN.y, PLAYER.SPAWN.z),
    yaw: PLAYER.SPAWN.yaw * deg,
    eyeOffset: PLAYER.CAMERA.eyeOffsetZ,
    capsuleRadius: PLAYER.capsuleRadius,
    capsuleHalfHeight: PLAYER.capsuleHalfHeight,
  }

  const spawnPoints = []
  for (const side of [1, -1]) {
    for (const x of DESIGNED.doorSpawnXs) {
      spawnPoints.push({
        kind: 'door',
        side: side > 0 ? 'north' : 'south',
        position: specToThree(x, DESIGNED.doorSpawnY * side, DESIGNED.doorSpawnZ),
        yaw: (side > 0 ? DESIGNED.doorSpawnYawNorth : DESIGNED.doorSpawnYawSouth) * deg,
      })
    }
  }
  for (const side of [1, -1]) {
    const west = DESIGNED.tunnelSpawnWest
    const east = DESIGNED.tunnelSpawnEast
    spawnPoints.push({
      kind: 'tunnel',
      side: side > 0 ? 'north' : 'south',
      position: specToThree(west[0], west[1] * side, west[2]),
      yaw: 0,
    })
    spawnPoints.push({
      kind: 'tunnel',
      side: side > 0 ? 'north' : 'south',
      position: specToThree(east[0], east[1] * side, east[2]),
      yaw: Math.PI,
    })
  }

  /**
   * And the stair, which is the point of building it.
   *
   * A second storey that only the player can use is set dressing with a floor on it. These
   * five points sit at the head of the flight, along both balcony arms and on the
   * half-landing, so a wave can be ordered DOWN the stairs into the hall instead of always
   * out of the same four train doors — and so a player who has climbed up to get away from
   * the melee finds the melee has an address up there too.
   */
  for (const point of [
    [DECK_MIN_X + 60, -160, STAIRS.topZ],
    [DECK_MIN_X + 60, 160, STAIRS.topZ],
    [DECK_VOID_MIN_X + 140, -(STAIRS.voidHalfY + DECK_HALF_Y) * 0.5, STAIRS.topZ],
    [DECK_VOID_MIN_X + 140, (STAIRS.voidHalfY + DECK_HALF_Y) * 0.5, STAIRS.topZ],
    [STAIRS.minX + 60, 0, STAIR_LANDING_Z],
  ]) {
    spawnPoints.push({
      kind: 'stair',
      side: point[1] >= 0 ? 'north' : 'south',
      position: specToThree(point[0], point[1], point[2]),
      spec: { x: point[0], y: point[1], z: point[2] },
      yaw: 0,
    })
  }

  // 18 points, two per column, dealt A-then-B so no two of a kind sit together
  const pickupPoints = []
  for (let i = 0; i < COUNTS.columns; i++) {
    const x = DIM.columnMargin + i * DIM.columnSpacing
    pickupPoints.push(specToThree(x - POINTS.offsetX, POINTS.offsetY, POINTS.z))
    pickupPoints.push(specToThree(x + POINTS.offsetX, -POINTS.offsetY, POINTS.z))
  }
  if (pickupPoints.length !== POINTS.count) {
    console.warn(`[station] produced ${pickupPoints.length} pickup points, expected ${POINTS.count}.`)
  }

  /**
   * The station publishes the stops the original NEVER READ: trains centred in the track
   * pits, arriving from opposite ends. Spec section 3.5 calls these the intended numbers,
   * and the shipped behaviour — both trains teleported onto the platform centreline,
   * parked through a column and the stairwell — is preserved under `.shipped` for anyone
   * reproducing the defect rather than the design.
   */
  const trainStop = {
    position: specToThree(DESIGNED.trainStopX, DESIGNED.trainStopY, DESIGNED.trainStopZ),
    staging: specToThree(...DESIGNED.trainStagingNorth),
    yaw: 0,
    designed: {
      north: {
        stop: specToThree(DESIGNED.trainStopX, DESIGNED.trainStopY, DESIGNED.trainStopZ),
        staging: specToThree(...DESIGNED.trainStagingNorth),
        yaw: 0,
      },
      south: {
        stop: specToThree(DESIGNED.trainStopX, -DESIGNED.trainStopY, DESIGNED.trainStopZ),
        staging: specToThree(...DESIGNED.trainStagingSouth),
        yaw: Math.PI,
      },
    },
    shipped: {
      stop: specToThree(...TRAIN.platformStopLocation),
      staging: specToThree(...TRAIN.stagingLocation),
      yaw: 0,
    },
  }

  /**
   * Circles the AI steers around.
   *
   * zombie.js has no navmesh and no collision against level geometry — `_avoidObstacles`
   * IS its pathing, and it only knows circles. The nine columns are already published as
   * such; without the same treatment the stairwell is invisible to every body in the game
   * and a wave ordered down the stairs walks out through the side of the shaft on its way
   * to the player. These are the masses a body must go round rather than through.
   */
  const navObstacles = []
  const spineSamples = 4
  for (let i = 0; i <= spineSamples; i++) {
    navObstacles.push({
      x: STAIR_LANDING_MAX_X + (i / spineSamples) * (STAIRS.maxX - STAIR_LANDING_MAX_X),
      y: 0,
      radius: STAIRS.newelHalfY + 20,
    })
  }
  const wallSamples = 5
  for (const side of [1, -1]) {
    for (let i = 0; i <= wallSamples; i++) {
      navObstacles.push({
        x: STAIRS.wallMinX + (i / wallSamples) * (STAIRS.maxX - STAIRS.wallMinX),
        y: (STAIRS.halfWidth + DIM.wallThickness * 0.5) * side,
        radius: DIM.wallThickness,
      })
    }
  }

  const boundsCentre = specToThree(...STATION.BOUNDS.centre)
  const boundsHalf = new THREE.Vector3(...specHalf(STATION.BOUNDS.halfExtent))
  const bounds = new THREE.Box3(boundsCentre.clone().sub(boundsHalf), boundsCentre.clone().add(boundsHalf))

  return {
    group,
    colliders,
    spawnPoints,
    pickupPoints,
    playerStart,
    trainStop,
    bounds,
    materials,
    lighting,
    /** The level's 2.5D floor query — see floorHeightAt. game.js drives the AI off it. */
    floorHeightAt,
    isOverMezzanine,
    mezzanineTopZ: MEZZANINE_TOP_Z,
    summit,
    navObstacles,
    logoReady,
    specToThree,
    update(dt) {
      lighting.update(dt)
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose()
      for (const item of stairwellDisposables) item.dispose()
      lighting.dispose()
      materials.dispose()
      scene.remove(group)
    },
  }
}
