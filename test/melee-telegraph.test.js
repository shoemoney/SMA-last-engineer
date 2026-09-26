/**
 * The melee swing must TELEGRAPH the hit, not receipt it.
 *
 * spec/zombies.md §4.1 fixes the damage timing and this file does not touch it: the assertions
 * below are about the *pose stream* around a damage frame, never about when damage lands. The
 * damage frames themselves are pinned separately, as literals, so a change to the animation
 * that moved a hit would fail here rather than sail through.
 *
 * It reads no tunable of the thing under test. There is no `ANIM.attackSeconds`, no lead-time
 * constant and no threshold imported from src/ anywhere below — the numbers are frames and
 * radians measured off the rig. The one import from rules.js is PLAYER.MOVEMENT.walkSpeed, and
 * that is the speed of the player doing the kiting, not a dial on the telegraph: hard-coding it
 * here would be a second copy of a number that lives in one place.
 *
 * HOW THE ATTACK IS ISOLATED. A rendered bone carries the walk, the slump, the lean and the
 * swing all summed into one array, so reading `_pose` directly cannot tell a cocked arm from a
 * stride. Each archetype therefore runs as an A/B twin: zombie A is real, zombie B is the same
 * archetype with `_poseAttack` monkeypatched to a no-op and A's rig seeds copied over. The
 * per-frame update is rng-free (rng is only drawn at configure time), so both twins walk
 * identical simulation paths, and each gets its own effectively-immortal HealthPool so damage
 * cannot diverge them. The difference on the lead arm's Y rotation IS the attack's contribution
 * and nothing else. That monkeypatch is the only stub in the file, and it stubs the term being
 * isolated rather than the ordering under test.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Zombie } from '../src/entities/zombie.js'
import { HealthPool } from '../src/game/health.js'
import { PLAYER } from '../src/game/rules.js'
import { STEP } from '../src/core/loop.js'

/** BONE.ARM_UL / BONE.ARM_UR from src/entities/zombie.js — the rig table is module-private. */
const ARM_UL = 4
const ARM_UR = 6
/** Stride of one bone in `_pose`: [offsetX, offsetY, offsetZ, rotX, rotY, rotZ]. */
const BONE_STRIDE = 6
const ROT_Y = 4

/** Everything `configureForWave` draws from rng that the pose or the facing reads back. */
const RIG_FIELDS = ['phase', 'dragSide', 'deadArm', 'slump', 'headLoll', 'shoulderTilt', 'spineTwist', 'yaw']

/** Far enough that every archetype spends real time closing, including the 90 cm/s Tank. */
const START_X = -600
/** Long enough for three hits at the Tank's 1.8 s cooldown, plus the trailing window. */
const FRAMES = 560

/** Frames of window either side of a damage frame that the peak is searched in. */
const WINDOW_BEFORE = 12
const WINDOW_AFTER = 30

/**
 * The WHOLE damage stream over the run, pinned as literals: (frame, damage) for every hit.
 * spec §4.1 is inherited timing — if a change to the animation moves a hit by one frame, or
 * shaves a point off one, it has crossed into the simulation, and this fails before anything
 * else does. This is the byte-identical guarantee, not a side script someone has to remember
 * to run.
 */
const EXPECTED_DAMAGE = Object.freeze({
  base: [[208, 10], [280, 10], [352, 10], [424, 10], [496, 10]],
  zerg: [[138, 6], [174, 6], [210, 6], [246, 6], [282, 6], [318, 6], [354, 6], [390, 6],
         [426, 6], [462, 6], [498, 6], [534, 6]],
  tank: [[299, 35], [408, 35], [517, 35]],
  boss: [[139, 60], [260, 60], [381, 60], [502, 60]],
})

function spawn(typeId, suppressAttackPose) {
  const z = new Zombie(null)
  z.configureForWave(typeId, { healthScale: 1, speedScale: 1, damageScale: 1 })
  z.position.set(START_X, 0, 0)
  z.groundZ = 0
  if (suppressAttackPose) z._poseAttack = () => {}
  return z
}

