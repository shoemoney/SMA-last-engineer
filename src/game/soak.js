/**
 * Deterministic wave bookkeeping and damage smoke test, not a playability test.
 * The default rifle has unlimited ammunition. Optional finite ammunition models
 * magazine/reload timing and immediate collection of matching summit restocks.
 * Movement, line of sight, incoming attacks, other inventory guns and pickup travel
 * are not simulated. Dual wield fires only on modeled trigger-engagement edges.
 */

import { EventBus, EV } from '../core/events.js'
import { Rng } from '../core/rng.js'
import { STEP } from '../core/loop.js'
import { WAVES, WEAPONS, PICKUPS } from './rules.js'
import { resolveShot, MOD, ZONE } from './damage.js'
import { HealthPool } from './health.js'
import { WaveDirector } from './waveDirector.js'

/**
 * Harness dials, not game balance — nothing in the shipped game reads them, which is why
 * they live here and not in rules.js. They describe an imaginary competent player: a rifle,
 * no mods, a plausible spread of hit zones, and a patience limit past which a wave that has
 * not ended is called stuck rather than waited on forever.
 */
const SOAK = Object.freeze({
  weapon: WEAPONS.RIFLE,
  mods: MOD.NONE,
  missRate: 0.12,
  headshotRate: 0.35,
  chestRate: 0.35,
  maxWaveSeconds: 900,
})

/**
 * resolveShot is pure and the soak fires one unchanging weapon with one unchanging mod
 * mask, so the three possible payloads are resolved once instead of ten times a second.
 */
const SHOT_BY_ZONE = new Map(
  [ZONE.head, ZONE.chest, ZONE.body].map(zone => [zone, resolveShot(SOAK.weapon.baseDamage, zone, SOAK.mods)])
)

/**
 * The dual-wield off hand is always a pistol (WEAPONS.DUAL_WIELD sockets a second PISTOL,
 * whatever the primary is — weapon.js grantDualWield()), so its payload is resolved from
 * WEAPONS.PISTOL.baseDamage, not the primary's, with the same mod mask the soak already
 * assumes (SOAK.mods — the soak models no mods on either hand).
 */
const PISTOL_SHOT_BY_ZONE = new Map(
  [ZONE.head, ZONE.chest, ZONE.body].map(zone => [zone, resolveShot(WEAPONS.PISTOL.baseDamage, zone, SOAK.mods)])
)

/** A miss still burns the shot, which is what keeps the sim clock honest. */
function pickZone(rng) {
  const roll = rng.next()
  if (roll < SOAK.missRate) return null
  if (roll < SOAK.missRate + SOAK.headshotRate) return ZONE.head
  if (roll < SOAK.missRate + SOAK.headshotRate + SOAK.chestRate) return ZONE.chest
  return ZONE.body
}

/** A fresh magazine-and-reserve tracker for one gun, mirroring Weapon's constructor fields. */
function makeAmmoState(weaponConfig) {
  return {
    magazineSize: weaponConfig.magazineSize,
    reserveAmmo: weaponConfig.reserveAmmo,
    reloadTime: weaponConfig.reloadTime,
    mag: weaponConfig.magazineSize,
    reserve: weaponConfig.reserveAmmo,
    reloading: false,
    reloadTimer: 0,
  }
}

/** Weapon.reload(): refused while already reloading or once the reserve is empty. */
function beginReload(ammo) {
  if (ammo.reloading || ammo.reserve <= 0) return
  ammo.reloading = true
  ammo.reloadTimer = ammo.reloadTime
}

/** Weapon.finishReload(): tops the magazine from the reserve, never wasting a chambered round. */
function tickReload(ammo, dt) {
  if (!ammo.reloading) return
  ammo.reloadTimer -= dt
  if (ammo.reloadTimer > 0) return
  const toLoad = Math.min(ammo.magazineSize - ammo.mag, ammo.reserve)
  ammo.mag += toLoad
  ammo.reserve -= toLoad
  ammo.reloading = false
  ammo.reloadTimer = 0
}

/** WeaponSystem.grant(): a re-granted weapon comes back with a full magazine AND reserve. */
function refillAmmo(ammo) {
  ammo.mag = ammo.magazineSize
  ammo.reserve = ammo.reserveAmmo
  ammo.reloading = false
  ammo.reloadTimer = 0
}

/**
 * Weapon.fireShot(): spends one round from the magazine and returns whether the gun actually
 * fired. A magazine that reaches zero immediately requests a reload — the harness's one
 * competent-player liberty, see the AMMUNITION doc above — which beginReload() refuses
 * outright once the reserve is also empty, leaving the gun silently, permanently dry.
 */
function spendRound(ammo) {
  if (ammo.mag <= 0) {
    beginReload(ammo)
    return false
  }
  ammo.mag -= 1
  if (ammo.mag === 0) beginReload(ammo)
  return true
}

export const ammoModel = { makeAmmoState, beginReload, tickReload, refillAmmo, spendRound }

