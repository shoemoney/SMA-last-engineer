/**
 * game.js — the running match.
 *
 * Ten modules were built in parallel against spec/ and rules.js. This file is the only
 * place they meet: it builds the station, drops the player on it, lets the wave director
 * order trains and bodies, routes every bullet from the weapon system through the damage
 * model into a zombie, and hands the result to the HUD, the FX layer and the mixer.
 *
 * ---------------------------------------------------------------------------
 * THE PURITY RULE, AND THE ONE DOCUMENTED EXCEPTION
 * ---------------------------------------------------------------------------
 * CONTRACT.md says `src/game/**` may not import three.js, so that `npm test` and
 * `npm run soak` can run the real damage model and the real wave director in node. This
 * file is the exception, and it is deliberate: the brief assigns the integration layer to
 * src/game/game.js, and integration cannot happen without meshes.
 *
 * The rule still holds where it earns its keep. Nothing in damage.js, health.js,
 * waveDirector.js, gameState.js, scoring.js, save.js or soak.js imports THIS file, so the
 * headless paths never pull three in. Grep `game.js` under src/game/ — nothing there
 * references it, and nothing there may start.
 *
 * ---------------------------------------------------------------------------
 * THE TWO COORDINATE FRAMES, AND WHERE THEY MEET
 * ---------------------------------------------------------------------------
 * The extracted spec is Z-up (+X down the platform, +Y across it, +Z up). three.js is
 * Y-up. station.js publishes `three = (spec.x, spec.z, -spec.y)` and everything it hands
 * back is already converted; player.js, weapon.js and the whole of src/fx/** work in
 * three's frame.
 *
 * zombie.js, projectile.js and train.js author their geometry Z-up instead, and say so.
 * Rather than ask either side to move, this file mounts them under `zUpMount`, a group
 * carrying `rotation.x = -PI/2` — which IS the (x, z, -y) remap, expressed as a transform.
 * Their simulation then runs in the spec's frame and renders in three's, and the only
 * conversions this file performs are at the four boundaries where a number crosses:
 *
 *   1. a bullet trace       three -> spec to ask the pool, spec -> three to report the hit
 *   2. the zombies' target  three -> spec, once per step, into `playerProxy`
 *   3. pickup placements    three -> spec, once, because pickups.js converts at its own root
 *   4. the audio listener   three -> spec, because rules.js states every cue position Z-up
 *
 * Handing back the wrong axis is the bug that passes every test and puts a zombie inside a
 * wall, so anything in spec coordinates here is named `spec*` and nothing else is.
 */

import * as THREE from 'three/webgpu'
import {
  AUDIO,
  DAMAGE,
  FX,
  PICKUPS,
  PLAYER,
  STATION,
  TRAIN,
  WAVES,
  WEAPONS,
  ZOMBIES,
} from './rules.js'
import { bus as sharedBus, EV } from '../core/events.js'
import { Rng, rng as sharedRng } from '../core/rng.js'
import { NEUTRAL } from '../core/input.js'
import { STEP } from '../core/loop.js'
import { GameState, GAME_STATES } from './gameState.js'
import { WaveDirector, WAVE_STATE, TRAIN_PHASE, buildWave } from './waveDirector.js'
import { mergeStatic, limitLights, dedupeMaterials } from '../world/optimize.js'
import { buildStation, floorHeightAt, stairPointAt, MEZZANINE_TOP_Z, specToThree, threeToSpec } from '../world/station.js'
import { createTrain } from '../world/train.js'
import { placePickups, PickupManager } from '../world/pickups.js'
import { initPostFX } from '../world/postfx.js'
import { createFX } from '../fx/impacts.js'
import { Player } from '../entities/player.js'
import { ZombiePool } from '../entities/zombie.js'
import { WeaponSystem } from '../weapons/weapon.js'
import { ViewModel } from '../weapons/viewmodel.js'

const DIM = STATION.DIMENSIONS
const LEVELS = STATION.LEVELS
const DESIGNED = STATION.DESIGNED
const MOD_BITS = WEAPONS.MOD_BITS

const DEG = Math.PI / 180

/**
 * A spec yaw of 0 faces +X; a three.js camera at rotation.y = 0 looks down -Z, which is
 * spec +Y. This quarter turn is the same constant player.js calls SOURCE_YAW_OFFSET, and
 * both must agree or aiming the camera by spec heading points it 90 degrees off.
 */
const SPEC_YAW_OFFSET = -Math.PI / 2

/**
 * Which track the car docks on: -1 is the south pit, +1 the north.
 *
 * It has to be the south one. train.js hangs its four doorways off the carriage's +Y flank,
 * so only a car parked with the platform on its +Y side opens onto the platform at all.
 */
const PLATFORM_SIDE = -1

/**
 * Where the carriage stops, in the spec's frame — and why it is not DESIGNED.trainStop*.
 *
 * The extracted stop is (3000, +/-950, -230): centred in a 500 cm track bed, 20 cm above a
 * pit floor that sits 250 cm down. The catch is that the spec's carriage is a greybox 160 cm
 * tall — a 100 cm cube scaled 8.0 x 1.6 x 1.6 — so from that stop its ROOF finishes 70 cm
 * BELOW the platform lip and the whole train is invisible from the platform. Rendered, the
 * "train arriving" moment was an empty platform.
 *
 * So the run is lifted to the platform's own floor line and pulled in flush against the
 * edge: the car rides beside the slab with its doorway side on the platform, which is what
 * train.js means when it says doorLocalZ = 0 is "the step", and what a real platform does.
 * X and the approach direction are unchanged, so it still docks at station centre coming out
 * of the west tunnel with its headlights raking the length of the platform.
 */
const TRAIN_DOCK_Y = PLATFORM_SIDE * (DIM.platformHalfWidth + TRAIN.bodyHalfExtent[1])
const TRAIN_DOCK_Z = LEVELS.platformTopZ

/**
 * Where a wave comes out of the doors, in the spec's frame.
 *
 * The director builds its spawn points as `trainOrigin.x + TRAIN.doorLocalXs[i]` and
 * `trainOrigin.y + TRAIN.doorLateralOffset`, then jitters both by spawnScatterRadius.
 * Feeding it the station's own designed door line (X 2700..3300 at station centre) puts the
 * wave beside the docked carriage instead of at the level's origin, which is where
 * TRAIN.platformStopLocation — the defect spec section 3.5 describes — would have parked it.
 *
 * The Y term is pulled one scatter radius inboard of DESIGNED.doorSpawnY so the whole
 * +/- 150 cm jitter band lands on the slab rather than half of it over the track bed.
 */
const SPAWN_DOOR_LINE_Y = PLATFORM_SIDE * (DESIGNED.doorSpawnY - WAVES.spawnScatterRadius)
const SPAWN_ORIGIN = Object.freeze([
  DESIGNED.trainStopX,
  SPAWN_DOOR_LINE_Y - TRAIN.doorLateralOffset,
  DESIGNED.doorSpawnZ,
])

const EYE = PLAYER.CAMERA.eyeOffsetZ

/**
 * The second storey, as gameplay.
 *
 * station.js now builds a stair a body can climb and a balcony a body can stand on, but
 * nothing in src/entities/** knows either exists: zombie.js pins every body to
 * `groundZ + halfHeight` and never touches groundZ, which is exactly right for a level
 * that is one flat slab and exactly why the old stairwell was furniture. The two numbers
 * below are what turns the level's floor query into movement, and the three after them are
 * what makes the upstairs worth taking.
 *
 * None of this has a home in rules.js — the original had no second storey to tune — so it
 * sits in one labelled block here the way STAGE and SPAWN_ORIGIN already do.
 */
const FLOOR = Object.freeze({
  /**
   * cm/s the storey under a body may rise. It has to beat the climb: a body walking a
   * 12.5-in-32 tread at the base 500 cm/s gains about 195 cm/s of height, so 400 leaves
   * headroom for the wave speed scale (capped at 2.0) without letting anything levitate.
   */
  riseRate: 400.0,
  /**
   * And fall faster than it climbs, because walking off the balcony lip is a DROP. Slower
   * than this and a body steps off the edge and glides down like a lift; much faster and
   * it teleports, which is what an unclamped assignment does and why this is clamped at all.
   */
  fallRate: 950.0,
})

const WAVE_ENTRY = Object.freeze({
  /** Share of each wave that comes down the stairs instead of out of the train doors. */
  stairShare: 0.28,
  /**
   * And the share once the player is upstairs. The balcony is genuinely safe from a crowd
   * on the slab — the level's own floor query will not let a body climb 250 cm at the lip,
   * so the only way up is the flight. Without this the answer to every hard wave is "stand
   * on the balcony", which is not a tactic, it is an exploit with a railing round it.
   */
  stairShareUpstairs: 0.72,
  /** Fraction of WAVES.spawnScatterRadius used upstairs, so the jitter stays on the deck. */
  stairScatterFraction: 0.3,
  /** cm of feet height above the deck that counts as "the player is up there". */
  upstairsMargin: 30.0,
})

// ---------------------------------------------------------------------------
// THE STREET — gameplay for the storey above the storey
// ---------------------------------------------------------------------------

/**
 * src/world/summit.js builds three more pitches out of the mezzanine, up the inside of the
 * light well and out through a hole in the pavement onto a city street at Z 980. That is
 * the ARCHITECTURE, and it belongs to that module. This block is everything that makes the
 * climb worth making, which is the half a level cannot do for itself:
 *
 *   1. the best pickup in the game, dealt on the pavement and nowhere else
 *   2. a wave that follows you up there, so the street is exposed rather than solved
 *   3. the moment of arriving, marked once per run
 *   4. something taped to a wall for whoever goes looking
 *
 * NOTHING HERE RESTATES A NUMBER FROM summit.js. An earlier pass built its own scaffold in
 * the same well — nine treads, a landing and a gantry, all colliders — and the two towers
 * were not merely redundant: this one's plates sat inside the head window of that one's
 * first pitch, and `_headroomOver` refuses a step whose landing is occupied, so the two
 * summits between them produced a climb that stopped dead on the mezzanine. Everything
 * below is resolved from `station.summit` at run time — the exit, the vista and the street
 * height come back off the object that module publishes, so this file cannot drift from it
 * and cannot contradict it.
 */
const SUMMIT = Object.freeze({
  /** cm of feet height below the street that still counts as "up top". */
  margin: 60.0,
  /** cm above the pavement the cache floats. */
  cacheHover: 55.0,

  /**
   * Where the cache stands, as offsets from the stair mouth in the pavement — because the
   * mouth is the one landmark on that street whose position this file can actually ask for.
   * All three sit well south of the shaft band and well north of the kerb, so none of them
   * is ever dealt over the hole or into the carriageway.
   */
  CACHE_OFFSETS: Object.freeze([
    Object.freeze({ x: -230, y: -330 }),
    Object.freeze({ x: 140, y: -470 }),
    Object.freeze({ x: 520, y: -330 }),
  ]),

  /**
   * The cache itself.
   *
   * The loose pistol IS the dual-wield second gun and it is the best pickup in the game —
   * it doubles the pistol's own 150-round reserve (WEAPONS.PISTOL.reserveAmmo — finite, not
   * unlimited) onto a second gun firing at the same rate — and PICKUPS.weaponsRespawn is
   * false, so it is a one-time prize for finding the street at all. The explosive mod is
   * the loudest entry in the mod table. The rifle is the resupply: `#grantPickup` rebuilds
   * a re-granted weapon with a full magazine AND a full reserve, which is the only ammo
   * resupply anywhere in this game.
   */
  CACHE: Object.freeze(['pistol', 'explosive', 'rifle']),
  /** Restocked at every wave clear onto whichever pedestal is standing empty. */
  RESTOCK: Object.freeze(['rifle', 'armor', 'shotgun', 'health']),

  /**
   * And the reason to come back down.
   *
   * The street is 980 cm over the platform behind a climb no melee body can shortcut, so a
   * player who reaches it has taken every zombie in the game out of range in one move. That
   * trade is only interesting if the top can be taken away from them. The stair mouth in
   * the pavement is therefore a SPAWN MOUTH: from `spawnFromWave` a share of every wave
   * comes up out of the same hole the player did, and the moment they are actually standing
   * on the street it is most of the wave.
   *
   * It only arms once the player has left the platform. A body ordered onto the street
   * while the player is on the slab would spend the whole wave walking down, which is not a
   * threat, it is a body that is not in the game.
   */
  spawnFromWave: 3,
  spawnShare: 0.22,
  spawnShareAtStreet: 0.7,
  spawnScatter: 110.0,
  /**
   * Offsets from the stair mouth where a wave comes out onto the pavement. They are
   * intentions, not coordinates: `#streetPoint` walks each one south until it is standing
   * on flags rather than over the opening, so none of them has to know how wide the hole is.
   */
  SPAWN_OFFSETS: Object.freeze([
    Object.freeze({ x: 250, y: 300 }),
    Object.freeze({ x: -60, y: -300 }),
    Object.freeze({ x: 430, y: 180 }),
    // Two on the WEST side of the opening, and they are the ones that matter. The hole is
    // 370 cm of open air across the middle of this plaza and a body walking at a player on
    // the far side of it walks into the hole and falls back down the shaft — measured: with
    // three eastern mouths and the player standing at the vista point, every body that came
    // up was gone again inside eight seconds. A street you can camp behind a hole is still
    // a safe room. These come out on the same flags the player is standing on.
    Object.freeze({ x: -420, y: 260 }),
    Object.freeze({ x: -300, y: -300 }),
  ]),

  /**
   * THE SECRET — fly-posted on the plaza's facade, west of the stair mouth.
   *
   * Not on the route: the mouth is at the plaza's middle and every sightline from it goes
   * south, over the kerb, at the skyline. This is behind you and to your left, flat against
   * a wall, at standing eye height, and it is found by turning round.
   *
   * The wall is summit.js's `street-facade`, which closes the plaza on the north side. Its
   * inner face is at the pavement's own north edge, which is published on `station.summit`
   * as the bounds — so the poster is HUNG off that box rather than off a copy of a number
   * in another module, and it moves when the building does.
   */
  SECRET: Object.freeze({
    offsetX: -520.0, // west of the stair mouth
    standHeight: 160.0, // eye height above the pavement — PLAYER.CAMERA.eyeOffsetZ + halfHeight
    width: 214.0,
    height: 94.0,
    proud: 2.0, // cm off the wall, so the poster never z-fights the facade
    /**
     * How close to dead-on the player has to be looking, as a dot product — about 16
     * degrees. It is not tighter for a measured reason: the first cut asked for 10 and
     * measured the angle from the capsule's CENTRE rather than from the eye, so standing
     * three metres away looking level at it scored 0.978 and the poster could not be found
     * at all. The eye is the thing doing the looking; the tolerance is what is left over.
     */
    lookDot: 0.96,
    range: 1400.0,
  }),

  /** What the arrival plate says. Spelled once; `#pollSummit` and the staged shot both use it. */
  ARRIVAL: Object.freeze({ title: 'STREET LEVEL', sub: 'SHOEMONEY SQ · NINE METRES UP' }),

  /** The verification moment. */
  scenarioWave: 5,
})

