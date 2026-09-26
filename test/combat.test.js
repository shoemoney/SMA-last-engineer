/**
 * The damage model, asserted against the worked tables in spec/damage-weapons.md.
 *
 * Every import is the REAL module. Nothing here stubs the maths it is checking, and nothing
 * here imports three.js — these run in node in milliseconds, which is the whole point of the
 * purity rule in CONTRACT.md.
 */
import { describe, it, expect } from 'vitest'
import { MOD, resolveShot, zoneMultiplier, applyExplosiveAoE, selectAoETargets } from '../src/game/damage.js'
import { HealthPool, CONDITION, effectiveHealth, armorSplit } from '../src/game/health.js'
import { DAMAGE, HEALTH, PICKUPS, WEAPONS } from '../src/game/rules.js'
import { STEP } from '../src/core/loop.js'

const PISTOL = WEAPONS.PISTOL.baseDamage
const RIFLE = WEAPONS.RIFLE.baseDamage
const SHOT = WEAPONS.SHOTGUN.baseDamage
const ZONES = DAMAGE.zones

/** 40 s of simulation at the loop's real fixed step, so decay is tested the way it runs. */
function advance(pool, seconds) {
  const steps = Math.round(seconds / STEP)
  for (let i = 0; i < steps; i++) pool.tick(STEP)
  return pool
}

describe('hit zones', () => {
  it('multiplies body 1x, chest 3x and head 5x', () => {
    expect(zoneMultiplier(ZONES.body)).toBe(1)
    expect(zoneMultiplier(ZONES.chest)).toBe(3)
    expect(zoneMultiplier(ZONES.head)).toBe(5)
  })

  it('resolves the pistol to spec section 16.1 — 20 / 60 / 100', () => {
    expect(resolveShot(PISTOL, ZONES.body).directDamage).toBe(20)
    expect(resolveShot(PISTOL, ZONES.chest).directDamage).toBe(60)
    expect(resolveShot(PISTOL, ZONES.head).directDamage).toBe(100)
  })

  it('resolves the rifle and one shotgun pellet on the same curve', () => {
    expect(resolveShot(RIFLE, ZONES.body).directDamage).toBe(15)
    expect(resolveShot(RIFLE, ZONES.head).directDamage).toBe(75)
    expect(resolveShot(SHOT, ZONES.body).directDamage).toBe(12)
    // Eight pellets, each resolved independently: an all-head blast is 8 x 60.
    expect(resolveShot(SHOT, ZONES.head).directDamage * WEAPONS.SHOTGUN.pelletCount).toBe(480)
  })
})

describe('incendiary', () => {
  it('carries exactly five ticks of the BASE damage, never the zone-scaled damage', () => {
    const head = resolveShot(PISTOL, ZONES.head, MOD.INCENDIARY)
    expect(head.burnTicks).toBe(5)
    expect(head.burnDamagePerTick).toBe(PISTOL)
    expect(head.burnTickInterval).toBe(1)
    // 100 up front from the headshot, then 5 x 20 over the next five seconds.
    expect(head.directDamage).toBe(100)
  })

  it('burns straight through armor', () => {
    const pool = new HealthPool({ maxHealth: 200, health: 200, armor: 100 })
    const shot = resolveShot(PISTOL, ZONES.body, MOD.INCENDIARY)
    pool.applyShot(shot, null)

    const healthAfterImpact = pool.health
    const armorAfterImpact = pool.armor
    advance(pool, shot.burnTicks * shot.burnTickInterval)

    expect(pool.armor).toBe(armorAfterImpact)
    expect(healthAfterImpact - pool.health).toBeCloseTo(shot.burnDamagePerTick * shot.burnTicks, 6)
  })

  it('stops ticking once the stack is spent', () => {
    const pool = new HealthPool({ maxHealth: 500, health: 500 })
    pool.applyShot(resolveShot(PISTOL, ZONES.body, MOD.INCENDIARY), null)
    advance(pool, DAMAGE.incendiary.ticks * DAMAGE.incendiary.tickInterval)
    const settled = pool.health
    advance(pool, 10)
    expect(pool.health).toBe(settled)
  })
})

