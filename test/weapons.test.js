/**
 * Dual wield, asserted against the REAL WeaponSystem.
 *
 * WHY THIS FILE IMPORTS THREE, when test/combat.test.js states a purity rule and keeps to it:
 * the defect being pinned lives in src/weapons/weapon.js, and that module owns a viewmodel,
 * so it pulls in three/webgpu at import time. There is no seam to test through that does not
 * drag it along, and stubbing the WeaponSystem would mean asserting against a copy of the bug.
 * Measured cost of the import in node: ~60 ms to collect, ~1 ms to run. The purity rule exists
 * to keep the suite fast, and at that price it still is. Nothing here touches a GPU, a canvas
 * or a frame — the weapons are driven by setTrigger()/update(dt) exactly as the fixed-step
 * loop drives them.
 *
 * Everything is counted off the event bus, because EV.WEAPON_FIRE is what actually spends a
 * round: a test that read ammoInMag would miss a press that was swallowed before it reached
 * a gun, which is precisely the failure mode here.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three/webgpu'
import { HealthPool } from '../src/game/health.js'
import { Weapon, WeaponSystem } from '../src/weapons/weapon.js'
import { EventBus, EV } from '../src/core/events.js'
import { WEAPONS } from '../src/game/rules.js'
import { STEP } from '../src/core/loop.js'

/** rounds x baseDamage, with a shotgun shell counted as all eight pellets landing. */
const SHOT_DAMAGE = {
  pistol: WEAPONS.PISTOL.baseDamage * WEAPONS.PISTOL.pelletCount,
  rifle: WEAPONS.RIFLE.baseDamage * WEAPONS.RIFLE.pelletCount,
  shotgun: WEAPONS.SHOTGUN.baseDamage * WEAPONS.SHOTGUN.pelletCount,
}

const AIM = Object.freeze({ origin: { x: 0, y: 160, z: 0 }, direction: { x: 0, y: 0, z: -1 } })

/**
 * A WeaponSystem on its own bus with every adapter present. The adapters have to exist:
 * a missing one warns once and degrades, which would turn a real regression into console
 * noise nobody reads.
 */
function makeSystem(primary = 'pistol', { dual = true } = {}) {
  const bus = new EventBus()
  const world = { trace: () => null, bodiesInSphere: () => [], alert: () => {} }
  const fx = {
    muzzleFlash: () => {}, cameraShake: () => {}, tracer: () => {},
    impact: () => {}, bloodDecal: () => {}, damageNumber: () => {}, explosion: () => {},
  }
  const system = new WeaponSystem({ bus, world, fx, audio: { play: () => {} }, aim: () => AIM })
  if (primary !== 'pistol') system.grant(primary)
  if (dual) system.grantDualWield()

  const fired = []
  bus.on(EV.WEAPON_FIRE, ({ weapon, hand }) => fired.push({ weapon, hand }))
  bus.on(EV.WEAPON_DRY, ({ weapon, hand }) => fired.push({ weapon, hand, dry: true }))
  return { system, fired }
}

/** Advance the system the way the fixed-step loop does. */
function step(system, seconds) {
  const steps = Math.round(seconds / STEP)
  for (let i = 0; i < steps; i++) system.update(STEP)
}

/** Trigger held for `seconds`, then released. The release is instant, as an input edge is. */
function hold(system, seconds) {
  system.setTrigger(true)
  step(system, seconds)
  system.setTrigger(false)
}

/** A press and release inside one frame, then `gap` seconds of nothing. */
function tap(system, gap) {
  system.setTrigger(true)
  system.setTrigger(false)
  step(system, gap)
}

/** Rounds of one weapon id in a slice of the fire log (dry presses spend nothing). */
const roundsOf = (log, id) => log.filter((e) => e.weapon === id && !e.dry).length
const damageOf = (log) => log.reduce((sum, e) => sum + (e.dry ? 0 : SHOT_DAMAGE[e.weapon]), 0)

/** Run `fn` and return only the events it produced. */
function slice(fired, fn) {
  const from = fired.length
  fn()
  return fired.slice(from)
}

