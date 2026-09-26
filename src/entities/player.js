/**
 * player.js — the body, the view, and the shot.
 *
 * Ports ShoeCharacter plus the walking half of UCharacterMovementComponent from the abandoned
 * UE5 build. The movement solver in spec/player.md §2.3 is reproduced step for step, because
 * that solver is the entire reason the original felt snappy rather than floaty: steering
 * friction reorients velocity without bleeding speed, and a separate sub-stepped braking pass
 * kills it in about a fifth of a second when the keys come up.
 *
 * Health maths are NOT here. The player owns a HealthPool from ../game/health.js and asks it
 * questions; the 50% armor absorption, the batched overfill decay and the burn stacks all live
 * in that one shared module because zombies use the same model.
 *
 * ---------------------------------------------------------------------------
 * The `world` argument to update() / fire() — the boundary with src/world/**.
 * ---------------------------------------------------------------------------
 *   world.colliders   Array of Box3-like { min:{x,y,z}, max:{x,y,z} } in world centimetres.
 *                     MUST include moving geometry (the train) — this module re-reads the
 *                     array every frame and never caches a box.
 *                     `world.getColliders()` is accepted as an alternative.
 *   world.zombies     Array of zombie entities. Each needs `.position` (Vector3),
 *                     `.capsuleRadius` and `.capsuleHalfHeight` as EFFECTIVE (already scaled)
 *                     centimetres, and an aliveness tell: `.alive === false`, `.isDead`, or
 *                     `.health.isDead`. `world.getZombies()` is accepted as an alternative.
 *
 * ---------------------------------------------------------------------------
 * The boundary with src/weapons/** and src/fx/**.
 * ---------------------------------------------------------------------------
 *   The player owns the trace, not the gun. Per spec §2.8 every hitscan shot starts at the
 *   camera and runs along camera-forward, so the crosshair cannot lie. The weapon module owns
 *   ammo, fire rate and reload; when it decides a shot is legal it reads `player.firePressed`
 *   / `player.fireHeld` and calls `player.fire(world, weaponRules)`. That call emits
 *   EV.WEAPON_FIRE exactly once, from here, carrying the resolved hits.
 *
 *   Camera shake belongs to src/fx/**. It writes `player.shakeOffset` (cm, camera-local) and
 *   `player.shakeEuler` (radians) each frame and this module folds them into the view
 *   transform. Nothing here generates shake.
 */

import * as THREE from 'three/webgpu'
import { PLAYER, HEALTH, DAMAGE, WEAPONS, STATION, ZOMBIES, UNITS } from '../game/rules.js'
import { HealthPool } from '../game/health.js'
import { NEUTRAL } from '../core/input.js'
import { bus, EV } from '../core/events.js'
import { rng } from '../core/rng.js'

const MOVE = PLAYER.MOVEMENT
const CAM = PLAYER.CAMERA
const LOOK = PLAYER.INPUT
const PIT = PLAYER.PIT
const ZONES = DAMAGE.zones
const ZONE_GEO = DAMAGE.hitZoneGeometry

const TAU = Math.PI * 2
const DEG = Math.PI / 180

/**
 * Source yaw 0 faces +X; a three.js camera at yaw 0 looks down -Z. This quarter turn lets
 * PLAYER.SPAWN.yaw and every other authored heading be used exactly as the original wrote it.
 */
const SOURCE_YAW_OFFSET = -Math.PI / 2

/**
 * Engine constants the movement solver needs that rules.js does not carry, because they are
 * internal to UCharacterMovementComponent rather than project-authored balance. The spread
 * lets rules.js take them over if PLAYER.MOVEMENT.ENGINE is ever added.
 */
const ENGINE = Object.freeze({
  brakeToStopSpeed: 0.1, // CharacterMovementComponent.cpp BRAKE_TO_STOP_VELOCITY — cm/s
  minTickTime: 1e-6, // CharacterMovementComponent.cpp MIN_TICK_TIME
  brakingSubStepMin: 1 / 75, // CharacterMovementComponent.cpp:4400 — lower clamp on the sub-step
  brakingSubStepMax: 1 / 20, // CharacterMovementComponent.cpp:4400 — upper clamp on the sub-step
  ...(MOVE.ENGINE ?? {}),
})

/**
 * Feel constants. The original had none of these — UE gave it no view bob, no landing dip and
 * no weapon sway, and the build was abandoned before anyone noticed how dead that reads in a
 * browser. Every number here is CHOSEN: not in original spec. They belong in rules.js under
 * PLAYER.FEEL; the spread lets rules.js take them over the moment that block exists.
 */
