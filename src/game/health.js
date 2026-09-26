/**
 * health.js — the health pool the player and every zombie share.
 *
 * Pure JavaScript: no three.js, no Math.random, no event bus. Owners wire the onChanged /
 * onDied callbacks to whatever they please, which keeps a pool constructible in a unit test
 * with one line.
 *
 * Spec: spec/damage-weapons.md §10 (armor), §11 (pool, overfill decay, death, conditions).
 * Every number comes from src/game/rules.js.
 */

import { DAMAGE, HEALTH } from './rules.js'
import { DotTracker } from './damage.js'

export const CONDITION = Object.freeze({
  CONFIDENT: HEALTH.CONDITIONS.confident.id,
  STEADY: HEALTH.CONDITIONS.steady.id,
  HURT: HEALTH.CONDITIONS.hurt.id,
  CRITICAL: HEALTH.CONDITIONS.critical.id,
  DEAD: HEALTH.CONDITIONS.dead.id,
})

const PERCENT_TO_FRACTION = 100

// ---------------------------------------------------------------------------
// Pure helpers — armor and overfill decay are where the original got subtle
// ---------------------------------------------------------------------------

/**
 * How an incoming hit splits between armor and health.
 *
 * Armor soaks HALF of every hit, capped at the armor remaining. It does NOT eat damage
 * whole until depleted: with armor up, exactly half of every hit still reaches health.
 * 100 armor taking a 40 hit absorbs 20, not 40. 5 armor taking a 100 hit absorbs all 5
 * and lets 95 through.
 */
export function armorSplit(amount, armor, absorption = HEALTH.armorAbsorption) {
  if (!(amount > 0)) return { absorbed: 0, toHealth: 0 }
  if (!(armor > 0)) return { absorbed: 0, toHealth: amount }
  const absorbed = Math.min(armor, amount * absorption)
  return { absorbed, toHealth: amount - absorbed }
}

/**
 * Overfill decay ticks owed for this frame.
 *
 * Batched rather than looped, with the engine's 1e-4 nudge, because 0.1 has no exact binary
 * representation and naive repeated subtraction silently drops one tick a second.
 */
export function decayTicks(accumulator, dt, interval = HEALTH.decayInterval, epsilon = HEALTH.decayEpsilon) {
  const advanced = accumulator + dt
  if (!(interval > 0) || !(advanced > 0)) return { ticks: 0, accumulator: advanced }

  const ticks = Math.floor((advanced + epsilon) / interval)
  if (ticks <= 0) return { ticks: 0, accumulator: advanced }

  return { ticks, accumulator: advanced - ticks * interval }
}

/** Drives the HUD portrait. Worst bucket wins; armor only shows through once health is healthy. */
export function conditionFor({ health, maxHealth = HEALTH.maxHealth, armor = 0, dead = false }) {
  if (dead) return CONDITION.DEAD
  const fraction = maxHealth > 0 ? health / maxHealth : 0
  if (fraction < HEALTH.criticalThreshold) return CONDITION.CRITICAL
  if (fraction < HEALTH.hurtThreshold) return CONDITION.HURT
  if (armor > 0) return CONDITION.CONFIDENT
  return CONDITION.STEADY
}

/**
 * Total damage needed to kill an unarmored-or-armored target with non-piercing fire.
 * Because armor soaks half, 200 armor over 900 health costs 1100 damage, not 1100-ish —
 * the first 400 dealt burns the armor and removes 200 health.
 */
