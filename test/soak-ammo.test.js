/**
 * Pins the ammunition model added to soak.js: the primitives that spend, reload and refill
 * a magazine, and the runSoak({ ammo }) wiring that stops crediting kills once a weapon runs
 * dry. Pure module, no renderer — same footing as waves.test.js.
 */
import { describe, it, expect } from 'vitest'
import { runSoak, ammoModel } from '../src/game/soak.js'
import { WEAPONS } from '../src/game/rules.js'

const { makeAmmoState, spendRound, tickReload, refillAmmo } = ammoModel

describe('ammo primitives', () => {
  it('starts with a full magazine and reserve, mirroring Weapon()', () => {
    const ammo = makeAmmoState(WEAPONS.RIFLE)
    expect(ammo.mag).toBe(WEAPONS.RIFLE.magazineSize)
    expect(ammo.reserve).toBe(WEAPONS.RIFLE.reserveAmmo)
    expect(ammo.reloading).toBe(false)
  })

  it('N shots spend N rounds off the magazine', () => {
    const ammo = makeAmmoState(WEAPONS.RIFLE)
    const shots = 12
    for (let i = 0; i < shots; i++) {
      const fired = spendRound(ammo)
      expect(fired).toBe(true)
    }
    expect(ammo.mag).toBe(WEAPONS.RIFLE.magazineSize - shots)
    expect(ammo.reserve).toBe(WEAPONS.RIFLE.reserveAmmo)
  })

  it('an empty magazine starts a reload and refuses to fire until it completes', () => {
    const ammo = makeAmmoState(WEAPONS.RIFLE)
    for (let i = 0; i < ammo.magazineSize; i++) spendRound(ammo)

    expect(ammo.mag).toBe(0)
    expect(ammo.reloading).toBe(true)
    expect(spendRound(ammo)).toBe(false) // still reloading — trigger pull does nothing

    tickReload(ammo, ammo.reloadTime - 0.001)
    expect(ammo.reloading).toBe(true) // not done yet
    expect(spendRound(ammo)).toBe(false)

    tickReload(ammo, 0.002)
    expect(ammo.reloading).toBe(false)
    expect(ammo.mag).toBe(WEAPONS.RIFLE.magazineSize)
    expect(ammo.reserve).toBe(WEAPONS.RIFLE.reserveAmmo - WEAPONS.RIFLE.magazineSize)
  })

  it('a dry weapon (mag and reserve both zero) cannot fire, ever', () => {
    const ammo = makeAmmoState(WEAPONS.RIFLE)
    ammo.mag = 0
    ammo.reserve = 0

    expect(spendRound(ammo)).toBe(false)
    expect(ammo.reloading).toBe(false) // reload() refuses outright: nothing to load

    tickReload(ammo, 999) // nothing to tick — it was never reloading
    expect(spendRound(ammo)).toBe(false)
    expect(ammo.mag).toBe(0)
    expect(ammo.reserve).toBe(0)
  })

  it('collecting a weapon (grant()) refills both the magazine and the reserve', () => {
    const ammo = makeAmmoState(WEAPONS.RIFLE)
    for (let i = 0; i < 40; i++) spendRound(ammo) // burn into the reserve, past one full mag
    expect(ammo.mag + ammo.reserve).toBeLessThan(WEAPONS.RIFLE.magazineSize + WEAPONS.RIFLE.reserveAmmo)

    refillAmmo(ammo)
    expect(ammo.mag).toBe(WEAPONS.RIFLE.magazineSize)
    expect(ammo.reserve).toBe(WEAPONS.RIFLE.reserveAmmo)
    expect(ammo.reloading).toBe(false)
  })
})

describe('runSoak({ ammo }) wiring', () => {
  it('defaults to unmodeled ammo, so the existing soak gate is untouched', () => {
    const report = runSoak({ waves: 3, seed: 1337 })
    expect(report.ammo).toBeNull()
  })

  it('a grounded player runs the primary weapon dry and stalls before wave 25', () => {
    const report = runSoak({ waves: 25, seed: 1337, ammo: true, climb: 'grounded' })
    expect(report.ammo.driedUpAtWave).not.toBeNull()
    expect(report.waves.length).toBeLessThan(25)
    expect(report.errors.some(e => e.includes('stalled'))).toBe(true)
    // Once dry, mag and reserve stay at zero — the weapon never fires again.
    expect(report.ammo.final.mag).toBe(0)
    expect(report.ammo.final.reserve).toBe(0)
  })

  it('a climbing player resupplies from the summit restock and reaches more waves than grounded', () => {
    const grounded = runSoak({ waves: 25, seed: 1337, ammo: true, climb: 'grounded' })
    const climbing = runSoak({ waves: 25, seed: 1337, ammo: true, climb: 'climbing' })
    // Same seed, same spawns and shot rolls — the only difference is the resupply.
    expect(climbing.waves.length).toBeGreaterThanOrEqual(grounded.waves.length)
    expect(climbing.ammo.primaryShotsFired).toBeGreaterThanOrEqual(grounded.ammo.primaryShotsFired)
  })
})


describe('resource termination evidence', () => {
  it('reports ammunition exhaustion without accusing the queue of being stuck', () => {
    const report = runSoak({ waves: 25, seed: 1337, ammo: true })
    expect(report.termination?.reason).toBe('ammo_exhausted')
    expect(report.termination?.wave).toBe(5)
    expect(report.errors.join(' ')).not.toContain('bookkeeping is stuck')
  })
  it('uses the current rifle restock after wave 3 and reports the modeled scope', () => {
    const report = runSoak({ waves: 4, seed: 1337, ammo: true, climb: 'climbing' })
    expect(report.ammo.curve.find(row => row.wave === 3)?.total).toBe(270)
    expect(report.assumptions.incomingDamage).toBe(false)
    expect(report.assumptions.ammunition).toBe('finite')
  })
})