export const FEEL = Object.freeze({
  bobCyclesPerSecondAtWalk: 1.9, // CHOSEN — full stride cycles/s at MOVE.walkSpeed
  bobVertical: 3.4, // CHOSEN — cm the camera rises and falls at walk pace
  bobLateral: 2.2, // CHOSEN — cm of side sway, at half the vertical rate so it reads as a gait
  bobRollDegrees: 0.6, // CHOSEN — the roll is what makes a walk feel weighted rather than wobbly
  bobSprintScale: 1.4, // CHOSEN — sprint exaggerates the gait, it does not only speed it up
  bobBlendRate: 9.0, // CHOSEN — per-second approach to the target gait weight; stops it snapping on
  bobMinSpeedFraction: 0.08, // CHOSEN — below this fraction of walk speed there is no gait at all

  landingDipPerSpeed: 0.05, // CHOSEN — cm of dip per cm/s of downward impact speed
  landingDipMax: 15.0, // CHOSEN — cm; a fall into the 250 cm track pit must not bury the camera
  landingDipStiffness: 170.0, // CHOSEN — spring omega^2; ~0.48 s natural period, snappy not squishy
  landingDipDamping: 26.0, // CHOSEN — 2*sqrt(stiffness), critically damped: settles without bouncing
  takeoffLift: 2.0, // CHOSEN — cm the camera pops up on the jump frame, which sells the push-off

  crouchBlendRate: 12.0, // CHOSEN — per-second approach of the eye toward its target height

  swayPerRadian: 30.0, // CHOSEN — cm the view model lags behind a radian of look delta
  swayStrafeRate: 22.0, // CHOSEN — cm/s of lean the gun takes while strafing
  swayMax: 10.0, // CHOSEN — cm; past this the gun leaves the frame
  swayReturnRate: 11.0, // CHOSEN — per-second spring back to centre
  swayRotationPerCm: 0.012, // CHOSEN — radians of view-model twist per cm of lag
  swayRollPerCm: 0.02, // CHOSEN — radians of view-model roll per cm of lateral lag
  viewModelBobScale: 0.55, // CHOSEN — the gun bobs less than the head or it reads as detached
  viewModelDipScale: 1.6, // CHOSEN — the gun dips more than the head, which is what sells a landing

  rightSocketOffset: Object.freeze([17.0, -18.0, -34.0]), // CHOSEN — cm from the arms-mesh origin
  leftSocketOffset: Object.freeze([-17.0, -18.0, -34.0]), // CHOSEN — mirror, for the dual-wield pistol

  groundProbe: 2.5, // CHOSEN — cm below the feet still counted as standing; kills grounded-flicker
  collisionSkin: 0.5, // CHOSEN — cm kept clear after a push-out so the next frame cannot re-penetrate
  ...(PLAYER.FEEL ?? {}),
})

/** Spec §3 names these verbatim, so a mismatch is a wiring bug and fails loudly at construction. */
const REQUIRED_HEALTH_METHODS = ['applyDamage', 'healPercent', 'addArmor', 'addBurn', 'getCondition']

const warnedKeys = new Set()
function warnOnce(key, ...message) {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(...message)
}

const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _origin = new THREE.Vector3()
const _point = new THREE.Vector3()
const _normal = new THREE.Vector3()

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Horizontal-only length; gravity must never leak into the ground speed cap. */
function planarSpeed(v) {
  return Math.hypot(v.x, v.z)
}

/**
 * Sub-stepped braking, straight from CharacterMovementComponent::ApplyVelocityBraking.
 * Friction and a constant reverse acceleration are integrated together in slices no longer
 * than MOVE.brakingSubStepTime, because a single 1/60 s Euler step at friction 16 overshoots
 * and the player visibly snaps backwards at the end of a sprint.
 */
function applyBraking(v, dt, friction, deceleration) {
  const startX = v.x
  const startZ = v.z
  let speed = planarSpeed(v)
  if (speed <= 0) return

  const zeroFriction = friction === 0
  if (zeroFriction && deceleration === 0) return

  const maxStep = clamp(MOVE.brakingSubStepTime, ENGINE.brakingSubStepMin, ENGINE.brakingSubStepMax)
  let remaining = dt

  while (remaining >= ENGINE.minTickTime) {
    const step = remaining > maxStep && !zeroFriction ? Math.min(maxStep, remaining * 0.5) : remaining
    remaining -= step

    const inv = 1 / speed
    v.x += (-friction * v.x - deceleration * v.x * inv) * step
    v.z += (-friction * v.z - deceleration * v.z * inv) * step

    // Overshooting past a standstill would read as a reversal, so UE zeroes out instead.
    if (v.x * startX + v.z * startZ <= 0) {
      v.x = 0
      v.z = 0
      return
    }

    speed = planarSpeed(v)
    if (speed <= 0) {
      v.x = 0
      v.z = 0
      return
    }
  }

  if (speed <= ENGINE.brakeToStopSpeed) {
    v.x = 0
    v.z = 0
  }
}

function boxListFrom(world) {
  if (!world) return null
  if (Array.isArray(world.colliders)) return world.colliders
  if (typeof world.getColliders === 'function') return world.getColliders()
  return null
}

function zombieListFrom(world) {
  if (!world) return null
  if (Array.isArray(world.zombies)) return world.zombies
  if (typeof world.getZombies === 'function') return world.getZombies()
  return null
}

function zombieIsAlive(z) {
  if (!z) return false
  if (z.alive === false) return false
  if (z.isDead === true) return false
  if (z.health && z.health.isDead === true) return false
  return true
}

function zombiePosition(z) {
  return z.position ?? z.object?.position ?? z.mesh?.position ?? null
}

function zombieRadius(z) {
  const r = z.capsuleRadius ?? z.hitRadius ?? z.radius
  if (typeof r === 'number' && r > 0) return r
  warnOnce(
    `zombie-capsule:${z.type ?? z.id ?? 'unknown'}`,
    `[player] zombie "${z.type ?? z.id ?? '?'}" exposes no capsuleRadius/capsuleHalfHeight; ` +
      'falling back to the base archetype capsule, so bullets will hit the wrong silhouette.',
  )
  return ZOMBIES.ARCHETYPES.base.capsuleRadius
}