function immortalPlayer() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    health: new HealthPool({ maxHealth: 1e6, health: 1e6, armor: 0 }),
  }
}

/**
 * One archetype, stepped at the loop's real fixed step.
 *
 * `breakFirst`/`breakStep` kite the player: after hit n both twins' players walk away at the
 * player's real walk speed for `breakFirst + breakStep * (n - 1)` frames, then stand. A zero
 * first break leaves the player planted for the whole run, and that path is bit-for-bit the
 * stationary one — nothing below it reads either number again.
 *
 * @returns {{rows: object[], hits: number[]}}
 */
function runTwins(typeId, { frames = FRAMES, breakFirst = 0, breakStep = 0 } = {}) {
  const a = spawn(typeId, false)
  const b = spawn(typeId, true)
  for (const field of RIG_FIELDS) b[field] = a[field]

  const playerA = immortalPlayer()
  const playerB = immortalPlayer()
  const worldA = { player: playerA }
  const worldB = { player: playerB }

  // The swing comes off the live side — the same choice _poseAttack makes.
  const lead = (a.deadArm > 0 ? ARM_UR : ARM_UL) * BONE_STRIDE + ROT_Y
  // Away from START_X, so the gap the zombie just closed reopens behind every hit.
  const step = PLAYER.MOVEMENT.walkSpeed * STEP

  const rows = []
  const hits = []
  let previousHp = playerA.health.health
  let breakRemaining = 0
  for (let frame = 0; frame < frames; frame++) {
    if (breakRemaining > 0) {
      playerA.position.x += step
      playerB.position.x += step
      breakRemaining--
    }
    a.update(STEP, worldA)
    b.update(STEP, worldB)
    const hp = playerA.health.health
    if (hp < previousHp) {
      hits.push(frame)
      breakRemaining = breakFirst && breakFirst + breakStep * (hits.length - 1)
    }
    rows.push({ frame, contrib: a._pose[lead] - b._pose[lead], hp, damage: previousHp - hp })
    previousHp = hp
  }
  return { rows, hits }
}

/**
 * The attack's contribution around one damage frame, which is the only thing either block below
 * grades. `peakBefore` against `peakAll` says whether the wind-up crested before the hit or
 * after it, `argmax` says how far ahead it crested, and `atHit` against `beforeHit` says which
 * way the arm was travelling when the damage arrived.
 */
function grade(rows, hitFrame) {
  const window = rows.slice(Math.max(0, hitFrame - WINDOW_BEFORE), hitFrame + WINDOW_AFTER)
  const before = window.filter(r => r.frame < hitFrame)
  return {
    peakBefore: Math.max(...before.map(r => r.contrib)),
    peakAll: Math.max(...window.map(r => r.contrib)),
    argmax: window.reduce((best, r) => (r.contrib > best.contrib ? r : best), window[0]).frame,
    atHit: window.find(r => r.frame === hitFrame).contrib,
    beforeHit: window.find(r => r.frame === hitFrame - 1).contrib,
  }
}

describe('melee swing telegraphs the hit', () => {
  for (const typeId of ['base', 'zerg', 'tank', 'boss']) {
    describe(typeId, () => {
      const { rows, hits } = runTwins(typeId)
      const graded = hits.slice(0, 3)

      it('lands the same damage on the same frames spec §4.1 fixes', () => {
        expect(rows.filter(r => r.damage > 0).map(r => [r.frame, r.damage]))
          .toEqual(EXPECTED_DAMAGE[typeId])
      })

      for (let n = 0; n < graded.length; n++) {
        const hitFrame = graded[n]
        const { peakBefore, peakAll, argmax, atHit, beforeHit } = grade(rows, hitFrame)

        it(`hit #${n + 1} (frame ${hitFrame}) peaks the wind-up BEFORE damage lands`, () => {
          expect(peakBefore).toBeGreaterThanOrEqual(0.9 * peakAll)
        })

        it(`hit #${n + 1} (frame ${hitFrame}) leads the hit by at least 6 frames`, () => {
          expect(hitFrame - argmax).toBeGreaterThanOrEqual(6)
        })

        it(`hit #${n + 1} (frame ${hitFrame}) is already swinging forward when damage lands`, () => {
          expect(hitFrame).toBeGreaterThan(argmax)
          expect(atHit).toBeLessThan(beforeHit)
        })
      }
    })
  }
})

