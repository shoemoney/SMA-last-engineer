/**
 * weapon.js — the shot pipeline, the firing/reload state machine, and the WeaponSystem that
 * owns the player's guns.
 *
 * All three weapons are the same machine with different numbers, exactly as the original
 * was: a base class whose subclasses set eleven fields and override no behaviour. So there
 * is one class here and three configured factories in pistol.js / rifle.js / shotgun.js.
 *
 * Nothing here computes damage. The resolver in src/game/damage.js decides every number;
 * this file decides where the ray went, what it hit, and what the player sees and hears.
 *
 * Timers are advanced by update(dt), never by setTimeout. The verification harness calls
 * tick(seconds) with no frame in sight and the headless soak runs 25 waves in node; a weapon
 * that waited on a real clock would be invisible to both.
 *
 * `world`, `fx` and `audio` are adapters supplied by whoever builds the level, kept
 * deliberately tiny — a weapon that knew how to raycast a scene graph could not be tested
 * without one. Every adapter method that is missing warns once and degrades visibly.
 */
import * as THREE from 'three/webgpu'
import { DAMAGE, FX, PLAYER, WEAPONS } from '../game/rules.js'
import { bus as sharedBus, EV } from '../core/events.js'
import { rng as sharedRng } from '../core/rng.js'
import {
  MOD,
  addMod,
  firePresentation,
  modBadges,
  resolveModdedShot,
  spreadHalfAngleRad,
  zoneFromBoneName,
} from './mods.js'
import { createPistol } from './pistol.js'
import { createRifle } from './rifle.js'
import { createShotgun } from './shotgun.js'

const { FIRE_AUDIO, SPREAD, fireIntervalFallback } = WEAPONS

const _origin = new THREE.Vector3()
const _direction = new THREE.Vector3()
const _pellet = new THREE.Vector3()
const _aim = new THREE.Vector3()
const _tangent = new THREE.Vector3()
const _bitangent = new THREE.Vector3()
const _muzzle = new THREE.Vector3()
const _end = new THREE.Vector3()

const NOOP = () => undefined
const REPORTED = new Set()

/**
 * Wrap an adapter method so a missing one is reported exactly once instead of once per
 * pellet per shot. The lookup stays live rather than being bound at construction, because
 * the verification harness swaps the world adapter out underneath a running weapon and a
 * bound reference would silently keep calling the old one.
 */
function hook(target, method, consequence) {
  return (...args) => {
    const fn = target?.[method]
    if (typeof fn === 'function') return fn.apply(target, args)
    if (!REPORTED.has(method)) {
      REPORTED.add(method)
      console.warn(`[weapons] no ${method}() adapter supplied — ${consequence}`)
    }
    return undefined
  }
}

/**
 * Public-release spread sampler, independently expressed in an orthonormal frame.
 * Uniform azimuth and uniform cos(polar angle) give equal probability per unit area
 * on the spherical cap. This intentionally differs from the earlier port's spread.
 * When biasTowardEdge is false, retain the configurable radial-angle alternative.
 */
export function randomUnitVectorInCone(dir, halfAngleRad, random, out) {
  _aim.copy(dir).normalize()
  if (_aim.lengthSq() === 0) _aim.set(0, 0, -1)
  if (halfAngleRad <= 0) return out.copy(_aim)

  const cap = Math.min(Math.PI, halfAngleRad)
  const azimuth = random.next() * (2 * Math.PI)
  const radiusSample = random.next()
  const cosine = SPREAD.biasTowardEdge
    ? 1 - radiusSample * (1 - Math.cos(cap))
    : Math.cos(cap * Math.pow(radiusSample, SPREAD.edgeBiasExponent))
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine))

  // Choose a reference that stays away from parallel to the normalized aim.
  _tangent.set(Math.abs(_aim.y) < 0.9 ? 0 : 1, Math.abs(_aim.y) < 0.9 ? 1 : 0, 0)
  _tangent.cross(_aim).normalize()
  _bitangent.crossVectors(_aim, _tangent)
  return out.copy(_aim).multiplyScalar(cosine)
    .addScaledVector(_tangent, sine * Math.cos(azimuth))
    .addScaledVector(_bitangent, sine * Math.sin(azimuth))
    .normalize()
}

/** A target is "flesh" when it owns a health pool. Everything else is scenery. */
function poolOf(actor) {
  if (!actor) return null
  if (typeof actor.applyDamage === 'function') return actor
  if (typeof actor.health?.applyDamage === 'function') return actor.health
  return null
}

