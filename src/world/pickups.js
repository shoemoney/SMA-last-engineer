/**
 * Pickups: opening equipment and one random health/armor supply per wave.
 * Seven equipment items occupy the station's first seven placement points. Wave
 * supplies choose distinct vacant points and replace the previous wave's leftovers.
 * A refused grant leaves the pickup standing. Health and armor use recognizable
 * rotating heart and chestplate meshes; equipment retains its glowing shell.
 *
 * Frame: the spec authors Z-up, three.js is Y-up. The remap (x, y, z)_spec ->
 * (x, z, -y)_three happens once per pickup, at its root. Everything after that is Y-up.
 */

import * as THREE from 'three/webgpu'
import { buildSustainGeometries, createSustainVisual } from './sustainVisuals.js'
import { PICKUPS, STATION, HEALTH, WEAPONS, WAVES, FX } from '../game/rules.js'
import { bus, EV } from '../core/events.js'
import { rng as defaultRng } from '../core/rng.js'

const DEG = Math.PI / 180
const TAU = Math.PI * 2
const PERCENT = 100

/** Radius of the visible ball: a 100 cm reference sphere at mesh scale 0.5. */
const BODY_RADIUS = (PICKUPS.referenceSphereDiameter * PICKUPS.meshScale) / 2

/**
 * Presentation proportions. The original had no shell, ring, floor pool or icon to put in
 * rules.js — it had one sphere — so these are expressed against the spec's body radius
 * rather than stated as free numbers.
 */
const LOOK = Object.freeze({
  coreFraction: 0.52, // of body radius; the solid emissive centre
  shellFraction: 1.0, // the additive halo sits exactly on the spec's 25 cm surface
  shellOpacity: 0.3,
  ringOpacityFactor: 2.0, // of shell opacity; the ring is the hard edge, the shell the bloom
  respawnFlashBoost: 2.0, // extra light multiplier at the instant a pickup returns
  respawnFlashShrink: 0.5, // how far it scales down before popping back to full size
  ringRadiusFraction: 1.24,
  ringTubeFraction: 0.1,
  poolRadiusFraction: 3.6, // the glow thrown onto the platform underfoot
  poolOpacity: 0.34,
  poolLift: 0.6, // cm above the platform surface, so the disc never z-fights the slab
  tiltDeg: 18, // the ring is canted so the spin reads from a standing eye height
  iconBarFraction: 1.5, // weapon icon length, of body radius
})

/**
 * The deal list. `kind` drives the grant, `glow` drives every colour on the object.
 * Health and armor are one-shot supplies replaced by the wave coordinator.
 */
const DEFS = Object.freeze({
  health: Object.freeze({
    id: 'health',
    kind: 'health',
    label: 'HEALTH',
    glow: PICKUPS.GLOW.health,
    respawn: PICKUPS.sustainRespawnTime,
    icon: 'cross',
  }),
  armor: Object.freeze({
    id: 'armor',
    kind: 'armor',
    label: 'ARMOR',
    glow: PICKUPS.GLOW.armor,
    respawn: PICKUPS.sustainRespawnTime,
    icon: 'shield',
  }),
  silencer: modDef('silencer', 'SIL', PICKUPS.GLOW.silencer),
  armorPiercing: modDef('armorPiercing', 'AP', PICKUPS.GLOW.armorPiercing),
  incendiary: modDef('incendiary', 'INC', PICKUPS.GLOW.incendiary),
  laserSight: modDef('laserSight', 'LAS', PICKUPS.GLOW.laserSight),
  pistol: weaponDef('pistol', 'DUAL WIELD'),
  rifle: weaponDef('rifle', 'RIFLE'),
  shotgun: weaponDef('shotgun', 'SHOTGUN'),
})

function modDef(id, label, glow) {
  return Object.freeze({
    id,
    kind: 'mod',
    mod: id,
    bit: WEAPONS.MOD_BITS[id],
    label,
    glow,
    respawn: PICKUPS.modsRespawn ? PICKUPS.respawnTime : null,
    icon: 'ring',
  })
}

