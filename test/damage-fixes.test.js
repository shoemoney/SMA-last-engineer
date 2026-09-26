import { describe, it, expect } from 'vitest'
import { MOD, resolveShot, damageNumberValue } from '../src/game/damage.js'
import { DAMAGE, WEAPONS } from '../src/game/rules.js'

const PISTOL = WEAPONS.PISTOL.baseDamage
const ZONES = DAMAGE.zones

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