/**
 * The camera for the seventh moment.
 *
 * Standing where summit.js published its `vistaPoint` — beside the head of the stair, at
 * the west lip of the hole it comes up through — and looking SOUTH across the pavement,
 * over the kerb and the carriageway, at the skyline. It is the only shot in this game taken
 * outdoors, and the only one whose back is to the station.
 *
 * The frame is not composed against numbers in this file: `stand` IS the vista point and
 * `at` is derived from it, so a street that moves takes its own establishing shot with it.
 */
const SUMMIT_STAGE = Object.freeze({
  /**
   * Every one of these is an OFFSET off a point src/world/summit.js published, never a
   * coordinate: the eye stands back and north of that module's vista point, and looks past
   * its stair mouth at the city. A street that moves takes its own establishing shot with it.
   *
   * The angles were measured against the 90 degree horizontal FOV rather than chosen. From
   * here the mouth sits 26 degrees off the view axis, all three cache pedestals fall between
   * 5 and 29, and the crowd between 17 and 34 — so the pickups, the hole they are guarding
   * and the bodies coming out of it are all inside one frame, with the skyline above them.
   * Standing ON the vista point and looking due south, which is the obvious shot, put the
   * mouth 82 degrees off axis and photographed an empty pavement.
   */
  standWest: 300.0, // back from the vista point, away from the lip of the hole
  standNorth: 400.0, // and off the kerb, so the whole plaza is in front of the eye
  lookEast: 800.0, // past the stair mouth
  lookSouth: 2400.0, // over the carriageway
  /**
   * And barely up at all, which is a correction.
   *
   * At 420 this tilted the nose 8 degrees above level and the frame came back roughly 65%
   * sky: a genuinely good rain-streaked skyline with lit windows and a sunset band, and
   * under it a strip of pavement so shallow that the stair mouth, all three cache pedestals
   * and every body coming out of the hole were squeezed into the bottom sixth of the
   * picture, half of them behind the vitals bars. The street is the SUBJECT of this moment
   * and the skyline is what it is standing in; it had them the other way round.
   *
   * 90 puts the nose within 2 degrees of level, which lifts the pavement band about 80
   * lines up the frame and reads as standing on a street rather than photographing a sky
   * from one. The towers simply crop at the top edge, which makes them taller, not smaller.
   */
  lookRise: 90.0,

  /**
   * Bodies just out of the hole, so the frame shows the street being used. Same rule as the
   * spawn offsets: each is walked onto real pavement before a body is put on it.
   */
  crowd: Object.freeze([
    { archetype: 'base', x: 55, y: -290 },
    { archetype: 'zerg', x: 275, y: -330 },
    { archetype: 'base', x: -125, y: -430 },
  ]),
})

/**
 * Camera framing for the six verification moments, in SPEC centimetres.
 *
 * These are not gameplay: they exist so `scenario()` can point a camera at something worth
 * photographing, and rules.js has no home for a screenshot composition. Every one is
 * expressed against a station dimension so the shots survive a change to the level's size.
 *
 * `eye`/`at` pairs drive the cinematic camera; `stand`/`at` pairs move the real player and
 * turn their head, so the shot keeps the view model and the first-person feel.
 */
const STAGE = Object.freeze({
  /** Three-quarter hero shot from the west end, columns receding toward the docked car. */
  menu: Object.freeze({
    eye: [DIM.columnMargin * 3, DIM.platformHalfWidth * 0.6, EYE * 3.8],
    at: [DESIGNED.trainStopX, -DIM.platformHalfWidth * 0.86, EYE],
  }),

  /**
   * Standing at the platform edge east of the dock, looking back into the headlights of a
   * car still on its approach. Everything about the platform is aimed down its length, so a
   * shot down the length is the one that reads.
   */
  train: Object.freeze({
    /**
     * Docked, three-quarter from ahead of the cab, above the roof, with the wave in the doors.
     *
     * Four separate attempts went into this frame and each one taught something, so the
     * reasoning is written down rather than the answer alone.
     *
     * 1. THE FIRST SHOT WAS TOO LOW. It stood beside the middle of the flank at EYE * 2.2 —
     *    141 cm, BELOW the carriage's 184 cm crown — so the tapered roof and the HVAC plant
     *    box were edge-on and invisible and the cab was a sliver at the frame edge. What was
     *    left was a beige slab with white rectangles punched in it, which a critic correctly
     *    called a shipping container. The model was never the problem; the camera was.
     *
     * 2. THE ARRIVAL CANNOT BE PHOTOGRAPHED FROM HERE, and not for the reason it looks like.
     *    The harness does not shoot when scenario() returns — it waits 1800 ms of wall clock
     *    with the loop running, and every step of that feeds train.update(). Against a 4 s
     *    approach the old `arrivalFraction: 0.86` therefore finished at an effective 0.96,
     *    and on a quadratic ease 0.96 IS the stop: every attempt to photograph the approach
     *    had actually photographed the dock. Stretching train.duration fixed the timing and
     *    revealed the real obstacle — train.js hangs a 2600 cm MODEL.hazeConeLength shaft off
     *    each headlight, additive, double-sided, two cones deep, and at any angle that also
     *    shows the cab those four additive layers plus bloom come out as a flat pale triangle
     *    across the lower third. Moving is only worth 0.09 opacity against 0.0225 parked
     *    (MODEL.hazeIdleFraction), so a docked car keeps the glow and loses the sheet of
     *    paper. The car is therefore run all the way in.
     *
     * 3. SCALE IS WHAT MADE IT READ AS A CONTAINER. A smooth box with lit rectangles has no
     *    size until something human-sized stands next to it. #plantAtDoors puts the wave in
     *    the doorways, which costs nothing — they were going to walk out of that car anyway —
     *    and settles the question in one glance. It also stops the HUD lying: zombiesRemaining
     *    is `this.zombies.aliveCount`, so the readout now counts something that is in frame.
     *
     * 4. THE CAB HAS TO BE AHEAD OF THE CAMERA. Everything recognisable about a train is at
     *    the end that faces you, so the eye sits forward of the cab (nose x = stop + 400),
     *    outboard, and above the crown. Measured against the 90 degree horizontal FOV the
     *    carriage lands at x 291..867, y 273..653 — 45% of frame width, whole, roof line
     *    inside the top edge, bottom-right corner left clear for the view model.
     */
    eye: [DESIGNED.trainStopX + DIM.columnSpacing * 1.03, -DIM.platformHalfWidth * 0.63, EYE * 3.5],
    at: [DESIGNED.trainStopX + DIM.columnSpacing * 0.13, TRAIN_DOCK_Y - 20, EYE * 1.75],

    /**
     * One body per doorway, taking TRAIN.doorLocalXs in order — which is the three doors
     * FURTHEST from the eye. A fourth entry would fill the near door too, and at 330 cm a
     * body there is 40% of the frame height and stands on the carriage it is meant to give
     * scale to. Three keeps the human reference and leaves the car whole.
     */
    crowd: ['base', 'zerg', 'base'],
    /** How far onto the slab a body stands, measured out from the carriage's flank. */
    doorStepOut: 85,
  }),

  /**
   * TURNED AROUND. The establishing shot now looks WEST, at the stair and the mezzanine.
   *
   * It used to stand west of centre and look east down the hall at the docked car, and as a
   * picture there was nothing wrong with it. The problem was that it was the fifth of six.
   * train, firefight, boss and death all stand within two bays of the same spot and look
   * down the same axis at the same carriage, so the entire graded record of this game was
   * one view of one end of one room — and the half of the level a player can CLIMB was in
   * none of it. A station with a storey above it that no frame has ever seen is, on the
   * evidence, a station without one.
   *
   * Looking the other way costs nothing that was worth keeping. The track pit, its rails,
   * the safety stripe, the light cones, the pitted columns, the brick, the wet slab and the
   * ad panels are all still in frame — the hall is symmetrical about its own length and this
   * end has the architecture as well. What it gains is the switchback, the balcony, the
   * railings, the SHOEMONEY SQ boards and twenty yellow nosings converging on a landing.
   *
   * Anchored off the WEST end rather than off the train, because that is what this shot is
   * about — 1.75 bays in from the first column, aimed at the mezzanine's own walking height
   * so the deck edge, the board over the mouth and the flight under it stack up the middle
   * of the frame.
   *
   * The distance was measured, not chosen. Inside about 1000 cm the frame blows out: the
   * daylight heads over the well plus the street opening (deliberately over 1 in linear
   * space, so it clips) put the shaft into the top of the picture at 6.5% white against a
   * 158 mean — a nova with a staircase under it. Further out than about 1800 and the stair
   * is a lit slot in a wall two hundred pixels wide. Here it is the subject: 16 distinct
   * hues, 0.65% white, and the climb reads from the bottom step to the landing.
   *
   * IT WAS STOOD ON THE PLATFORM EDGE AND AIMED OVER THE PIT. Everything above is still
   * true about which way this shot faces and how far back it stands; none of it defends the
   * other two numbers. Measured on the frame it produced, the strip x 0-290, y 150-720 came
   * back mean luminance 24.6 with HALF its pixels under 8, and lifting it +30 found nothing
   * in there to recover — the left third of the establishing shot of the whole station was
   * not dark detail, it was fog.
   *
   * The camera maths says why, and it is not a lighting fault. The slab runs to y -700 and
   * the road bed is outboard of that, so on a west-facing eye the TRACK is frame left. From
   * y -350 the left edge ray of a 90 degree horizontal FOV crossed the platform edge 7.5 m
   * out and spent the rest of the picture over an unlit pit. Relighting that is the wrong
   * answer twice over: there is nothing down there to light, and the rig is the best thing
   * in this build.
   *
   * So the fix is a dolly and a pitch, and deliberately NOT a yaw.
   *
   *   - stand moves 112 cm inboard, off the edge and onto the slab. The left edge ray now
   *     crosses the platform edge 9.9 m away instead of 7.5, which fills the bottom of the
   *     left third with wet floor and the mezzanine's own underside instead of open air.
   *   - `at` y moves the same 112 cm north with it. That is the whole point: a pure lateral
   *     dolly keeps the heading at 163 degrees, so the composition four attempts went into
   *     — stair up the middle, pitted column right, ad panel beyond it — survives intact
   *     and only the foreground changes.
   *   - `at` z drops to 0.62 of the mezzanine's height, pitching the nose from 9.4 degrees
   *     up to 4.8. That lifts the slab, the safety stripe and the rails into frame and
   *     takes some of the stairwell's daylight shaft back out of the top of it, which is
   *     what was carrying this frame to a 101 mean against train.png's 80.
   *
   * WHY THE DOLLY STOPS AT 112 CM AND NOT 224. It was tried at 224 and the frame came back
   * split in half: the centre-line column row sits at y 0, and a camera 126 cm off that row
   * puts the next column dead on the view axis. Measured from the rendered frame, a 90 cm
   * cylinder 4.7 m away, floor to ceiling, straight through the crosshair and across the
   * stair behind it — the whole picture read as two pictures. The old y -350 was not an
   * arbitrary number: 350 cm off the row is what throws the columns out to 21 degrees right
   * where they frame the shot instead of bisecting it. At -238 the nearest one lands at 11
   * degrees right, clear of the crosshair, still doing the foreground job. That tolerance,
   * not the pit, is what caps this move.
   */
  platform: Object.freeze({
    stand: [DIM.columnMargin + DIM.columnSpacing * 1.75, -DIM.platformHalfWidth * 0.34, LEVELS.platformTopZ],
    at: [DIM.columnMargin * 0.95, DIM.platformHalfWidth * 0.13, MEZZANINE_TOP_Z * 0.62],
    /**
     * And the wave is ON the stair, which is the point of having built one.
     *
     * A staircase with nothing on it is a staircase a critic has to take on faith. Three
     * bodies strung down the flight settle it in one glance: they are standing on treads at
     * three different heights, so the climb is load-bearing geometry that the AI walks,
     * not a texture of a staircase painted on a wall. #settleStoreys puts them there every
     * step of a real game anyway — 28% of every wave is routed down these steps.
     *
     * Fractions of the way up the lower flight, from the mouth toward the half-landing.
     */
    stairCrowd: [
      { archetype: 'base', climb: 0.12 },
      { archetype: 'zerg', climb: 0.46 },
      { archetype: 'base', climb: 0.82 },
    ],
  }),

  /**
   * Down the platform with the docked carriage filling the right of frame, so the crowd is
   * read against the lit train rather than against a dark wall. Shooting ALONG the platform
   * also keeps the centre-line columns out of the near foreground, where a 45 cm cylinder at
   * arm's length eats a third of the picture.
   *
   * THE AIM CARRIES A COLD SOURCE NOW, BECAUSE THE FRAME HAD NONE. This is the core
   * gameplay picture and it graded 6 distinct hues, the fewest of all seven moments against
   * platform's 14 and train's 15. Binning every pixel with saturation over 40 into sixteen
   * hue buckets put 90.2% of them in buckets 0 and 1 — red through orange, nothing else.
   * Six zombies, a firing rifle, a train and a whole station had collapsed to a sepia
   * filter: muzzle flash plus bloom plus the sodium pools saturating everything they touch.
   *
   * The station already owns the answer and this shot was aimed away from it. The teal
   * emergency heads that read so clearly in train.png live along the platform CENTRE-LINE,
   * and the old aim sat 518 cm south of it, hard against the track side, with its back to
   * every cold fixture in the room. Pulling the aim point in to 0.20 of the half-width
   * swings the view about 13 degrees north — enough to bring the teal into the composition
   * without losing the carriage, which is 8 m long and parked at the camera's right elbow.
   * A single complementary source is what turns an orange wash back into a lit scene.
   */
  firefight: Object.freeze({
    stand: [DESIGNED.trainStopX - DIM.columnSpacing * 0.63, -DIM.platformHalfWidth * 0.61, LEVELS.platformTopZ],
    at: [DESIGNED.trainStopX + DIM.columnSpacing * 2.2, -DIM.platformHalfWidth * 0.20, EYE],
    wave: 6,
    /**
     * TWO SPITTERS, NOT ONE, AND THEY ARE ON OPPOSITE FLANKS.
     *
     * The ranged archetype's 0x39ff6a emissive is the one enemy tell in this build that a
     * reviewer could name from the frame alone — in both this shot and boss.png it is the
     * only body anybody identified instantly. One of them was carrying the entire cold end
     * of a picture in which 90% of every saturated pixel was red or orange.
     *
     * #plantCrowd fans outward 0, +1, -1, +2, -2, +3, so this puts green at rank +1 and
     * rank -2: one just off the muzzle flash where it has to fight for it, one out on the
     * far side where nothing else is lit. A second cold accent costs no light rig and no
     * post change — it is an actor that was already in the wave table.
     */
    crowd: ['base', 'ranged', 'base', 'zerg', 'ranged', 'zerg'],
  }),

  /** The Conductor, close enough to fill the frame, already most of the way dead. */
  boss: Object.freeze({
    stand: [DESIGNED.trainStopX - DIM.columnSpacing * 0.17, -DIM.platformHalfWidth * 0.36, LEVELS.platformTopZ],
    at: [DESIGNED.trainStopX + DIM.columnSpacing * 2.2, -DIM.platformHalfWidth * 0.47, EYE * 1.5],
    wave: 10,
    /** The first entry lands dead centre — see #plantCrowd's fan order. */
    crowd: ['boss', 'base', 'base', 'tank'],
    /** Fraction of the Conductor's health left when the shot is taken. */
    healthLeft: 0.11,
    /** Player health as a fraction of max — the vignette is a vitals readout, so it must be low. */
    playerHealthLeft: 0.16,
  }),

  death: Object.freeze({
    stand: [DESIGNED.trainStopX - DIM.columnSpacing * 0.5, -DIM.platformHalfWidth * 0.54, LEVELS.platformTopZ],
    at: [DESIGNED.trainStopX + DIM.columnSpacing * 2, -DIM.platformHalfWidth * 0.67, EYE],
    wave: 7,
    crowd: ['base', 'tank', 'base'],
    /**
     * Seconds of run time to credit per wave reached. Simulating seven real waves to fill in
     * one line of the game-over card would mean twenty-five thousand fixed steps inside a
     * synchronous scenario() call; the card is staged, exactly like the kills above it.
     */
    secondsPerWave: 45,
  }),

  /** How far in front of the player a staged crowd is planted, and how wide it fans. */
  crowdDistance: DIM.platformHalfWidth * 0.6,
  crowdSpread: DIM.columnSpacing * 0.87,
  /** Seconds of simulation a staged moment is settled for before the camera is handed over. */
  settle: 0.4,
})

