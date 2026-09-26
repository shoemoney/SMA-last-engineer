/**
 * Two targeted regression tests, written RED against current damage.js:
 *
 *  1. Explosive AoE has no line-of-sight check — a column between the blast and a body
 *     currently does nothing to stop the hit. `applyExplosiveAoE` needs to accept the same
 *     kind of trace function weapon.js already uses (`world.trace` — see weapon.js's
 *     `this.traceRay`) and skip any candidate the trace says is blocked.
 *
 *  2. `damageNumberValue` prints `directDamage` only, so an incendiary hit's floating number
 *     understates the real total by a ratio that moves with hit zone (6x at body, 2x at
 *     head, for the same weapon) — the player can never learn the true number from the HUD.
 */
import { describe, it, expect } from 'vitest'
import { MOD, resolveShot, applyExplosiveAoE, damageNumberValue } from '../src/game/damage.js'
import { HealthPool } from '../src/game/health.js'
import { DAMAGE, WEAPONS } from '../src/game/rules.js'

const PISTOL = WEAPONS.PISTOL.baseDamage
const ZONES = DAMAGE.zones

function bodyAt(z) {
  return { position: { x: 0, y: 0, z }, health: new HealthPool({ maxHealth: 500, health: 500 }) }
}

describe('explosive AoE line-of-sight', () => {
  it('deals zero damage to a body behind an occluder the trace facility reports', () => {
    const shot = resolveShot(PISTOL, ZONES.body, MOD.EXPLOSIVE)
    const target = bodyAt(150) // well inside DAMAGE.explosive.radius (350cm)

    // A stand-in for world.trace: reports ANY ray as blocked, as if a station column sat
    // directly between the blast origin and every candidate.
    const blockedTrace = () => ({ point: { x: 0, y: 0, z: 75 }, distance: 75 })

    const { hits, totalDealt } = applyExplosiveAoE({
      impactPoint: { x: 0, y: 0, z: 0 },
      candidates: [target],
      result: shot,
      traceRay: blockedTrace,
    })

    expect(totalDealt).toBe(0)
    expect(hits).toEqual([])
    expect(target.health.health).toBe(500) // untouched — the blast never reached it
  })

  it('still deals damage to a body with clear line of sight', () => {
    const shot = resolveShot(PISTOL, ZONES.body, MOD.EXPLOSIVE)
    const target = bodyAt(150)
    const clearTrace = () => null // nothing in the way

    const { totalDealt } = applyExplosiveAoE({
      impactPoint: { x: 0, y: 0, z: 0 },
      candidates: [target],
      result: shot,
      traceRay: clearTrace,
    })

    expect(totalDealt).toBeGreaterThan(0)
  })

  it('never traces more than the per-blast cap, however many bodies are in radius', () => {
    const shot = resolveShot(PISTOL, ZONES.body, MOD.EXPLOSIVE)
    const candidates = []
    // 80 bodies packed inside the blast radius — a crowd, not a realistic wave, on purpose.
    for (let i = 0; i < 80; i++) candidates.push(bodyAt(10 + i))

    let traceCalls = 0
    const countingTrace = () => {
      traceCalls++
      return null
    }

    applyExplosiveAoE({
      impactPoint: { x: 0, y: 0, z: 0 },
      candidates,
      result: shot,
      traceRay: countingTrace,
    })

    expect(traceCalls).toBeLessThanOrEqual(32)
    expect(traceCalls).toBeGreaterThan(0)
  })
})

describe('damage number reflects the real total, not just the direct hit', () => {
  it('matches direct + full burn commitment at a body-shot depth (6x understated today)', () => {
    const shot = resolveShot(PISTOL, ZONES.body, MOD.INCENDIARY)
    const trueTotal = shot.directDamage + shot.burnDamagePerTick * shot.burnTicks
    expect(damageNumberValue(shot)).toBe(Math.round(trueTotal))
  })

  it('matches direct + full burn commitment at a head-shot depth too (2x understated today)', () => {
    const shot = resolveShot(PISTOL, ZONES.head, MOD.INCENDIARY)
    const trueTotal = shot.directDamage + shot.burnDamagePerTick * shot.burnTicks
    expect(damageNumberValue(shot)).toBe(Math.round(trueTotal))
    // Prove the ratio actually moves — this is the bug, not a single wrong constant.
    const bodyShot = resolveShot(PISTOL, ZONES.body, MOD.INCENDIARY)
    const bodyTrue = bodyShot.directDamage + bodyShot.burnDamagePerTick * bodyShot.burnTicks
    const headRatio = trueTotal / shot.directDamage
    const bodyRatio = bodyTrue / bodyShot.directDamage
    expect(headRatio).not.toBeCloseTo(bodyRatio, 1)
  })

  it('leaves a plain (non-incendiary) shot untouched', () => {
    const shot = resolveShot(PISTOL, ZONES.chest)
    expect(damageNumberValue(shot)).toBe(Math.round(shot.directDamage))
  })
})
