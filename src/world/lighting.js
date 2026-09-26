/**
 * lighting.js — the station's light rig, atmosphere and light-shaft haze.
 *
 * The spec's 28 lights (7 down-spots, 7 head-height fills, 14 outward wall washes) are
 * the floor, not the ceiling: they are reproduced exactly, at the exact positions,
 * intensities, cone angles and colours the original authored, and then the things the
 * original never had are layered on top — visible fixture housings around the emissive
 * tubes, cold spill out of the four tunnel mouths, additive light shafts under every
 * down-spot, exponential fog so the tunnels dissolve into black, and one tube that has
 * been failing since 1987.
 *
 * It also owns the hour. sky.js builds the night above the light well — moon, stars, city
 * glow, rain — and `NIGHT_RIG` below is the small second rig that lights it and leaks a
 * little of it back down the stairwell. The two rigs are deliberately sealed off from each
 * other: the station stays warm sodium, the street stays cold, and the contrast between
 * them is the only signage in this game that says there is somewhere to climb to.
 *
 * Unreal candelas assume metres; this world is in centimetres, so every intensity is
 * multiplied by FX.LIGHT_INTENSITY_SCALE, the single knob that dims or brightens the
 * whole game at once.
 */

import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'
import { Rng } from '../core/rng.js'
import { STATION, FX } from '../game/rules.js'
import { createEnvironmentTexture } from './materials.js'
import { initSky } from './sky.js'
import { reserveFromLightBudget } from './optimize.js'

const DIM = STATION.DIMENSIONS
const LEVELS = STATION.LEVELS
const COUNTS = STATION.COUNTS
const LIGHTING = STATION.LIGHTING
const ATMOSPHERE = STATION.ATMOSPHERE

/**
 * Spec frame (Z-up) to three frame (Y-up): (x, y, z) -> (x, z, -y).
 *
 * station.js exports this as `specToThree` for the rest of the game. It is repeated
 * here as a one-liner rather than imported, because station.js imports this module and
 * a cycle between the two would buy nothing.
 */
const v3 = (x, y, z) => new THREE.Vector3(x, z, -y)

const deg = Math.PI / 180

/**
 * Presentation-only additions. The original authored no fog, no fixtures, no shafts and
 * no failing tube, so none of these have a home in rules.js the way a gameplay tunable
 * does. One frozen block, so they stay findable and diffable in one place.
 */