describe('dual wield adds the left pistol, it never takes the primary trigger', () => {
  it('an automatic primary fires its full burst on EVERY hold, not every other one', () => {
    const { system, fired } = makeSystem('rifle')
    const holds = []
    for (let i = 0; i < 4; i++) holds.push(slice(fired, () => hold(system, 1.0)))

    // Holds 1-3 only: the rifle's 30-round magazine is spent by then, so hold 4 is dry in
    // both the broken and the fixed build and would pin a magazine artefact, not the defect.
    for (let i = 0; i < 3; i++) {
      expect(roundsOf(holds[i], 'rifle'), `hold #${i + 1} rifle rounds`).toBe(10)
    }
  })

  it('a semi-automatic primary fires on EVERY hold', () => {
    const { system, fired } = makeSystem('shotgun')
    const holds = []
    for (let i = 0; i < 2; i++) holds.push(slice(fired, () => hold(system, 1.0)))

    for (let i = 0; i < 2; i++) {
      expect(roundsOf(holds[i], 'shotgun'), `hold #${i + 1} shotgun rounds`).toBeGreaterThanOrEqual(1)
    }
  })

  /**
   * MAGNITUDE, not direction. The assertion here used to be a bare
   * `dual > solo`, which passes for one extra round and passes just as happily for a
   * thousand — so it certified the sign of the dual-wield buff while saying nothing about
   * its size. That is exactly the number the balance of the game turns on, and it was
   * measured only once, by hand, in a writeup, as "+28% to +67%". Both ends of that range
   * were wrong (the real figures are below), which is what an untested number does.
   *
   * These bands are OBSERVED, not chosen: each was measured against this build. They are
   * deliberately tight enough that a balance change trips them, because a balance change
   * SHOULD have to be acknowledged rather than absorbed. If one fails after a deliberate
   * rebalance, re-measure and move the band in the same commit as the change — do not widen
   * it to make a red test green.
   *
   * Neither soak.mjs nor e2e.mjs ever grants dual wield, so this test is the only thing in
   * the repo that has ever put a number on the most powerful pickup in the game.
   */
  const TAP_DPS_RATIO = { pistol: 1.89, rifle: 1.53, shotgun: 1.56 }

  const tapFor = (sys, seconds) => {
    for (let frame = 0; frame < Math.round(seconds / STEP); frame++) {
      sys.setTrigger(frame % 2 === 0)
      sys.update(STEP)
    }
  }

  for (const [id, expected] of Object.entries(TAP_DPS_RATIO)) {
    it(`alternating taps with the left pistol multiply ${id} damage by ~${expected}x`, () => {
      const dual = makeSystem(id)
      const solo = makeSystem(id, { dual: false })
      tapFor(dual.system, 2.0)
      tapFor(solo.system, 2.0)

      const soloDamage = damageOf(solo.fired)
      const dualDamage = damageOf(dual.fired)
      expect(soloDamage, 'the solo build must actually fire, or the ratio is meaningless')
        .toBeGreaterThan(0)

      const ratio = dualDamage / soloDamage
      expect(ratio, `${id} dual/solo damage over 2s of taps (${dualDamage}/${soloDamage})`)
        .toBeGreaterThan(expected - 0.06)
      expect(ratio, `${id} dual/solo damage over 2s of taps (${dualDamage}/${soloDamage})`)
        .toBeLessThan(expected + 0.06)

      // The primary is never starved to pay for the off-hand: that was the original defect.
      expect(roundsOf(dual.fired, id), `${id} rounds must not drop when dual wielding`)
        .toBeGreaterThanOrEqual(roundsOf(solo.fired, id))
    })
  }

  /**
   * CHARACTERISATION, and the part worth arguing about. A HELD trigger gets no off-hand
   * benefit at all — measured at exactly 1.000x for all three primaries, because the left
   * pistol only ever fires on a trigger EDGE. So dual wield is a taps-only buff, and a
   * player who holds the trigger owns the strongest pickup in the game and gets nothing
   * from it.
   *
   * This test asserts the CURRENT behaviour rather than the desirable one, so that whichever
   * way the owner decides, the change is visible instead of silent. It is not an endorsement:
   * if the off-hand should fire on hold, this test is the one to delete, deliberately.
   */
  it('a HELD trigger gets no off-hand damage at all — taps-only buff, by construction', () => {
    for (const id of ['pistol', 'rifle', 'shotgun']) {
      const dual = makeSystem(id)
      const solo = makeSystem(id, { dual: false })
      hold(dual.system, 2.0)
      hold(solo.system, 2.0)

      expect(damageOf(dual.fired), `${id}: held-trigger damage is identical dual vs solo`)
        .toBe(damageOf(solo.fired))
      expect(roundsOf(dual.fired, 'pistol'), `${id}: left pistol fired on a held trigger`)
        .toBe(id === 'pistol' ? roundsOf(solo.fired, 'pistol') : 0)
    }
  })

  it('the left pistol still participates behind a rifle', () => {
    const { system, fired } = makeSystem('rifle')
    for (let i = 0; i < 8; i++) tap(system, 0.3)

    expect(roundsOf(fired, 'pistol')).toBeGreaterThanOrEqual(4)
  })

  it('no hold ever yields a primary fewer rounds than that primary fires alone', () => {
    for (const id of ['pistol', 'rifle', 'shotgun']) {
      const dual = makeSystem(id)
      const solo = makeSystem(id, { dual: false })
      for (let i = 0; i < 4; i++) {
        const withLeft = slice(dual.fired, () => hold(dual.system, 1.0))
        const alone = slice(solo.fired, () => hold(solo.system, 1.0))
        expect(roundsOf(withLeft, id), `${id} hold #${i + 1}`).toBeGreaterThanOrEqual(roundsOf(alone, id))
      }
      expect(damageOf(dual.fired), `${id} total`).toBeGreaterThanOrEqual(damageOf(solo.fired))
    }
  })
})


describe('weapon impacts stay on the struck target', () => {
  it('all supported mods and the retired bit cause no splash damage or detonation', () => {
    const target = { health: new HealthPool({ maxHealth: 500, health: 500 }) }
    const neighbor = { health: new HealthPool({ maxHealth: 500, health: 500 }) }
    let sphereQueries = 0
    let explosions = 0
    const bus = new EventBus()
    bus.on(EV.EXPLOSION, () => explosions++)
    const point = new THREE.Vector3(0, 0, -100)
    const normal = new THREE.Vector3(0, 0, 1)
    const noop = () => {}
    const weapon = new Weapon(WEAPONS.PISTOL, {
      bus,
      world: {
        trace: () => ({ actor: target, point, normal, zone: 'body' }),
        bodiesInSphere: () => { sphereQueries++; return [target, neighbor] },
        alert: noop,
      },
      fx: Object.fromEntries(['muzzleFlash', 'cameraShake', 'tracer', 'impact', 'bloodDecal', 'damageNumber', 'explosion'].map(key => [key, noop])),
      audio: { play: noop },
    })
    weapon.applyMods(Object.values(WEAPONS.MOD_BITS).reduce((a, b) => a | b, 8))
    weapon.fireSingleTrace(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 0, new THREE.Vector3())
    expect(target.health.health).toBe(500 - WEAPONS.PISTOL.baseDamage)
    expect(neighbor.health.health).toBe(500)
    expect(sphereQueries).toBe(0)
    expect(explosions).toBe(0)
  })
})