function weaponDef(id, label) {
  return Object.freeze({
    id,
    kind: 'weapon',
    weapon: id,
    label,
    glow: PICKUPS.GLOW.weapon,
    respawn: PICKUPS.weaponsRespawn ? PICKUPS.respawnTime : null,
    icon: 'bar',
  })
}

// ---------------------------------------------------------------------------
// Placement points
// ---------------------------------------------------------------------------

/**
 * The station's 18 published points, §4.3. Recomputed here rather than assumed, so this
 * module still deals a correct loadout if it is handed a station that publishes nothing.
 */
export function pickupPoints() {
  const { columnMargin, columnSpacing } = STATION.DIMENSIONS
  const { count, z, offsetX, offsetY } = STATION.PICKUP_POINTS
  const points = []
  for (let i = 0; i < STATION.COUNTS.columns; i++) {
    const x = columnMargin + i * columnSpacing
    points.push({ x: x - offsetX, y: offsetY, z })
    points.push({ x: x + offsetX, y: -offsetY, z })
  }
  if (points.length !== count) {
    console.warn(
      `[pickups] derived ${points.length} placement points but rules.js says ${count} — ` +
        'the column count and the point count have drifted apart',
    )
  }
  return points
}

/** Opening equipment only; health and armor are managed once per wave. */
export function openingLoadout() {
  const { sustainPairs, modOrder, weaponOrder, totalItems } = PICKUPS.OPENING_LOADOUT
  const order = []
  for (let i = 0; i < sustainPairs; i++) order.push('health', 'armor')
  order.push(...modOrder)
  order.push(...weaponOrder)
  if (order.length !== totalItems) {
    console.warn(
      `[pickups] opening loadout came out ${order.length} items, rules.js says ${totalItems}`,
    )
  }
  return order
}

function normalisePoint(raw) {
  if (Array.isArray(raw)) return { x: raw[0], y: raw[1], z: raw[2] }
  if (raw && typeof raw === 'object' && Number.isFinite(raw.x)) {
    return { x: raw.x, y: raw.y, z: raw.z }
  }
  return null
}

/**
 * Prefer the points the station publishes, exactly as the original's placer did, and fall
 * back to recomputing them. A station that publishes a malformed list is a bug worth
 * shouting about; a station that publishes nothing at all is just an integration order.
 */
function resolvePoints(station) {
  const published = station?.pickupPoints ?? station?.getPickupPoints?.()
  if (!published) return pickupPoints()

  const points = Array.from(published, normalisePoint)
  const bad = points.findIndex((p) => !p)
  if (bad !== -1) {
    console.warn(
      `[pickups] station published an unreadable point at index ${bad}; ` +
        'falling back to the 18 points derived from rules.js',
    )
    return pickupPoints()
  }
  return points
}

// ---------------------------------------------------------------------------
// Grant handshake — "did you actually do anything?"
// ---------------------------------------------------------------------------

const HEALTH_PATHS = [
  ['health'],
  ['health', 'current'],
  ['healthComponent', 'health'],
  ['stats', 'health'],
]
const ARMOR_PATHS = [['armor'], ['armor', 'current'], ['healthComponent', 'armor'], ['stats', 'armor']]
const MOD_PATHS = [['mods'], ['modMask'], ['weaponMods'], ['weapon', 'mods']]

function resolveField(root, paths) {
  for (const path of paths) {
    let owner = root
    for (let i = 0; i < path.length - 1; i++) owner = owner?.[path[i]]
    const key = path[path.length - 1]
    if (owner && typeof owner[key] === 'number') {
      return { get: () => owner[key], set: (v) => { owner[key] = v } }
    }
  }
  return null
}

function firstMethod(root, names) {
  for (const name of names) {
    const dotted = name.split('.')
    let owner = root
    for (let i = 0; i < dotted.length - 1; i++) owner = owner?.[dotted[i]]
    const key = dotted[dotted.length - 1]
    if (owner && typeof owner[key] === 'function') return (...args) => owner[key](...args)
  }
  return null
}