function zombieHalfHeight(z) {
  const h = z.capsuleHalfHeight ?? z.hitHalfHeight ?? z.halfHeight
  if (typeof h === 'number' && h > 0) return h
  return ZOMBIES.ARCHETYPES.base.capsuleHalfHeight
}

/**
 * Ray against an axis-aligned box. Returns the near hit distance, or -1 for a miss.
 * A ray starting inside the box misses on purpose: you cannot be shot by the wall you are
 * standing in, and a column brushing the camera would otherwise eat every shot at range 0.
 */
function rayBox(ox, oy, oz, dx, dy, dz, box, maxDist) {
  if (
    ox > box.min.x && ox < box.max.x &&
    oy > box.min.y && oy < box.max.y &&
    oz > box.min.z && oz < box.max.z
  ) return -1

  let tMin = 0
  let tMax = maxDist

  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi
    const inv = 1 / d
    let t0 = (lo - o) * inv
    let t1 = (hi - o) * inv
    if (t0 > t1) {
      const swap = t0
      t0 = t1
      t1 = swap
    }
    if (t0 > tMin) tMin = t0
    if (t1 < tMax) tMax = t1
    return tMax >= tMin
  }

  if (!slab(ox, dx, box.min.x, box.max.x)) return -1
  if (!slab(oy, dy, box.min.y, box.max.y)) return -1
  if (!slab(oz, dz, box.min.z, box.max.z)) return -1
  return tMin
}

/** Outward normal of the box face nearest a surface point, for impact decals and sparks. */
function boxNormalAt(px, py, pz, box, out) {
  const faces = [
    [Math.abs(px - box.min.x), -1, 0, 0],
    [Math.abs(px - box.max.x), 1, 0, 0],
    [Math.abs(py - box.min.y), 0, -1, 0],
    [Math.abs(py - box.max.y), 0, 1, 0],
    [Math.abs(pz - box.min.z), 0, 0, -1],
    [Math.abs(pz - box.max.z), 0, 0, 1],
  ]
  let best = faces[0]
  for (const face of faces) if (face[0] < best[0]) best = face
  return out.set(best[1], best[2], best[3])
}

/** Nearest root of a sphere intersection that lies in [0, maxDist], or -1. */
function raySphereNear(ox, oy, oz, dx, dy, dz, cx, cy, cz, radius, maxDist) {
  const fx = ox - cx
  const fy = oy - cy
  const fz = oz - cz
  const b = 2 * (fx * dx + fy * dy + fz * dz)
  const c = fx * fx + fy * fy + fz * fz - radius * radius
  const disc = b * b - 4 * c
  if (disc < 0) return -1
  const sq = Math.sqrt(disc)
  const near = (-b - sq) / 2
  if (near >= 0 && near <= maxDist) return near
  const far = (-b + sq) / 2
  if (far >= 0 && far <= maxDist) return far
  return -1
}

/** Ray against a vertical capsule: the cylinder body clipped to its axis, then the two caps. */
function rayCapsule(ox, oy, oz, dx, dy, dz, cx, cy, cz, radius, halfHeight, maxDist) {
  const segHalf = Math.max(0, halfHeight - radius)
  const yLo = cy - segHalf
  const yHi = cy + segHalf
  let best = -1

  const ex = ox - cx
  const ez = oz - cz
  const a = dx * dx + dz * dz
  if (a > 1e-12) {
    const b = 2 * (ex * dx + ez * dz)
    const c = ex * ex + ez * ez - radius * radius
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      const roots = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]
      for (const t of roots) {
        if (t < 0 || t > maxDist) continue
        const y = oy + dy * t
        if (y < yLo || y > yHi) continue
        best = t
        break
      }
    }
  }

  for (const capY of [yLo, yHi]) {
    const t = raySphereNear(ox, oy, oz, dx, dy, dz, cx, capY, cz, radius, best < 0 ? maxDist : best)
    if (t >= 0 && (best < 0 || t < best)) best = t
  }

  return best
}