export class Weapon {
  /**
   * @param {object} config one of WEAPONS.PISTOL / RIFLE / SHOTGUN
   * @param {object} deps   { owner, world, fx, audio, bus, rng, aim, muzzle, hand, onFired }
   */
  constructor(config, deps = {}) {
    this.config = config
    this.id = config.id
    this.label = config.displayName

    this.baseDamage = config.baseDamage
    this.fireInterval = config.fireRate > 0 ? config.fireInterval : fireIntervalFallback
    this.magazineSize = config.magazineSize
    this.reloadTime = config.reloadTime
    this.baseSpread = config.baseSpread
    this.range = config.range
    this.automatic = config.automatic
    this.pelletCount = Math.max(1, config.pelletCount)
    this.fireSound = config.fireSound

    this.ammoInMag = config.magazineSize
    this.reserve = config.reserveAmmo
    this.isReloading = false
    this.reloadTimer = 0
    this.wantsToFire = false
    this.fireCooldownActive = false
    this.fireCooldown = 0
    this.mods = MOD.NONE

    this.owner = deps.owner ?? null
    this.hand = deps.hand ?? 'right'
    this.bus = deps.bus ?? sharedBus
    this.rng = deps.rng ?? sharedRng
    this.onFired = typeof deps.onFired === 'function' ? deps.onFired : NOOP
    this.ignore = this.owner ? [this.owner, this] : [this]

    this.aimSource = typeof deps.aim === 'function' ? deps.aim : null
    this.muzzleSource = typeof deps.muzzle === 'function' ? deps.muzzle : null

    const world = deps.world
    this.traceRay = hook(world, 'trace', 'shots hit nothing and the game is unwinnable')
    this.alertZombies = hook(world, 'alert', 'gunfire never wakes an unaware zombie')

    const fx = deps.fx
    this.fxMuzzleFlash = hook(fx, 'muzzleFlash', 'shots fire with no flash')
    this.fxCameraShake = hook(fx, 'cameraShake', 'shots have no weight')
    this.fxTracer = hook(fx, 'tracer', 'bullets are invisible in flight')
    this.fxImpact = hook(fx, 'impact', 'hits leave no burst')
    this.fxBloodDecal = hook(fx, 'bloodDecal', 'flesh hits leave no blood')
    this.fxDamageNumber = hook(fx, 'damageNumber', 'damage is never shown to the player')

    this.playSound = hook(deps.audio, 'play', 'the guns are silent')
  }

  /** The mask always comes from the player; a weapon never accumulates one of its own. */
  applyMods(mask) {
    this.mods = mask | 0
  }

  get empty() {
    return this.ammoInMag <= 0
  }

  /**
   * Trigger press. Edge-triggered on purpose: a semi-automatic weapon fires once per call,
   * and a press that lands inside the cooldown window is swallowed entirely rather than
   * queued. Feed it from WeaponSystem.setTrigger() if you only have a held/not-held flag.
   */
  startFire() {
    if (this.isReloading) return false
    this.wantsToFire = true
    if (this.fireCooldownActive) return false

    this.fireShot()
    // The cooldown starts even on an empty chamber, so a dry trigger cannot be pulled
    // faster than the gun's own rate.
    this.fireCooldownActive = true
    this.fireCooldown = this.fireInterval
    return true
  }

  /** An in-flight cooldown is deliberately NOT cancelled, so the rate cap survives tapping. */
  stopFire() {
    this.wantsToFire = false
  }

  /**
   * The magazine-change sound plays BEFORE the guard, which is what the original did: a
   * reload pressed on a full magazine or an empty reserve still clunks and does nothing.
   */
  reload() {
    this.playSound('magazine_reload', { volume: FIRE_AUDIO.reloadVolume })
    if (this.isReloading || this.ammoInMag >= this.magazineSize || this.reserve <= 0) return false

    this.isReloading = true
    this.reloadTimer = this.reloadTime
    this.fireCooldownActive = false
    this.fireCooldown = 0
    this.bus.emit(EV.WEAPON_RELOAD, { weapon: this.id, hand: this.hand, seconds: this.reloadTime })
    return true
  }