describe('explosive', () => {
  /**
   * REBALANCED from the original spec's 5.0 impact multiplier. At 5.0 an explosive pistol
   * body shot was 120 against a 100hp shambler — a one-shot kill that also dealt a flat 60
   * to everything within 3.5m through walls. Played as "extremely easy". These assertions
   * now pin the DELIBERATE deviation, not the original's numbers.
   */
  it('adds a 2x impact on the struck body and a 3x blast to everything else', () => {
    const shot = resolveShot(PISTOL, ZONES.body, MOD.EXPLOSIVE)
    expect(DAMAGE.explosive.impactMultiplier).toBe(2.0) // rebalanced from 5.0
    expect(shot.directDamage).toBe(60) // 20 body + 20 * 2 impact
    expect(shot.aoeDamage).toBe(60) // 20 * 3, still deliberately not zone-scaled
    expect(shot.aoeRadius).toBe(DAMAGE.explosive.radius)
    // A headshot scales only the direct term; the blast is the same size either way.
    expect(resolveShot(PISTOL, ZONES.head, MOD.EXPLOSIVE).directDamage).toBe(140) // 20*5 + 20*2
    // It must still beat a plain body shot decisively, or the mod is not worth picking up.
    expect(shot.directDamage).toBeGreaterThan(resolveShot(PISTOL, ZONES.body, MOD.NONE).directDamage * 2)
  })

  it('falls off with distance instead of dealing flat damage across the sphere', () => {
    expect(DAMAGE.explosive.damageFallsOff).toBe(true) // rebalanced from the original's false
    const shot = resolveShot(PISTOL, ZONES.body, MOD.EXPLOSIVE)
    const at = z => {
      const t = { position: { x: 0, y: 0, z }, health: new HealthPool({ maxHealth: 500, health: 500 }) }
      return applyExplosiveAoE({ impactPoint: { x: 0, y: 0, z: 0 }, candidates: [t], result: shot }).totalDealt
    }
    const point_blank = at(1)
    const edge = at(DAMAGE.explosive.radius - 1)
    expect(point_blank).toBeGreaterThan(edge)
    // The edge still hurts — a blast that does nothing at 3.4m is not a blast.
    expect(edge).toBeGreaterThan(shot.aoeDamage * DAMAGE.explosive.minFalloffFraction * 0.9)
  })

  it('excludes the body it hit directly and spares anything past the radius', () => {
    const near = { position: { x: 0, y: 0, z: 100 }, health: new HealthPool({ maxHealth: 500, health: 500 }) }
    const far = { position: { x: 0, y: 0, z: DAMAGE.explosive.radius + 1 }, health: new HealthPool({ maxHealth: 500, health: 500 }) }
    const direct = { position: { x: 0, y: 0, z: 0 }, health: new HealthPool({ maxHealth: 500, health: 500 }) }

    const selected = selectAoETargets({
      impactPoint: { x: 0, y: 0, z: 0 },
      candidates: [direct, near, far],
      radius: DAMAGE.explosive.radius,
      directTarget: direct,
    })
    expect(selected).toEqual([near])
  })

  it('respects armor on the area pass even with armor piercing fitted', () => {
    const shot = resolveShot(PISTOL, ZONES.body, MOD.EXPLOSIVE | MOD.ARMOR_PIERCING)
    const target = { position: { x: 0, y: 0, z: 10 }, health: new HealthPool({ maxHealth: 500, health: 500, armor: 200 }) }
    const { totalDealt } = applyExplosiveAoE({
      impactPoint: { x: 0, y: 0, z: 0 },
      candidates: [target],
      result: shot,
      directTarget: null,
    })
    // Armor eats half whatever arrives: WEAPONS.MODS.armorPiercing.appliesToAreaDamage is false.
    // The arriving amount is now distance-scaled, so assert the RATIO rather than a constant —
    // a test that hardcodes the post-falloff number would have to be rewritten on every tune.
    expect(WEAPONS.MODS.armorPiercing.appliesToAreaDamage).toBe(false)
    const arrived = totalDealt / (1 - HEALTH.armorAbsorption)
    expect(arrived).toBeLessThanOrEqual(shot.aoeDamage)
    expect(arrived).toBeGreaterThan(shot.aoeDamage * 0.9)  // 10cm from the centre of a 350cm blast
    expect(target.health.armor).toBeCloseTo(200 - arrived * HEALTH.armorAbsorption, 6)
  })
})