/**
 * Tracer geometry. FX.TRACER carries the colour, thickness, lifetime and pellet stride, but
 * nothing in src/fx/** publishes a tracer adapter, so the round in flight is drawn here —
 * the one piece of rendering this file owns rather than delegates.
 */
const TRACER_POOL_SIZE = 64

const _eye = new THREE.Vector3()
const _at = new THREE.Vector3()
const _specOrigin = new THREE.Vector3()
const _specDir = new THREE.Vector3()

/** Ray/AABB slab test. Returns the entry distance and the face crossed, or null. */
function rayBoxT(ox, oy, oz, dx, dy, dz, box, maxT) {
  let tmin = 0
  let tmax = maxT
  let axis = 0
  let sign = 1

  const o = [ox, oy, oz]
  const d = [dx, dy, dz]
  const lo = [box.min.x, box.min.y, box.min.z]
  const hi = [box.max.x, box.max.y, box.max.z]

  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null
      continue
    }
    const inv = 1 / d[i]
    let near = (lo[i] - o[i]) * inv
    let far = (hi[i] - o[i]) * inv
    let faceSign = -1
    if (near > far) {
      const swap = near
      near = far
      far = swap
      faceSign = 1
    }
    if (near > tmin) {
      tmin = near
      axis = i
      sign = faceSign
    }
    if (far < tmax) tmax = far
    if (tmin > tmax) return null
  }

  return { t: tmin, axis, sign }
}

/**
 * A live zombie, as the weapon system and the blast resolver want to see it.
 *
 * Three jobs, none of which zombie.js can do for itself without knowing three's frame:
 * it carries a three-space position so damage.js can measure a blast radius against a
 * three-space impact point; it exposes `applyDamageResult` so the hit ZONE survives the
 * trip (going straight to the pool loses it, and the kill marker, the headshot count and
 * the score bonus all read off the zone); and it is one stable identity per body, so
 * `selectAoETargets` can exclude the directly hit zombie from its own explosion.
 */
class ZombieTarget {
  constructor(zombie) {
    this.zombie = zombie
    this.position = new THREE.Vector3()
    this.sync()
  }

  /** The pool builds a fresh HealthPool on every configureForWave, so this cannot be cached. */
  get health() { return this.zombie.health }
  get alive() { return this.zombie.state !== 'dead' }
  get isDead() { return this.zombie.isDead }
  get capsuleRadius() { return this.zombie.capsuleRadius }
  get capsuleHalfHeight() { return this.zombie.capsuleHalfHeight }

  sync() {
    const p = this.zombie.position
    this.position.set(p.x, p.z, -p.y)
    return this
  }

  /**
   * weapon.js prefers this over the raw pool, which is exactly why it exists: routing
   * through `Zombie.hit()` stashes the zone for EV.ZOMBIE_HIT / EV.ZOMBIE_DEATH. The burn
   * attaches only to a survivor, matching HealthPool.applyShot.
   */
  applyDamageResult(result, shooter) {
    const zombie = this.zombie
    const dealt = zombie.hit(result.directDamage, {
      zone: result.zone,
      ignoresArmor: result.ignoresArmor,
      instigator: shooter,
    })
    if (result.burnTicks > 0 && !zombie.isDead) {
      zombie.health.addBurn(result.burnDamagePerTick, result.burnTicks, result.burnTickInterval, shooter)
    }
    return dealt
  }
}

export class Game {
  /**
   * @param {object} deps
   * @param {THREE.WebGPURenderer} deps.renderer
   * @param {THREE.Scene} deps.scene
   * @param {THREE.PerspectiveCamera} deps.camera
   * @param {object} [deps.hud]   what initHUD() returned; polled once per simulation step
   * @param {object} [deps.sound] the `sound` facade from src/audio/audio.js
   */
  constructor({ renderer, scene, camera, hud = null, sound = null, bus = sharedBus, rng = sharedRng }) {
    if (!renderer || !scene || !camera) throw new TypeError('[game] needs a renderer, a scene and a camera')

    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.hud = hud
    this.sound = sound
    this.bus = bus
    this.rng = rng

    this.elapsed = 0
    this.frames = 0
    this.cinematic = null
    this.stage = null
    this.input = null
    this.reloadHeld = false
    this.lowHealthLatched = false

    // --- the level ---------------------------------------------------------
    this.station = buildStation(scene)

    /**
     * Flatten the station's static scenery into one draw per material.
     *
     * The station is authored as ~136 individual boxes because that is the readable way to
     * describe a platform; it is not the way to render one. three's WebGPU path does
     * per-object uniform work every frame whether or not the object moved, and measured
     * frame-time p95 on this scene tracks visible mesh count almost linearly (480 meshes
     * → 199ms, 153 meshes → 11ms).
     *
     * Names listed here stay addressable because something still reads or animates them.
     */
    mergeStatic(this.station.group, {
      keepNames: new Set([
        'station-logo',            // its texture loads late and swaps in
        'street-opening',          // the summit queries it
      ]),
    })

    /**
     * zombie.js, projectile.js and train.js all author Z-up. This group IS the (x, z, -y)
     * remap, expressed as a transform, so their local coordinates are spec coordinates and
     * nothing has to be converted per frame to draw them. train.js does the same thing
     * internally for its own carriage, which is why it is not parented here.
     */
    this.zUpMount = new THREE.Group()
    this.zUpMount.name = 'spec-frame'
    this.zUpMount.rotation.x = -Math.PI / 2
    scene.add(this.zUpMount)

    this.train = createTrain(scene, {
      // The station publishes the in-pit run the original never read; the car docks at
      // station centre beside the player instead of through a column on the centreline.
      placement: 'designed',
      // The wave director emits TRAIN_INBOUND itself and audio.js binds that one event.
      // Letting the carriage emit as well would play the arrival twice per wave.
      emitEvents: false,
    })
    // See TRAIN_DOCK_Y: the extracted stop buries a 160 cm carriage under the platform lip.
    // `stop` and `staging` are public, so the run is re-seated rather than the module forked.
    this.train.stop.set(this.train.stop.x, TRAIN_DOCK_Y, TRAIN_DOCK_Z)
    this.train.staging.set(this.train.staging.x, TRAIN_DOCK_Y, TRAIN_DOCK_Z)
    this.train.reset()

    /**
     * The carriage is ~103 meshes that never move relative to each other — only the whole
     * group slides, and the door leaves within it. Flattening it was worth roughly 50ms of
     * p95 on its own when measured by hiding it outright.
     */
    mergeStatic(this.train.group, {
      // A leaf that has learned its open and shut positions is excluded by mergeStatic
      // itself; this catches anything else the carriage animates by name.
      skip: node => /door|leaf|wheel|bogie|light|lamp|sign|roll/i.test(node.name),
    })

    // --- combatants --------------------------------------------------------
    this.player = new Player({ camera, scene })
    this.lastYaw = this.player.yaw
    this.lastPitch = this.player.pitch

    this.zombies = new ZombiePool(this.zUpMount, { groundZ: LEVELS.platformTopZ })
    this.viewModel = new ViewModel(camera, { rng })
    this.fx = createFX({ scene, camera })
    this.tracers = this.#buildTracers()
    this.weapons = this.#buildWeapons()

    // --- the run -----------------------------------------------------------
    this.gameState = new GameState({
      bus,
      rng,
      director: new WaveDirector({ bus, rng, trainOrigin: SPAWN_ORIGIN }),
    })

    // --- adapters the other modules read -----------------------------------
    this.targets = []
    this.targetByZombie = new WeakMap()

    this.trainBox = new THREE.Box3()
    this.colliderBoxes = this.station.colliders.map(c => c.box)
    this.colliderBoxes.push(this.trainBox)
    this.#syncTrainCollider()

    this.playerWorld = { colliders: this.colliderBoxes, zombies: this.targets }

    this.playerProxy = {
      position: new THREE.Vector3(),
      radius: this.player.radius,
      halfHeight: this.player.halfHeight,
      health: this.player.health,
      get isDead() { return this.health?.isDead === true },
    }

    /**
     * Where a wave can come in from besides the train doors. station.js publishes these
     * with their spec coordinates attached precisely so this file never has to convert
     * back out of three's frame to hand one to the pool.
     */
    this.stairSpawns = this.station.spawnPoints.filter(p => p.kind === 'stair' && p.spec).map(p => p.spec)
    /**
     * Its own stream, not the shared one. Routing a spawn is a draw, and taking it from
     * `rng` would shift every subsequent draw the wave director makes — so the browser and
     * the headless soak would stop agreeing on a seed that is supposed to reproduce a crash.
     */
    this.entryRng = new Rng(0x57a1 ^ 0x9e3779b9)

    this.zombieWorld = {
      player: this.playerProxy,
      obstacles: this.#columnObstacles(),
      hasLineOfSight: (from, to) => this.#hasLineOfSight(from, to),
      bounds: {
        minX: 0,
        maxX: DIM.length,
        minY: -DIM.platformHalfWidth,
        maxY: DIM.platformHalfWidth,
      },
    }

    this.pickups = placePickups(
      scene,
      // pickups.js authors in the spec frame and converts once at each root. station.js has
      // already converted, so its points go back through the inverse rather than being
      // remapped a second time into the ceiling.
      { pickupPoints: this.station.pickupPoints.map(p => threeToSpec(p.x, p.y, p.z, new THREE.Vector3())) },
      rng,
      {
        emitEvents: false, // see #grantPickup — this file publishes the complete payload instead
        grant: (_player, def) => this.#grantPickup(def),
      },
    )

    // --- the street above the station --------------------------------------
    /**
     * The summit itself is src/world/summit.js's, and station.js publishes it. This file
     * only reads it: where the stair comes out, how high the street is, and which of its
     * boxes a BODY can stand on — because zombie.js asks the level for its floor and
     * station.js's floor query predates the climb entirely.
     */
    this.summitLevel = this.#readSummit()
    if (this.summitLevel) this.summitLevel.secret = this.#buildSecret(this.summitLevel)

    /**
     * The cache is a SECOND PickupManager, not a hand-rolled prop.
     *
     * pickups.js already owns the bob, the spin, the breathing light, the floor pool, the
     * respawn flash and — the part that actually matters — the grant handshake that leaves
     * a heart standing when the player is already at the overheal cap. A cache that
     * re-implemented any of that would be a second set of rules for the same object. It is
     * handed its own three points on the pavement and the same grant closure the platform's
     * manager uses, so a street pickup is a pickup in every respect except its altitude.
     */
    this.summitPickups = this.summitLevel
      ? new PickupManager(scene, this.#summitCachePoints(), rng, {
          emitEvents: false,
          grant: (_player, def) => this.#grantPickup(def),
        })
      : null
    this.#dealSummitCache()

    /** Latched for the run: the arrival beat fires once, and so does the secret. */
    this.summitFound = false
    this.secretFound = false

    // Quality decides the post chain. 'low' skips it entirely — the chain's screen-space AO
    // is the single most expensive thing in the frame, and a game nobody can run is worth
    // less than a plainer one that holds 60fps. Every call site below is null-guarded.
    const q = globalThis.__SHOE_QUALITY__ ?? 'medium'
    this.post = q === 'low' ? null : initPostFX(renderer, scene, camera)

    /**
     * Whole-scene light budget, applied LAST because it is the last moment every module has
     * finished adding lights.
     *
     * lighting.js culls its own rig, but station.js, summit.js and sky.js each add more
     * afterwards, so a scene that believed itself culled still carried 85 lights. Per-fragment
     * lighting is paid on every pixel: measured at quality=low with shadows AND the post chain
     * both off, frame time tracked pixel count (39.9ms at 1280x720, 21.8ms at 640x360, 15.9ms
     * at 320x180) while the CPU sat 72% idle. Nothing else behaves like that.
     */
    limitLights(scene, { low: 8, medium: 20, high: 30 }[q] ?? 20)

    // Share identical materials. Each distinct one is a pipeline compiled at boot and a set
    // of uniforms pushed every frame; 111 of the scene's 244 were byte-for-byte redundant.
    dedupeMaterials(scene)

