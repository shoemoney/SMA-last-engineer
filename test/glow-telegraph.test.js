/**
 * The Tank's and Conductor's (boss) "charge" glow must actually tell a player when a hit is
 * coming. It reads `timeUntilNextAttack` against `attackCooldown` — the same attack-timing
 * state `_tryMeleeAttack` already maintains and resets on every landed hit (zombie.js
 * `_tryMeleeAttack`) — so the glow's envelope ramps toward an imminent swing and drops right
 * after it fires. A glow driven only by `age` (a wall clock) pulses on a fixed cycle no matter
 * what the attack is doing, which is what shipped before this test: it looks like a warning and
 * carries no information.
 *
 * The zombie sits inside its own attackRange from frame one so every cooldown is spent
 * attacking, not closing distance — that keeps `timeUntilNextAttack` cycling cleanly against a
 * stationary, immortal player and isolates the glow from the movement/telegraph systems this
 * file does not touch.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Zombie } from '../src/entities/zombie.js'
import { HealthPool } from '../src/game/health.js'
import { STEP } from '../src/core/loop.js'

/** Long enough for at least two full swings at the Boss's 2.0 s cooldown (the longest of the two). */
const FRAMES = 420
/** Frames either side of a hit graded as "imminent" / "just fired" — well inside both cooldowns
 *  (Tank 1.8 s = 108 frames, Boss 2.0 s = 120 frames at STEP = 1/60). */
const EDGE_WINDOW = 10

function spawnInRange(typeId) {
  const z = new Zombie(null)
  z.configureForWave(typeId, { healthScale: 1, speedScale: 1, damageScale: 1 })
  z.groundZ = 0
  // Half the attack range: comfortably inside reach so it never has to chase, and never moves.
  z.position.set(-(z.attackRange * 0.5), 0, 0)
  return z
}

function immortalPlayer() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    health: new HealthPool({ maxHealth: 1e6, health: 1e6, armor: 0 }),
  }
}

/** Steps the zombie, recording glowLevel every frame plus which frames landed a hit. */
function run(typeId) {
  const z = spawnInRange(typeId)
  const player = immortalPlayer()
  const world = { player }

  const glow = []
  const hits = []
  let previousHp = player.health.health
  for (let frame = 0; frame < FRAMES; frame++) {
    z.update(STEP, world)
    glow.push(z.glowLevel)
    const hp = player.health.health
    if (hp < previousHp) hits.push(frame)
    previousHp = hp
  }
  return { glow, hits }
}

describe('the charge glow tracks the incoming attack, not the wall clock', () => {
  for (const typeId of ['tank', 'boss']) {
    describe(typeId, () => {
      const { glow, hits } = run(typeId)

      it('lands at least two hits over the run, so at least one full cooldown is graded', () => {
        expect(hits.length).toBeGreaterThanOrEqual(2)
      })

      it('glow is dim right after a hit fires and bright right before the next one lands', () => {
        // Skip the very first hit: there is no "after" to sample for it, only a "before".
        for (let n = 1; n < hits.length; n++) {
          const hitFrame = hits[n]
          const prevHitFrame = hits[n - 1]

          // Imminent: the window right before this hit lands.
          const before = glow.slice(Math.max(0, hitFrame - EDGE_WINDOW), hitFrame)
          // Just fired: the window right after the previous hit landed (cooldown just reset).
          const after = glow.slice(prevHitFrame + 1, prevHitFrame + 1 + EDGE_WINDOW)

          const meanBefore = before.reduce((a, b) => a + b, 0) / before.length
          const meanAfter = after.reduce((a, b) => a + b, 0) / after.length

          // A wall-clock pulse (sin(age * k)) has no reason to be brighter in one window than
          // the other — it depends only on which phase `age` happens to land in. A charge tied
          // to the real attack timer must be reliably brighter just before the hit than just
          // after the previous one, every cycle, not by chance.
          expect(meanBefore).toBeGreaterThan(meanAfter * 1.3)
        }
      })
    })
  }
})