  /** Partial reloads top the magazine up; rounds already chambered are never wasted. */
  finishReload() {
    const toLoad = Math.min(this.magazineSize - this.ammoInMag, this.reserve)
    this.ammoInMag += toLoad
    this.reserve -= toLoad
    this.isReloading = false
    this.reloadTimer = 0

    // The cooldown was cancelled when the reload began, so a held trigger on an automatic
    // weapon has a round available the instant the magazine seats.
    if (this.automatic && this.wantsToFire) {
      this.fireShot()
      this.fireCooldownActive = true
      this.fireCooldown = this.fireInterval
    }
  }

  update(dt) {
    if (this.isReloading) {
      this.reloadTimer -= dt
      if (this.reloadTimer <= 0) this.finishReload()
    }

    if (!this.fireCooldownActive) return

    this.fireCooldown -= dt
    // A long frame must not lose shots: a 0.25 s hitch owes a rifle two rounds. The
    // remainder carries into the next interval so the cadence cannot drift toward the
    // frame rate.
    let budget = Math.ceil(dt / this.fireInterval) + 1
    while (this.fireCooldownActive && this.fireCooldown <= 0 && budget-- > 0) {
      this.fireCooldownActive = false
      if (this.automatic && this.wantsToFire && !this.isReloading) {
        this.fireShot()
        this.fireCooldownActive = true
        this.fireCooldown += this.fireInterval
      }
    }
  }

  /**
   * Aim origin priority from the original: the player's camera wins over the weapon mesh.
   * The ray therefore starts at the eye while the flash spawns at the muzzle — that split
   * is what makes the gun shoot exactly where the crosshair is.
   */
  resolveAim() {
    if (!this.aimSource) return false
    const aim = this.aimSource(this.hand)
    if (!aim?.origin || !aim?.direction) return false
    _origin.copy(aim.origin)
    _direction.copy(aim.direction)
    if (_direction.lengthSq() === 0) return false
    _direction.normalize()
    return true
  }

  resolveMuzzle() {
    if (this.muzzleSource) {
      const point = this.muzzleSource(this.hand)
      if (point) return _muzzle.copy(point)
    }
    return _muzzle.copy(_origin)
  }

  fireShot() {
    if (this.isReloading) return false

    if (this.empty) {
      // The original guarded here and returned, leaving the dry-fire clip unreachable and
      // an empty gun completely silent. rules.js marks the click reachable in the port.
      this.playSound('empty_chamber_click', { volume: FIRE_AUDIO.emptyChamberVolume })
      this.bus.emit(EV.WEAPON_DRY, { weapon: this.id, hand: this.hand, reserve: this.reserve })
      return false
    }

    if (!this.resolveAim()) {
      console.warn(`[weapons] ${this.id} could not resolve an aim origin — supply deps.aim(); no shot fired`)
      return false
    }

    this.ammoInMag -= 1
    const presentation = firePresentation(this.mods, this.rng)
    const muzzle = this.resolveMuzzle()

    this.fxMuzzleFlash({
      position: muzzle.clone(),
      suppressed: presentation.suppressed,
      profile: presentation.flash,
      weapon: this.id,
    })
    this.fxCameraShake(presentation.shakeScale)
    this.playSound(this.fireSound, {
      volume: presentation.volume,
      pitch: presentation.pitch,
      position: muzzle.clone(),
    })

    const halfAngle = spreadHalfAngleRad(this.baseSpread, this.mods)
    for (let pellet = 0; pellet < this.pelletCount; pellet++) {
      randomUnitVectorInCone(_direction, halfAngle, this.rng, _pellet)
      this.fireSingleTrace(_origin, _pellet, pellet, muzzle)
    }

    this.bus.emit(EV.WEAPON_FIRE, {
      weapon: this.id,
      hand: this.hand,
      suppressed: presentation.suppressed,
      mag: this.ammoInMag,
      reserve: this.reserve,
    })
    this.onFired({ weapon: this.id, hand: this.hand, suppressed: presentation.suppressed })
    return true
  }