const warned = new Set()
function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[pickups] ${message}`)
}

/**
 * Add to a capped pool and report whether the number actually moved. This is the whole
 * handshake: a refused grant must leave the pickup standing.
 */
function addToPool(player, amount, cap, paths, mutators, poolName) {
  const field = resolveField(player, paths)
  const mutate = firstMethod(player, mutators)

  if (mutate) {
    const before = field?.get()
    const result = mutate(amount)
    if (field) return field.get() > before
    // Nothing readable to measure against, so the mutator's own answer is all there is.
    // `undefined` means it did not implement the handshake; treat that as granted rather
    // than leaving an uncollectable pickup on the floor forever.
    return result !== false
  }

  if (field) {
    const before = field.get()
    if (before >= cap) return false
    field.set(Math.min(cap, before + amount))
    return field.get() > before
  }

  warnOnce(
    poolName,
    `player exposes no ${poolName} pool and no grant method — ${poolName} pickups can never ` +
      'be collected. Pass a `grant` override to placePickups() or expose player.' + poolName,
  )
  return false
}

function grantHealth(player) {
  return addToPool(
    player,
    (HEALTH.maxHealth * PICKUPS.healPercent) / PERCENT,
    HEALTH.overhealCap,
    HEALTH_PATHS,
    ['heal', 'addHealth', 'health.add', 'healthComponent.addHealth', 'healthComponent.heal'],
    'health',
  )
}

function grantArmor(player) {
  return addToPool(
    player,
    PICKUPS.armorAmount,
    HEALTH.overArmorCap,
    ARMOR_PATHS,
    ['addArmor', 'armor.add', 'healthComponent.addArmor'],
    'armor',
  )
}

/** Mods are `mask |= bit` and are consumed whether or not the bit was already set. */
function grantMod(player, def) {
  const mutate = firstMethod(player, ['addWeaponMod', 'addMod', 'giveMod', 'weapon.addMod'])
  if (mutate) {
    mutate(def.bit, def.mod)
    return true
  }
  const field = resolveField(player, MOD_PATHS)
  if (field) {
    field.set(field.get() | def.bit)
    return true
  }
  warnOnce('mods', 'player exposes no mod mask and no addWeaponMod() — mod pickups grant nothing')
  return true
}

/** The pistol pickup is the off-hand gun; the other two replace the primary. */
function grantWeapon(player, def) {
  if (def.weapon === 'pistol') {
    const dual = firstMethod(player, ['enableDualWield', 'giveDualWield', 'setDualWield'])
    if (dual) {
      dual(true)
      return true
    }
    if (typeof player?.dualWield === 'boolean') {
      player.dualWield = true
      return true
    }
    warnOnce('dualWield', 'player exposes no dual-wield hook — the second pistol grants nothing')
    return true
  }

  const give = firstMethod(player, ['giveWeapon', 'setWeapon', 'equipWeapon'])
  if (give) {
    give(def.weapon)
    return true
  }
  warnOnce('weapons', 'player exposes no giveWeapon() — weapon pickups grant nothing')
  return true
}

function defaultGrant(player, def) {
  switch (def.kind) {
    case 'health':
      return grantHealth(player)
    case 'armor':
      return grantArmor(player)
    case 'mod':
      return grantMod(player, def)
    case 'weapon':
      return grantWeapon(player, def)
    default:
      console.warn(`[pickups] no grant path for kind "${def.kind}"`)
      return false
  }
}

// ---------------------------------------------------------------------------
// Geometry — shared across every instance, built once, disposed by the manager
// ---------------------------------------------------------------------------

/**
 * Every shape is a multiple of the spec's 25 cm body radius, and the segment counts are
 * tessellation, not balance — none of it has a rules.js home because the original drew one
 * stock sphere and nothing else.
 */
function buildSharedGeometry() {
  const r = BODY_RADIUS
  return {
    ...buildSustainGeometries(r),
    core: new THREE.IcosahedronGeometry(r * LOOK.coreFraction, 1),
    shell: new THREE.IcosahedronGeometry(r * LOOK.shellFraction, 2),
    ring: new THREE.TorusGeometry(
      r * LOOK.ringRadiusFraction,
      r * LOOK.ringTubeFraction,
      8,
      28,
    ),
    pool: new THREE.CircleGeometry(r * LOOK.poolRadiusFraction, 28),
    crossArm: new THREE.BoxGeometry(r * 1.1, r * 0.34, r * 0.34),
    shield: new THREE.OctahedronGeometry(r * 0.66, 0),
    bar: new THREE.BoxGeometry(r * LOOK.iconBarFraction, r * 0.24, r * 0.24),
    band: new THREE.TorusGeometry(r * 0.78, r * 0.07, 6, 20),
  }
}

/** Icons exist so the four kinds stay apart for a colour-blind player, not just by hue. */
function buildIcon(def, geo, mat) {
  const group = new THREE.Group()
  switch (def.icon) {
    case 'cross': {
      const a = new THREE.Mesh(geo.crossArm, mat)
      const b = new THREE.Mesh(geo.crossArm, mat)
      b.rotation.z = Math.PI / 2
      group.add(a, b)
      break
    }
    case 'shield':
      group.add(new THREE.Mesh(geo.shield, mat))
      break
    case 'bar': {
      const bar = new THREE.Mesh(geo.bar, mat)
      bar.rotation.z = -Math.PI / 12
      group.add(bar)
      break
    }
    default:
      group.add(new THREE.Mesh(geo.band, mat))
  }
  return group
}

// ---------------------------------------------------------------------------
// One pickup
// ---------------------------------------------------------------------------


/**
 * One set of materials per COLOUR, not per pickup.
 *
 * Every Pickup built four fresh materials, so fourteen opening pickups minted 56 of them and
 * each wave-clear reward minted four more. Each distinct material is a pipeline three compiles
 * the first time it is drawn — which is why the last zombie of each of the first five waves
 * died into a shader compile, and why pre-warming the five reward types cost eighteen seconds
 * of boot.
 *
 * Pickups of the same type are visually identical, so they can share. These are cached for the
 * life of the page and never disposed: disposing one while another pickup of the same colour
 * still uses it would blank that pickup.
 */
/**
 * The floor pool's radial falloff, built once for the whole page.
 *
 * The pool used to be a flat CircleGeometry with a plain MeshBasicMaterial: additive
 * colour out to a crisp 28-segment rim, then nothing — a hard-edged coloured disc that
 * sliced flat across steps and crates instead of blooming out. This is a white,
 * quadratic alpha gradient (opaque centre, zero by the rim); the material's own `color`
 * still does the tinting, this texture only shapes the edge.
 *
 * A DataTexture, not a canvas: three's CircleGeometry UVs put the disc's edge at exactly
 * UV distance 0.5 from centre (verified against the geometry, not assumed), so a plain
 * pixel buffer lines up with the mesh with no canvas/DOM dependency — it builds and reads
 * back fine in a node test with no GPU. It uploads through three's ordinary texture
 * pipeline, so it renders identically on the WebGPU and WebGL2 paths this project ships;
 * nothing here is backend-specific GLSL.
 *
 * Built exactly once at module load and shared by every colour's pool material below —
 * never rebuilt per pickup or per spawn.
 */
const POOL_FALLOFF_SIZE = 64

function buildPoolFalloffTexture() {
  const size = POOL_FALLOFF_SIZE
  const data = new Uint8Array(size * size * 4)
  const centre = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - centre
      const dy = y + 0.5 - centre
      const ratio = Math.sqrt(dx * dx + dy * dy) / centre // 0 at centre, 1 at the disc's rim
      const t = Math.max(0, 1 - ratio)
      const alpha = Math.round(255 * t * t) // quadratic: bright core, soft shoulder, true zero at the rim
      const i = (y * size + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = alpha
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.needsUpdate = true
  texture.generateMipmaps = false // never drawn at a size where mip levels would matter
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

const POOL_FALLOFF_TEXTURE = buildPoolFalloffTexture()

const MATERIAL_CACHE = new Map()

function pickupMaterials(colour) {
  const key = typeof colour === 'number' ? colour : colour.getHex?.() ?? String(colour)
  const hit = MATERIAL_CACHE.get(key)
  if (hit) return hit

  const made = {
    core: new THREE.MeshStandardMaterial({
      color: colour,
      emissive: colour,
      emissiveIntensity: STATION.PROPS.hangingSign.emissiveIntensity,
      roughness: STATION.MATERIALS.signageRoughness,
      metalness: STATION.MATERIALS.signageMetalness,
    }),
    shell: new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: LOOK.shellOpacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    ring: new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: LOOK.shellOpacity * LOOK.ringOpacityFactor,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    pool: new THREE.MeshBasicMaterial({
      color: colour, map: POOL_FALLOFF_TEXTURE, transparent: true, opacity: LOOK.poolOpacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide,   // the original had this; without it the floor glow vanishes edge-on
    }),
  }
  MATERIAL_CACHE.set(key, made)
  return made
}

class Pickup {
  constructor(def, point, index, geo, rng, borrowedLight = null) {
    this.def = def
    this.point = point
    this.pointIndex = index

    this.active = true
    this.dead = false // a non-respawning pickup that has been taken is gone for the run
    this.age = 0 // seconds since it last became active; drives the bob phase
    this.respawnLeft = 0
    this.flashLeft = 0
    this.sortKey = 0 // squared distance to the player, refreshed by the manager each frame
    /** 1 or 0, written by the manager's light budget. Scales the glow; never hides it. */
    this.lit = 1

    const colour = new THREE.Color(def.glow)

    this.root = new THREE.Group()
    this.root.name = `pickup:${def.id}@${index}`
    this.root.position.set(point.x, point.z, -point.y)

    this.bobber = new THREE.Group()
    this.root.add(this.bobber)

    this.spinner = new THREE.Group()
    // A random start angle costs nothing and stops fourteen identical balls from spinning
    // in lockstep like a chorus line. Drawn from the seeded rng so a soak stays replayable.
    this.spinner.rotation.y = rng.range(0, TAU)
    this.bobber.add(this.spinner)

    const shared = pickupMaterials(colour)
    this.coreMat = shared.core
    const sustainVisual = createSustainVisual(def.kind, geo, this.coreMat)
    if (sustainVisual) this.spinner.add(sustainVisual)
    else {
      this.spinner.add(new THREE.Mesh(geo.core, this.coreMat))
      this.spinner.add(buildIcon(def, geo, this.coreMat))
    }

    this.shellMat = shared.shell
    if (!sustainVisual) this.bobber.add(new THREE.Mesh(geo.shell, this.shellMat))

    this.ringMat = shared.ring
    const ring = new THREE.Mesh(geo.ring, this.ringMat)
    ring.rotation.x = Math.PI / 2 + LOOK.tiltDeg * DEG
    this.spinner.add(ring)

    /**
     * BORROW the light, never create one.
     *
     * three collects lights by walking the scene graph and the COUNT is part of every
     * material's program key — the comment below has always said so. Creating a light per
     * pickup therefore meant that dropping a wave-clear reward changed the count and
     * recompiled every material in the station, which is the multi-second stall a player
     * saw on the last kill of every wave. Pre-allocated per placement point by the manager,
     * so the count is fixed at boot and never moves again.
     */
    this.light = borrowedLight ?? new THREE.PointLight(
      colour,
      PICKUPS.themeLightIntensity * FX.LIGHT_INTENSITY_SCALE,
      PICKUPS.themeLightRadius,
      2, // inverse-square decay: three's physical default, not a tunable
    )
    this.ownsLight = !borrowedLight
    this.light.color.set(colour)
    this.light.intensity = PICKUPS.themeLightIntensity * FX.LIGHT_INTENSITY_SCALE
    this.baseIntensity = this.light.intensity
    if (!this.ownsLight) this.light.position.copy(this.root.position)
    // On the ROOT, not the bobber, and the root is never hidden. Three collects lights by
    // walking the visible scene graph, so a light under a hidden parent drops out of the
    // lights array exactly as if its own flag had been cleared — and that count is part of
    // every material's program key. Taking one pickup would then recompile the entire
    // station. update() copies the bob offset down instead; it is one float a frame.
    // Only a light we made ourselves may be parented here. A BORROWED light lives in the
    // manager's group for the life of the page — parenting it to this root would take it out
    // of the scene the moment this pickup is collected, which is the very count change this
    // whole arrangement exists to prevent.
    if (this.ownsLight) this.root.add(this.light)

    this.poolMat = shared.pool
    this.pool = new THREE.Mesh(geo.pool, this.poolMat)
    this.pool.rotation.x = -Math.PI / 2
    // The point floats 10 cm over the slab, so the pool has to come back down to it.
    this.pool.position.y = STATION.LEVELS.platformTopZ - point.z + LOOK.poolLift
    this.root.add(this.pool)

    /** Cached so the proximity test is a squared compare with no allocation. */
    this.worldPosition = this.root.position.clone()
  }

  get respawns() {
    return this.def.respawn !== null && this.def.respawn !== undefined
  }

  /**
   * Deliberately does nothing now.
   *
   * These four materials used to be built per pickup, so freeing them here was correct. They
   * are now shared per colour by pickupMaterials(), which is what stops every wave-clear
   * reward from minting four new pipelines. Disposing a shared material would blank every
   * OTHER pickup of the same type the moment one was collected — a bug that would surface
   * minutes later, somewhere else, as an invisible pickup.
   *
   * The cache lives for the life of the page on purpose; four materials per colour is a
   * rounding error against what it saves.
   */
  disposeMaterials() {}

  /** Hide, stop spinning and bobbing, start the timer — or leave for good. §4.1. */
  consume() {
    this.active = false
    this.bobber.visible = false
    this.pool.visible = false
    this.light.intensity = 0
    this.dead = !this.respawns
    this.respawnLeft = this.dead ? 0 : this.def.respawn
  }

  respawn() {
    this.active = true
    this.age = 0 // §4.1: the bob phase resets, so it returns to exactly the same height
    this.flashLeft = PICKUPS.respawnFlashSeconds
    this.bobber.visible = true
    this.pool.visible = true
  }

  update(dt) {
    if (!this.active) {
      if (this.dead || this.respawnLeft <= 0) return
      this.respawnLeft -= dt
      if (this.respawnLeft <= 0) this.respawn()
      return
    }

    this.age += dt

    // §4.1: z = baseZ + sin(2*PI*t / period) * amplitude, in the spec's up axis.
    this.bobber.position.y = Math.sin((TAU * this.age) / PICKUPS.bobPeriod) * PICKUPS.bobAmplitude
    this.spinner.rotation.y += PICKUPS.rotationRate * DEG * dt

    const pulse = 1 + PICKUPS.pulseDepth * Math.sin((TAU * this.age) / PICKUPS.pulsePeriod)
    let boost = 1
    if (this.flashLeft > 0) {
      this.flashLeft -= dt
      const k = Math.max(0, this.flashLeft / PICKUPS.respawnFlashSeconds)
      boost = 1 + k * LOOK.respawnFlashBoost
      this.bobber.scale.setScalar(1 - k * LOOK.respawnFlashShrink)
    } else if (this.bobber.scale.x !== 1) {
      this.bobber.scale.setScalar(1)
    }

    if (this.ownsLight) {
      this.light.position.y = this.bobber.position.y
    } else {
      // World-space: the borrowed light is a sibling, not a child.
      this.light.position.set(this.root.position.x,
                              this.root.position.y + this.bobber.position.y,
                              this.root.position.z)
    }
    this.light.intensity = this.baseIntensity * pulse * boost * this.lit
    this.shellMat.opacity = LOOK.shellOpacity * pulse
    this.poolMat.opacity = LOOK.poolOpacity * pulse

    this.worldPosition.set(
      this.root.position.x,
      this.root.position.y + this.bobber.position.y,
      this.root.position.z,
    )
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Where the player is, in three's Y-up world frame. */
function resolvePlayerPosition(player) {
  const p = player?.position ?? player?.mesh?.position ?? player?.object3D?.position ?? player?.camera?.position
  if (p && Number.isFinite(p.x)) return p
  if (player && Number.isFinite(player.x)) return player
  warnOnce(
    'playerPosition',
    'update(dt, player) got something with no readable position — nothing will ever be picked up',
  )
  return null
}

/** Sorts the light-budget ranking nearest-first without allocating a comparator closure. */
function byDistance(a, b) {
  return a.sortKey - b.sortKey
}

export class PickupManager {
  /** Reused by update() so the per-frame light ranking allocates nothing. */
  #ranked = []

  /**
   * @param {THREE.Scene} scene
   * @param {Array<{x:number,y:number,z:number}>} points the station's 18 placement points
   * @param {Rng} rng seeded gameplay rng; drives the reward drop and the spin phases
   * @param {object} [options]
   * @param {(player:object, def:object) => boolean} [options.grant] override the handshake
   */
  constructor(scene, points, rng, options = {}) {
    this.scene = scene
    this.points = points
    /**
     * One light per placement point, created once and never added or removed again. See the
     * note in Pickup: the light COUNT is part of every material's program key, so a light
     * that appears at wave clear recompiles the entire station.
     */
    this.pointLights = points.map(() => {
      const l = new THREE.PointLight(0xffffff, 0, PICKUPS.themeLightRadius, 2)
      l.name = 'pickup-light'
      return l
    })
    this.rng = rng
    this.grant = options.grant ?? defaultGrant
    this.emitEvents = options.emitEvents !== false

    this.geo = buildSharedGeometry()
    this.group = new THREE.Group()
    // Added once, never removed — the entire point of pre-allocating them.
    for (const l of this.pointLights) this.group.add(l)
    this.group.name = 'pickups'
    scene.add(this.group)

    this.pickups = []
    /** point index -> live pickup, so the reward drop can honour WAVES.REWARD.checksOccupancy */
    this.occupied = new Map()

    this.triggerSq = PICKUPS.collisionRadius * PICKUPS.collisionRadius
    this.cullSq = FX.BUDGET.cullEffectsBeyond * FX.BUDGET.cullEffectsBeyond
  }

  /** Place one item on a point index, replacing nothing. Returns the new pickup. */
  place(defId, pointIndex) {
    const def = DEFS[defId]
    if (!def) {
      console.warn(`[pickups] unknown pickup type "${defId}" — nothing placed`)
      return null
    }
    const point = this.points[pointIndex % this.points.length]
    if (!point) {
      console.warn(`[pickups] no placement point at index ${pointIndex}`)
      return null
    }

    const slot = pointIndex % this.points.length
    const pickup = new Pickup(def, point, slot, this.geo, this.rng, this.pointLights[slot])
    this.group.add(pickup.root)
    this.pickups.push(pickup)
    this.occupied.set(pickup.pointIndex, pickup)
    return pickup
  }

  /** Deal opening equipment without consuming the wave supply allowance. */
  dealOpeningLoadout() {
    let index = 0
    for (const id of openingLoadout()) {
      this.place(id, index++ % this.points.length)
    }
    return this
  }

  /** Replace old wave supplies with at most one of each, on distinct vacant points. */
  beginWave(waveNumber) {
    if (this.supplyWave === waveNumber) return []
    this.supplyWave = waveNumber
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pickup = this.pickups[i]
      if (pickup.def.kind !== 'health' && pickup.def.kind !== 'armor') continue
      pickup.consume()
      this.group.remove(pickup.root)
      pickup.disposeMaterials()
      if (this.occupied.get(pickup.pointIndex) === pickup) this.occupied.delete(pickup.pointIndex)
      this.pickups.splice(i, 1)
    }
    const free = this.points.map((_, index) => index).filter(index => !this.occupied.has(index))
    const placed = []
    for (const id of ['health', 'armor']) {
      if (!free.length) break
      const choice = Math.min(free.length - 1, Math.floor(this.rng.next() * free.length))
      const [index] = free.splice(choice, 1)
      placed.push(this.place(id, index))
    }
    return placed
  }

  /**
   * §4.5 / WAVES.REWARD: the between-wave mod drop the original implemented and never
   * called. rules.js turns it on at wave clear and, unlike the original, refuses to stack
   * it on top of an existing pickup.
   */
  dropReward(waveNumber) {
    const cycle = WAVES.REWARD.cycle
    const id = cycle[waveNumber % cycle.length]

    const candidates = []
    for (let i = 0; i < this.points.length; i++) {
      if (!WAVES.REWARD.checksOccupancy || !this.occupied.has(i)) candidates.push(i)
    }
    // With every point taken the original's behaviour is the only behaviour left: drop it
    // somewhere and let it overlap.
    const pool = candidates.length > 0 ? candidates : this.points.map((_, i) => i)
    const index = pool[Math.min(pool.length - 1, Math.floor(this.rng.next() * pool.length))]
    return this.place(id, index)
  }

  /**
   * @param {number} dt seconds
   * @param {object} player anything exposing a three-space `position`
   */
  update(dt, player) {
    if (!(dt > 0)) return
    const playerPos = player ? resolvePlayerPosition(player) : null
    const ranked = this.#ranked
    ranked.length = 0

    for (const pickup of this.pickups) {
      pickup.update(dt)
      if (!pickup.active || !playerPos) continue

      const dx = pickup.worldPosition.x - playerPos.x
      const dy = pickup.worldPosition.y - playerPos.y
      const dz = pickup.worldPosition.z - playerPos.z
      const distSq = dx * dx + dy * dy + dz * dz

      if (distSq >= this.cullSq) {
        pickup.lit = 0
        continue
      }

      pickup.sortKey = distSq
      ranked.push(pickup)
      if (distSq <= this.triggerSq) this.#tryCollect(pickup, player)
    }

    // Nearest-first, so the light budget is spent on the pickups the player can actually
    // see glowing. The emissive core and the additive shell carry the rest at distance.
    ranked.sort(byDistance)
    let budget = FX.BUDGET.maxDynamicLights
    for (const pickup of ranked) {
      if (!pickup.active) continue // just collected; consume() already went dark
      pickup.lit = budget > 0 ? 1 : 0
      if (budget > 0) budget--
    }
  }

  #tryCollect(pickup, player) {
    let granted = false
    try {
      // A custom grant that returns nothing is taken as a success; only an explicit `false`
      // is the "I did nothing" answer that leaves the pickup standing. defaultGrant always
      // returns a real boolean, so the spec's handshake is exact on the built-in path.
      granted = this.grant(player, pickup.def) !== false
    } catch (err) {
      // A throwing grant must not eat the pickup, and must not be silent.
      console.error(`[pickups] grant for "${pickup.def.id}" threw; leaving it on the floor`, err)
      return
    }
    if (!granted) return

    pickup.consume()
    this.occupied.delete(pickup.pointIndex)

    if (!this.emitEvents) return
    const payload = {
      type: pickup.def.id,
      kind: pickup.def.kind,
      label: pickup.def.label,
      position: pickup.worldPosition.toArray(),
      respawns: pickup.respawns,
    }
    bus.emit(EV.PICKUP, payload)
    if (pickup.def.kind === 'mod') bus.emit(EV.MOD_GAINED, { ...payload, bit: pickup.def.bit })
  }

  /** Clear the board and deal a fresh opening loadout — the start of a new run. */
  reset() {
    this.supplyWave = null
    for (const pickup of this.pickups) {
      this.group.remove(pickup.root)
      pickup.disposeMaterials()
    }
    this.pickups.length = 0
    this.occupied.clear()
    this.dealOpeningLoadout()
  }

  dispose() {
    this.scene.remove(this.group)
    for (const pickup of this.pickups) pickup.disposeMaterials()
    // Geometry is shared across every instance, so it is owned here, not by the pickups.
    for (const geometry of Object.values(this.geo)) geometry.dispose()
    this.pickups.length = 0
    this.occupied.clear()
  }
}

/**
 * Build the station's pickups and deal the opening loadout.
 *
 * @param {THREE.Scene} scene
 * @param {object} station the station builder; its published `pickupPoints` win if present
 * @param {Rng} rng seeded gameplay rng
 * @param {object} [options] `{ grant, emitEvents }` — see PickupManager
 * @returns {PickupManager}
 */
export function placePickups(scene, station, rng = defaultRng, options = {}) {
  const manager = new PickupManager(scene, resolvePoints(station), rng, options)
  manager.dealOpeningLoadout()
  return manager
}

export { DEFS as PICKUP_DEFS }
// Exported for testing the floor-pool glow's radial falloff (see buildPoolFalloffTexture
// above); not used by any other production module.
export { pickupMaterials, POOL_FALLOFF_TEXTURE }