/**
 * A TELEGRAPH IS A PROMISE OF AN IMMINENT HIT, SO IT MUST ONLY FIRE WHEN ONE IS COMING.
 *
 * The block above grades the pose around a hit that lands. This one grades the clip SCHEDULE in
 * the case where no hit is coming at all: a zombie pinned just outside its own reach, which is
 * what geometry, a body in the doorway, or a player backing away at exactly max range all look
 * like from inside `_startTelegraph`. Nothing about the gap says "contact soon" — the gap is not
 * shrinking — so a swing started there is a promise the zombie cannot keep, and one started every
 * time the previous one ends reads as a seizure rather than as intent.
 *
 * It is deliberately two-sided. Suppressing the telegraph outright would satisfy the held phase
 * and fail the released phase, where the same zombie, freed from the same distance, must have its
 * clip already in flight when damage lands.
 *
 * This reads `attackT` (the clip's own 0..1 clock) rather than the pose, because the question here
 * is WHEN the clip is scheduled, not what it draws — the twins above already pin the pose that a
 * running clip produces. It is state, not a tunable: no lead time, no clip length, no threshold
 * from src/ appears below.
 */
const HOLD_FRAMES = 600
const RELEASE_FRAMES = 180
/** Inside every archetype's telegraph window, so suppression is being tested where it is hardest. */
const HOLD_MARGIN = 20

function runStandoff(typeId) {
  const z = spawn(typeId, false)
  const player = immortalPlayer()
  const world = { player }
  const hold = z.attackRange + HOLD_MARGIN
  // Placed AT the standoff, not walked into it: a snap from START_X would be a real 430 cm of
  // closure on frame one and the telegraph would be right to fire on it.
  z.position.set(-hold, 0, 0)

  const clipStarts = []
  let previousT = z.attackT
  let previousHp = player.health.health
  let heldHits = 0
  let hitFrame = -1
  let attackTAtHit = -1

  for (let frame = 0; frame < HOLD_FRAMES + RELEASE_FRAMES; frame++) {
    z.update(STEP, world)
    if (frame < HOLD_FRAMES) {
      // Pinned: whatever the steering asked for, the body does not advance. This is the shape of
      // every real standoff — the zombie is trying, and the gap is not closing.
      z.position.set(-hold, 0, 0)
      z.velocity.set(0, 0, 0)
    }
    if (previousT >= 1 && z.attackT < 1) clipStarts.push(frame)
    previousT = z.attackT
    const hp = player.health.health
    if (hp < previousHp) {
      if (frame < HOLD_FRAMES) heldHits++
      else if (hitFrame < 0) { hitFrame = frame; attackTAtHit = z.attackT }
    }
    previousHp = hp
  }
  return {
    heldStarts: clipStarts.filter(f => f < HOLD_FRAMES),
    releasedStarts: clipStarts.filter(f => f >= HOLD_FRAMES),
    heldHits,
    hitFrame,
    attackTAtHit,
  }
}