  fireSingleTrace(origin, direction, pelletIndex, muzzle) {
    const hit = this.traceRay(origin, direction, this.range, this.ignore)

    if (FX.TRACER.enabled && pelletIndex % FX.TRACER.everyNthPellet === 0) {
      if (hit) _end.copy(hit.point)
      else _end.copy(origin).addScaledVector(direction, this.range)
      this.fxTracer({ from: muzzle.clone(), to: _end.clone(), weapon: this.id })
    }

    // A shot into open air produces nothing at all — no impact burst, and crucially no
    // noise. Firing at the ceiling is free, mods or not.
    if (!hit) return null

    const zone = hit.zone ?? zoneFromBoneName(hit.boneName)
    const result = resolveModdedShot(this.baseDamage, zone, this.mods)
    const actor = hit.actor ?? hit.target ?? null
    const pool = poolOf(actor)

    if (pool) {
      const healthBefore = pool.health
      this.applyDirect(actor, pool, result)
      const removed = healthBefore - pool.health
      if (Number.isFinite(removed) && removed > 0) {
        this.fxDamageNumber({ point: hit.point.clone(), value: Math.round(removed), zone })
      }
      this.fxBloodDecal({ point: hit.point.clone(), normal: hit.normal.clone(), zone })
    }

    this.fxImpact({ point: hit.point.clone(), normal: hit.normal.clone(), zone, flesh: Boolean(pool) })

    // Alerting runs per pellet, so a shotgun blast wakes the station eight times over —
    // redundant but harmless, and the adapter is free to keep a live zombie list rather
    // than walking the whole world eight times.
    if (result.alertsEnemies) this.alertZombies(origin.clone(), DAMAGE.hearingRadius)

    return { hit, zone, result }
  }

  applyDirect(actor, pool, result) {
    if (typeof actor.applyDamageResult === 'function') {
      actor.applyDamageResult(result, this.owner)
      return
    }
    if (typeof pool.applyShot === 'function') {
      pool.applyShot(result, this.owner)
      return
    }
    pool.applyDamage(result.directDamage, result.ignoresArmor, this.owner)
    // A shot that kills outright applies no burn; the stack only attaches to a survivor.
    if (result.burnTicks > 0 && !pool.isDead && typeof pool.addBurn === 'function') {
      pool.addBurn(result.burnDamagePerTick, result.burnTicks, result.burnTickInterval, this.owner)
    }
  }

  ammoState() {
    return {
      weapon: this.id,
      label: this.label,
      mag: this.ammoInMag,
      reserve: this.reserve,
      magazineSize: this.magazineSize,
      reloading: this.isReloading,
      reloadProgress: this.isReloading ? 1 - this.reloadTimer / this.reloadTime : 1,
      empty: this.empty,
    }
  }
}

/**
 * WeaponSystem — the player's hands.
 *
 * The original had no inventory: picking up a rifle destroyed the pistol forever, and the
 * switch key only wrote a log line. rules.js sets `switchingEnabled: true`, so the port
 * keeps every weapon it has been granted and cycles WEAPONS.ORDER. The one behaviour that
 * survives verbatim is that a grant builds a FRESH instance — re-picking a weapon restocks
 * it to a full magazine and a full reserve, and that is the only ammo resupply in the game.
 */
export class WeaponSystem {
  constructor(deps = {}) {
    this.deps = deps
    this.bus = deps.bus ?? sharedBus
    this.viewModel = deps.viewModel ?? null

    this.mods = PLAYER.START.activeMods
    this.dualWield = WEAPONS.DUAL_WIELD.startsEnabled
    this.fireLeftNext = WEAPONS.DUAL_WIELD.fireLeftNext
    this.switchTimer = 0
    this.triggerDown = false

    this.weapons = new Map()
    this.left = null
    this.current = PLAYER.START.weapon
    this.weapons.set(this.current, this.build(this.current, 'right'))
    this.viewModel?.setWeapon(this.current)
  }

  build(id, hand) {
    const deps = { ...this.deps, hand, onFired: (info) => this.handleFired(info) }
    // The flash and the fire sound belong at the muzzle of the gun the player can see, so
    // the viewmodel is the muzzle source unless the caller supplied its own.
    if (!deps.muzzle && this.viewModel) {
      deps.muzzle = (which) => this.viewModel.muzzleWorldPosition(which)
    }

    switch (id) {
      case 'pistol':
        return createPistol(deps)
      case 'rifle':
        return createRifle(deps)
      case 'shotgun':
        return createShotgun(deps)
      default:
        console.warn(`[weapons] unknown weapon id "${id}" — falling back to the pistol`)
        return createPistol(deps)
    }
  }

  handleFired(info) {
    const scale = info.suppressed ? FX.SHAKE.scaleSuppressedShot : FX.SHAKE.scaleNormalShot
    this.viewModel?.kick(scale, info.hand)
  }

  active() {
    return this.weapons.get(this.current) ?? null
  }

