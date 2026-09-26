/**
 * Wave composition, scaling and boss cadence, asserted against spec/waves-progression.md
 * section 2.1 — the same table the original's ShoeWaveDirector produced.
 *
 * Pure modules only: this runs in node with no renderer, no DOM and no three.js.
 */
import { describe, it, expect } from 'vitest'
import { buildWave, flattenComposition, resolveZombieForWave, rewardForWave } from '../src/game/waveDirector.js'
import { WAVES, ZOMBIES } from '../src/game/rules.js'

/** waveNumber -> [base, zerg, ranged, tank, boss] straight off spec section 2.1. */
const TABLE = {
  1: [6, 0, 0, 0, 0],
  2: [8, 0, 0, 0, 0],
  3: [10, 2, 0, 0, 0],
  5: [14, 4, 1, 0, 1],
  7: [18, 6, 2, 1, 0],
  10: [24, 9, 3, 2, 2],
  20: [44, 19, 8, 5, 3],
}

describe('wave composition', () => {
  for (const [wave, [base, zerg, ranged, tank, boss] ] of Object.entries(TABLE)) {
    it(`matches the spec table on wave ${wave}`, () => {
      const c = buildWave(Number(wave))
      expect([c.baseCount, c.zergCount, c.rangedCount, c.tankCount, c.bossCount])
        .toEqual([base, zerg, ranged, tank, boss])
      expect(c.totalCount).toBe(base + zerg + ranged + tank + boss)
    })
  }

  it('holds the archetypes back until their first wave', () => {
    expect(buildWave(2).zergCount).toBe(0)
    expect(buildWave(4).rangedCount).toBe(0)
    expect(buildWave(6).tankCount).toBe(0)
  })

  it('flattens FIFO in spawn order, so the boss is always last out of the doors', () => {
    const queue = flattenComposition(buildWave(10))
    expect(queue.length).toBe(buildWave(10).totalCount)
    expect(queue[0]).toBe(WAVES.spawnQueueOrder[0])
    expect(queue.at(-1)).toBe('boss')
    expect(queue.at(-2)).toBe('boss') // wave 10 sends two
    expect(queue.filter(id => id === 'boss').length).toBe(2)
  })
})

describe('boss cadence', () => {
  it('sends one every fifth wave and a second from wave 10', () => {
    expect(buildWave(4).bossCount).toBe(0)
    expect(buildWave(5).bossCount).toBe(1)
    expect(buildWave(9).bossCount).toBe(0)
    expect(buildWave(10).bossCount).toBe(2)
    expect(buildWave(15).bossCount).toBe(2)
    expect(buildWave(20).bossCount).toBe(3)
    expect(buildWave(25).bossCount).toBe(3)
  })
})

describe('wave scaling', () => {
  it('grows health and damage without bound and clamps speed at 2.0', () => {
    expect(buildWave(1).healthScale).toBe(1)
    expect(buildWave(7).healthScale).toBeCloseTo(1.72, 10)
    expect(buildWave(7).damageScale).toBeCloseTo(1.48, 10)
    expect(buildWave(26).speedScale).toBe(WAVES.SCALING.speed.cap)
    expect(buildWave(100).speedScale).toBe(WAVES.SCALING.speed.cap)
    expect(buildWave(100).healthScale).toBeGreaterThan(12)
  })

  it('scales a Tank to 1548 health on wave 7 and leaves its armor alone', () => {
    const tank = resolveZombieForWave('tank', buildWave(7))
    expect(tank.maxHealth).toBeCloseTo(1548, 6)
    expect(tank.health).toBe(tank.maxHealth)
    expect(tank.armor).toBe(ZOMBIES.ARCHETYPES.tank.armor)
    expect(tank.attackCooldown).toBe(ZOMBIES.ARCHETYPES.tank.attackCooldown)
    expect(tank.meleeDamage).toBeCloseTo(ZOMBIES.ARCHETYPES.tank.meleeDamage * 1.48, 6)
  })

  it('applies body scale to the collision capsule but never to the wave scaling', () => {
    const zerg = resolveZombieForWave('zerg', buildWave(1))
    expect(zerg.capsuleRadius).toBeCloseTo(11, 6)
    expect(zerg.capsuleHalfHeight).toBeCloseTo(24.2, 6)
  })
})

describe('wave rewards', () => {
  it('cycles the five mods by wave number', () => {
    const cycle = WAVES.REWARD.cycle
    for (let wave = 1; wave <= 12; wave++) {
      expect(rewardForWave(wave)).toBe(cycle[wave % cycle.length])
    }
  })
})