describe('a swing that cannot land is not telegraphed', () => {
  for (const typeId of ['base', 'zerg', 'tank', 'boss']) {
    describe(typeId, () => {
      const r = runStandoff(typeId)

      it('lands nothing during the 10 s standoff — the hold is real', () => {
        expect(r.heldHits).toBe(0)
      })

      it('starts no swing clip while the gap refuses to close', () => {
        expect(r.heldStarts).toEqual([])
      })

      it('telegraphs again the moment the same gap starts closing', () => {
        expect(r.hitFrame).toBeGreaterThan(0)
        expect(r.releasedStarts.length).toBeGreaterThan(0)
        expect(r.releasedStarts[0]).toBeLessThan(r.hitFrame)
      })

      it('is mid-clip, not starting one, on the frame damage lands', () => {
        expect(r.attackTAtHit).toBeGreaterThan(0)
        expect(r.attackTAtHit).toBeLessThan(1)
      })
    })
  }
})

/**
 * A KITING PLAYER IS THE COMMON CASE, AND IT IS WHERE A COOLDOWN-ONLY LEAD GOES BLIND.
 *
 * Every run above walks a zombie at a player who never moves, so after first contact the gap
 * never reopens and each later swing starts from inside reach with the cooldown as the only
 * thing left to wait for. Backing off is the first thing anyone does with a zombie on them, and
 * it breaks that shape: the player's 600 cm/s outruns every melee archetype, so the break always
 * opens, and the zombie then spends part of its cooldown closing the gap again from OUTSIDE its
 * reach. The hit that follows is led by neither gate alone — the cooldown can expire while the
 * zombie is still short of reach, and the gap can close while the cooldown is still running.
 *
 * THE BREAK LENGTHENS BY FOUR FRAMES A HIT, WHICH IS THE POINT. One fixed break would park every
 * arrival at one phase of the cooldown and could sit either side of the defect by luck. Growing
 * it walks the arrival across the whole cooldown instead, so each archetype is measured early,
 * dead on and late without the test having to know where its own bad window is. Nine to twelve
 * hits per archetype come out of it, and every one of them is graded.
 *
 * Same twins, same isolation, same three thresholds as the stationary block — the only change is
 * that the player walks. Damage frames are deliberately NOT pinned here: spec §4.1 is pinned
 * once, against the stationary run, and a literal captured off a kite would pin the kite.
 */
/** Frames of retreat after the first hit, and the growth per hit after that. */
const BREAK_FIRST = 6
const BREAK_STEP = 4
const KITE_FRAMES = 1200
/** Under every archetype's count at this break (base 9, zerg 12, tank 7, boss 9), so a fix that
 *  bought its lead by letting the player escape would fail here instead of going quiet. */
const MIN_KITE_HITS = 7

describe('the swing telegraphs the hit when the player kites', () => {
  for (const typeId of ['base', 'zerg', 'tank', 'boss']) {
    describe(typeId, () => {
      const { rows, hits } = runTwins(typeId, {
        frames: KITE_FRAMES, breakFirst: BREAK_FIRST, breakStep: BREAK_STEP,
      })
      // Only hits with a whole grading window ahead of them.
      const graded = hits.filter(f => f + WINDOW_AFTER <= KITE_FRAMES)

      it('keeps catching the retreating player — the kite is a chase, not a standoff', () => {
        expect(graded.length).toBeGreaterThanOrEqual(MIN_KITE_HITS)
      })

      for (let n = 0; n < graded.length; n++) {
        const hitFrame = graded[n]
        const { peakBefore, peakAll, argmax, atHit, beforeHit } = grade(rows, hitFrame)

        it(`kited hit #${n + 1} (frame ${hitFrame}) peaks the wind-up BEFORE damage lands`, () => {
          expect(peakBefore).toBeGreaterThanOrEqual(0.9 * peakAll)
        })

        it(`kited hit #${n + 1} (frame ${hitFrame}) leads the hit by at least 6 frames`, () => {
          expect(hitFrame - argmax).toBeGreaterThanOrEqual(6)
        })

        it(`kited hit #${n + 1} (frame ${hitFrame}) is already swinging forward when damage lands`, () => {
          expect(hitFrame).toBeGreaterThan(argmax)
          expect(atHit).toBeLessThan(beforeHit)
        })
      }
    })
  }
})