  /** Convenience for an input layer that only knows held / not-held. */
  setTrigger(down) {
    if (down === this.triggerDown) return
    this.triggerDown = down
    if (down) this.startFire()
    else this.stopFire()
  }

  /**
   * Every press goes to the primary. With the second pistol fitted the flag still flips on
   * every press, but it now decides whether the left pistol JOINS that press — not which of
   * the two guns receives it. That is what lets alternating taps beat a single pistol's 5/s
   * rate cap, and why the second gun stays a pistol even when the primary is a rifle.
   *
   * The left gun is additive because a primary denied its press is a primary whose automatic
   * burst never starts, and one pistol round is not a burst: routing every other HOLD to the
   * left pistol cost a rifle its entire 10-round second and a shotgun its shell.
   */
  startFire() {
    if (this.switchTimer > 0) return false
    if (!this.dualWield) return this.active()?.startFire() ?? false

    const primary = this.active()?.startFire() ?? false
    const left = this.fireLeftNext ? (this.left?.startFire() ?? false) : false
    this.fireLeftNext = !this.fireLeftNext
    return primary || left
  }

  stopFire() {
    this.active()?.stopFire()
    this.left?.stopFire()
  }

  /** Both guns reload at once, each running its own 2 s timer. */
  reload() {
    const primary = this.active()?.reload() ?? false
    const secondary = this.left?.reload() ?? false
    if (primary || secondary) {
      this.viewModel?.playReload(this.active()?.reloadTime ?? WEAPONS.DEFAULTS.reloadTime)
    }
    return primary || secondary
  }

  /** Picking a mod up ORs its bit in and pushes the whole mask to every gun in hand. */
  giveMod(bit) {
    const next = addMod(this.mods, bit)
    if (next === this.mods) return false
    this.mods = next
    for (const weapon of this.weapons.values()) weapon.applyMods(this.mods)
    this.left?.applyMods(this.mods)
    this.bus.emit(EV.MOD_GAINED, { mods: this.mods, badges: modBadges(this.mods, this.dualWield) })
    return true
  }

  grant(id) {
    const weapon = this.build(id, 'right')
    weapon.applyMods(this.mods)
    this.weapons.set(id, weapon)
    this.switchTo(id, true)
    return weapon
  }

  /** Idempotent: a second dual-wield pickup is ignored, exactly as the original's was. */
  grantDualWield() {
    if (this.dualWield) return false
    this.left = this.build('pistol', 'left')
    this.left.applyMods(this.mods)
    this.dualWield = true
    this.fireLeftNext = WEAPONS.DUAL_WIELD.fireLeftNext
    this.viewModel?.setDualWield(true)
    return true
  }

  switchTo(id, immediate = false) {
    if (!this.weapons.has(id) || id === this.current) return false
    this.active()?.stopFire()
    this.current = id
    this.switchTimer = immediate ? 0 : WEAPONS.switchCooldown
    this.viewModel?.setWeapon(id, this.switchTimer)
    this.bus.emit(EV.WEAPON_SWITCH, { weapon: id, ...this.ammoState() })
    return true
  }

  /** Cycles only the weapons actually picked up, in the published draw order. */
  switchNext(direction = 1) {
    if (!WEAPONS.switchingEnabled || this.switchTimer > 0) return false
    const owned = WEAPONS.ORDER.filter((id) => this.weapons.has(id))
    if (owned.length < 2) return false
    const index = owned.indexOf(this.current)
    const next = owned[(index + direction + owned.length) % owned.length]
    return this.switchTo(next)
  }

  update(dt, motion) {
    if (this.switchTimer > 0) this.switchTimer = Math.max(0, this.switchTimer - dt)
    this.active()?.update(dt)
    this.left?.update(dt)
    this.viewModel?.update(dt, motion)
  }

  ammoState() {
    const primary = this.active()?.ammoState()
    if (!primary) {
      return { weapon: null, text: '-- / --', mods: this.mods, badges: [], dual: this.dualWield }
    }
    return {
      ...primary,
      text: `${primary.mag} / ${primary.reserve}`,
      left: this.left ? this.left.ammoState() : null,
      dual: this.dualWield,
      mods: this.mods,
      badges: modBadges(this.mods, this.dualWield),
      owned: WEAPONS.ORDER.filter((id) => this.weapons.has(id)),
      switching: this.switchTimer > 0,
    }
  }
}