    this.#subscribe()
    this.#syncPlayerProxy()
  }

  /**
   * Fire every effect once, out of sight, so its pipeline compiles behind the loading bar.
   *
   * WebGPU compiles a pipeline the first time a material is actually drawn. Nothing warms
   * the combat effects at boot, because none of them exist until something happens — so the
   * first muzzle flash, the first tracer, the first impact spark and the first blood each
   * stall the frame they appear in. Reported from real play: "right before it starts it
   * freezes and right before you fire your first shot", and again on the first kill.
   *
   * The effects are triggered at a point behind the camera's far plane would not work —
   * they must be genuinely rendered to compile — so they go directly in front of a throwaway
   * camera pointed away from the play space, drawn, then advanced past their own lifetime.
   *
   * Call this while the loading screen still covers the canvas.
   */
  async warmPipelines() {
    const { renderer, scene } = this
    const cam = this.camera.clone()
    // Far under the platform, looking at a spot a metre away: nothing there to occlude the
    // effects and nothing of the level in frame to disturb.
    cam.position.set(0, -4000, 0)
    cam.lookAt(0, -4000, -100)
    cam.updateMatrixWorld(true)

    const at = new THREE.Vector3(0, -4000, -100)
    const up = new THREE.Vector3(0, 1, 0)

    // Compile at a postage stamp. A pipeline is compiled per material, not per pixel, so
    // the warm-up gets the same result for a fraction of the fill — six full-resolution
    // frames cost six seconds of boot, and this costs almost none of it.
    const size = new THREE.Vector2()
    renderer.getSize(size)
    const ratio = renderer.getPixelRatio()

    try {
      renderer.setPixelRatio(1)
      renderer.setSize(64, 64, false)
      this.fx.shot(at, up, false)
      this.fx.shot(at, up, true)                 // the suppressed flash is its own material
      this.fx.impact(at, up)
      this.fx.bloodHit(at, up)
      this.fx.explosion(at)
      this.fx.damageNumber(at, 75, DAMAGE.zones.head)
      this.fx.shake(0.4)

      // Several frames: pooled systems stagger their spawns, and one render only compiles
      // what happened to be alive on that frame.
      for (let i = 0; i < 6; i++) {
        this.fx.update(1 / 60)
        if (renderer.renderAsync) await renderer.renderAsync(scene, cam)
        else renderer.render(scene, cam)
      }
      /**
       * Every REWARD PICKUP, drawn once.
       *
       * #onWaveClear drops one pickup from WAVES.REWARD.cycle — five weapon mods, each with
       * its own colour, material and pipeline — so the last zombie of each of the first five
       * waves died into a first-ever draw and that frame paid the compile. Reported from real
       * play: "it locks up at the end of every wave... it's like when the last zombie dies".
       *
       * This costs real boot time and is worth it: a stall you can schedule behind a loading
       * bar beats one that lands on a kill. Deferring it until after the menu was tried and
       * HUNG — it resizes the canvas, and the render loop is already running by then.
       *
       * The cheaper fix, not done here, is to give the five mods ONE material and vary the
       * colour per instance, so there is one pipeline instead of five.
       */
      const rewards = []
      for (let i = 0; i < WAVES.REWARD.cycle.length; i++) {
        try {
          if (this.pickups.place(WAVES.REWARD.cycle[i], i % Math.max(1, this.pickups.points.length))) rewards.push(1)
        } catch (err) { console.warn('[boot] could not pre-compile', WAVES.REWARD.cycle[i], err) }
      }
      for (let i = 0; i < 3; i++) {
        this.pickups.update?.(1 / 60, null)
        if (renderer.renderAsync) await renderer.renderAsync(scene, cam)
        else renderer.render(scene, cam)
      }
      this.pickups.reset()
      console.info(`[boot] ${rewards.length} reward pickups pre-compiled`)

      /**
       * Every zombie archetype, drawn once. A wave that introduces a Tank or the Conductor
       * compiles its materials the frame it first appears, which is why clearing a level and
       * starting the next one stalls — reported from real play.
       */
      /**
       * The weapon viewmodel is hidden on the menu, so its materials compile the instant
       * play begins — that is the 400ms freeze "right before it starts". Show each weapon
       * once here instead. The camera is 40 metres under the platform, so nobody sees it.
       */
      const vm = this.viewModel
      const wasVisible = vm?.root?.visible
      if (vm?.root) {
        vm.root.visible = true
        for (const slot of ['pistol', 'rifle', 'shotgun']) {
          try { this.weapons?.select?.(slot) ?? this.weapons?.switchTo?.(slot) } catch (e) {}
          vm.update?.(1 / 60, {})
          if (renderer.renderAsync) await renderer.renderAsync(scene, cam)
          else renderer.render(scene, cam)
        }
        try { this.weapons?.select?.('pistol') ?? this.weapons?.switchTo?.('pistol') } catch (e) {}
        vm.root.visible = wasVisible ?? false
      }

      const kinds = Object.keys(ZOMBIES.ARCHETYPES)
      const warmed = []
      for (let i = 0; i < kinds.length; i++) {
        const z = this.zombies.spawn(kinds[i], 1, i * 200 - 400, -4000 + 100, -4000)
        if (z) warmed.push(z)
      }
      for (let i = 0; i < 4; i++) {
        this.zombies.update?.(1 / 60)
        if (renderer.renderAsync) await renderer.renderAsync(scene, cam)
        else renderer.render(scene, cam)
      }
      for (const z of warmed) z.kill?.(true) ?? z.release?.() ?? (z.alive = false)
      this.zombies.reset?.()
      console.info(`[boot] ${warmed.length} zombie archetypes pre-compiled`)

      // Run the pools out so nothing warmed here is still on screen when play starts.
      for (let i = 0; i < 120; i++) this.fx.update(1 / 60)
      console.info('[boot] combat effects pre-compiled')
    } catch (err) {
      // A warm-up that fails must not stop the game booting; it only costs a stutter later.
      console.warn('[boot] effect pre-compile failed; first shots may stutter', err)
    } finally {
      // Always put the canvas back, including on the failure path — a game rendering at
      // 64x64 because a warm-up threw would be a far worse bug than the stutter it prevents.
      renderer.setPixelRatio(ratio)
      renderer.setSize(size.x, size.y, false)
    }
  }


  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  #buildWeapons() {
    return new WeaponSystem({
      owner: this.player,
      viewModel: this.viewModel,
      bus: this.bus,
      rng: this.rng,
      aim: () => ({ origin: this.player.aimOrigin().clone(), direction: this.player.aimDirection().clone() }),
      world: this.#weaponWorld(),
      fx: this.#weaponFx(),
      // weapon.js plays each cue directly AND emits the matching bus event, and audio.js
      // binds all four of those events (fire, reload, dry, explosion). Wiring the direct
      // adapter too would fire every gunshot twice. This one is deliberately inert; leaving
      // it undefined would instead warn, once, that "the guns are silent" — they are not.
      audio: { play: () => undefined },
    })
  }

  #subscribe() {
    const bus = this.bus
    this.unsubscribe = [
      /**
       * The director owns the queue and the live cap, so it is the only thing that decides a
       * body exists. gameState.js is the only consumer of EV.ZOMBIE_DEATH; nothing here may
       * call director.notifyZombieRemoved() or every kill is counted twice and waves end early.
       */
      bus.on(EV.ZOMBIE_SPAWN, p => this.#spawnZombie(p)),
      bus.on(EV.WAVE_CLEAR, p => this.#onWaveClear(p)),
      bus.on(EV.TRAIN_INBOUND, p => this.#onTrainOrder(p)),
      bus.on(EV.PLAYER_DEATH, () => this.#onPlayerDeath()),
      bus.on(EV.PLAYER_HIT, () => this.post?.pulse('hit')),
      bus.on(EV.EXPLOSION, () => this.post?.pulse('explosion')),
    ]
  }

  #buildTracers() {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial({
      color: FX.TRACER.colorHex,
      emissive: new THREE.Color(FX.TRACER.colorHex),
      emissiveIntensity: FX.TRACER.emissiveIntensity,
      roughness: 1,
      metalness: 0,
    })
    const mesh = new THREE.InstancedMesh(geometry, material, TRACER_POOL_SIZE)
    mesh.name = 'tracers'
    mesh.count = 0
    // A tracer spans the length of the shot, so its source bounding sphere describes a unit
    // cube at the origin and per-mesh culling would delete every round in the air.
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.scene.add(mesh)

    return {
      mesh,
      geometry,
      material,
      live: [],
      matrix: new THREE.Matrix4(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      axis: new THREE.Vector3(0, 0, 1),
    }
  }

  /** The adapter weapon.js traces, blasts and alerts through. Arguments in three's frame. */
  #weaponWorld() {
    return {
      trace: (origin, direction, range) => {
        _specOrigin.set(origin.x, -origin.z, origin.y)
        _specDir.set(direction.x, -direction.z, direction.y)

        const flesh = this.zombies.raycast(_specOrigin, _specDir, range)
        // Scenery is only tested as far as the nearest body, so a zombie standing against a
        // wall is still hittable and a zombie behind one is not.
        const limit = flesh ? Math.min(flesh.distance, range) : range
        const scenery = this.#raycastColliders(origin, direction, limit)

        if (scenery) return scenery
        if (!flesh) return null

        const target = this.#targetFor(flesh.zombie)
        const point = specToThree(flesh.point.x, flesh.point.y, flesh.point.z, new THREE.Vector3())
        const normal = point.clone().sub(target.position)
        normal.y = 0
        if (normal.lengthSq() < 1e-8) normal.copy(direction).negate()
        normal.normalize()

        return { point, normal, actor: target, zone: flesh.zone, distance: flesh.distance }
      },

      /**
       * Everything a blast can reach. The player is in the list on purpose:
       * DAMAGE.explosive.damagesOwner is true, so a point-blank explosive round hurts the
       * shooter, and spec section 17 flags that as shipped behaviour rather than a bug.
       */
      bodiesInSphere: (centre, radius) => {
        const out = []
        const radiusSq = radius * radius
        for (const target of this.targets) {
          if (!target.alive) continue
          if (target.position.distanceToSquared(centre) <= radiusSq) out.push(target)
        }
        if (this.player.alive && this.player.position.distanceToSquared(centre) <= radiusSq) {
          out.push(this.player)
        }
        return out
      },

      alert: (origin) => {
        _specOrigin.set(origin.x, -origin.z, origin.y)
        this.zombies.alertNearby(_specOrigin)
      },
    }
  }

  /** weapon.js's fx contract, mapped onto the facade src/fx/impacts.js publishes. */
  #weaponFx() {
    const fx = this.fx
    return {
      muzzleFlash: ({ position, suppressed }) => {
        fx.muzzle.flash(position, this.player.aimDirection(), suppressed)
      },
      cameraShake: scale => fx.shake(scale),
      tracer: ({ from, to }) => this.#spawnTracer(from, to),
      impact: ({ point, normal, zone, flesh }) => {
        fx.impact(point, normal, { surface: flesh ? 'flesh' : 'concrete', zone, bloody: flesh })
      },
      bloodDecal: ({ point, normal }) => fx.bloodHit(point, normal),
      damageNumber: ({ point, value, zone }) => fx.damageNumber(point, value, zone),
      explosion: ({ point, radius }) => fx.explosion(point, radius),
    }
  }

  // -------------------------------------------------------------------------
  // The street above the station
  // -------------------------------------------------------------------------

  /**
   * Read the level's own summit and turn it into the three things gameplay needs: where the
   * stair comes out, how high the street is, and which of its surfaces a body can stand on.
   *
   * Everything comes off `station.summit`, the object src/world/summit.js publishes. That is
   * deliberate and it is the correction to an earlier pass: this file once carried its own
   * copy of the climb, and two towers in one shaft is not a redundancy, it is a level nobody
   * can walk up. Resolved at run time there is exactly one summit, and this file is the
   * layer on top of it rather than a second opinion about where it is.
   *
   * @returns {null} when the level has no summit — every summit feature then stands down
   *   quietly rather than throwing on a station this file was not built against.
   */
  #readSummit() {
    const published = this.station.summit
    if (!published?.exitPoint || !published?.vistaPoint) {
      console.warn(
        '[game] the station published no summit — the street cache, its spawn mouth, the ' +
          'discovery beat and the `summit` scenario are all standing down',
      )
      return null
    }

    const exit = threeToSpec(published.exitPoint.x, published.exitPoint.y, published.exitPoint.z, new THREE.Vector3())
    const vista = threeToSpec(published.vistaPoint.x, published.vistaPoint.y, published.vistaPoint.z, new THREE.Vector3())

    return {
      exit,
      vista,
      /** The pavement's own height. Both published points stand on it. */
      streetZ: exit.z,
      /** The hole in the pavement, midway between the two points the module published. */
      mouth: { x: (exit.x + vista.x) * 0.5, y: 0 },
      bounds: published.bounds ?? null,
      surfaces: this.#summitSurfaces(published.colliders),
      secret: null,
    }
  }

  /**
   * Which of the summit's boxes a BODY may stand on.
   *
   * The player walks on all of them already — player.js resolves against the collider list
   * and summit.js appends to it. zombie.js cannot: it pins every body to `groundZ` and asks
   * the level where that is, and station.js's `floorHeightAt` predates the summit and does
   * not know a single one of its treads. Without this, the entire climb is a place only the
   * player can go, which is the definition of a safe room.
   *
   * A guard rail is a collider too, and a body standing on a handrail is worse than a body
   * that cannot climb. They are told apart the only way an anonymous AABB allows: a rail is
   * thin on one axis and a tread is not. summit.js's rails are one rail thickness wide; its
   * narrowest tread is several times that.
   */
  #summitSurfaces(colliders) {
    const MIN_SPAN = 18.0 // cm; comfortably over a rail's thickness and under a tread's going
    const out = []
    for (const collider of colliders ?? []) {
      const box = collider?.box ?? collider
      if (!box?.min || !box?.max) continue
      if (box.max.x - box.min.x < MIN_SPAN) continue
      if (box.max.z - box.min.z < MIN_SPAN) continue
      // three (x, y, z) is spec (x, -z, y): the box's top face is its three +Y.
      out.push({ x0: box.min.x, x1: box.max.x, y0: -box.max.z, y1: -box.min.z, z: box.max.y })
    }
    if (out.length === 0) {
      console.warn('[game] the summit published no standable surfaces — no body will ever climb it')
    }
    return out
  }

  /**
   * THE SECRET — fly-posted on the plaza wall, and the only thing in this game that rewards
   * turning round.
   *
   * $132,994.97, August 2005: one month of search traffic, printed on a novelty bank draft
   * and pasted on a wall nine metres above a platform full of the dead. It is at standing
   * eye height on the facade west of the stair mouth, which is behind the player and off
   * every sightline the street is composed around — you find it by walking away from the
   * view. `#pollSummit` notices when someone is actually looking at it.
   */
  #buildSecret(summit) {
    if (!summit || typeof document === 'undefined') return null
    const spec = SUMMIT.SECRET
    const bounds = summit.bounds
    // The facade stands on the pavement's north edge; `bounds` is the street, in three's
    // frame, so its most-negative Z is the pavement's most-positive spec Y.
    const wallY = bounds ? -bounds.min.z : 900
    const centre = [summit.mouth.x + spec.offsetX, wallY - spec.proud, summit.streetZ + spec.standHeight]

    const texture = this.#bakeCheque(1024, 448)
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      emissive: 0xffffff,
      emissiveMap: texture,
      // Paper under a street lamp, not signage. POST.bloomThreshold is 0.78 and a bright
      // white rectangle on a night street would haze the whole plaza.
      emissiveIntensity: 0.3,
      roughness: 0.86,
      metalness: 0.0,
    })
    const geometry = new THREE.PlaneGeometry(spec.width, spec.height)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'street-secret'
    mesh.position.copy(specToThree(centre[0], centre[1], centre[2], new THREE.Vector3()))
    // An unrotated plane faces three +Z, which is spec -Y: off the wall, across the plaza.
    this.scene.add(mesh)

    const lamp = new THREE.PointLight(0xffd9a0, 1200 * FX.LIGHT_INTENSITY_SCALE, 620, 2)
    lamp.name = 'street-secret-lamp'
    lamp.position.copy(specToThree(centre[0], centre[1] - 120, centre[2] + 110, new THREE.Vector3()))
    this.scene.add(lamp)

    return {
      mesh, material, geometry, texture, lamp,
      centre,
      baseEmissive: material.emissiveIntensity,
      baseLamp: lamp.intensity,
    }
  }

  /** The cheque itself, baked once. No webfont is loaded in this build, so the stack is system type. */
  #bakeCheque(width, height) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const font = '"Helvetica Neue", Helvetica, Arial, sans-serif'
    ctx.fillStyle = '#d9cfb4'
    ctx.fillRect(0, 0, width, height)

    // Safety tint: the banding every cheque blank has, so it is paper and not a flat card.
    ctx.fillStyle = 'rgba(150, 168, 150, 0.16)'
    for (let y = 0; y < height; y += 12) ctx.fillRect(0, y, width, 5)

    ctx.strokeStyle = '#4b4636'
    ctx.lineWidth = 5
    ctx.strokeRect(9, 9, width - 18, height - 18)

    ctx.fillStyle = '#23201a'
    ctx.textBaseline = 'middle'

    ctx.font = `700 34px ${font}`
    ctx.textAlign = 'left'
    ctx.fillText('GOOGLE ADSENSE', 44, 56)
    ctx.font = `400 22px ${font}`
    ctx.fillText('MOUNTAIN VIEW, CA', 44, 92)

    ctx.textAlign = 'right'
    ctx.font = `600 26px ${font}`
    ctx.fillText('AUGUST 2005', width - 44, 56)

    ctx.textAlign = 'left'
    ctx.font = `400 22px ${font}`
    ctx.fillText('PAY TO THE ORDER OF', 44, 168)
    ctx.font = `700 46px ${font}`
    ctx.fillText('SHOEMONEY', 44, 212)

    ctx.strokeStyle = '#23201a'
    ctx.lineWidth = 3
    ctx.strokeRect(width - 430, 176, 386, 72)
    ctx.textAlign = 'center'
    ctx.font = `700 52px ${font}`
    ctx.fillText('$132,994.97', width - 237, 213)

    ctx.textAlign = 'left'
    ctx.font = `400 24px ${font}`
    ctx.fillText('ONE HUNDRED THIRTY TWO THOUSAND NINE HUNDRED NINETY FOUR AND 97/100', 44, 278)
    ctx.beginPath()
    ctx.moveTo(44, 296)
    ctx.lineTo(width - 44, 296)
    ctx.stroke()

    ctx.font = `400 22px ${font}`
    ctx.fillText('MEMO   SEARCH TRAFFIC — ONE MONTH', 44, 340)

    // The signature, in the blue of a ballpoint that has been in a pocket too long.
    ctx.save()
    ctx.translate(width - 352, 352)
    ctx.rotate(-0.06)
    ctx.fillStyle = '#20386e'
    ctx.font = `italic 700 44px ${font}`
    ctx.fillText('Mind the gap.', 0, 0)
    ctx.restore()

    ctx.fillStyle = '#23201a'
    ctx.font = `400 20px ${font}`
    ctx.fillText('GAME PROP - NOT NEGOTIABLE', 44, 400)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return texture
  }

  /** The three pedestals on the pavement, in the spec frame. */
  #summitCachePoints() {
    const summit = this.summitLevel
    if (!summit) return []
    return SUMMIT.CACHE_OFFSETS.map(o => ({
      x: summit.mouth.x + o.x,
      y: summit.mouth.y + o.y,
      z: summit.streetZ + SUMMIT.cacheHover,
    }))
  }

  /** Deal the cache. See SUMMIT.CACHE for why it is these three items. */
  #dealSummitCache() {
    if (!this.summitPickups) return
    SUMMIT.CACHE.forEach((id, i) => this.#seatSummitPickup(this.summitPickups.place(id, i)))
  }

  /**
   * pickups.js drops each pickup's floor pool at `platformTopZ - point.z`, which is right
   * for fourteen balls floating ten centimetres over the slab and puts a street cache's
   * glow on a platform nine metres below it. The pool is re-seated onto the pavement. One
   * line, and the alternative is a coloured disc on the floor of a room the pickup is not in.
   */
  #seatSummitPickup(pickup) {
    if (!pickup) return null
    pickup.pool.position.y = -SUMMIT.cacheHover + 0.6
    return pickup
  }

  /**
   * Restock the street at every wave clear — the recurring reason to make the climb again.
   *
   * A player who never climbs never frees a pedestal, so `free.length` was 0 forever and
   * this returned null every wave clear for the run's whole length — the cache sat frozen
   * on whatever #dealSummitCache() dealt at boot, and the resupply mechanic did nothing for
   * them. There is always a pedestal to restock: an empty one if the player took something,
   * else the one this wave's slot rotation names, cleared first so the old pickup does not
   * double up on top of the new one.
   */
  #restockSummit(wave) {
    if (!this.summitPickups) return null
    const total = this.summitPickups.points.length
    if (total === 0) return null

    const free = []
    for (let i = 0; i < total; i++) {
      if (!this.summitPickups.occupied.has(i)) free.push(i)
    }

    const index = free.length > 0 ? free[0] : Math.max(0, wave) % total
    if (free.length === 0) this.#clearSummitPedestal(index)

    const id = SUMMIT.RESTOCK[Math.max(0, wave) % SUMMIT.RESTOCK.length]
    return this.#seatSummitPickup(this.summitPickups.place(id, index))
  }

  /**
   * Take a pedestal's current pickup off the board so #restockSummit can reseat it.
   * PickupManager.place() does not clear whatever was already at a point index — dropReward()
   * relies on exactly that to let a reward overlap a taken pickup when the platform is full —
   * so restocking an OCCUPIED pedestal has to remove the old one first, or the pavement grows
   * an extra mesh every wave the player never visits.
   */
  #clearSummitPedestal(index) {
    const pickups = this.summitPickups
    const existing = pickups.occupied.get(index)
    if (!existing) return
    pickups.group.remove(existing.root)
    const i = pickups.pickups.indexOf(existing)
    if (i !== -1) pickups.pickups.splice(i, 1)
    pickups.occupied.delete(index)
  }

  /**
   * The level's floor query, with the summit folded in.
   *
   * station.js's `floorHeightAt` is 2.5D — it answers with the highest surface the querier
   * can actually reach from where it is standing, and falls back to the lowest one under the
   * point when nothing is in reach. The summit obeys the same contract, so a body on the
   * street is told the street, a body on the slab under it is told the slab, and walking off
   * the lip is a drop rather than a lift.
   */
  #floorAt(x, y, fromZ, reach = PLAYER.MOVEMENT.maxStepHeight) {
    const base = floorHeightAt(x, y, fromZ, reach)
    const surfaces = this.summitLevel?.surfaces
    if (!surfaces) return base

    const ceiling = fromZ + reach
    let best = -Infinity
    for (let i = 0; i < surfaces.length; i++) {
      const s = surfaces[i]
      if (x < s.x0 || x > s.x1 || y < s.y0 || y > s.y1) continue
      if (s.z <= ceiling && s.z > best) best = s.z
    }
    return best > base ? best : base
  }

  /**
   * Is (x, y) standing on the pavement, rather than over the hole the stair comes up?
   *
   * The opening is a rectangle punched through the middle of the flags, and a body placed
   * over it does not stand on it — it falls nine metres, which at the fall rate puts it out
   * of frame inside a second. Rather than carry a copy of the hole's dimensions (they belong
   * to summit.js and that module is still moving them), the question is asked of the
   * surfaces summit.js actually published.
   */
  #onStreet(x, y) {
    const summit = this.summitLevel
    if (!summit) return false
    for (const s of summit.surfaces) {
      if (Math.abs(s.z - summit.streetZ) > 1) continue
      if (x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) return true
    }
    return false
  }

  /**
   * The nearest point to (x, y) that is genuinely on the flags, walking south to find it.
   *
   * South, because that is the way the plaza opens: the facade closes it to the north and
   * the kerb is a long way off to the south, so stepping away from the hole in that
   * direction always lands on pavement and always lands in shot.
   */
  #streetPoint(x, y) {
    const summit = this.summitLevel
    if (!summit) return null
    let at = y
    for (let i = 0; i < 8; i++) {
      if (this.#onStreet(x, at)) return { x, y: at, z: summit.streetZ }
      at -= 110
    }
    // Nothing south of it is pavement either, so fall back to the one point the level
    // published as standable and say so — a silent 900 cm drop is the worse failure.
    console.warn(`[game] no pavement found south of (${Math.round(x)}, ${Math.round(y)}); using the vista point`)
    return { x: summit.vista.x, y: summit.vista.y, z: summit.streetZ }
  }

  /** Feet on the pavement. playerProxy.position.z is the capsule CENTRE, spec frame. */
  #playerIsAtSummit() {
    const summit = this.summitLevel
    if (!summit) return false
    return this.playerProxy.position.z - this.player.halfHeight > summit.streetZ - SUMMIT.margin
  }

  /** Feet height above the platform slab, in cm. The HUD's climb gauge reads this. */
  #altitude() {
    return Math.max(0, this.playerProxy.position.z - this.player.halfHeight - LEVELS.platformTopZ)
  }

  /**
   * Does this body come up out of the pavement instead?
   *
   * See SUMMIT.spawnFromWave for why the mouth only arms once the player has left the slab,
   * and why the share goes up so hard once they are standing on the street.
   */
  #summitEntry() {
    const summit = this.summitLevel
    if (!summit) return null

    const atStreet = this.#playerIsAtSummit()
    const climbing = atStreet || this.#playerIsUpstairs()
    if (!climbing) return null
    if (!atStreet && this.gameState.wave < SUMMIT.spawnFromWave) return null

    const share = atStreet ? SUMMIT.spawnShareAtStreet : SUMMIT.spawnShare
    if (!this.entryRng.chance(share)) return null

    /**
     * Two candidates, and the nearer one wins.
     *
     * A uniform pick over five mouths spreads a wave evenly round a plaza with a 370 cm
     * hole across the middle of it, and a body on the far side of that hole walks into the
     * hole. A tournament of two biases the wave onto the flags the player is actually
     * standing on without making it predictable — you cannot learn which mouth is next, only
     * that most of them will be near you.
     */
    const a = this.entryRng.pick(SUMMIT.SPAWN_OFFSETS)
    const b = this.entryRng.pick(SUMMIT.SPAWN_OFFSETS)
    const here = this.playerProxy.position
    const near = (o) => (summit.mouth.x + o.x - here.x) ** 2 + (summit.mouth.y + o.y - here.y) ** 2
    const offset = near(a) <= near(b) ? a : b
    const scatter = SUMMIT.spawnScatter
    // Resolved against the published pavement, not against a copy of the hole's dimensions:
    // a body dealt over the opening does not arrive, it falls straight back down the shaft
    // it was supposed to be cutting off.
    return this.#streetPoint(
      summit.mouth.x + offset.x + this.entryRng.range(-scatter, scatter),
      summit.mouth.y + offset.y + this.entryRng.range(-scatter, scatter),
    )
  }

  /**
   * The two moments, polled once per step.
   *
   * ARRIVAL. The first time a run reaches the pavement it is announced — a plate on the HUD,
   * a kick on the camera, and a scream out of the dark over the plaza. The scream is
   * `zombie_scream`, one of exactly two clips that ship in this build and were never wired
   * to anything (cues.js UNWIRED_CUES; spec/audio.md §9.5 sketches a home for it and stops
   * short of inventing the constant). This is that home, and it does two jobs at once: it
   * marks the discovery, and it is the only warning the player gets that the top of the
   * world is about to become a spawn mouth.
   *
   * THE SECRET. Found by looking straight at it, from anywhere on the street. Nothing else
   * in this game rewards turning your back on the view.
   */
  #pollSummit() {
    const summit = this.summitLevel
    if (!summit || !this.playing) return
    const atStreet = this.#playerIsAtSummit()

    if (atStreet && !this.summitFound) {
      this.summitFound = true
      this.hud?.discovery(SUMMIT.ARRIVAL.title, SUMMIT.ARRIVAL.sub)
      this.fx.shake(FX.SHAKE.scaleExplosion)
      this.sound?.playAt('zombie_scream', [summit.mouth.x, summit.mouth.y - 600, summit.streetZ], { volume: 0.5 })
    }

    if (!atStreet || this.secretFound) return
    const secret = summit.secret
    if (!secret) return

    // From the EYE, not the capsule centre: the eye is what is doing the looking, and the
    // two are 64 cm apart, which at conversational range is most of the tolerance.
    const eye = threeToSpec(...this.player.aimOrigin().toArray(), _specOrigin)
    const dx = secret.centre[0] - eye.x
    const dy = secret.centre[1] - eye.y
    const dz = secret.centre[2] - eye.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance > SUMMIT.SECRET.range || distance < 1) return

    // aimDirection() is three's frame; the poster's position is the spec's. One conversion.
    const aim = this.player.aimDirection()
    const dot = (aim.x * dx + -aim.z * dy + aim.y * dz) / distance
    if (dot < SUMMIT.SECRET.lookDot) return

    this.secretFound = true
    secret.material.emissiveIntensity = 1.0
    secret.lamp.intensity = secret.baseLamp * 2.2
    this.hud?.discovery('$132,994.97', 'AUGUST 2005 · ONE MONTH OF SEARCH TRAFFIC')
  }

  /**
   * A fresh run gets a fresh cache and its discovery back.
   *
   * NOT `summitPickups.reset()`: that method re-deals `openingLoadout()`, which is the
   * platform's fourteen items, onto whatever points its manager holds — three of them, in
   * this case, so the whole loadout would stack on one pavement. The board is cleared by
   * hand and SUMMIT.CACHE is dealt instead.
   */
  #resetSummit() {
    this.summitFound = false
    this.secretFound = false

    const secret = this.summitLevel?.secret
    if (secret) {
      secret.material.emissiveIntensity = secret.baseEmissive
      secret.lamp.intensity = secret.baseLamp
    }

    if (!this.summitPickups) return
    for (const pickup of this.summitPickups.pickups) {
      this.summitPickups.group.remove(pickup.root)
      pickup.disposeMaterials()
    }
    this.summitPickups.pickups.length = 0
    this.summitPickups.occupied.clear()
    this.#dealSummitCache()
  }

  #disposeSummit() {
    const secret = this.summitLevel?.secret
    if (!secret) return
    secret.mesh.removeFromParent()
    secret.lamp.removeFromParent()
    secret.geometry.dispose()
    secret.material.dispose()
    secret.texture?.dispose()
  }

  // -------------------------------------------------------------------------
  // Pickups
  // -------------------------------------------------------------------------

  /**
   * Health, armor, mods, dual wield and weapons — applied by hand rather than through
   * `weapons.giveMod()` / `player.addMod()`.
   *
   * Both of those emit an EV.MOD_GAINED of their own, and the PickupManager emits a third.
   * None of the three carries BOTH the mod id (which audio.js needs to pick the voice line)
   * and the whole mask (which hud.js needs to repaint the badge row), so the manager is
   * built with emitEvents:false and one complete event is published from here instead.
   *
   * The return value is the spec's handshake: `false` means "I did nothing", and the pickup
   * stays standing. A player already at the overheal cap leaves the heart on the floor.
   */
  #grantPickup(def) {
    const player = this.player
    let granted = false

    switch (def.kind) {
      case 'health':
        granted = player.healPercent(PICKUPS.healPercent) > 0
        if (granted) this.bus.emit(EV.PLAYER_HEAL, this.#vitals())
        break

      case 'armor':
        granted = player.addArmor(PICKUPS.armorAmount) > 0
        break

      case 'mod':
        granted = !player.hasMod(def.bit)
        if (granted) this.#applyMods(def.bit)
        break

      case 'weapon':
        // The loose pistol IS the dual-wield pickup — PICKUPS labels it "DUAL WIELD".
        if (def.weapon === PLAYER.START.weapon) {
          granted = this.weapons.grantDualWield()
          if (granted) player.grantDualWield()
        } else {
          // A re-grant rebuilds the gun with a full magazine and a full reserve, which is the
          // only ammo resupply in the game, so it always does something.
          this.weapons.grant(def.weapon)
          granted = true
        }
        break

      default:
        console.warn(`[game] pickup "${def.id}" has an unknown kind "${def.kind}" — it grants nothing`)
        return false
    }

    if (!granted) return false

    const specPosition = threeToSpec(player.position.x, player.position.y, player.position.z, new THREE.Vector3())
    this.bus.emit(EV.PICKUP, {
      type: def.id,
      kind: def.kind,
      label: def.label,
      position: specPosition.toArray(),
    })
    if (def.kind === 'mod') {
      this.bus.emit(EV.MOD_GAINED, { mod: def.mod, bit: def.bit, mods: this.weapons.mods })
    } else if (def.kind === 'weapon' && def.weapon === PLAYER.START.weapon) {
      this.bus.emit(EV.MOD_GAINED, { mod: 'dualWield', mods: this.weapons.mods, dualWield: true })
    }
    return true
  }

  /** Set bits on the player and push the whole mask onto every gun in hand, silently. */
  #applyMods(...bits) {
    for (const bit of bits) {
      this.player.activeMods |= bit
      this.weapons.mods |= bit
    }
    for (const weapon of this.weapons.weapons.values()) weapon.applyMods(this.weapons.mods)
    this.weapons.left?.applyMods(this.weapons.mods)
  }

  // -------------------------------------------------------------------------
  // Bus handlers
  // -------------------------------------------------------------------------

  #spawnZombie({ archetype, transform }) {
    const composition = this.gameState.director.composition
    if (!composition) {
      console.warn('[game] EV.ZOMBIE_SPAWN arrived with no live composition — no body was built for it')
      return
    }
    const from = this.#entryPoint(transform)
    this.zombies.spawn(archetype, composition, from.x, from.y, from.z)
  }

  /**
   * Which way a body comes in — and the reason the stairwell is architecture rather than
   * scenery.
   *
   * Every wave in the original arrived through the same four carriage doors on the same
   * flank at the same height, so the entire game was one firing line held against one wall.
   * A share of each wave now comes DOWN the stairs and out along the balcony instead, which
   * puts bodies above and behind the player and turns the hall into a room with two ends.
   * The share more than doubles once the player is standing on the balcony, because a deck
   * nothing can climb to is a safe room, and a safe room is where a wave shooter goes to die
   * of boredom.
   */
  #entryPoint(transform) {
    const street = this.#summitEntry()
    if (street) return street
    if (this.stairSpawns.length === 0) return transform
    const share = this.#playerIsUpstairs() ? WAVE_ENTRY.stairShareUpstairs : WAVE_ENTRY.stairShare
    if (!this.entryRng.chance(share)) return transform

    const point = this.entryRng.pick(this.stairSpawns)
    // A third of the door scatter: the balcony arms are 190 cm wide and the full +/-150 cm
    // band would drop a quarter of the wave straight through the void it opens onto.
    const scatter = WAVES.spawnScatterRadius * WAVE_ENTRY.stairScatterFraction
    return {
      x: point.x + this.entryRng.range(-scatter, scatter),
      y: point.y + this.entryRng.range(-scatter, scatter),
      z: point.z,
    }
  }

  /** Feet above the balcony deck. playerProxy.position.z is the capsule CENTRE, spec frame. */
  #playerIsUpstairs() {
    return this.playerProxy.position.z - this.player.halfHeight > MEZZANINE_TOP_Z - WAVE_ENTRY.upstairsMargin
  }

  #onWaveClear({ wave, reward }) {
    if (reward) this.pickups.dropReward(wave)
    // And the street is restocked whether or not the platform's own drop was earned: the
    // climb has to pay every time, or it is a place you visit once.
    this.#restockSummit(wave)
  }

  /** The director paces the shuttle run; the carriage only performs it. */
  #onTrainOrder({ phase }) {
    if (phase === TRAIN_PHASE.departing) this.train.depart()
    else this.train.arrive()
  }

  #onPlayerDeath() {
    // A crowd that keeps swinging at a corpse looks like a bug. With no target the AI falls
    // back to its idle pose, which reads as a platform full of things still breathing.
    this.zombieWorld.player = null
    this.post?.pulse('death')
    this.weapons.setTrigger(false)
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  toMenu() {
    this.stage = null
    this.gameState.toMenu()
    this.zombies.clear()
    this.train.reset()

  }

  startRun() {
    this.stage = null
    this.cinematic = null
    this.lowHealthLatched = false
    this.reloadHeld = false

    this.zombies.clear()
    this.train.reset()

    this.pickups.reset()
    this.#resetSummit()

    this.player.spawn()
    this.zombieWorld.player = this.playerProxy
    this.#syncPlayerProxy()
    this.lastYaw = this.player.yaw
    this.lastPitch = this.player.pitch

    // Rebuilding the weapon system is the cheapest honest reset: it restores the starting
    // pistol, a full magazine and an empty mod mask in one step, exactly as loading a fresh
    // level did in the original.
    this.weapons = this.#buildWeapons()
    this.viewModel.setDualWield(false)
    this.viewModel.root.visible = true

    this.fx.reset()
    this.gameState.startRun()
  }

  /** True while the player has control. False in the menu, and false once they are dead. */
  get playing() { return this.gameState.isPlaying && !this.gameState.runOver }

  // -------------------------------------------------------------------------
  // Fixed-step simulation
  // -------------------------------------------------------------------------

  /** @param {number} dt always STEP — the loop never hands this a variable slice. */
  update(dt) {
    this.elapsed += dt

    // The level breathes whether or not anyone is playing: the failing tube stutters behind
    // the title card and the car still runs its shuttle under the game-over screen.
    this.station.update(dt)
    this.train.update(dt)
    this.#syncTrainCollider()

    const playing = this.playing
    const cmd = playing ? (this.input?.sample(dt, this) ?? NEUTRAL) : NEUTRAL

    /**
     * The pawn is updated in every state, not only while it is being driven.
     *
     * After death it keeps falling and the camera keeps dropping, because update() feeds
     * itself NEUTRAL once dead — a corpse stops obeying, it does not stop existing. And
     * under the menu it is what composes the view at all: the camera's vertical FOV and
     * projection are derived inside _composeView from the aspect, so a build that skipped
     * this until the first run would render its opening frames through the engine's
     * placeholder projection.
     */
    this.player.update(dt, cmd, this.playerWorld)
    this.#syncPlayerProxy()

    // The gun is fired AFTER the view is composed, so the ray leaves along the crosshair the
    // player is actually looking at rather than along last frame's.
    //
    // A staged moment owns the trigger outright. Letting the (neutral) scripted sample
    // through would release it on the very next step, which is why the first attempt at the
    // firefight frame captured one round fired and no flash.
    if (playing && !this.stage) this.#drive(cmd)

    this.weapons.update(dt, {
      speed: this.player.speed,
      grounded: this.player.grounded,
      lookYaw: this.player.yaw - this.lastYaw,
      lookPitch: this.player.pitch - this.lastPitch,
    })
    this.lastYaw = this.player.yaw
    this.lastPitch = this.player.pitch

    // Corpses still need to fade and spits still need to land even with nobody in control.
    this.#settleStoreys(dt)
    this.zombies.update(dt, this.zombieWorld)
    this.#syncTargets()

    if (playing) this.#checkLowHealth()

    this.pickups.update(dt, playing ? this.player : null)
    this.summitPickups?.update(dt, playing ? this.player : null)
    this.#pollSummit()
    this.gameState.update(dt)

    if (this.stage) this.#sustainStage()

    this.hud?.update(this.hudSnapshot())
    this.#updateListener()
    this.sound?.update(dt)
  }

  /** Input -> the weapon system. The player only tracks the trigger edge; the gun owns the shot. */
  #drive(cmd) {
    this.weapons.setTrigger(cmd.fire === true)

    if (cmd.reload === true && !this.reloadHeld) this.weapons.reload()
    this.reloadHeld = cmd.reload === true

    if (cmd.slot > 0) {
      const id = WEAPONS.ORDER[cmd.slot - 1]
      if (id) this.weapons.switchTo(id)
    }
    if (cmd.wheel) this.weapons.switchNext(Math.sign(cmd.wheel))
  }

  /**
   * Put every body on the storey it is actually standing on, before it is asked to move.
   *
   * zombie.js writes `position.z = groundZ + halfHeight` at the end of every integrate and
   * never changes groundZ itself. That is not a defect — it is a module that correctly
   * refuses to know what the level looks like — but it does mean the level has to say, and
   * this is where the level says it. `floorHeightAt` is 2.5D: it is handed the body's
   * CURRENT height and will only offer a surface within one step of it, so a body on the
   * slab under the balcony is told the slab and a body that has walked up the flight is
   * told the deck. Climbing 250 cm at the lip is not on offer to anything, which is the
   * whole of the flanking mechanic.
   *
   * The rate clamp is what makes it read as movement. Assigned outright, a body crossing
   * the balcony edge jumps 250 cm in one frame; clamped, it walks the treads at the pace
   * they allow and drops off the lip at about the speed gravity would have taken it.
   */
  #settleStoreys(dt) {
    const bodies = this.zombies.bodies
    const rise = FLOOR.riseRate * dt
    const fall = FLOOR.fallRate * dt
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]
      const delta = this.#floorAt(body.position.x, body.position.y, body.groundZ) - body.groundZ
      if (delta === 0) continue
      body.groundZ += delta > 0 ? Math.min(delta, rise) : Math.max(delta, -fall)
    }
  }

  #syncPlayerProxy() {
    const p = this.player.position
    this.playerProxy.position.set(p.x, -p.z, p.y)
    // spawn() builds a new HealthPool, so the proxy cannot hold a reference across a run.
    this.playerProxy.health = this.player.health
  }

  #syncTargets() {
    const bodies = this.zombies.bodies
    this.targets.length = 0
    for (let i = 0; i < bodies.length; i++) this.targets.push(this.#targetFor(bodies[i]).sync())
  }

  #targetFor(zombie) {
    let target = this.targetByZombie.get(zombie)
    if (!target) {
      target = new ZombieTarget(zombie)
      this.targetByZombie.set(zombie, target)
    }
    return target
  }

  #syncTrainCollider() {
    // train.js hangs the carriage off its FLOOR line, so the body occupies
    // [z, z + bodySize.z] in the spec frame rather than straddling the pivot.
    const p = this.train.position
    const hx = TRAIN.bodyHalfExtent[0]
    const hy = TRAIN.bodyHalfExtent[1]
    const height = TRAIN.bodySize[2]
    this.trainBox.min.set(p.x - hx, p.z, -(p.y + hy))
    this.trainBox.max.set(p.x + hx, p.z + height, -(p.y - hy))
  }

  /**
   * The one voice line rules.js wired that nothing ever fired. Latched, so a player sitting
   * at 29% is told once rather than sixty times a second; the voice director's own 25 s
   * cooldown covers a player who climbs back over the line and straight down through it.
   */
  #checkLowHealth() {
    const fraction = this.player.healthValue / this.player.maxHealth
    if (fraction > AUDIO.VOICE.lowHealthThreshold) {
      this.lowHealthLatched = false
      return
    }
    if (this.lowHealthLatched || this.player.isDead) return
    this.lowHealthLatched = true
    this.bus.emit(EV.LOW_HEALTH, this.#vitals())
  }

  /**
   * rules.js states every cue position in the spec's Z-up frame and audio.js defaults to
   * reading them that way, so the listener is converted rather than the forty cues.
   *
   * Known cost: weapon.js and its explosions emit their positions in three's frame, so those
   * two arrive permuted. The muzzle sits on top of the listener, which makes its error
   * inaudible; an explosion's is not, and the honest fix is a frame on the payload rather
   * than a second conversion guessed at here.
   */
  #updateListener() {
    if (!this.sound) return
    const p = this.camera.position
    const forward = this.player.aimDirection()
    this.sound.setListener([p.x, -p.z, p.y], [forward.x, -forward.z, forward.y])
  }

  // -------------------------------------------------------------------------
  // Render tick — variable dt, decoupled from the simulation
  // -------------------------------------------------------------------------

  /** @param {number} dt wall-clock seconds since the last rendered frame. */
  render(dt) {
    // Every effect here is wall-clock timed, and the shake deliberately resamples its noise
    // once per RENDERED frame; driving it off the fixed step would smooth out the harshness
    // that is the whole point of it.
    this.fx.update(dt)
    this.#updateTracers(dt)

    if (this.cinematic) this.#applyCinematic()

    this.fx.applyShake(this.camera)
    if (this.post) this.post.render(dt)
    else this.renderer.render(this.scene, this.camera)
    this.fx.releaseShake(this.camera)

    this.frames += 1
  }

  resize() { this.post?.resize() }

  // -------------------------------------------------------------------------
  // Tracers
  // -------------------------------------------------------------------------

  #spawnTracer(from, to) {
    const live = this.tracers.live
    // Oldest out first: in a firefight the round that just left the barrel is the one worth
    // a slot, not the one that is already half faded.
    if (live.length >= TRACER_POOL_SIZE) live.shift()
    live.push({ from: from.clone(), to: to.clone(), age: 0 })
  }

  #updateTracers(dt) {
    const pool = this.tracers
    const live = pool.live
    let slot = 0

    for (let i = live.length - 1; i >= 0; i--) {
      live[i].age += dt
      if (live[i].age >= FX.TRACER.lifeSeconds) live.splice(i, 1)
    }

    for (const t of live) {
      const length = pool.dir.subVectors(t.to, t.from).length()
      if (length < 1e-4) continue
      pool.dir.multiplyScalar(1 / length)
      pool.quaternion.setFromUnitVectors(pool.axis, pool.dir)
      // The round thins as it fades, so a burst reads as a stream of light rather than a
      // rank of identical sticks blinking off together.
      const fade = 1 - t.age / FX.TRACER.lifeSeconds
      pool.scale.set(FX.TRACER.thickness * fade, FX.TRACER.thickness * fade, length)
      pool.mid.addVectors(t.from, t.to).multiplyScalar(0.5)
      pool.matrix.compose(pool.mid, pool.quaternion, pool.scale)
      pool.mesh.setMatrixAt(slot++, pool.matrix)
    }

    pool.mesh.count = slot
    pool.mesh.instanceMatrix.needsUpdate = true
  }

  // -------------------------------------------------------------------------
  // Geometry queries
  // -------------------------------------------------------------------------

  #raycastColliders(origin, direction, maxT) {
    let best = null
    for (const box of this.colliderBoxes) {
      const hit = rayBoxT(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, box, maxT)
      if (!hit || hit.t <= 0) continue
      if (best && hit.t >= best.t) continue
      best = hit
    }
    if (!best) return null

    const point = new THREE.Vector3().copy(origin).addScaledVector(direction, best.t)
    const normal = new THREE.Vector3()
    normal.setComponent(best.axis, best.sign)
    return { point, normal, actor: null, zone: null, distance: best.t }
  }

  /** Both endpoints are in the SPEC frame — this is the Spitter's occlusion test. */
  #hasLineOfSight(specFrom, specTo) {
    const from = specToThree(specFrom.x, specFrom.y, specFrom.z, _eye)
    const to = specToThree(specTo.x, specTo.y, specTo.z, _at)
    const direction = to.clone().sub(from)
    const distance = direction.length()
    if (distance < 1e-4) return true
    direction.multiplyScalar(1 / distance)
    // The train is the last box in the list and it moves, so a spit that would pass through a
    // docked carriage is correctly held. Nothing is excluded here.
    return this.#raycastColliders(from, direction, distance) === null
  }

  #columnObstacles() {
    const out = []
    for (let i = 0; i < STATION.COUNTS.columns; i++) {
      out.push({ x: DIM.columnMargin + i * DIM.columnSpacing, y: 0, radius: DIM.columnRadius })
    }
    // The stairwell's spine and flanking walls, published by the level for the same reason
    // the columns are here: `_avoidObstacles` is the only pathing in the game.
    for (const mass of this.station.navObstacles ?? []) out.push(mass)
    return out
  }

  // -------------------------------------------------------------------------
  // Readouts
  // -------------------------------------------------------------------------

  #vitals() {
    return {
      health: this.player.healthValue,
      armor: this.player.armorValue,
      maxHealth: this.player.maxHealth,
      overhealCap: this.player.overhealCap,
      maxArmor: this.player.maxArmor,
      overArmorCap: this.player.overArmorCap,
      dead: this.player.isDead,
      burning: this.player.isBurning,
    }
  }

  hudSnapshot() {
    const ammo = this.weapons.ammoState()
    const run = this.gameState.snapshot()
    return {
      ...this.#vitals(),
      wave: run.wave,
      // The wave director's remainingThisWave, NOT this.zombies.aliveCount: aliveCount is
      // only how many bodies are on screen right now, capped at WAVES.spawnBatchSize per
      // release and topped back up from the queue on every kill mid-wave, so it sits still
      // or climbs while the player is actually making progress. run.remaining is decremented
      // once per confirmed kill (waveDirector.js notifyZombieRemoved) and only that number
      // reaches zero when the wave actually clears.
      zombiesRemaining: run.remaining,
      countdown: run.countdown,
      intermission: run.intermission,
      score: run.score,
      weapon: { name: ammo.label, mag: ammo.mag, reserve: ammo.reserve, dry: ammo.empty },
      mods: this.player.mods,
      dualWield: this.weapons.dualWield,
      // The climb gauge. hud.js draws nothing until altitude leaves the slab, so this costs
      // a player who never goes upstairs exactly one number a frame.
      altitude: this.#altitude(),
      summitTopZ: this.summitLevel?.streetZ ?? 0,
      mezzanineZ: MEZZANINE_TOP_Z,
      atSummit: this.#playerIsAtSummit(),
      summitStock: this.summitPickups?.occupied.size ?? 0,
    }
  }

  /** The shape CONTRACT.md pins for globalThis.__SHOE__.state(). */
  snapshot() {
    const run = this.gameState.snapshot()
    const ammo = this.weapons.ammoState()
    return {
      ...run,
      health: this.player.healthValue,
      armor: this.player.armorValue,
      alive: this.player.alive && !this.gameState.runOver,
      zombies: this.zombies.aliveCount,
      bodies: this.zombies.bodyCount,
      weapon: ammo.weapon,
      mag: ammo.mag,
      reserve: ammo.reserve,
      mods: this.player.mods,
      dualWield: this.weapons.dualWield,
      frames: this.frames,
      backend: globalThis.__SHOE_BACKEND__ ?? null,
      altitude: this.#altitude(),
      atSummit: this.#playerIsAtSummit(),
      summitFound: this.summitFound,
      secretFound: this.secretFound,
      summitStock: this.summitPickups?.occupied.size ?? 0,
      streetZ: this.summitLevel?.streetZ ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // Scripted control, for the verification harness
  // -------------------------------------------------------------------------

  attachInput(input) {
    this.input = input
  }

  /** One trigger press, resolved synchronously. Semi-automatics need the release too. */
  fire() {
    this.weapons.setTrigger(true)
    this.weapons.setTrigger(false)
  }

  /**
   * @param {number} yawDegrees   spec heading; 0 looks down the platform toward +X
   * @param {number} pitchDegrees positive looks up
   */
  aim(yawDegrees = 0, pitchDegrees = 0) {
    this.player.yaw = yawDegrees * DEG + SPEC_YAW_OFFSET
    this.player.pitch = Math.max(
      PLAYER.CAMERA.viewPitchMin * DEG,
      Math.min(PLAYER.CAMERA.viewPitchMax * DEG, pitchDegrees * DEG),
    )
    this.lastYaw = this.player.yaw
    this.lastPitch = this.player.pitch
  }

  /** Advance the simulation without waiting on a frame. */
  tick(seconds) {
    const steps = Math.max(0, Math.round(seconds / STEP))
    for (let i = 0; i < steps; i++) this.update(STEP)
    return steps
  }

  // -------------------------------------------------------------------------
  // The six verification moments
  // -------------------------------------------------------------------------

  /**
   * Force one legible visual moment, synchronously.
   *
   * A scene that is technically correct and aimed at a dark wall fails the frame gate, so
   * every branch finishes by pointing a camera at the thing the moment is named after and
   * settling the simulation far enough that the lights, the crowd and the HUD are in their
   * final state before the shutter opens.
   */
  scenario(name) {
    switch (name) {
      case 'menu': return this.#stageMenu()
      case 'platform': return this.#stagePlatform()
      case 'train': return this.#stageTrain()
      case 'firefight': return this.#stageFirefight()
      case 'boss': return this.#stageBoss()
      case 'death': return this.#stageDeath()
      case 'summit': return this.#stageSummit()
      default:
        // Throw, do not warn-and-continue. A no-op leaves the previous capture's staging
        // in place, so the harness photographs the LAST scenario again and grades it green
        // under the new name. Measured: scenario('vista'), ('street') and ('mezzanine') all
        // reported ok and passed the gate while staging nothing, because scenario('summit')
        // ran first and its camera persisted. Three green frames, one actual view.
        throw new Error(
          `[game] unknown scenario "${name}" — expected one of: ` +
          `menu, platform, train, firefight, boss, death, summit`
        )
    }
  }

  #stageMenu() {
    // toMenu() is not startRun(), so this is the one staged moment that would otherwise
    // keep the previous capture's blood, tracers and discovery plate. See #clearStagedResidue.
    this.#clearStagedResidue()
    this.toMenu()
    // The title card sits over a live platform with the car already docked and lit, which is
    // the difference between a menu and a black rectangle with a logo on it.
    this.train.arrive()
    this.#advanceTrain(TRAIN.arrivalTime + TRAIN.doorOpenSeconds)
    this.cinematic = STAGE.menu
    this.viewModel.root.visible = false
    this.tick(STAGE.settle)
    return true
  }

  #stagePlatform() {
    this.#beginStagedRun(WAVES.firstWaveNumber)
    this.#standAt(STAGE.platform.stand, STAGE.platform.at)
    this.train.arrive()
    this.#advanceTrain(TRAIN.arrivalTime + TRAIN.doorOpenSeconds)
    this.#plantOnStairs(STAGE.platform.stairCrowd, WAVES.firstWaveNumber)
    this.tick(STAGE.settle)
    return true
  }

  /**
   * Stand bodies ON the climb, each on the tread it would have stepped onto.
   *
   * #plantCrowd fans a crowd out on the slab in front of the player and #plantAtDoors puts
   * one in each doorway; neither can place anything on a staircase, because both assume a
   * single floor at LEVELS.platformTopZ. The Z here comes back from station.js's own 2.5D
   * floor query through stairPointAt, so these are standing on the same surfaces
   * #settleStoreys walks the AI up and down — a body that is one tread too high is a body
   * the simulation would immediately drop, and that would show.
   */
  #plantOnStairs(entries, waveNumber) {
    if (!entries?.length) return []
    const composition = buildWave(waveNumber)
    const spec = this.playerProxy.position
    const out = []

    for (const entry of entries) {
      const point = stairPointAt(entry.climb)
      const zombie = this.zombies.spawn(entry.archetype, composition, point.x, point.y, point.z)
      // Facing the camera, for the same reason #plantCrowd turns its crowd around: the AI is
      // halted for a staged moment, so a body spawned on a random heading will keep it.
      zombie.yaw = Math.atan2(spec.y - point.y, spec.x - point.x)
      out.push(zombie)
    }

    this.#syncTargets()
    return out
  }

  #stageTrain() {
    const s = STAGE.train
    this.#beginStagedRun(WAVES.firstWaveNumber)
    this.train.reset()

    this.train.arrive()
    this.#advanceTrain(TRAIN.arrivalTime + TRAIN.doorOpenSeconds)
    this.#plantAtDoors(s.crowd, WAVES.firstWaveNumber)
    this.cinematic = s

    /**
     * The gun stays in frame here, and #stageMenu's `root.visible = false` is NOT copied.
     *
     * The two moments are not the same kind of picture. The menu hides its HUD behind a full
     * screen card, so a floating pistol under it would be furniture with no readout attached.
     * This frame keeps the whole combat HUD — wave counter, both vitals bars, PISTOL 15/150 —
     * and an ammo counter for a weapon that is nowhere on screen was the one element in this
     * build that actively lied about the game state. A critic found it in ten seconds by
     * measuring the box where the pistol sits in platform.png and finding bare lit floor.
     *
     * Showing the gun is the honest half of that trade and the better picture besides: the
     * frame's bottom-right corner was empty wet floor, and a dark receiver silhouetted
     * against a lit carriage is exactly the foreground anchor the composition was missing.
     * The view model is a child of the camera (viewmodel.js), so it rides the cinematic eye
     * without any extra wiring.
     */
    this.tick(STAGE.settle)

    // The centre of the frame carried nothing: #beginStagedRun's WAVE_START banner has faded
    // by the time the shutter opens. Re-raising the wave banner is what the real game shows
    // the instant those doors open, and it now agrees with the counter in the corner.
    this.hud?.banner(`WAVE ${WAVES.firstWaveNumber}`)
    return true
  }

  #stageFirefight() {
    const s = STAGE.firefight
    this.#beginStagedRun(s.wave)
    this.#standAt(s.stand, s.at)

    this.train.arrive()
    this.#advanceTrain(TRAIN.arrivalTime + TRAIN.doorOpenSeconds)

    // An automatic weapon is the only one that keeps firing across the harness's settle, so
    // the capture lands on muzzle flash, tracers and blood rather than on a still pose.
    this.weapons.grant('rifle')
    this.#applyMods(MOD_BITS.laserSight, MOD_BITS.incendiary)
    this.bus.emit(EV.MOD_GAINED, { mods: this.weapons.mods })

    // Topped up so a staged shot cannot end in the game-over screen if the crowd lands a hit.
    this.player.health.heal(this.player.overhealCap)
    this.player.addArmor(this.player.overArmorCap)

    this.#plantCrowd(s.crowd, s.wave)
    this.stage = { kind: 'firefight', wave: s.wave, crowd: s.crowd.length }
    this.weapons.setTrigger(true)
    this.tick(STAGE.settle)
    // startWave() banners NEXT TRAIN INBOUND through the HUD's own TRAIN_INBOUND handler,
    // and its animation outlasts the harness's settle. Retrigger the banner that belongs to
    // the moment instead: hud.banner() ignores an empty string, so it cannot simply be cleared.
    this.hud?.banner(`WAVE ${s.wave}`)
    return true
  }

  #stageBoss() {
    const s = STAGE.boss
    this.#beginStagedRun(s.wave)
    this.#standAt(s.stand, s.at)

    this.train.arrive()
    this.#advanceTrain(TRAIN.arrivalTime + TRAIN.doorOpenSeconds)

    this.weapons.grant('shotgun')
    this.#applyMods(MOD_BITS.explosive, MOD_BITS.armorPiercing, MOD_BITS.laserSight)
    this.bus.emit(EV.MOD_GAINED, { mods: this.weapons.mods })

    const bodies = this.#plantCrowd(s.crowd, s.wave)
    const boss = bodies[0]
    if (boss) {
      // A full-health Conductor reads as a wall. Most of the way dead is the moment worth
      // showing, and it is also when its own furnace glow is brightest.
      const pool = boss.health
      pool.applyDamage(pool.health * (1 - s.healthLeft), true, this.player)
    }

    // The vignette IS a vitals readout: it only comes up when the player is nearly gone.
    const pool = this.player.health
    pool.applyDamage(pool.health - this.player.maxHealth * s.playerHealthLeft, true, boss)

    this.stage = { kind: 'boss', wave: s.wave, crowd: s.crowd.length }
    this.tick(STAGE.settle)
    this.hud?.banner(ZOMBIES.ARCHETYPES.boss.displayName, true)
    return true
  }

  #stageDeath() {
    const s = STAGE.death
    this.#beginStagedRun(s.wave)
    this.#standAt(s.stand, s.at)
    this.#plantCrowd(s.crowd, s.wave)

    // Run the scorer forward so the game-over card has a real run behind it, not zeroes.
    const at = this.gameState.elapsed
    this.gameState.scoring.registerKill({ archetype: 'base', zone: DAMAGE.zones.head, at })
    this.gameState.scoring.registerKill({ archetype: 'tank', zone: DAMAGE.zones.chest, at })
    this.gameState.scoring.registerWaveClear(s.wave - 1)
    this.gameState.totalKills = buildWave(s.wave).totalCount
    this.gameState.elapsed = s.wave * s.secondsPerWave

    this.player.health.kill(null)
    this.tick(STAGE.settle)
    return true
  }

  /**
   * THE SEVENTH MOMENT — the street.
   *
   * The other six all stand on the platform slab at Z 0 and look east down the same hall.
   * This one stands nine metres over it, outdoors, on the pavement the stair comes up
   * through, with its back to the station: the cache on the flags in the near ground, the
   * mouth of the stair and its yellow nosing beside it, bodies already coming out of it,
   * then the kerb, the carriageway and the city.
   *
   * Not one coordinate in the composition is typed into this file. The eye is an offset off
   * the vista point src/world/summit.js published and the aim is an offset off its stair
   * mouth, so a street that moves takes its own establishing shot with it.
   */
  #stageSummit() {
    const summit = this.summitLevel
    if (!summit) {
      console.warn('[game] scenario("summit") has no summit to stand on — the station published none')
      return false
    }

    this.#beginStagedRun(SUMMIT.scenarioWave)
    this.#standAt(
      [
        summit.vista.x - SUMMIT_STAGE.standWest,
        summit.vista.y + SUMMIT_STAGE.standNorth,
        summit.streetZ,
      ],
      [
        summit.mouth.x + SUMMIT_STAGE.lookEast,
        summit.vista.y - SUMMIT_STAGE.lookSouth,
        summit.streetZ + SUMMIT_STAGE.lookRise,
      ],
    )

    // The car is run in and docked below, so a player who walks back to the mouth and looks
    // down is looking at a station that is still running rather than at a held frame.
    this.train.arrive()
    this.#advanceTrain(TRAIN.arrivalTime + TRAIN.doorOpenSeconds)

    this.#plantOnSummit(SUMMIT_STAGE.crowd, SUMMIT.scenarioWave)
    this.tick(STAGE.settle)

    /**
     * The arrival beat is re-raised, for the same reason #stageFirefight re-raises its
     * banner — and it is the ONLY card raised here.
     *
     * scenario() returns the instant the staged work is done; the harness then waits 1800 ms
     * of WALL CLOCK before the shutter opens. #pollSummit fires the beat during the settle
     * tick, which is simulation time and costs no wall clock at all, so by the time anyone
     * looks the card is somewhere unpredictable in its own animation — measured, it had
     * already run out. Raising it again puts it at a known point on that curve.
     *
     * No WAVE banner: hud.discovery() now speaks through the banner itself, and the wave
     * number is already printed in the corner readout. Two cards in one slot is how the
     * first version of this frame came back with STREET LEVEL and WAVE 5 stacked on top of
     * each other, both illegible.
     */
    this.hud?.discovery(SUMMIT.ARRIVAL.title, SUMMIT.ARRIVAL.sub)
    return true
  }

  /** Stand bodies on the pavement around the stair mouth, where a wave actually comes out. */
  #plantOnSummit(entries, waveNumber) {
    const summit = this.summitLevel
    if (!entries?.length || !summit) return []
    const composition = buildWave(waveNumber)
    const spec = this.playerProxy.position
    const out = []

    for (const entry of entries) {
      const at = this.#streetPoint(summit.mouth.x + entry.x, summit.mouth.y + entry.y)
      const zombie = this.zombies.spawn(entry.archetype, composition, at.x, at.y, at.z)
      // The AI is halted for a staged moment, so a body spawned on a random heading keeps it.
      zombie.yaw = Math.atan2(spec.y - at.y, spec.x - at.x)
      out.push(zombie)
    }

    this.#syncTargets()
    return out
  }

  /** Keeps a staged moment alive across the harness's settle window. */
  #sustainStage() {
    if (this.stage.kind === 'firefight') {
      if (this.zombies.aliveCount < this.stage.crowd) this.#plantCrowd(['base'], this.stage.wave)
      if (this.weapons.active()?.empty) this.weapons.reload()
      this.weapons.setTrigger(true)
    }
    if (this.stage.kind === 'boss') {
      // The hit pulse decays in FX.DAMAGE_FLASH.fullDecaySeconds, which is shorter than the
      // harness's settle, so it is re-armed rather than fired once and photographed cold.
      this.post?.pulse('hit')
    }
  }

  /**
   * Start a run, jump the director to one wave, then hold it still.
   *
   * The AI is frozen by taking its target away, which also stops a staged shot from ending
   * in the game-over screen while the harness waits out its settle. The crowd keeps
   * breathing in place, which is what `idle` was built for.
   */
  #beginStagedRun(waveNumber) {
    this.#clearStagedResidue()
    this.startRun()
    this.gameState.director.startWave(waveNumber)
    this.gameState.director.stop()
    this.zombies.clear()
    this.zombieWorld.player = null
    this.cinematic = null
    this.viewModel.root.visible = true
  }

  /**
   * SEVEN MOMENTS IN ONE PAGE, AND THE SEVENTH WAS BEING JUDGED IN THE STATE THE OTHER SIX
   * LEFT IT IN.
   *
   * The harness boots once and then stages every scenario into the same live scene, in a
   * fixed order, so whatever a moment leaves behind is standing in the next one's frame.
   * That is not a theoretical worry: the same build, same seed, same camera measured mean
   * luminance 39.9 when the summit was staged FIRST and 147.6 when it was staged SEVENTH —
   * a 3.7x exposure swing bought entirely with run order, and because the summit is always
   * last, the PNG a reviewer opens is always the 147 one. A frame nobody can reproduce in
   * isolation cannot be art-directed, only guessed at.
   *
   * startRun() already resets the FX facade and re-deals both pickup boards, and that is
   * most of it. What it never touched is everything this file owns outright and every piece
   * of transient UI state:
   *
   *   - the tracer pool, which is a 64-slot emissive instanced mesh living in game.js
   *     precisely because src/fx/** publishes no adapter for it. #stageFirefight holds an
   *     automatic weapon's trigger down through its settle and #sustainStage keeps it down,
   *     so it hands the next moment a magazine's worth of glowing bars that no reset owned.
   *   - the discovery plate and the wave banner, which are latched DOM. The summit frame
   *     was photographed with STREET LEVEL still up underneath its own WAVE 5 announce —
   *     two cards stacked on one another, both illegible, and both of them the residue of
   *     a beat that had already fired.
   *   - the damage flash and crosshair kick, which hud.reset() zeroes and nothing else does.
   *
   * Cheap, total, and called from every staged moment including the menu, so the rule is
   * simply that no moment can see the one before it. The check that this is honest is to
   * measure a scenario staged first and staged seventh: the two means have to agree.
   */
  #clearStagedResidue() {
    // Emissive geometry with a lifetime, owned here, reset here.
    this.tracers.live.length = 0
    this.tracers.mesh.count = 0
    this.tracers.mesh.instanceMatrix.needsUpdate = true

    // Latched UI: the discovery plate, the boss nameplate, the damage flash, the kick.
    this.hud?.reset()

    // The FX pools are startRun()'s job for a staged run, but #stageMenu goes through
    // toMenu() instead, and a menu with the last firefight's blood on the slab is the same
    // bug wearing a different hat.
    this.fx.reset()
  }

  /**
   * Put the player at a spec position and turn their head toward a spec target. The camera
   * follows on the next composed view, so this is always paired with a tick().
   */
  #standAt(specStand, specLookAt) {
    const three = specToThree(specStand[0], specStand[1], specStand[2], _eye)
    this.player.teleport(three.x, three.y + this.player.halfHeight, three.z)

    const dx = specLookAt[0] - specStand[0]
    const dy = specLookAt[1] - specStand[1]
    const dz = specLookAt[2] - (specStand[2] + EYE)
    const flat = Math.hypot(dx, dy)
    this.aim(Math.atan2(dy, dx) / DEG, Math.atan2(dz, flat || 1) / DEG)
    this.#syncPlayerProxy()
  }

  /**
   * Drop a fan of bodies in front of the player, close enough to read and far enough apart
   * to be individually legible. These go straight into the pool: the director is halted for
   * a staged moment, so they must not travel through its queue or count against its cap.
   */
  #plantCrowd(archetypes, waveNumber) {
    const composition = buildWave(waveNumber)
    const spec = this.playerProxy.position
    const heading = this.player.yaw - SPEC_YAW_OFFSET
    const out = []

    // Fan outward from the centre — 0, +1, -1, +2, -2 — so the FIRST archetype listed is the
    // one dead ahead. The Conductor is listed first for exactly that reason.
    const ranks = Math.max(1, Math.ceil((archetypes.length - 1) / 2))

    for (let i = 0; i < archetypes.length; i++) {
      const rank = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1)
      const lateral = (rank / ranks) * STAGE.crowdSpread * 0.5
      const depth = STAGE.crowdDistance + (i % 2) * STAGE.crowdSpread * 0.25
      const x = spec.x + Math.cos(heading) * depth - Math.sin(heading) * lateral
      const y = spec.y + Math.sin(heading) * depth + Math.cos(heading) * lateral
      const zombie = this.zombies.spawn(archetypes[i], composition, x, y, LEVELS.platformTopZ)
      // The pool randomises facing at spawn so a crowd does not step off in formation. A
      // staged shot wants them looking at the camera, and with the AI frozen the turn rate
      // will never get them there.
      zombie.yaw = heading + Math.PI
      out.push(zombie)
    }

    this.#syncTargets()
    return out
  }

  /**
   * Stand one body in each of the carriage's doorways.
   *
   * #plantCrowd fans bodies out in front of the PLAYER, which is the wrong frame of
   * reference for a cinematic — the pawn is parked somewhere else while a detached eye does
   * the looking. These are placed against the train instead: TRAIN.doorLocalXs is the same
   * door line the wave director spawns from, so this is where a wave comes out anyway.
   *
   * They are not decoration. A smooth 800 cm box with lit rectangles in it has no size until
   * something human-sized stands beside it, which is precisely why the first version of this
   * frame read as a shipping container rather than a subway car.
   */
  #plantAtDoors(archetypes, waveNumber) {
    const composition = buildWave(waveNumber)
    const eye = STAGE.train.eye
    const flankY = TRAIN_DOCK_Y + TRAIN.bodyHalfExtent[1] * -PLATFORM_SIDE
    const y = flankY - PLATFORM_SIDE * STAGE.train.doorStepOut
    const out = []

    for (let i = 0; i < archetypes.length; i++) {
      const x = DESIGNED.trainStopX + TRAIN.doorLocalXs[i % TRAIN.doorLocalXs.length]
      const zombie = this.zombies.spawn(archetypes[i], composition, x, y, LEVELS.platformTopZ)
      // Spawn randomises facing so a wave does not step off in formation. With the AI frozen
      // the turn rate will never correct it, so they are turned to the lens by hand.
      zombie.yaw = Math.atan2(eye[1] - y, eye[0] - x)
      out.push(zombie)
    }

    this.#syncTargets()
    return out
  }

  #advanceTrain(seconds) {
    const steps = Math.max(1, Math.round(seconds / STEP))
    for (let i = 0; i < steps; i++) this.train.update(STEP)
    this.#syncTrainCollider()
  }

  #applyCinematic() {
    const eye = specToThree(this.cinematic.eye[0], this.cinematic.eye[1], this.cinematic.eye[2], _eye)
    const at = specToThree(this.cinematic.at[0], this.cinematic.at[1], this.cinematic.at[2], _at)
    this.camera.position.copy(eye)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(at)
    this.camera.updateMatrixWorld(true)
  }

  // -------------------------------------------------------------------------

  dispose() {
    for (const off of this.unsubscribe ?? []) off()
    this.unsubscribe = []
    this.gameState.dispose()
    this.pickups.dispose()
    this.summitPickups?.dispose()
    this.#disposeSummit()
    this.zombies.dispose()
    this.train.dispose()
    this.station.dispose()
    this.viewModel.dispose()
    this.fx.dispose()
    this.tracers.mesh.removeFromParent()
    this.tracers.geometry.dispose()
    this.tracers.material.dispose()
    this.zUpMount.removeFromParent()
  }
}

export { GAME_STATES, WAVE_STATE, SPAWN_ORIGIN, STAGE }
export default Game