export function runSoak({ waves = 25, seed = 1337, dualWield = false, ammo = false, climb = 'grounded' } = {}) {
  const errors = []
  const bus = new EventBus()
  const rng = new Rng(seed)
  const director = new WaveDirector({ bus, rng })

  const live = []
  const report = []
  let current = null
  let termination = null
  let simSeconds = 0
  let totalSpawned = 0
  let totalKilled = 0
  let dualWieldShots = 0
  let dualWieldKills = 0

  const primaryAmmo = ammo ? makeAmmoState(SOAK.weapon) : null
  const offHandAmmo = ammo && dualWield ? makeAmmoState(WEAPONS.PISTOL) : null
  const ammoCurve = []
  let driedUpAtWave = null
  let primaryShotsFired = 0
  let offHandShotsFired = 0

  // WeaponSystem.startFire() semantics (weapon.js:489-501): the left pistol joins a
  // trigger PRESS, not a trigger HOLD — an automatic weapon held down calls startFire()
  // once and then fires on its own via Weapon.update(), never touching fireLeftNext again.
  // The soak has no discrete "press" input; the honest analogue is the trigger going from
  // idle (no target) to engaged (a target exists), which is exactly what `live.length`
  // crossing 0 -> >0 already means in this file. fireLeftNext starts false — "the first
  // trigger press fires the RIGHT pistol" (WEAPONS.DUAL_WIELD) — and is reset to false by
  // grantDualWield(), which is why it starts false here too rather than mid-cycle.
  let fireLeftNext = WEAPONS.DUAL_WIELD.fireLeftNext
  let triggerEngaged = false

  bus.on(EV.ZOMBIE_SPAWN, ({ archetype, stats }) => {
    // maxArmor is left at its default: HealthPool lifts its own hard caps to whatever it is
    // configured with, so a Boss keeps all 300 points and then decays back to 200 like the
    // original's did.
    live.push({
      archetype,
      pool: new HealthPool({ maxHealth: stats.maxHealth, armor: stats.armor }),
    })
    totalSpawned += 1
    if (current) current.spawned += 1
  })

  bus.on(EV.WAVE_START, ({ wave, composition }) => {
    if (live.length > 0) {
      errors.push(`wave ${wave} started with ${live.length} zombies still alive from the previous wave`)
    }
    current = {
      wave,
      spawned: 0,
      killed: 0,
      boss: composition.bossCount > 0,
      expected: composition.totalCount,
      startedAt: simSeconds,
    }
  })

  bus.on(EV.WAVE_CLEAR, ({ wave }) => {
    if (!current) {
      errors.push(`wave ${wave} cleared without a matching start`)
      return
    }
    if (current.spawned !== current.expected) {
      errors.push(`wave ${wave} spawned ${current.spawned} of the ${current.expected} its composition called for`)
    }
    if (current.killed !== current.spawned) {
      errors.push(`wave ${wave} cleared with ${current.spawned} spawned but ${current.killed} killed`)
    }

    if (ammo) {
      if (climb === 'climbing') {
        const restock = PICKUPS.summitRestock[wave % PICKUPS.summitRestock.length]
        if (restock === SOAK.weapon.id) refillAmmo(primaryAmmo)
        if (restock === WEAPONS.PISTOL.id && offHandAmmo) refillAmmo(offHandAmmo)
      }
      ammoCurve.push({
        wave,
        mag: primaryAmmo.mag,
        reserve: primaryAmmo.reserve,
        total: primaryAmmo.mag + primaryAmmo.reserve,
        offHandTotal: offHandAmmo ? offHandAmmo.mag + offHandAmmo.reserve : null,
      })
    }

    report.push({
      wave: current.wave,
      spawned: current.spawned,
      killed: current.killed,
      boss: current.boss,
      simSeconds: simSeconds - current.startedAt,
    })
    current = null
  })

  /** Returns whether a round actually left the gun — false is a dry click (ammo model only). */
  const shoot = () => {
    if (ammo) {
      if (!spendRound(primaryAmmo)) return false
      primaryShotsFired += 1
      // A magazine that just emptied and could not start a reload has an empty reserve too —
      // this is the last round the primary weapon will ever fire for the rest of the run.
      if (primaryAmmo.mag === 0 && !primaryAmmo.reloading && driedUpAtWave === null) {
        driedUpAtWave = current?.wave ?? null
      }
    }

    const zone = pickZone(rng)
    if (zone === null) return true

    // Always the oldest live zombie: a deterministic target choice keeps the seed meaningful.
    const target = live[0]
    const { dealt, killed } = target.pool.applyShot(SHOT_BY_ZONE.get(zone))

    if (!Number.isFinite(dealt)) {
      errors.push(`a ${zone} shot on a ${target.archetype} in wave ${current?.wave} dealt ${dealt}`)
      return true
    }
    if (!killed) return true

    live.shift()
    totalKilled += 1
    if (current) current.killed += 1

    // Called directly rather than through EV.ZOMBIE_DEATH: in the browser build GameState is
    // the one subscriber that relays a death to the director, and there is no GameState here.
    // Emitting would only invite a second, double-counting listener.
    director.notifyZombieRemoved()
    return true
  }

  /**
   * One shot from the off-hand pistol, fired on a trigger-press edge per the alternation
   * in WeaponSystem.startFire(). Mirrors `shoot()` above rather than sharing it: the two
   * guns resolve independent payloads (pistol vs primary) and either one can land the kill.
   */
  const shootOffHand = () => {
    if (ammo) {
      if (!spendRound(offHandAmmo)) return
      offHandShotsFired += 1
    }

    const zone = pickZone(rng)
    if (zone === null) return

    const target = live[0]
    const { dealt, killed } = target.pool.applyShot(PISTOL_SHOT_BY_ZONE.get(zone))
    dualWieldShots += 1

    if (!Number.isFinite(dealt)) {
      errors.push(`a dual-wield ${zone} shot on a ${target.archetype} in wave ${current?.wave} dealt ${dealt}`)
      return
    }
    if (!killed) return

    live.shift()
    totalKilled += 1
    dualWieldKills += 1
    if (current) current.killed += 1
    director.notifyZombieRemoved()
  }

  director.start(WAVES.firstWaveNumber)

  let fireTimer = 0
  let steps = 0
  const maxSteps = Math.ceil((SOAK.maxWaveSeconds * waves) / STEP)

  while (report.length < waves && steps < maxSteps) {
    director.update(STEP)
    simSeconds += STEP
    steps += 1

    // Armor above its soft cap decays, and any burn stack advances, on the same clock the
    // director runs on.
    for (const zombie of live) zombie.pool.tick(STEP)

    if (ammo) {
      tickReload(primaryAmmo, STEP)
      if (dualWield) tickReload(offHandAmmo, STEP)
    }

    if (dualWield) {
      const engaged = live.length > 0
      if (engaged && !triggerEngaged) {
        // A fresh press: the left pistol joins only if fireLeftNext is currently true,
        // then the flag flips regardless of whether it fired — identical order of
        // operations to WeaponSystem.startFire(). Reloading blocks the press entirely,
        // same as Weapon.startFire()'s `if (this.isReloading) return false`.
        if (fireLeftNext && (!ammo || !offHandAmmo.reloading)) shootOffHand()
        fireLeftNext = !fireLeftNext
      }
      triggerEngaged = engaged
    }

    // Weapon.update() skips fireShot() entirely while isReloading — the cooldown clock is
    // parked, not just the shot — so the whole fire-timer block is skipped the same way.
    if (!ammo || !primaryAmmo.reloading) {
      fireTimer -= STEP
      while (fireTimer <= 0 && live.length > 0) {
        const fired = shoot()
        fireTimer += SOAK.weapon.fireInterval
        // Dry (out of reserve) or just started reloading — no more catch-up shots this step.
        if (ammo && !fired) break
      }
      if (live.length === 0 && fireTimer < 0) fireTimer = 0
    }

    if (current && simSeconds - current.startedAt > SOAK.maxWaveSeconds) {
      const primaryDry = ammo && primaryAmmo.mag + primaryAmmo.reserve === 0
      termination = {
        reason: primaryDry ? 'ammo_exhausted' : 'time_budget',
        wave: current.wave,
        killed: current.killed,
        expected: current.expected,
        primaryAmmo: ammo ? primaryAmmo.mag + primaryAmmo.reserve : null,
        offHandAmmo: offHandAmmo ? offHandAmmo.mag + offHandAmmo.reserve : null,
      }
      errors.push(
        `wave ${current.wave} stalled: ${SOAK.maxWaveSeconds}s of sim with ${current.killed}/${current.expected} killed ` +
        `and ${live.length} alive — ${primaryDry ? 'primary ammunition exhausted in this resource model' : 'simulation time budget exceeded'}`
      )
      break
    }
  }

  if (report.length < waves && errors.length === 0) {
    errors.push(`only ${report.length} of ${waves} waves completed inside the ${maxSteps}-step budget`)
  }

  return {
    assumptions: {
      ammunition: ammo ? 'finite' : 'unlimited',
      incomingDamage: false,
      movement: false,
      lineOfSight: false,
      restockCollection: climb === 'climbing' ? 'immediate' : 'none',
      primaryWeapon: SOAK.weapon.id,
    },
    termination,
    waves: report,
    totalSpawned,
    totalKilled,
    errors,
    dualWieldShots,
    dualWieldKills,
    ammo: ammo
      ? {
          climb,
          curve: ammoCurve,
          driedUpAtWave,
          primaryShotsFired,
          offHandShotsFired,
          final: { mag: primaryAmmo.mag, reserve: primaryAmmo.reserve },
        }
      : null,
  }
}