export class Player {
  /**
   * @param {object} opts
   * @param {THREE.PerspectiveCamera} [opts.camera] the engine's camera; one is made if absent
   * @param {THREE.Scene} [opts.scene] the camera is parented here so the view model renders
   */
  constructor({ camera, scene } = {}) {
    this.camera = camera ?? new THREE.PerspectiveCamera(CAM.fieldOfView, 16 / 9, CAM.nearPlane, CAM.farPlane)
    this.camera.near = CAM.nearPlane
    this.camera.far = CAM.farPlane
    this.camera.rotation.order = 'YXZ'
    this._lastAspect = 0

    this.position = new THREE.Vector3()
    this.velocity = new THREE.Vector3()

    this.radius = PLAYER.capsuleRadius
    this.halfHeight = PLAYER.capsuleHalfHeight

    this.yaw = 0
    this.pitch = 0
    this.grounded = false
    this.sprinting = false
    this.crouching = false
    this.dead = false

    /** Written by src/fx/** each frame; folded into the view transform, never generated here. */
    this.shakeOffset = new THREE.Vector3()
    this.shakeEuler = new THREE.Euler(0, 0, 0, 'YXZ')

    this.activeMods = PLAYER.START.activeMods
    this.dualWield = PLAYER.START.dualWield
    this.fireLeftNext = WEAPONS.DUAL_WIELD.fireLeftNext

    this.firePressed = false
    this.fireHeld = false
    this.reloadPressed = false

    this._eyeHeight = CAM.eyeOffsetZ
    this._bobPhase = 0
    this._bobWeight = 0
    this._dip = 0
    this._dipVelocity = 0
    this._swayX = 0
    this._swayY = 0
    this._prevYaw = 0
    this._prevPitch = 0
    this._jumpLatched = false
    this._pitTimer = 0
    this._deathAnnounced = false

    /**
     * The arms mesh hangs 160 cm below the camera so its feet-at-origin skeleton lands exactly
     * on the floor (spec §1). Weapons attach to the two sockets, which src/weapons/** looks up
     * by PLAYER.SOCKETS name — the names are load-bearing, not decoration.
     */
    this.viewModel = new THREE.Group()
    this.viewModel.name = 'viewModel'
    this.viewModel.position.y = CAM.mesh1pRelativeZ
    this.viewModel.renderOrder = 10

    this.sockets = { right: new THREE.Group(), left: new THREE.Group() }
    this.sockets.right.name = PLAYER.SOCKETS.rightHand
    this.sockets.left.name = PLAYER.SOCKETS.leftHand
    this.sockets.right.position.fromArray(FEEL.rightSocketOffset)
    this.sockets.left.position.fromArray(FEEL.leftSocketOffset)
    this.viewModel.add(this.sockets.right, this.sockets.left)
    this.camera.add(this.viewModel)

    if (scene) scene.add(this.camera)

    this.health = null
    this.spawn()
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Full run reset: fresh pool, mods cleared, back on the platform facing down the tracks. */
  spawn() {
    this.health = this._makeHealth()
    this.activeMods = PLAYER.START.activeMods
    this.dualWield = PLAYER.START.dualWield
    this.fireLeftNext = WEAPONS.DUAL_WIELD.fireLeftNext
    this.dead = false
    this._deathAnnounced = false
    this._bobPhase = 0
    this._bobWeight = 0
    this._dip = 0
    this._dipVelocity = 0
    this._swayX = 0
    this._swayY = 0
    this.pitch = 0
    this._toSpawnPoint()
  }

  _toSpawnPoint() {
    // Source axes are Z-up: (X, Y, Z)_source maps to (X, Z, -Y)_three.
    this.teleport(PLAYER.SPAWN.x, PLAYER.SPAWN.z, -PLAYER.SPAWN.y, PLAYER.SPAWN.yaw)
  }

  /** Coordinates are three-space centimetres, matching the world builder's output. */
  teleport(x, y, z, yawDegrees = null) {
    this.position.set(x, y, z)
    this.velocity.set(0, 0, 0)
    if (yawDegrees !== null) {
      this.yaw = yawDegrees * DEG + SOURCE_YAW_OFFSET
      this._prevYaw = this.yaw
    }
    this.grounded = false
    this._pitTimer = 0
  }

  _makeHealth() {
    const pool = new HealthPool({
      maxHealth: HEALTH.maxHealth,
      overhealCap: HEALTH.overhealCap,
      maxArmor: HEALTH.maxArmor,
      overArmorCap: HEALTH.overArmorCap,
      health: PLAYER.START.health,
      armor: PLAYER.START.armor,
      owner: this,
    })

    const missing = REQUIRED_HEALTH_METHODS.filter(name => typeof pool[name] !== 'function')
    this._healthTick =
      typeof pool.tick === 'function' ? 'tick' : typeof pool.update === 'function' ? 'update' : null
    if (!this._healthTick) missing.push('tick (or update)')
    if (missing.length > 0) {
      throw new TypeError(
        `[player] HealthPool from src/game/health.js is missing: ${missing.join(', ')}. ` +
          'spec/player.md §3 names these verbatim and the player will not reimplement them.',
      )
    }
    return pool
  }

  // -------------------------------------------------------------------------
  // HUD-facing getters
  // -------------------------------------------------------------------------

  get healthValue() { return this.health.health }
  get armorValue() { return this.health.armor }
  get maxHealth() { return HEALTH.maxHealth }
  get overhealCap() { return HEALTH.overhealCap }
  get maxArmor() { return HEALTH.maxArmor }
  get overArmorCap() { return HEALTH.overArmorCap }
  get condition() { return this.health.getCondition() }
  get isBurning() { return this.health.isBurning === true }
  get isDead() { return this.dead || this.health.isDead === true }
  get alive() { return !this.isDead }
  get mods() { return this.activeMods }
  get speed() { return planarSpeed(this.velocity) }
  get eyeHeight() { return this._eyeHeight }
  /** Feet in world centimetres — what the pit rescue and any height readout key off. */
  get feetY() { return this.position.y - this.halfHeight }

  hasMod(bit) { return (this.activeMods & bit) !== 0 }

  /** Mods are permanent for the run (spec §8), so there is deliberately no remove. */
  addMod(bit) {
    if (this.hasMod(bit)) return false
    this.activeMods |= bit
    bus.emit(EV.MOD_GAINED, { mod: bit, mods: this.activeMods })
    return true
  }

  grantDualWield() {
    if (this.dualWield) return false
    this.dualWield = true
    this.fireLeftNext = WEAPONS.DUAL_WIELD.fireLeftNext
    return true
  }

  // -------------------------------------------------------------------------
  // Damage passthrough — the pool does the arithmetic, the player only routes
  // -------------------------------------------------------------------------

  applyDamage(amount, ignoresArmor = false, instigator = null) {
    return this.health.applyDamage(amount, ignoresArmor, instigator)
  }

  healPercent(percent) { return this.health.healPercent(percent) }
  addArmor(amount) { return this.health.addArmor(amount) }
  addBurn(damagePerTick, ticks, interval, source = null) {
    return this.health.addBurn(damagePerTick, ticks, interval, source)
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt, input, world) {
    if (!(dt > 0)) return
    const cmd = input ?? NEUTRAL

    this.health[this._healthTick](dt)

    this.dead = this.health.isDead === true
    if (this.dead && !this._deathAnnounced) {
      this._deathAnnounced = true
      bus.emit(EV.PLAYER_DEATH, { position: this.position.clone() })
    }

    // Spec §5: death disables every input. The pawn still falls, it just stops obeying.
    const live = !this.dead
    const commanded = live ? cmd : NEUTRAL
    if (live) this._look(cmd)
    this._trackFireInput(commanded)

    const boxes = this._boxes(world)
    this._move(dt, commanded, boxes)
    this._pitRescue(dt)
    this._composeView(dt, commanded)
  }

  _boxes(world) {
    const boxes = boxListFrom(world)
    if (boxes && boxes.length > 0) return boxes
    warnOnce(
      'no-colliders',
      '[player] world exposes no colliders (expected world.colliders or world.getColliders()). ' +
        `Standing on a bare plane at Y=${STATION.LEVELS.platformTopZ} so the run is playable but visibly wrong.`,
    )
    return null
  }

  _look(cmd) {
    const sign = LOOK.invertY ? 1 : -1
    // Raw deltas: mouse smoothing is disabled project-wide (spec §2.7).
    this.yaw -= (cmd.yaw ?? 0) * LOOK.lookSensitivity
    this.pitch = clamp(
      this.pitch + sign * (cmd.pitch ?? 0) * LOOK.lookSensitivity,
      CAM.viewPitchMin * DEG,
      CAM.viewPitchMax * DEG,
    )
    if (this.yaw > Math.PI) this.yaw -= TAU
    else if (this.yaw < -Math.PI) this.yaw += TAU
  }

  _trackFireInput(cmd) {
    const held = cmd.fire === true
    this.firePressed = held && !this.fireHeld
    this.fireHeld = held
    this.reloadPressed = cmd.reload === true
  }

  // -------------------------------------------------------------------------
  // Movement — spec §2.3 reproduced, then collided against boxes
  // -------------------------------------------------------------------------

  _move(dt, cmd, boxes) {
    this.crouching = MOVE.crouchEnabled && cmd.crouch === true
    this.sprinting = cmd.sprint === true && !this.crouching

    /**
     * The original wrote the literal MOVE.sprintReleaseSpeed on sprint release rather than
     * restoring the previous speed, which silently clobbered the crouch speed. Crouch had no
     * binding there so the bug never fired. Deriving the cap from state each frame is identical
     * while crouch is off and correct once it is on.
     */
    const maxWalk = this.crouching ? MOVE.crouchSpeed : this.sprinting ? MOVE.sprintSpeed : MOVE.walkSpeed

    // Basis from yaw alone: looking up or down must never change where forward is (spec §2.2).
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const forwardIn = cmd.forward ?? 0
    const strafeIn = cmd.strafe ?? 0
    let ix = -sin * forwardIn + cos * strafeIn
    let iz = -cos * forwardIn - sin * strafeIn
    let mag = Math.hypot(ix, iz)
    if (mag > 1) {
      // Clamped to length 1 so a diagonal is not faster than a straight line.
      ix /= mag
      iz /= mag
      mag = 1
    }

    const maxSpeed = maxWalk * clamp(mag, 0, 1)
    const hasInput = mag > 0
    const v = this.velocity
    const accelX = ix * MOVE.maxAcceleration
    const accelZ = iz * MOVE.maxAcceleration

    if (this.grounded) {
      const speed = planarSpeed(v)

      if (!hasInput || speed > maxSpeed) {
        applyBraking(v, dt, MOVE.groundFriction * MOVE.brakingFrictionFactor, MOVE.brakingDecelerationWalking)
      } else {
        // Steering friction rotates velocity toward the input without touching its magnitude.
        const invAccelLength = 1 / (MOVE.maxAcceleration * mag)
        const blend = Math.min(dt * MOVE.groundFriction, 1)
        v.x -= (v.x - accelX * invAccelLength * speed) * blend
        v.z -= (v.z - accelZ * invAccelLength * speed) * blend
      }

      if (hasInput) {
        const cap = Math.max(planarSpeed(v), maxSpeed)
        v.x += accelX * dt
        v.z += accelZ * dt
        this._capPlanar(cap)
      }

      if (cmd.jump === true && !this._jumpLatched) {
        v.y = MOVE.jumpZVelocity
        this.grounded = false
        this._jumpLatched = true
        this._dipVelocity += FEEL.takeoffLift * Math.sqrt(FEEL.landingDipStiffness)
      }
    } else {
      // Air control: 30% of ground acceleration, doubled below the boost threshold so a standing
      // jump still steers while a sprinting one commits to its arc (spec §2.5).
      const planar = planarSpeed(v)
      const control =
        planar < MOVE.airControlBoostVelocityThreshold
          ? Math.min(1, MOVE.airControl * MOVE.airControlBoostMultiplier)
          : MOVE.airControl
      if (hasInput) {
        const cap = Math.max(planar, maxSpeed)
        v.x += accelX * control * dt
        v.z += accelZ * control * dt
        this._capPlanar(cap)
      }
      v.y += UNITS.gravityZ * dt
    }

    if (cmd.jump !== true) this._jumpLatched = false

    this._integrate(dt, boxes)
  }

  _capPlanar(cap) {
    const v = this.velocity
    const speed = planarSpeed(v)
    if (speed <= cap || speed <= 0) return
    const scale = cap / speed
    v.x *= scale
    v.z *= scale
  }

  /**
   * Horizontal and vertical are resolved separately, against a cylinder of the capsule's own
   * dimensions rather than a true capsule. On a station built entirely from axis-aligned boxes
   * the two agree everywhere except at ledge edges, and there the cylinder is what players
   * expect: you stand on the lip instead of sliding off a rounded foot.
   *
   * At the sprint speed of 900 cm/s a 1/60 s step moves 15 cm against a 42 cm radius, so
   * discrete movement cannot tunnel and no sweep is needed.
   */
  _integrate(dt, boxes) {
    const p = this.position
    const v = this.velocity

    p.x += v.x * dt
    p.z += v.z * dt
    if (boxes) this._resolveHorizontal(boxes)

    const prevFeet = p.y - this.halfHeight
    const prevHead = p.y + this.halfHeight
    p.y += v.y * dt

    const wasGrounded = this.grounded
    const landingSpeed = -v.y
    this.grounded = false

    if (boxes) this._resolveVertical(boxes, prevFeet, prevHead)
    else this._resolveFallbackFloor()

    if (this.grounded && !wasGrounded && landingSpeed > 0) this._land(landingSpeed)
  }

  _resolveHorizontal(boxes) {
    const p = this.position
    const v = this.velocity
    const r = this.radius
    const hh = this.halfHeight
    const skin = FEEL.collisionSkin

    for (const box of boxes) {
      const feet = p.y - hh
      if (feet >= box.max.y - skin) continue
      if (p.y + hh <= box.min.y + skin) continue

      const qx = clamp(p.x, box.min.x, box.max.x)
      const qz = clamp(p.z, box.min.z, box.max.z)
      const dx = p.x - qx
      const dz = p.z - qz
      const d2 = dx * dx + dz * dz
      if (d2 >= r * r) continue

      /**
       * Anything no taller than maxStepHeight is walked over rather than walked into: the
       * vertical pass lifts the capsule onto it on this same frame. Rising through the side of
       * a kerb would look wrong, so a step is only offered on the way down or from the ground.
       */
      const rise = box.max.y - feet
      if (rise > 0 && rise <= MOVE.maxStepHeight && (this.grounded || v.y <= 0) && this._headroomOver(boxes, box)) {
        continue
      }

      let nx
      let nz
      let depth
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2)
        nx = dx / d
        nz = dz / d
        depth = r - d
      } else {
        // The centre is inside the footprint, so leave by the nearest face, not just any face.
        const toMinX = p.x - box.min.x
        const toMaxX = box.max.x - p.x
        const toMinZ = p.z - box.min.z
        const toMaxZ = box.max.z - p.z
        const best = Math.min(toMinX, toMaxX, toMinZ, toMaxZ)
        nx = best === toMinX ? -1 : best === toMaxX ? 1 : 0
        nz = nx !== 0 ? 0 : best === toMinZ ? -1 : 1
        depth = r + best
      }

      p.x += nx * (depth + skin)
      p.z += nz * (depth + skin)

      const into = v.x * nx + v.z * nz
      if (into < 0) {
        v.x -= into * nx
        v.z -= into * nz
      }
    }
  }

  /** Would standing on `step` bury the capsule in something else? If so the step is refused. */
  _headroomOver(boxes, step) {
    const p = this.position
    const r = this.radius
    const feet = step.max.y + FEEL.collisionSkin
    const head = feet + this.halfHeight * 2

    for (const box of boxes) {
      if (box === step) continue
      if (box.min.y >= head || box.max.y <= feet) continue
      const qx = clamp(p.x, box.min.x, box.max.x)
      const qz = clamp(p.z, box.min.z, box.max.z)
      const dx = p.x - qx
      const dz = p.z - qz
      if (dx * dx + dz * dz < r * r) return false
    }
    return true
  }

  _resolveVertical(boxes, prevFeet, prevHead) {
    const p = this.position
    const v = this.velocity
    const r = this.radius
    const hh = this.halfHeight
    const probe = FEEL.groundProbe

    let supportY = -Infinity

    for (const box of boxes) {
      const qx = clamp(p.x, box.min.x, box.max.x)
      const qz = clamp(p.z, box.min.z, box.max.z)
      const dx = p.x - qx
      const dz = p.z - qz
      if (dx * dx + dz * dz >= r * r) continue

      const feet = p.y - hh
      const head = p.y + hh

      /**
       * A box top counts as floor because an AABB face normal is +Y, comfortably past
       * MOVE.walkableFloorZ — nothing in this station is steep enough to slide off. The
       * penetration branch is what catches the spawn, which the original placed 4 cm inside
       * the platform (spec §5), and what completes a step-up the horizontal pass waved through.
       */
      if (v.y <= 0 && feet <= box.max.y + probe && box.max.y > supportY) {
        const crossedDown = prevFeet >= box.max.y - probe
        if (crossedDown || box.max.y - feet <= MOVE.maxStepHeight) supportY = box.max.y
        continue
      }

      if (v.y > 0 && head >= box.min.y && prevHead <= box.min.y + probe) {
        p.y = box.min.y - hh - FEEL.collisionSkin
        v.y = 0
      }
    }

    if (supportY > -Infinity) {
      p.y = supportY + hh
      if (v.y < 0) v.y = 0
      this.grounded = true
    }
  }

  _resolveFallbackFloor() {
    const top = STATION.LEVELS.platformTopZ
    if (this.position.y - this.halfHeight > top) return
    this.position.y = top + this.halfHeight
    if (this.velocity.y < 0) this.velocity.y = 0
    this.grounded = true
  }

  /**
   * Kick the dip spring downward. Scaling the impulse by omega (sqrt of the stiffness) keeps
   * landingDipPerSpeed meaningful in centimetres no matter how the spring is retuned; a
   * critically damped spring then peaks at about 37% of that depth, which is why a routine
   * jump lands at a few centimetres rather than the full budget.
   */
  _land(impactSpeed) {
    const depth = Math.min(impactSpeed * FEEL.landingDipPerSpeed, FEEL.landingDipMax)
    this._dipVelocity -= depth * Math.sqrt(FEEL.landingDipStiffness)
  }

  /** The original had no answer for a fall into the 250 cm track pit; this one lifts you out. */
  _pitRescue(dt) {
    if (this.position.y > PIT.rescueBelowZ) {
      this._pitTimer = 0
      return
    }
    this._pitTimer += dt
    if (this._pitTimer < PIT.rescueTeleportDelay) return
    console.warn(`[player] fell below Y=${PIT.rescueBelowZ}; lifting back to the platform spawn.`)
    if (PIT.fallDamage > 0) this.applyDamage(PIT.fallDamage, false, null)
    this._toSpawnPoint()
  }

  // -------------------------------------------------------------------------
  // View — eye height, gait, landing dip, weapon sway, then the fx shake on top
  // -------------------------------------------------------------------------

  _composeView(dt, cmd) {
    const cam = this.camera

    if (cam.isPerspectiveCamera && cam.aspect !== this._lastAspect) {
      this._lastAspect = cam.aspect
      // rules.js states FOV as HORIZONTAL degrees (UE's convention); three.js wants vertical.
      const halfHorizontal = CAM.fieldOfView * 0.5 * DEG
      cam.fov = (2 * Math.atan(Math.tan(halfHorizontal) / Math.max(cam.aspect, 1e-4))) / DEG
      cam.updateProjectionMatrix()
    }

    const targetEye = this.crouching ? MOVE.crouchedEyeHeight : CAM.eyeOffsetZ
    this._eyeHeight += (targetEye - this._eyeHeight) * Math.min(1, FEEL.crouchBlendRate * dt)

    const speedFraction = planarSpeed(this.velocity) / MOVE.walkSpeed
    const walking = this.grounded && speedFraction > FEEL.bobMinSpeedFraction
    const targetWeight = walking ? Math.min(speedFraction, this.sprinting ? FEEL.bobSprintScale : 1) : 0
    this._bobWeight += (targetWeight - this._bobWeight) * Math.min(1, FEEL.bobBlendRate * dt)
    if (walking) {
      this._bobPhase = (this._bobPhase + TAU * FEEL.bobCyclesPerSecondAtWalk * speedFraction * dt) % TAU
    }

    // Two footfalls per stride, so the vertical term runs at twice the lateral one.
    const bobUp = Math.sin(this._bobPhase * 2) * FEEL.bobVertical * this._bobWeight
    const bobSide = Math.sin(this._bobPhase) * FEEL.bobLateral * this._bobWeight
    const bobRoll = Math.sin(this._bobPhase) * FEEL.bobRollDegrees * DEG * this._bobWeight

    // Critically damped: the camera settles after a landing instead of bouncing back up.
    this._dipVelocity += (-FEEL.landingDipStiffness * this._dip - FEEL.landingDipDamping * this._dipVelocity) * dt
    this._dip = clamp(this._dip + this._dipVelocity * dt, -FEEL.landingDipMax, FEEL.landingDipMax)

    cam.rotation.set(this.pitch + this.shakeEuler.x, this.yaw + this.shakeEuler.y, bobRoll + this.shakeEuler.z)
    cam.position.set(this.position.x, this.position.y + this._eyeHeight + this._dip, this.position.z)
    cam.translateX(bobSide + this.shakeOffset.x)
    cam.translateY(bobUp + this.shakeOffset.y)
    cam.translateZ(this.shakeOffset.z)
    // Spec §5: one uncompensated drop along the camera's own up, not a world-space one, so
    // dying while looking straight up slides the view backwards rather than down.
    if (this.dead) cam.translateY(CAM.deathDropZ)

    this._swayX += -(this.yaw - this._prevYaw) * FEEL.swayPerRadian - (cmd.strafe ?? 0) * FEEL.swayStrafeRate * dt
    this._swayY += (this.pitch - this._prevPitch) * FEEL.swayPerRadian
    this._prevYaw = this.yaw
    this._prevPitch = this.pitch

    const decay = Math.max(0, 1 - FEEL.swayReturnRate * dt)
    this._swayX *= decay
    this._swayY *= decay
    const lag = Math.hypot(this._swayX, this._swayY)
    if (lag > FEEL.swayMax) {
      const scale = FEEL.swayMax / lag
      this._swayX *= scale
      this._swayY *= scale
    }

    this.viewModel.position.set(
      this._swayX + bobSide * FEEL.viewModelBobScale,
      CAM.mesh1pRelativeZ + this._swayY + bobUp * FEEL.viewModelBobScale + this._dip * FEEL.viewModelDipScale,
      0,
    )
    this.viewModel.rotation.set(
      this._swayY * FEEL.swayRotationPerCm,
      this._swayX * FEEL.swayRotationPerCm,
      -this._swayX * FEEL.swayRollPerCm,
    )
  }

  // -------------------------------------------------------------------------
  // Shooting
  // -------------------------------------------------------------------------

  /** Camera forward in world space — the truthful crosshair direction (spec §2.8). */
  aimDirection(out = _dir) {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize()
  }

  aimOrigin(out = _origin) {
    return out.copy(this.camera.position)
  }

  /**
   * One hitscan ray with cone spread, resolved against zombies first and station geometry
   * second so a zombie standing against a wall is still hittable.
   *
   * @returns {null|{entity, point, normal, distance, zone}} entity and zone are null for a
   *          geometry hit, which impact FX still want.
   */
  traceShot(world, { range = WEAPONS.DEFAULTS.range, spreadDegrees = 0, ignore = null } = {}) {
    this.aimOrigin(_origin)
    this.aimDirection(_dir)

    if (spreadDegrees > 0) {
      _up.set(0, 1, 0)
      _right.crossVectors(_dir, _up)
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0)
      _right.normalize()
      _up.crossVectors(_right, _dir).normalize()
      const angle = rng.next() * TAU
      // WEAPONS.SPREAD.edgeBiasExponent reproduces FMath::VRandCone's push toward the cone edge.
      const radial = Math.pow(rng.next(), WEAPONS.SPREAD.edgeBiasExponent) * Math.tan(spreadDegrees * DEG)
      _dir.addScaledVector(_right, radial * Math.cos(angle))
      _dir.addScaledVector(_up, radial * Math.sin(angle))
      _dir.normalize()
    }

    const ox = _origin.x
    const oy = _origin.y
    const oz = _origin.z
    const dx = _dir.x
    const dy = _dir.y
    const dz = _dir.z

    let bestT = range
    let bestEntity = null
    let bestBox = null

    const zombies = zombieListFrom(world)
    if (zombies) {
      for (const z of zombies) {
        if (z === ignore || !zombieIsAlive(z)) continue
        const pos = zombiePosition(z)
        if (!pos) {
          warnOnce('zombie-no-position', '[player] a world.zombies entry has no .position, so it cannot be shot.')
          continue
        }
        const t = rayCapsule(
          ox, oy, oz, dx, dy, dz,
          pos.x, pos.y, pos.z,
          zombieRadius(z), zombieHalfHeight(z),
          bestT,
        )
        if (t >= 0 && t < bestT) {
          bestT = t
          bestEntity = z
        }
      }
    } else {
      warnOnce('no-zombie-list', '[player] world exposes no zombies array, so every shot will hit only geometry.')
    }

    const boxes = boxListFrom(world)
    if (boxes) {
      for (const box of boxes) {
        const t = rayBox(ox, oy, oz, dx, dy, dz, box, bestT)
        if (t >= 0 && t < bestT) {
          bestT = t
          bestBox = box
          bestEntity = null
        }
      }
    }

    if (!bestEntity && !bestBox) return null

    _point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT)

    if (bestBox) {
      boxNormalAt(_point.x, _point.y, _point.z, bestBox, _normal)
      return { entity: null, point: _point.clone(), normal: _normal.clone(), distance: bestT, zone: null }
    }

    const pos = zombiePosition(bestEntity)
    _normal.set(_point.x - pos.x, 0, _point.z - pos.z)
    if (_normal.lengthSq() < 1e-8) _normal.set(-dx, -dy, -dz)
    _normal.normalize()

    return {
      entity: bestEntity,
      point: _point.clone(),
      normal: _normal.clone(),
      distance: bestT,
      zone: this._resolveZone(bestEntity, pos, _point.y, ox, oy, oz, dx, dy, dz, bestT),
    }
  }

  /**
   * The original picked a zone by exact bone name off a physics asset that is not in the
   * source, so DAMAGE.hitZoneGeometry resolves it from the capsule instead: a head sphere the
   * ray must genuinely intersect, then a chest band, then everything else.
   */
  _resolveZone(zombie, pos, hitY, ox, oy, oz, dx, dy, dz, bodyT) {
    const halfHeight = zombieHalfHeight(zombie)
    const total = halfHeight * 2
    const feet = pos.y - halfHeight

    const headRadius = ZONE_GEO.headRadiusFraction * halfHeight
    const headCentreY = feet + total * ZONE_GEO.headBottomFraction + headRadius
    // Allowing one extra radius past the body hit lets a ray clip the skull it entered through.
    const headT = raySphereNear(
      ox, oy, oz, dx, dy, dz,
      pos.x, headCentreY, pos.z,
      headRadius,
      bodyT + zombieRadius(zombie),
    )
    if (headT >= 0) return ZONES.head

    const fraction = total > 0 ? (hitY - feet) / total : 0
    if (fraction >= ZONE_GEO.chestBottomFraction && fraction < ZONE_GEO.chestTopFraction) return ZONES.chest
    return ZONES.body
  }

}

export default Player
