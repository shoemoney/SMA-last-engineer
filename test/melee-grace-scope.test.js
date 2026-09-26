/**
 * SCOPE MEASUREMENT: does the 0.15 s spawn grace (ZOMBIES.SHARED_DEFAULTS.timeUntilNextAttack,
 * added to fix the Spitter's zero-reaction first spit) also delay a MELEE archetype's first
 * swing?
 *
 * configureForWave() resets timeUntilNextAttack from SHARED_DEFAULTS for every archetype, not
 * just 'ranged' (see rules.js "step 4" comment above SHARED_DEFAULTS), so the grace reaches the
 * four melee archetypes too. The belief under test is that this is harmless because melee
 * zombies spawn at real distance from the player (off the train) and are never already inside
 * attackRange on frame one, so 0.15 s of cooldown ticks away for free while they are still
 * walking in — making the grace a no-op for melee in practice.
 *
 * This is not inferred from the green 171-test melee/telegraph suite passing (that suite never
 * varies timeUntilNextAttack's starting value, so it cannot see this). It is measured directly:
 * two identically-configured zombies per archetype, one with the real post-fix grace (0.15 s)
 * and one with the grace forced back to 0 (the pre-fix value, set directly on the instance —
 * src/ is not touched), walked at the real fixed step from a realistic spawn distance, and the
 * frame each one first lands damage on the player is recorded and compared.
 *
 * SPAWN DISTANCE: START_X = -600 cm, the same value test/melee-telegraph.test.js already uses
 * and documents as "far enough that every archetype spends real time closing, including the
 * 90 cm/s Tank" — i.e. this project's own established stand-in for a realistic spawn-to-player
 * gap, not a zombie dropped inside its own reach.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Zombie } from '../src/entities/zombie.js'
import { HealthPool } from '../src/game/health.js'
import { STEP } from '../src/core/loop.js'

const MELEE_ARCHETYPES = ['base', 'zerg', 'tank', 'boss'] // this codebase's five archetypes minus 'ranged' (the Spitter)

const START_X = -600
/** Generous ceiling: the slowest archetype (Tank, 90 cm/s) needs ~600/90 s = ~400 frames just to
 *  close the gap to its 200 cm attackRange, plus telegraph lead. 3000 frames (50 s) is ample. */
const MAX_FRAMES = 3000

function immortalPlayer() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    health: new HealthPool({ maxHealth: 1e6, health: 1e6, armor: 0 }),
  }
}

function spawnMelee(typeId, graceOverride) {
  const z = new Zombie(null)
  z.configureForWave(typeId, { healthScale: 1, speedScale: 1, damageScale: 1 })
  if (graceOverride !== undefined) z.timeUntilNextAttack = graceOverride // no src edit — set post-configure, same as the contrast proof in reward-cycle-and-spawn-grace.test.js
  z.position.set(START_X, 0, 0)
  z.groundZ = 0
  return z
}

/** @returns {number} the frame the player's health first drops, or -1 if it never does within MAX_FRAMES */
function firstHitFrame(typeId, graceOverride) {
  const z = spawnMelee(typeId, graceOverride)
  const player = immortalPlayer()
  const world = { player }
  let previousHp = player.health.health
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    z.update(STEP, world)
    const hp = player.health.health
    if (hp < previousHp) return frame
    previousHp = hp
  }
  return -1
}

describe('SHARED_DEFAULTS spawn grace — melee scope measurement', () => {
  const measured = []

  for (const typeId of MELEE_ARCHETYPES) {
    it(`${typeId}: first-hit frame is identical with the grace (0.15s) and without it (0.0)`, () => {
      const withGrace = firstHitFrame(typeId) // real post-fix default: configureForWave sets 0.15s
      const withoutGrace = firstHitFrame(typeId, 0) // pre-fix value, forced directly, rules.js untouched

      measured.push({ typeId, withGrace, withoutGrace })
      // eslint-disable-next-line no-console
      console.log(`[melee-grace-scope] ${typeId}: first hit @ frame ${withGrace} (grace=0.15s) vs frame ${withoutGrace} (grace=0.0s)`)

      expect(withGrace).toBeGreaterThan(0) // sanity: the zombie actually reaches and hits the player within MAX_FRAMES
      expect(withoutGrace).toBeGreaterThan(0)
      expect(withGrace).toBe(withoutGrace) // THE MEASUREMENT: the grace changes nothing about when the first melee hit lands
    })
  }
})