const RIG = Object.freeze({
  environmentIntensity: 0.70, // how hard the procedural env map reflects in wet floor and steel

  /** The sheet-metal pan the tube is recessed into, and the two cheeks that flank it. */
  housingPan: Object.freeze({ half: Object.freeze([82.0, 27.0, 7.0]), z: 455.0 }),
  housingCheek: Object.freeze({ half: Object.freeze([82.0, 4.0, 6.0]), y: 22.0, z: 447.0 }),

  /** Cold light leaking out of the four tunnel mouths, so the ends are not simply black. */
  tunnelSpill: Object.freeze({
    insetX: 380.0, // station side of the 300 cm deep darkness caps
    z: 30.0,
    /**
     * A tunnel mouth is the deepest point in every shot and it was reading BRIGHTER than
     * the walls framing it — a milky plug where there should be a throat. At 5400 this
     * spill was not leaking out of the dark, it was filling it in. It only has to say
     * "the tunnel is not painted-on black", so it runs at well under a third of that and
     * lets the fog take the far end.
     */
    intensity: 1600.0,
    attenuationRadius: 1600.0,
    colorHex: 0x5b86d8,
  }),

  /**
   * The far end has to actually dissolve. ATMOSPHERE.fogDensity 0.00018 only reaches a
   * 0.69 fog factor at the 6000 cm tunnel mouth, so a quarter of the raw surface still
   * showed through and the deepest point in the frame glowed back at the player. 0.00030
   * reaches 0.96 there and the tunnel sinks into the fog colour. Taken as a FLOOR rather
   * than a multiplier so that raising the rules.js value later moves this with it instead
   * of compounding against it.
   */
  fogMinDensity: 0.0003,

  /**
   * Same deal for the shafts: six of the seven were too faint to see, and the shafts are
   * the only thing that visually connects a fixture to the pool it throws. A floor, not a
   * gain — ATMOSPHERE.hazeIntensity stays the knob, this just refuses to go below useful.
   *
   * 0.62 was too far: the shafts read, but the mid-distance went milky grey and the
   * station stopped sinking into its own blacks — fog-machine haze rather than a place
   * you would not want to be. 0.5 keeps all seven legible and gives the dark back.
   */
  hazeMinIntensity: 0.5,

  /**
   * Nothing in the spec rig ever pointed UP. Every fixture hung in a black void with its
   * pool on the floor and no visible path between the two — the "evenly lit from nowhere"
   * failure inverted, a 204-luma lamp sitting in a 5-luma ceiling with a cliff between
   * them instead of a falloff. One shadowless spot per station throws back at the slab
   * from below head height.
   *
   * It has to be a long throw. A point light tucked under the tube is 16 cm from the slab
   * and lands at ~97 irradiance where white is 1.0: a blown dot, not a pool. From 120 cm
   * the inverse square has 330 cm to spread over and the same energy reads as a 420 cm
   * pool, comfortably inside the 800 cm station spacing so the ceiling gains rhythm
   * rather than a flat wash.
   *
   * Aimed up it also grazes standing bodies from below, which — with the inward washes —
   * is the only light in the whole rig that arrives at a coat or a face from anywhere
   * other than straight overhead.
   */
  ceilingBounce: Object.freeze({
    z: 120.0,
    gain: 0.055, // of the ceiling spot's candelas
    attenuationRadius: 700.0,
    innerConeDeg: 26.0,
    outerConeDeg: 52.0, // 330 cm of throw x tan 52 = a 422 cm pool
  }),

  /**
   * Alternate stations throw INWARD across the platform instead of outward across the pit.
   *
   * Every wash the spec authored sits at the platform edge, aims at the far wall and is
   * pitched 30 degrees down, so it lands in one low band at Z=81 and the wall above that
   * is a flat dark smear from end to end. Worse, it means NOTHING in the rig ever crosses
   * the platform horizontally: a standing figure gets pure top-down key, catches it on the
   * crown of the hat and nowhere else, and reads as a black cutout pasted over the frame.
   * That is the verdict that killed the Unreal build, and it is a lighting fault, not a
   * material one — no albedo survives being lit only from 90 degrees above.
   *
   * The inward ones are pitched nearly flat, so they cross at chest height (Z=173 at the
   * opposite platform edge) and run out of attenuation at 1000 cm — before they reach
   * either the floor or the opposite wall. The floor's 7.7:1 pool-to-dark ratio is the
   * best thing in the build and filling it in would be a worse crime than the flatness.
   */
  wallWash: Object.freeze({
    inwardPitchDeg: -8.0,
    inwardAttenuationRadius: 1000.0,
    /**
     * The far tile wall was blowing its own texture out into a blank sheet of paper, and
     * the near wall was a flat dark smear — the same complaint from both ends, which is
     * what a uniform wash looks like at two distances. Turning every other station inward
     * already halves the energy reaching the walls; dimming the survivors ON TOP of that
     * double-dips and just makes the walls evenly darker, which measured 31 -> 22 and is
     * the same failure one stop down. The ones that still face outward run at full
     * strength instead, so the walls get bright bands with dark gaps between them — the
     * pool rhythm the floor already has, rather than one flat value at any exposure.
     */
    outwardGain: 1.0,
  }),

  /**
   * THE CHARACTER KEY — the one light in this rig that is not in the room.
   *
   * Everything above lights the STATION. Nothing above lights a BODY, and the numbers said
   * so: measured on one build, one seed, identical materials, a zombie torso came back at
   * luminance 227 on the wave-1 stair, 125 in the firefight, 86 beside the train and 16 in
   * the boss fight. A 13x spread on one archetype with nothing controlling it, and in the
   * firefight the torso read DARKER than the floor behind it — which is what a body looks
   * like when the only thing lighting it arrives from 90 degrees above and the floor it
   * stands on is taking that same light at normal incidence.
   *
   * The asymmetry was already written down elsewhere in the codebase and nobody had joined
   * the dots: src/weapons/viewmodel.js parents THREE dedicated lights into the view
   * (VIEW.key/fill/rim) for exactly this reason, so that the gun can never go dark no matter
   * where the player is standing. The gun got a rig. The enemies got the ceiling. This is
   * the enemies' half of that bargain — one shadowless lamp riding the camera, so a body is
   * shaded the same whether it is standing in a sodium pool, between two of them, or on a
   * staircase in another bay.
   *
   * Five choices, each of which is the difference between a key and a flashlight:
   *
   * 1. DECAY 0 — NO FALLOFF AT ALL, and a windowed range instead. A body in these frames
   *    stands anywhere from 420 cm (the staged crowd fan in firefight/boss/death, which is
   *    DIM.platformHalfWidth * 0.6) out to about 1150 cm (the crowd on the stair flight in
   *    platform). Inverse square turns that 2.7x of distance into 7.5x of exposure and
   *    decay 1 into 2.7x — both of them WIDER than some of the spread being fixed here.
   *    Decay 0 makes distance stop mattering entirely and hands the shaping to three's
   *    cutoff window, which is a pow4 ramp: 1.00 of this lamp survives at 420 cm, 0.95 at
   *    800, 0.83 at 1100, 0.35 at 1600, and exactly nothing at `distance`. So a body reads
   *    the same at four metres and at eleven, then walks out of it — which is the behaviour
   *    wanted, stated directly, instead of being approximated by an exponent.
   *
   *    It also means this lamp has NO hotspot anywhere in the level, at any range, which is
   *    what makes it safe to hang off a camera that spins: there is no distance at which it
   *    blows a wall, a floor or a body out, so nothing flares as the player turns.
   *
   * 2. BELOW AND OUTBOARD OF THE LENS, NOT ON IT. A lamp exactly at the eye is
   *    retro-reflective: every surface facing the camera gets an identical dose and bodies
   *    come back as flash photography. Offset left and dropped, it arrives about 18 degrees
   *    off axis at crowd distance and slightly from underneath — enough to find the
   *    underside of a brow ridge and a jaw, which are the two features faceParts() authored
   *    and which light from 90 degrees above erases. Under decay 0 the offset costs nothing
   *    but that shaping, because moving the lamp cannot change how much it delivers.
   *
   * 3. WARM, AND STATED AS IRRADIANCE. Under decay 0 `intensity` IS the irradiance, flat,
   *    inside the window — the same idiom NIGHT_RIG uses, only here it needs no arithmetic.
   *    The tint carries a luminance of 0.57, so 1.4 lands about 0.80 on a chest. That is
   *    roughly two fifths of what a sodium pool puts on the slab directly under a tube
   *    (2.08), which is the right size for something that is meant to read as the wet floor
   *    throwing light back up, not as a torch strapped to the player's head. Measured on the
   *    seven gate frames on the way up from nothing: at 1.2 a face in the train doorway got
   *    its brow ridge, sockets, cheekbone and open jaw back, the near vault went 26 -> 32
   *    and the FAR vault did not move at all (21.0, because the window and the grazing angle
   *    both work against it), so the black ceiling the brief protects survives this.
   *
   * 4. IT CANNOT FLATTEN THE FLOOR. Geometry enforces that rather than taste: a torso faces
   *    the lamp square (dot 1.0) while the slab takes it at a graze — 0.38 at crowd distance
   *    from an eye 170 cm up, 0.21 at 500 cm — so a standing body collects three to five
   *    times what the floor it stands on does, and the 7.7:1 pool-to-dark ratio that is the
   *    best thing about this floor survives. Measured, key off vs key on, in one boot of one
   *    build: the slab beside the Conductor moved 56.8 -> 56.9 and the wet slab in train
   *    67.5 -> 68.3. The floor does not know this lamp exists.
   *
   * 5. AND IT IS A CONE, BECAUSE A SPHERE DID FLATTEN THE WALLS. The first build of this was
   *    a point light and the same A/B caught it: in train.png the bodies gained 9% while the
   *    near brick wall gained 48 (59.4 -> 87.8) and the near vault 44 (32.9 -> 47.4). Of
   *    course they did — a wall at the frame edge faces the lens as squarely as a chest
   *    does, and decay 0 gives it the same dose. "Brick falling off into dark" was becoming
   *    "brick", which is the exact charge the Unreal build died on, arriving from the
   *    opposite direction.
   *
   *    So the lamp is aimed. The frame is 90 degrees of VERTICAL fov at 16:9, so it spans
   *    +/-45 degrees up and +/-60.6 across; a 52 degree cone therefore covers the full
   *    height and about six sevenths of the width and runs out in the corners. That is
   *    where the near wall (55 degrees off axis in train), the near vault (47) and the floor
   *    at the player's feet (45 and below) all live, and it is never where a body the player
   *    is looking at lives. The inner cone is wide — 22 degrees — so the middle of the frame
   *    is one flat plateau rather than a bright spot with a ring around it: 100% out to 22
   *    degrees, 90% at 30, 47% at 40, 8% at 48, nothing past 52. A soft vignette of fill,
   *    which is what a lens does anyway, and not a torch circle on the wall.
   *
   *    `distance` is set short of the room on top of that: the far tunnel mouth at 3000+ cm
   *    is outside it entirely, so the deepest point in every frame is still black.
   */
  characterKey: Object.freeze({
    colorHex: 0xdcc3a0,
    /** Decay 0: this is the on-axis irradiance, not a candela figure. See point 3 above. */
    intensity: 1.4,
    decay: 0,
    distance: 2000.0, // reaches the stair crowd at 1150 cm and dies well short of the tunnels
    innerConeDeg: 22.0,
    outerConeDeg: 52.0,
    offset: Object.freeze([-120.0, -45.0, 0.0]), // camera space: outboard left, under the lens
    /** Camera space. Aiming at the view axis rather than straight ahead of the offset lamp
     *  keeps the plateau centred on the crosshair instead of 120 cm to the left of it. */
    aim: Object.freeze([0.0, 0.0, -1000.0]),
  }),

  /** Additive shafts under each down-spot. Real volumetrics cost more than they are worth here. */
  haze: Object.freeze({
    radialSegments: 20,
    heightSegments: 18, // the falloff curve is baked into vertex colours, so it needs rings to live on
    topRadius: 22.0,
    falloffPower: 3.4, // how fast the shaft thins toward the floor; linear reads as cardboard
    bottomZ: -60.0, // runs a little past the platform so the cone never ends in mid-air
    renderOrder: 3,
  }),

  /**
   * One failing fluorescent. Long healthy stretches broken by bursts of stutter is what
   * a dying ballast actually does; an even sine looks like a prop, not a fault.
   */
  flicker: Object.freeze({
    seed: 0xf11c4e,
    steadyMin: 2.4,
    steadyMax: 8.0,
    stutterMin: 0.14,
    stutterMax: 0.95,
    strobeStep: 0.042,
    darkChance: 0.58,
    darkMin: 0.02,
    darkMax: 0.26,
    brightMin: 0.82,
    brightMax: 1.28,
  }),

  shadow: Object.freeze({
    /**
     * WebGPU only guarantees 16 sampled textures per fragment stage, and EVERY material
     * in the scene pays for EVERY shadow-casting light — measured at 2 bindings each on
     * Apple silicon. Seven shadow-casting ceiling spots put a three-map material at 19
     * and the pipeline silently fails to compile, which renders the whole station
     * invisible. Four casters leaves a material room for seven of its own textures,
     * which is enough headroom for the zombies, weapons and train to be authored
     * without tripping over the station's rig. Raise this only alongside a
     * `requiredLimits: { maxSampledTexturesPerShaderStage }` on the device request.
     */
    maxCasters: 4,
    mapSize: 2048, // resolution is free in binding terms, so spend it here instead
    near: 40.0,
    bias: -0.0005,
    normalBias: 6.0, // centimetres; acne on a 6000 cm room needs a real-world offset
  }),
})