export function effectiveHealth(health, armor, absorption = HEALTH.armorAbsorption) {
  if (!(armor > 0) || !(absorption > 0)) return health
  const healthLostWhileArmored = Math.min(health, armor * (1 - absorption) / absorption)
  return health + healthLostWhileArmored / absorption - healthLostWhileArmored
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export class HealthPool {
  constructor({
    maxHealth = HEALTH.maxHealth,
    health = maxHealth,
    armor = 0,
    maxArmor = HEALTH.maxArmor,
    overhealCap = HEALTH.overhealCap,
    overArmorCap = HEALTH.overArmorCap,
    decayPerTick = HEALTH.decayPerTick,
    decayInterval = HEALTH.decayInterval,
    armorAbsorption = HEALTH.armorAbsorption,
    maxBurnStacks = DAMAGE.incendiary.maxStacksPerTarget,
    owner = null,
    onChanged = null,
    onDied = null,
  } = {}) {
    /** Whoever this pool belongs to, carried so a killer can be credited back to an entity. */
    this.owner = owner

    this.maxHealth = maxHealth
    this.maxArmor = maxArmor

    // A Boss carries 4000 health and 300 armor, both at or past the default hard caps. The
    // original dodged that by running BeginPlay before ConfigureForWave; lifting each hard cap
    // to what the pool is actually configured for is the same outcome without depending on
    // init order. `health` is deliberately NOT in the health max, so the spawn clamp below
    // still bites on a caller that asks for more health than its own maxHealth allows.
    this.overhealCap = Math.max(overhealCap, maxHealth)
    this.overArmorCap = Math.max(overArmorCap, maxArmor, armor)

    this.health = Math.min(health, this.overhealCap)
    this.armor = Math.min(armor, this.overArmorCap)

    this.decayPerTick = decayPerTick
    this.decayInterval = decayInterval
    this.armorAbsorption = armorAbsorption

    this.dots = new DotTracker({ maxStacks: maxBurnStacks })
    this.decayAccumulator = 0
    this.dead = false

    this.onChanged = onChanged
    this.onDied = onDied
  }

  get alive() {
    return !this.dead
  }

  get isDead() {
    return this.dead
  }

  get isBurning() {
    return this.dots.count > 0
  }

  get healthFraction() {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0
  }

  /**
   * Named getCondition() because spec/player.md §3 names it that verbatim and player.js
   * throws at construction if it is missing. condition() below is the same call under the
   * name spec/damage-weapons.md §11.4 uses.
   */
  getCondition() {
    return conditionFor(this)
  }

  condition() {
    return this.getCondition()
  }

  /**
   * The single funnel every damage source in the game passes through.
   * @returns health actually removed — NOT the total damage, which armor may have eaten half of.
   */
  applyDamage(amount, ignoresArmor = false, instigator = null) {
    if (this.dead || !(amount > 0)) return 0

    let remaining = amount
    if (!ignoresArmor && this.armor > 0) {
      const { absorbed, toHealth } = armorSplit(amount, this.armor, this.armorAbsorption)
      this.armor -= absorbed
      remaining = toHealth
    }

    const before = this.health
    this.health = Math.max(0, this.health - remaining)
    const dealt = before - this.health

    this.#changed(-dealt, instigator)
    if (this.health <= 0) this.#die(instigator)
    return dealt
  }

  /**
   * Take a whole resolved shot: direct damage, then the burn if the target survived it.
   * A shot that kills outright applies no burn — death clears every stack anyway.
   */
  applyShot(result, instigator = null) {
    if (!result) throw new TypeError('HealthPool.applyShot needs a resolveShot() result')

    const wasDead = this.dead
    const dealt = this.applyDamage(result.directDamage, result.ignoresArmor, instigator)
    const burned = !this.dead && this.dots.addFromShot(result, instigator)

    return { dealt, burned, killed: !wasDead && this.dead }
  }

  addBurn(damagePerTick, ticks, interval = DAMAGE.incendiary.tickInterval, source = null) {
    if (this.dead) return false
    return this.dots.add(damagePerTick, ticks, interval, source)
  }

  heal(amount) {
    if (this.dead || !(amount > 0)) return 0
    const before = this.health
    this.health = Math.min(this.overhealCap, this.health + amount)
    const gained = this.health - before
    if (gained > 0) this.#changed(gained, null)
    return gained
  }

  /** Health pickups heal a percentage of max health, not a flat amount. 50 means 50 points at default. */
  healPercent(percent) {
    return this.heal(this.maxHealth * (percent / PERCENT_TO_FRACTION))
  }

  addArmor(amount) {
    if (this.dead || !(amount > 0)) return 0
    const before = this.armor
    this.armor = Math.min(this.overArmorCap, this.armor + amount)
    const gained = this.armor - before
    if (gained > 0) this.#changed(gained, null)
    return gained
  }

  /** Scripted death, for the boss-clear path and the verification harness's death scenario. */
  kill(instigator = null) {
    if (this.dead) return 0
    const removed = this.health
    this.health = 0
    this.#changed(-removed, instigator)
    this.#die(instigator)
    return removed
  }

  /**
   * One fixed-timestep tick: overfill decay first, then burn, exactly as the original ordered
   * them. Decaying first means a pool sitting at 200 sheds before fire eats into it.
   * @returns the raw burn damage dispatched this tick.
   */
  tick(dt) {
    if (this.dead || !(dt > 0)) return 0

    this.#decay(dt)

    return this.dots.advance(dt, (damage, source) => {
      this.applyDamage(damage, DAMAGE.incendiary.ignoresArmor, source)
      // false tells the tracker the target died mid-burn, which wipes the remaining stacks.
      return !this.dead
    })
  }

  /** The name spec/damage-weapons.md §9.2 uses for tick(). player.js calls tick(). */
  advanceTimers(dt) {
    return this.tick(dt)
  }

  /** Flat state for the HUD and the `__SHOE__.state()` verification hook. */
  snapshot() {
    return {
      health: this.health,
      armor: this.armor,
      maxHealth: this.maxHealth,
      maxArmor: this.maxArmor,
      overhealCap: this.overhealCap,
      overArmorCap: this.overArmorCap,
      dead: this.dead,
      condition: this.condition(),
      burnStacks: this.dots.count,
    }
  }

  #decay(dt) {
    const { ticks, accumulator } = decayTicks(this.decayAccumulator, dt, this.decayInterval, HEALTH.decayEpsilon)
    this.decayAccumulator = accumulator
    if (ticks <= 0) return

    const shed = ticks * this.decayPerTick
    const healthBefore = this.health
    const armorBefore = this.armor

    if (this.health > this.maxHealth) this.health = Math.max(this.maxHealth, this.health - shed)
    if (this.armor > this.maxArmor) this.armor = Math.max(this.maxArmor, this.armor - shed)

    const delta = this.health - healthBefore
    // The HUD has to watch an overheal bar visibly drain, so decay reports like any other change.
    if (delta !== 0 || this.armor !== armorBefore) this.#changed(delta, null)
  }

  #changed(delta, instigator) {
    if (!this.onChanged) return
    this.onChanged({
      health: this.health,
      armor: this.armor,
      delta,
      instigator,
      condition: this.condition(),
    })
  }

  #die(instigator) {
    if (this.dead) return
    this.dead = true
    this.dots.clear()
    if (this.onDied) this.onDied({ instigator, pool: this })
  }
}