describe('armor piercing and the silencer', () => {
  it('bypasses armor on the direct hit only', () => {
    const plain = new HealthPool({ maxHealth: 200, health: 200, armor: 100 })
    const pierced = new HealthPool({ maxHealth: 200, health: 200, armor: 100 })

    plain.applyShot(resolveShot(PISTOL, ZONES.head), null)
    pierced.applyShot(resolveShot(PISTOL, ZONES.head, MOD.ARMOR_PIERCING), null)

    // 100 damage: unarmoured it is 100 health, armoured the plate eats 50 of it.
    expect(plain.health).toBe(150)
    expect(plain.armor).toBe(50)
    expect(pierced.health).toBe(100)
    expect(pierced.armor).toBe(100)
  })

  it('splits damage exactly as spec section 10.1 works it', () => {
    expect(armorSplit(100, 100, HEALTH.armorAbsorption)).toEqual({ absorbed: 50, toHealth: 50 })
    // The plate can only give what it has: 20 armor against 100 damage absorbs 20, not 50.
    expect(armorSplit(100, 20, HEALTH.armorAbsorption)).toEqual({ absorbed: 20, toHealth: 80 })
  })

  it('is the only mod that changes whether a shot wakes the station', () => {
    expect(resolveShot(PISTOL, ZONES.body).alertsEnemies).toBe(true)
    expect(resolveShot(PISTOL, ZONES.body, MOD.SILENCER).alertsEnemies).toBe(false)
    // and it changes nothing about the damage
    expect(resolveShot(PISTOL, ZONES.head, MOD.SILENCER).directDamage)
      .toBe(resolveShot(PISTOL, ZONES.head).directDamage)
  })
})

describe('health, overheal and death', () => {
  it('heals 50% of MAX health, not of what is missing', () => {
    const pool = new HealthPool({ maxHealth: HEALTH.maxHealth, health: 40 })
    expect(pool.healPercent(PICKUPS.healPercent)).toBe(50)
    expect(pool.health).toBe(90)
  })

  it('refuses a heal at the overheal cap, which is what leaves the pickup standing', () => {
    const pool = new HealthPool({ maxHealth: HEALTH.maxHealth, health: HEALTH.overhealCap })
    expect(pool.healPercent(PICKUPS.healPercent)).toBe(0)
  })

  it('decays 200 back to 100 in exactly 40 seconds', () => {
    const pool = new HealthPool({ maxHealth: HEALTH.maxHealth, health: HEALTH.overhealCap })
    advance(pool, 39)
    expect(pool.health).toBeGreaterThan(HEALTH.maxHealth)
    advance(pool, 1)
    expect(pool.health).toBeCloseTo(HEALTH.maxHealth, 6)
    // At the soft cap the bleed stops rather than eating into real health.
    advance(pool, 10)
    expect(pool.health).toBeCloseTo(HEALTH.maxHealth, 6)
  })

  it('reports a Tank at 1100 raw damage to kill, and 900 once armor is bypassed', () => {
    expect(effectiveHealth(900, 200, HEALTH.armorAbsorption)).toBe(1100)
    expect(effectiveHealth(900, 0, HEALTH.armorAbsorption)).toBe(900)
  })

  it('dies once, and stays dead', () => {
    const pool = new HealthPool({ maxHealth: 100, health: 100 })
    expect(pool.alive).toBe(true)
    pool.applyDamage(100, false, null)
    expect(pool.isDead).toBe(true)
    expect(pool.health).toBe(0)
    expect(pool.getCondition()).toBe(CONDITION.DEAD)
    // A second hit on a corpse removes nothing.
    expect(pool.applyDamage(100, false, null)).toBe(0)
  })
})