/**
 * The night rig — four lights that exist because the station now has an OUTSIDE.
 *
 * sky.js hangs a moon, a city and two fields of rain above the light well. None of that is
 * lit by the station's 28 sodium lamps, and none of the station's lamps may be allowed to
 * reach up into it either, so this is a second, separate rig with one rule governing every
 * number in it:
 *
 * **Every attenuation radius here is shorter than the distance from that light to the
 * platform slab.** Not dimmer — SHORTER. three's point and spot lights do not respect
 * walls, so the only thing standing between a moon hung 31 m up and a washed-out platform
 * is the radius at which its contribution is cut to zero. The warm sodium hall downstairs
 * and the cold night upstairs share a building and share no photons, and that is enforced
 * arithmetically rather than by eye — see the assertion at the end of `createLighting`.
 *
 * The one light that does reach indoors is `well-moon`, and it stops 900 cm short of the
 * slab: it lands on the balcony deck and the lip of the void and goes out there, which is
 * the cold edge at the top of the frame, not a wash across the floor.
 */
const NIGHT_RIG = Object.freeze({
  moonColorHex: 0x9ec2ff,
  streetColorHex: 0xff9a3c,

  /** The moon, as a lamp: one wide cold spot standing 21 m over the pavement. */
  moonKey: Object.freeze({
    position: Object.freeze([500.0, 900.0, 3100.0]), // spec cm
    aim: Object.freeze([400.0, 0.0, 0.0]), // z is filled in from the sky's own street height
    coneDeg: 44.0,
    penumbra: 0.75,
    /** Chosen so the pavement reads at roughly a third of a sodium pool — moonlit, not lit. */
    irradiance: 0.3,
    attenuationRadius: 2450.0, // 2620 cm to the slab, so the platform is out of range by 170
  }),

  /** Two sodium heads over the pavement. Warm, because a real street lamp is the same lamp. */
  streetLamps: Object.freeze([
    Object.freeze([1150.0, -520.0, 1180.0]),
    Object.freeze([-260.0, 470.0, 1180.0]),
  ]),
  streetLamp: Object.freeze({
    intensityGain: 2.4, // x the spec's ambient-fill candelas
    attenuationRadius: 1000.0, // the lamp hangs 1180 above the slab; the slab is out of range
  }),

  /**
   * The cue the whole thing is for: cold light falling INTO the building, down the shaft
   * and through the balcony's void.
   *
   * **Decay 1, not 2**, and the reason is the same one station.js wrote down for its
   * daylight heads: this shaft is nine metres deep and an inverse-square lamp cannot light
   * it. Hung under the grating on decay 2, whatever reaches the balcony 6.5 m below has
   * already put nine times that on anything standing at gantry height 2 m below — and
   * there IS something standing there now, because the summit gantry sits at Z 690 inside
   * this well. Decay 1 makes that 3:1 instead of 9:1, which is what a hole in a pavement
   * actually looks like from underneath.
   *
   * So the brightness is stated as the irradiance it lands at the VOID with, and the
   * candela figure is derived from the throw — the same idiom, so the two rigs can be
   * compared line to line.
   */
  wellMoon: Object.freeze({
    position: Object.freeze([700.0, 0.0, 900.0]),
    aim: Object.freeze([720.0, 0.0, 250.0]),
    coneDeg: 34.0,
    penumbra: 0.6,
    /**
     * Measured down from 0.30 against the summit frame, which came back at lum 131 with the
     * shaft washed to cream. This lamp sits 210 cm over the gantry deck and station.js
     * already hangs three daylight heads in the same 7 m of air; a cold rim on top of that
     * is the job, a second key light is not. At 0.18 it lands about a twelfth of a sodium
     * pool on the void and reads as colour rather than as exposure.
     */
    voidIrradiance: 0.18,
    attenuationRadius: 700.0, // 900 cm to the slab, so the platform stays out of it
  }),

  /**
   * And the sodium leaking in over it, high on the shaft's west wall. It never gets below
   * Z 510, so the warm/cold order of the building is preserved: sodium hall, cold shaft,
   * sodium street — with one warm smear up top to say where the cold is NOT coming from.
   */
  streetLeak: Object.freeze({
    position: Object.freeze([240.0, -210.0, 830.0]),
    gain: 0.16, // x the spec's ambient-fill candelas; trimmed with wellMoon, same frame, same reason
    attenuationRadius: 320.0,
  }),
})

