/**
 * Two defects, same species: a comment states a fact the code did not implement.
 *
 * 1) REWARD.cycle's own doc says explosive lands on waves 9, 18, 27 (a 9-entry cycle,
 *    rarest mod, clean multiples of 9). The wave counter in this codebase is 1-based
 *    (WAVES.firstWaveNumber === 1, BOSS_FORMULA fires on `W % everyNthWave === 0` giving
 *    boss waves 5, 10, 15...), and rewardForWave() indexes with `cycle[waveNumber % cycle.length]`
 *    unmodified (see waveDirector.js / pickups.js — not owned here). So whichever slot
 *    the cycle array puts 'explosive' in is exactly the slot that fires on
 *    waveNumber % 9 === thatIndex. For the doc's claimed waves (9, 18, 27 — all ≡ 0 mod 9)
 *    to be true, 'explosive' must sit at index 0, not index 8.
 *
 * 2) A newly spawned ranged attacker (Spitter) had SHARED_DEFAULTS.timeUntilNextAttack at
 *    0.0, so its first spit could leave the barrel on the very frame it spawns — zero
 *    reaction time. rules.js's own melee ANIM.telegraphLeadSeconds analysis establishes
 *    this project's bar for "reactable": a 146ms peak-to-hit window, explicitly framed
 *    against a 6-frame/100ms window being "marginal". The fix gives ranged spawns an
 *    explicit, named grace constant instead of the bare 0.0.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { WAVES, ZOMBIES } from '../src/game/rules.js'
import { rewardForWave } from '../src/game/waveDirector.js'
import { Zombie } from '../src/entities/zombie.js'
import { HealthPool } from '../src/game/health.js'
import { STEP } from '../src/core/loop.js'

describe('reward cycle — explosive cadence matches its own doc comment', () => {
  it('fires explosive on waves 9, 18 and 27, per the cycle doc comment', () => {
    expect(rewardForWave(9)).toBe('explosive')
    expect(rewardForWave(18)).toBe('explosive')
    expect(rewardForWave(27)).toBe('explosive')
  })

  it('does NOT fire explosive on 8, 17, 26 (the pre-fix off-by-one waves)', () => {
    expect(rewardForWave(8)).not.toBe('explosive')
    expect(rewardForWave(17)).not.toBe('explosive')
    expect(rewardForWave(26)).not.toBe('explosive')
  })

  it('keeps the cycle nine entries long with explosive appearing exactly once', () => {
    const cycle = WAVES.REWARD.cycle
    expect(cycle.length).toBe(9)
    expect(cycle.filter(m => m === 'explosive').length).toBe(1)
  })
})

describe('ranged spawn attack grace — no zero-reaction first spit', () => {
  it('gives a newly spawned attacker a positive, named grace window before its first attack is possible', () => {
    const grace = ZOMBIES.SHARED_DEFAULTS.timeUntilNextAttack
    expect(grace).toBeGreaterThan(0)
    // Floor: the project's own melee analysis treats a 6-frame/100ms window as "already marginal".
    // A spawn grace at or below that bar is not a fix, it is the same bug with a smaller number.
    expect(grace).toBeGreaterThanOrEqual(0.1)
  })
})

/**
 * BEHAVIOURAL PROOF, NOT A DATA-LEVEL ONE.
 *
 * The block above only pins the VALUE of ZOMBIES.SHARED_DEFAULTS.timeUntilNextAttack. That
 * passes even if nothing ever reads it, or if some other code path resets timeUntilNextAttack
 * to 0 on spawn regardless of what SHARED_DEFAULTS says. What actually matters is what a real
 * Spitter DOES: does a spit exist in the world before the grace has elapsed, and does one show
 * up after it. This drives a real Zombie ('ranged' archetype, i.e. the Spitter) through
 * z.update(STEP, world) at the project's real fixed step and watches the one thing
 * _tryRangedAttack can produce — a call into the projectile pool's spawn() — rather than
 * inspecting timeUntilNextAttack directly.
 *
 * The pool is a minimal fake: a real ProjectilePool needs a live THREE renderer parent and
 * exists to draw the round, not to decide whether one was fired. Recording spawn() calls is
 * the same observable the real pool would produce (a projectile enters the world), without
 * pulling rendering machinery into a combat-timing test.
 */
function immortalPlayer() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    health: new HealthPool({ maxHealth: 1e6, health: 1e6, armor: 0 }),
  }
}

function fakeProjectilePool() {
  const fired = []
  return {
    fired,
    pool: {
      _warnOnce: () => {}, // silence the missing-LOS/missing-pool console warnings; not under test here
      projectiles: { spawn: (opts) => fired.push(opts) },
    },
  }
}

/** Dead centre of the Spitter's own 800-1000 cm hold band (desiredRange 900 ± rangedTolerance 100),
 *  so it never has to chase or retreat first — the attack gate is isolated from the movement gate. */
const SPITTER_HOLD_X = -900

function spawnSpitter(pool) {
  const z = new Zombie(pool)
  z.configureForWave('ranged', { healthScale: 1, speedScale: 1, damageScale: 1 })
  z.position.set(SPITTER_HOLD_X, 0, 0)
  z.groundZ = 0
  return z
}

describe('ranged spawn attack grace — behavioural proof (real Spitter, real fixed step)', () => {
  it('CONTRAST — a spitter with the grace forced to 0 (the pre-fix bug, no src edit) fires on frame one', () => {
    const { pool, fired } = fakeProjectilePool()
    const z = spawnSpitter(pool)
    z.timeUntilNextAttack = 0 // reproduces the old bare-0.0 SHARED_DEFAULTS without touching rules.js
    z.update(STEP, { player: immortalPlayer() })
    expect(fired.length).toBe(1)
  })

  it('CONTRAST — the same spitter, left at its real spawn-time default, does NOT fire on frame one', () => {
    const { pool, fired } = fakeProjectilePool()
    const z = spawnSpitter(pool)
    expect(z.timeUntilNextAttack).toBe(ZOMBIES.SHARED_DEFAULTS.timeUntilNextAttack) // sanity: this is the real default, untouched
    z.update(STEP, { player: immortalPlayer() })
    expect(fired.length).toBe(0)
  })

  it('spawns no spit for every frame inside the grace window, then one shortly after it elapses', () => {
    const { pool, fired } = fakeProjectilePool()
    const z = spawnSpitter(pool)
    const world = { player: immortalPlayer() }
    const grace = ZOMBIES.SHARED_DEFAULTS.timeUntilNextAttack

    // Walked frame-by-frame (not jumped to via Math.round(grace / STEP)) because
    // timeUntilNextAttack -= STEP accumulates float error: 0.15 minus nine STEPs lands on
    // 2e-17, still > 0, so the real fire happens one fixed-step tick later than the exact
    // ratio predicts. Recording the frame it actually happens on is the point of this test.
    let fireFrame = -1
    const maxFrames = Math.ceil(grace / STEP) + 5
    for (let frame = 0; frame < maxFrames && fireFrame < 0; frame++) {
      z.update(STEP, world)
      if (fired.length > 0) fireFrame = frame
    }

    expect(fireFrame).toBeGreaterThanOrEqual(0) // (b) it does eventually fire
    const elapsedAtFire = (fireFrame + 1) * STEP
    // (a) nothing fired before simulated time reached the grace (within one frame of float slop)
    expect(elapsedAtFire).toBeGreaterThanOrEqual(grace - STEP)
    // and firing is the moment the grace elapses, not some later fluke
    expect(elapsedAtFire).toBeLessThanOrEqual(grace + STEP + 1e-9)
  })
})