const candela = (unrealIntensity) => unrealIntensity * FX.LIGHT_INTENSITY_SCALE

/** three's SpotLight takes the outer half-angle plus a 0..1 blend in from the inner one. */
const penumbraFrom = (innerDeg, outerDeg) => Math.max(0, 1 - innerDeg / outerDeg)

const linearColor = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace)

/** X positions of the seven light stations: 400, 1200, ... 5200. */
function lightStationXs() {
  const xs = []
  for (let i = 0; i < COUNTS.lightStations; i++) xs.push(LIGHTING.firstX + i * LIGHTING.spacing)
  return xs
}

/**
 * A hollow cone of additive haze, coloured bright at the tube and fading to nothing at
 * the floor. The gradient lives in vertex colours so all seven can share one geometry
 * and one instanced draw call, with per-instance colour left free for the flicker.
 */
function buildHazeGeometry(color) {
  const top = LIGHTING.lightStrip.z
  const bottom = RIG.haze.bottomZ
  const height = top - bottom
  const spread = Math.tan(LIGHTING.ceilingSpot.innerConeDeg * deg)
  const bottomRadius = RIG.haze.topRadius + height * spread

  const geometry = new THREE.CylinderGeometry(
    RIG.haze.topRadius,
    bottomRadius,
    height,
    RIG.haze.radialSegments,
    RIG.haze.heightSegments,
    true,
  )

  const position = geometry.getAttribute('position')
  const colors = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const t = position.getY(i) / height + 0.5 // 0 at the floor, 1 at the tube
    // Steep falloff: near the tube the air is thick with light, a body-length down it is a hint.
    const fade = Math.pow(t, RIG.haze.falloffPower) * Math.max(ATMOSPHERE.hazeIntensity, RIG.hazeMinIntensity)
    colors[i * 3] = color.r * fade
    colors[i * 3 + 1] = color.g * fade
    colors[i * 3 + 2] = color.b * fade
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

function addInstances(parent, geometry, material, transforms) {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length)
  const matrix = new THREE.Matrix4()
  transforms.forEach((position, i) => {
    matrix.makeTranslation(position.x, position.y, position.z)
    mesh.setMatrixAt(i, matrix)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = false
  mesh.receiveShadow = false
  parent.add(mesh)
  return mesh
}

/**
 * Build the whole rig into `scene` and return the handle the station hands on to the
 * game loop. `update(dt)` must be called every frame or the failing tube never fails.
 */
export function createLighting(scene, materials) {
  const group = new THREE.Group()
  group.name = 'station-lighting'
  scene.add(group)

  // --- atmosphere -----------------------------------------------------------
  // engine.js boots with a placeholder FogExp2 tuned for a metre-scale test scene; at
  // centimetre scale that density fogs out at arm's length, so the real level replaces it.
  scene.background = new THREE.Color(ATMOSPHERE.backgroundHex)
  scene.fog = new THREE.FogExp2(ATMOSPHERE.fogColorHex, Math.max(ATMOSPHERE.fogDensity, RIG.fogMinDensity))

  const environment = createEnvironmentTexture()
  if (environment) {
    scene.environment = environment
    scene.environmentIntensity = RIG.environmentIntensity
  }

  // --- the two level-placed lights (section 1 of the spec) ------------------
  const ambient = new THREE.AmbientLight(LIGHTING.skyAmbient.colorHex, LIGHTING.skyAmbient.intensity)
  ambient.name = 'sky-ambient'
  group.add(ambient)

  const sun = new THREE.DirectionalLight(LIGHTING.directional.colorHex, LIGHTING.directional.intensity)
  sun.name = 'directional-fill'
  sun.position.copy(v3(...LIGHTING.directional.position))
  // pitch -60 with yaw 0 means "along +X and down" in the spec frame
  const sunPitch = LIGHTING.directional.pitchDeg * deg
  sun.target.position.copy(
    v3(
      LIGHTING.directional.position[0] + Math.cos(sunPitch) * 1000,
      LIGHTING.directional.position[1],
      LIGHTING.directional.position[2] + Math.sin(sunPitch) * 1000,
    ),
  )
  sun.castShadow = LIGHTING.directional.castsShadow
  group.add(sun)
  group.add(sun.target)

  // --- the 28 station lights ------------------------------------------------
  const xs = lightStationXs()
  const ceilingSpots = []
  const ceilingBounces = []
  const ambientFills = []
  const wallWashes = []

  const spotColor = linearColor(LIGHTING.ceilingSpot.colorLinear)
  const fillColor = linearColor(LIGHTING.ambientFill.colorLinear)
  const washColor = linearColor(LIGHTING.wallWash.colorLinear)

  // Shadows go to the bays nearest the station centre — where the player spawns and
  // where the fight happens — rather than to the tunnel ends, which are meant to be murk.
  const shadowCasters = new Set(
    xs
      .map((x, i) => i)
      .sort((a, b) => Math.abs(xs[a] - DIM.length * 0.5) - Math.abs(xs[b] - DIM.length * 0.5))
      .slice(0, RIG.shadow.maxCasters),
  )

  xs.forEach((x, index) => {
    const spot = new THREE.SpotLight(
      spotColor,
      candela(LIGHTING.ceilingSpot.intensity),
      LIGHTING.ceilingSpot.attenuationRadius,
      LIGHTING.ceilingSpot.outerConeDeg * deg,
      penumbraFrom(LIGHTING.ceilingSpot.innerConeDeg, LIGHTING.ceilingSpot.outerConeDeg),
      2,
    )
    spot.name = `ceiling-spot-${x}`
    spot.position.copy(v3(x, 0, LIGHTING.ceilingSpot.z))
    spot.target.position.copy(v3(x, 0, LEVELS.trackFloorZ))
    spot.castShadow = LIGHTING.ceilingSpot.castsShadow && shadowCasters.has(index)
    if (spot.castShadow) {
      spot.shadow.mapSize.set(RIG.shadow.mapSize, RIG.shadow.mapSize)
      spot.shadow.camera.near = RIG.shadow.near
      spot.shadow.camera.far = LIGHTING.ceilingSpot.attenuationRadius
      spot.shadow.bias = RIG.shadow.bias
      spot.shadow.normalBias = RIG.shadow.normalBias
    }
    group.add(spot)
    group.add(spot.target)
    ceilingSpots.push(spot)

    // The only thing in the rig aimed at the ceiling. See RIG.ceilingBounce.
    const bounce = new THREE.SpotLight(
      spotColor,
      candela(LIGHTING.ceilingSpot.intensity) * RIG.ceilingBounce.gain,
      RIG.ceilingBounce.attenuationRadius,
      RIG.ceilingBounce.outerConeDeg * deg,
      penumbraFrom(RIG.ceilingBounce.innerConeDeg, RIG.ceilingBounce.outerConeDeg),
      2,
    )
    bounce.name = `ceiling-bounce-${x}`
    bounce.position.copy(v3(x, 0, RIG.ceilingBounce.z))
    bounce.target.position.copy(v3(x, 0, LEVELS.wallTopZ))
    // Shadowless, so it costs no sampled-texture bindings and never touches RIG.shadow.maxCasters.
    bounce.castShadow = false
    group.add(bounce)
    group.add(bounce.target)
    ceilingBounces.push(bounce)

    const fill = new THREE.PointLight(
      fillColor,
      candela(LIGHTING.ambientFill.intensity),
      LIGHTING.ambientFill.attenuationRadius,
      2,
    )
    fill.name = `ambient-fill-${x}`
    fill.position.copy(v3(x, 0, LIGHTING.ambientFill.z))
    fill.castShadow = LIGHTING.ambientFill.castsShadow
    group.add(fill)
    ambientFills.push(fill)

    for (const side of [1, -1]) {
      // Odd stations turn round and cross the platform at chest height. See RIG.wallWash.
      const inward = index % 2 === 1
      const yawDeg =
        (inward ? -1 : 1) * (side > 0 ? LIGHTING.wallWash.yawNorthDeg : LIGHTING.wallWash.yawSouthDeg)
      const yaw = yawDeg * deg
      const pitch = (inward ? RIG.wallWash.inwardPitchDeg : LIGHTING.wallWash.pitchDeg) * deg
      const originY = LIGHTING.wallWash.y * side
      const radius = inward ? RIG.wallWash.inwardAttenuationRadius : LIGHTING.wallWash.attenuationRadius

      const wash = new THREE.SpotLight(
        washColor,
        candela(LIGHTING.wallWash.intensity) * (inward ? 1 : RIG.wallWash.outwardGain),
        radius,
        LIGHTING.wallWash.outerConeDeg * deg,
        penumbraFrom(LIGHTING.wallWash.innerConeDeg, LIGHTING.wallWash.outerConeDeg),
        2,
      )
      wash.name = `wall-wash-${x}-${side > 0 ? 'n' : 's'}-${inward ? 'in' : 'out'}`
      wash.position.copy(v3(x, originY, LIGHTING.wallWash.z))
      const reach = radius
      wash.target.position.copy(
        v3(
          x + Math.cos(pitch) * Math.cos(yaw) * reach,
          originY + Math.cos(pitch) * Math.sin(yaw) * reach,
          LIGHTING.wallWash.z + Math.sin(pitch) * reach,
        ),
      )
      wash.castShadow = LIGHTING.wallWash.castsShadow
      group.add(wash)
      group.add(wash.target)
      wallWashes.push(wash)
    }
  })

  // --- tunnel mouth spill ---------------------------------------------------
  const tunnelSpills = []
  for (const x of [RIG.tunnelSpill.insetX, DIM.length - RIG.tunnelSpill.insetX]) {
    for (const side of [1, -1]) {
      const spill = new THREE.PointLight(
        new THREE.Color(RIG.tunnelSpill.colorHex),
        candela(RIG.tunnelSpill.intensity),
        RIG.tunnelSpill.attenuationRadius,
        2,
      )
      spill.name = `tunnel-spill-${x}-${side > 0 ? 'n' : 's'}`
      spill.position.copy(v3(x, LEVELS.pitCentreY * side, RIG.tunnelSpill.z))
      group.add(spill)
      tunnelSpills.push(spill)
    }
  }

  // --- the night above ------------------------------------------------------
  // sky.js builds the sky, the weather and the pavement; this builds what lights them, and
  // what carries a little of that light back down the stairwell. See NIGHT_RIG for why
  // every radius here is a distance rather than a preference.
  let sky = null
  try {
    sky = initSky(scene, null) // createLighting is handed a scene and materials, never the renderer
  } catch (err) {
    console.warn('[lighting] the night sky could not be built; the station keeps its sealed-tunnel look.', err)
    sky = null
  }

  const streetZ = sky?.streetZ ?? LEVELS.ceilingTopZ + 470 // the light-well cap's own top face
  const nightLights = []

  const moonColor = new THREE.Color(NIGHT_RIG.moonColorHex)
  const streetColor = new THREE.Color(NIGHT_RIG.streetColorHex)

  const moonSpec = NIGHT_RIG.moonKey
  const moonThrow = Math.hypot(
    moonSpec.aim[0] - moonSpec.position[0],
    moonSpec.aim[1] - moonSpec.position[1],
    streetZ - moonSpec.position[2],
  )
  const moon = new THREE.SpotLight(
    moonColor,
    moonSpec.irradiance * moonThrow * moonThrow, // decay 2: irradiance = I / d^2
    moonSpec.attenuationRadius,
    moonSpec.coneDeg * deg,
    moonSpec.penumbra,
    2,
  )
  moon.name = 'moon-key'
  moon.position.copy(v3(...moonSpec.position))
  moon.target.position.copy(v3(moonSpec.aim[0], moonSpec.aim[1], streetZ))
  moon.castShadow = false // shadowless: RIG.shadow.maxCasters is a hard WebGPU binding budget
  group.add(moon)
  group.add(moon.target)
  nightLights.push(moon)

  for (const [i, position] of NIGHT_RIG.streetLamps.entries()) {
    const lamp = new THREE.PointLight(
      streetColor,
      candela(LIGHTING.ambientFill.intensity) * NIGHT_RIG.streetLamp.intensityGain,
      NIGHT_RIG.streetLamp.attenuationRadius,
      2,
    )
    lamp.name = `street-lamp-${i}`
    lamp.position.copy(v3(...position))
    group.add(lamp)
    nightLights.push(lamp)
  }

  const wellSpec = NIGHT_RIG.wellMoon
  const wellThrow = Math.hypot(
    wellSpec.aim[0] - wellSpec.position[0],
    wellSpec.aim[1] - wellSpec.position[1],
    wellSpec.aim[2] - wellSpec.position[2],
  )
  const wellMoon = new THREE.SpotLight(
    moonColor,
    wellSpec.voidIrradiance * wellThrow, // decay 1: irradiance = I / d. See NIGHT_RIG.wellMoon.
    wellSpec.attenuationRadius,
    wellSpec.coneDeg * deg,
    wellSpec.penumbra,
    1,
  )
  wellMoon.name = 'well-moon'
  wellMoon.position.copy(v3(...wellSpec.position))
  wellMoon.target.position.copy(v3(...wellSpec.aim))
  wellMoon.castShadow = false
  group.add(wellMoon)
  group.add(wellMoon.target)
  nightLights.push(wellMoon)

  const leakSpec = NIGHT_RIG.streetLeak
  const streetLeak = new THREE.PointLight(
    streetColor,
    candela(LIGHTING.ambientFill.intensity) * leakSpec.gain,
    leakSpec.attenuationRadius,
    2,
  )
  streetLeak.name = 'street-leak'
  streetLeak.position.copy(v3(...leakSpec.position))
  group.add(streetLeak)
  nightLights.push(streetLeak)

  // The rule NIGHT_RIG is built on, checked rather than trusted: nothing up there may reach
  // the slab. A radius that outgrows its own height is how "cold light from the exit"
  // quietly becomes "the platform went blue".
  for (const light of nightLights) {
    const height = light.position.y - LEVELS.platformTopZ
    if (light.distance > 0 && light.distance >= height) {
      console.warn(
        `[lighting] ${light.name} reaches ${light.distance} cm from ${height.toFixed(0)} cm up — ` +
          'it can touch the platform, and the warm-below/cold-above contrast is what the night is for.',
      )
    }
  }

  // --- the character key ----------------------------------------------------
  // See RIG.characterKey. It hangs off the CAMERA, not off `group`, so it rides the eye —
  // including the cinematic eye, which is the same camera object the view model is parented
  // to. player.js adds that camera to the scene, and it may not exist yet when the station
  // is built, so the mount is retried from update() until it takes.
  const keySpec = RIG.characterKey
  const characterKey = new THREE.SpotLight(
    new THREE.Color(keySpec.colorHex),
    keySpec.intensity,
    keySpec.distance,
    keySpec.outerConeDeg * deg,
    penumbraFrom(keySpec.innerConeDeg, keySpec.outerConeDeg),
    keySpec.decay,
  )
  characterKey.name = 'character-key'
  characterKey.position.set(...keySpec.offset)
  characterKey.target.position.set(...keySpec.aim)
  // Shadowless, like the view model's own three: RIG.shadow.maxCasters is a hard WebGPU
  // binding budget, and a shadow map from a lamp half a metre off the lens is all acne.
  characterKey.castShadow = false
  // RESERVED, not costly. This is a camera-space fixture sized in irradiance (1.4) next to
  // spots running 122,880-1,594,320 cd — the same 30x-plus working-distance mismatch that
  // sorted the viewmodel's rig permanently last and left the gun unlit (see
  // optimize.reserveFromLightBudget). Without this call the character key is just another
  // COSTLY light and, being the dimmest in the whole rig, ALWAYS loses limitLights()'s
  // intensity sort and is dropped at every quality tier.
  reserveFromLightBudget(characterKey)

  let characterKeyMounted = false
  function mountCharacterKey() {
    if (characterKeyMounted) return true
    // Direct child first — that is where player.js puts it — then a deep search, so a later
    // refactor that nests the camera does not silently drop the only light bodies have.
    const camera =
      scene.children.find((child) => child.isCamera) ?? scene.getObjectByProperty('isCamera', true)
    if (!camera) return false
    camera.add(characterKey)
    camera.add(characterKey.target) // the cone aims in WORLD space, so the target rides the eye too
    characterKeyMounted = true
    return true
  }
  mountCharacterKey()

  // --- fixtures: the emissive tube, its pan and its cheeks -------------------
  const strip = LIGHTING.lightStrip
  const stripGeometry = new THREE.BoxGeometry(
    strip.halfExtent[0] * 2,
    strip.halfExtent[2] * 2, // spec Z half-extent becomes three Y
    strip.halfExtent[1] * 2,
  )

  const flickerIndex = new Rng(RIG.flicker.seed).int(0, COUNTS.lightStations - 1)
  // The failing tube needs its own material instance so its emissive can be driven
  // independently of the six healthy ones, which share a single material.
  const flickerStripMaterial = materials.lightStrip.clone()
  // Cloned SO THAT it can be mutated alone. dedupeMaterials would otherwise merge it back
  // into the strip material it was cloned from, and every tube in the station would flicker.
  flickerStripMaterial.userData.noDedupe = true

  const strips = xs.map((x, i) => {
    const mesh = new THREE.Mesh(stripGeometry, i === flickerIndex ? flickerStripMaterial : materials.lightStrip)
    mesh.name = `light-strip-${x}`
    mesh.position.copy(v3(x, 0, strip.z))
    group.add(mesh)
    return mesh
  })

  const panGeometry = new THREE.BoxGeometry(
    RIG.housingPan.half[0] * 2,
    RIG.housingPan.half[2] * 2,
    RIG.housingPan.half[1] * 2,
  )
  addInstances(
    group,
    panGeometry,
    materials.lightHousing,
    xs.map((x) => v3(x, 0, RIG.housingPan.z)),
  ).name = 'light-housing-pans'

  const cheekGeometry = new THREE.BoxGeometry(
    RIG.housingCheek.half[0] * 2,
    RIG.housingCheek.half[2] * 2,
    RIG.housingCheek.half[1] * 2,
  )
  const cheekPositions = []
  for (const x of xs) {
    cheekPositions.push(v3(x, RIG.housingCheek.y, RIG.housingCheek.z))
    cheekPositions.push(v3(x, -RIG.housingCheek.y, RIG.housingCheek.z))
  }
  addInstances(group, cheekGeometry, materials.lightHousing, cheekPositions).name = 'light-housing-cheeks'

  // --- light shafts ---------------------------------------------------------
  const hazeGeometry = buildHazeGeometry(spotColor)
  const hazeCentreZ = (strip.z + RIG.haze.bottomZ) * 0.5
  // Seven separate meshes rather than one instanced draw: the failing tube's shaft needs
  // its own shader uniform, and a custom colorNode bypasses per-instance colour.
  const hazeFlickerLevel = uniform(1)
  const hazeFlickerMaterial = materials.haze.clone()
  hazeFlickerMaterial.userData.noDedupe = true   // same reason as the strip: it is driven per frame
  hazeFlickerMaterial.colorNode = materials.haze.colorNode.mul(hazeFlickerLevel)
  const hazeMeshes = xs.map((x, i) => {
    const node = new THREE.Mesh(hazeGeometry, i === flickerIndex ? hazeFlickerMaterial : materials.haze)
    node.name = `light-shaft-${x}`
    node.position.copy(v3(x, 0, hazeCentreZ))
    node.renderOrder = RIG.haze.renderOrder
    group.add(node)
    return node
  })

  // --- the failing tube -----------------------------------------------------
  const flickerRng = new Rng(RIG.flicker.seed ^ 0x2b2b)
  const baseSpotIntensity = candela(LIGHTING.ceilingSpot.intensity)
  const baseEmissive = strip.emissiveIntensity
  const flicker = {
    stuttering: false,
    // The opening stretch is pinned to the longest steady interval rather than drawn,
    // so the headless frame gate always captures the rig in its lit state. After that
    // the seeded stream takes over and the sequence is still reproducible run to run.
    remaining: RIG.flicker.steadyMax,
    strobeRemaining: 0,
    level: 1,
  }

  function applyFlickerLevel(level) {
    flicker.level = level
    ceilingSpots[flickerIndex].intensity = baseSpotIntensity * level
    flickerStripMaterial.emissiveIntensity = baseEmissive * level
    hazeFlickerLevel.value = level
  }

  function update(dt) {
    sky?.update(dt) // the weather runs on its own clock; the failing tube must not gate it
    if (!characterKeyMounted) mountCharacterKey()
    if (!(dt > 0)) return
    flicker.remaining -= dt
    if (flicker.remaining <= 0) {
      flicker.stuttering = !flicker.stuttering
      flicker.remaining = flicker.stuttering
        ? flickerRng.range(RIG.flicker.stutterMin, RIG.flicker.stutterMax)
        : flickerRng.range(RIG.flicker.steadyMin, RIG.flicker.steadyMax)
      flicker.strobeRemaining = 0
      if (!flicker.stuttering) applyFlickerLevel(1)
    }
    if (!flicker.stuttering) return

    flicker.strobeRemaining -= dt
    if (flicker.strobeRemaining > 0) return
    flicker.strobeRemaining = RIG.flicker.strobeStep
    const level = flickerRng.chance(RIG.flicker.darkChance)
      ? flickerRng.range(RIG.flicker.darkMin, RIG.flicker.darkMax)
      : flickerRng.range(RIG.flicker.brightMin, RIG.flicker.brightMax)
    applyFlickerLevel(level)
  }

  // The spec count below deliberately excludes the bounces: they are a presentation
  // addition like the spills, not one of the original's 28.
  const lights = [
    ambient, sun,
    ...ceilingSpots, ...ceilingBounces, ...ambientFills, ...wallWashes, ...tunnelSpills,
    ...nightLights, characterKey,
  ]
  if (ceilingSpots.length + ambientFills.length + wallWashes.length !== COUNTS.totalLights) {
    console.warn(
      `[lighting] built ${ceilingSpots.length + ambientFills.length + wallWashes.length} spec lights, ` +
        `expected ${COUNTS.totalLights} — the station will not match the original's look.`,
    )
  }
  /**
   * Cull the rig to fit the quality tier.
   *
   * Every light in a WebGPU forward pass costs per-fragment work on every lit surface, so a
   * 44-light rig is paid on every pixel of every frame. The rig was built by agents told to
   * push the lighting, with no frame budget given to any of them — it looks superb on a
   * screenshot and locked up an M4 Max in play.
   *
   * Shadow casters go first (each is an extra depth pass), then the presentation extras
   * (bounces, washes, fills) which shape the look but are not the spec's 28. The ceiling
   * spots that define the platform's pool-and-dark rhythm are thinned last and evenly, so a
   * culled station still reads as lit from above rather than going flat.
   */
  const tier = globalThis.__SHOE_QUALITY__ ?? 'medium'
  if (tier !== 'high') {
    /**
     * REMOVE the light, do not hide it. Setting visible=false leaves it in the scene graph,
     * and three's WebGPU path still walks every light each frame building lighting node
     * structures — the cost is paid per light per object regardless of visibility. Measured
     * 120 lights against 480 visible meshes, with the allocation churn showing up as
     * three-internal update/updateNumber/getAttributes traffic and an 8.6 MB/sec garbage
     * rate that forced a ~200ms stop-the-world collection roughly three times a second.
     */
    const drop = light => {
      light.visible = false
      light.intensity = 0
      light.castShadow = false
      light.parent?.remove(light)
      if (light.target?.parent) light.target.parent.remove(light.target)
      light.dispose?.()
    }
    const thin = (arr, keepEvery) => arr.forEach((l, i) => { if (i % keepEvery !== 0) drop(l) })

    if (tier === 'low') {
      ceilingBounces.forEach(drop)
      wallWashes.forEach(drop)
      ambientFills.forEach(drop)
      thin(ceilingSpots, 2)                          // every other lamp
      ceilingSpots.forEach(l => { l.castShadow = false })
      nightLights.forEach((l, i) => { if (i > 0) drop(l) })   // keep the moon only
    } else {
      thin(ceilingBounces, 2)
      thin(wallWashes, 2)
      ceilingSpots.forEach((l, i) => { if (i % 3 !== 0) l.castShadow = false })
    }
    const live = lights.filter(l => l.visible !== false).length
    console.info(`[lighting] quality=${tier} culled ${lights.length - live} of ${lights.length} lights`)
  }

  console.info(
    `[lighting] ${COUNTS.totalLights} spec lights + ${tunnelSpills.length} tunnel spills ` +
      `+ ${ceilingBounces.length} ceiling bounces + ${nightLights.length} night lights ` +
      `+ 1 character key ${characterKeyMounted ? 'on the camera' : 'WAITING FOR A CAMERA'}, ` +
      `${shadowCasters.size}/${xs.length} spots casting shadows (WebGPU sampled-texture budget), ` +
      `tube ${flickerIndex} (x=${xs[flickerIndex]}) is the bad one`,
  )

  return {
    group,
    lights,
    ceilingSpots,
    ceilingBounces,
    ambientFills,
    wallWashes,
    tunnelSpills,
    nightLights,
    /** The one light that rides the eye instead of the room. See RIG.characterKey. */
    characterKey,
    /** The sky, the rain and the pavement. Null only if the whole night pass failed to build. */
    sky,
    strips,
    haze: hazeMeshes,
    flickerIndex,
    /** Live state of the failing tube, so FX and audio can sync to the same stutter. */
    flicker,
    /** Geometry primitives this rig owns: the 7 spec light strips, plus 21 added fixture parts. */
    specPrimitives: strips.length,
    addedPrimitives: xs.length * 3,
    update,
    dispose() {
      stripGeometry.dispose()
      panGeometry.dispose()
      cheekGeometry.dispose()
      hazeGeometry.dispose()
      flickerStripMaterial.dispose()
      hazeFlickerMaterial.dispose()
      environment?.dispose()
      sky?.dispose()
      // It is parented to the camera, not to `group`, so removing the group leaves it behind.
      characterKey.target.parent?.remove(characterKey.target)
      characterKey.parent?.remove(characterKey)
      characterKey.dispose?.()
      scene.remove(group)
    },
  }
}
