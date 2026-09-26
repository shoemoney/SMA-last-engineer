/**
 * damage.js — the shot pipeline, as pure arithmetic.
 *
 * Everything here is engine-free: give it a base damage, a hit zone and a mod bitmask and
 * it hands back a plain result object. No three.js, no world queries, no Math.random. That
 * is what lets `npm test` and `npm run soak` run the real damage model in node.
 *
 * Spec: spec/damage-weapons.md §2 (zones), §3 (resolution), §4 (mods),
 * §9 (burn). Every number comes from src/game/rules.js.
 */

import { DAMAGE, WEAPONS } from './rules.js'

// ---------------------------------------------------------------------------
// Mods — a bitmask the player accumulates and can never lose
// ---------------------------------------------------------------------------

/** Screaming-case aliases over rules.js's camelCase bits, so call sites read like the C++. */
export const MOD = Object.freeze({
  NONE: 0,
  SILENCER: WEAPONS.MOD_BITS.silencer,
  ARMOR_PIERCING: WEAPONS.MOD_BITS.armorPiercing,
  INCENDIARY: WEAPONS.MOD_BITS.incendiary,
  LASER_SIGHT: WEAPONS.MOD_BITS.laserSight,
})

/** The same bits keyed by mod id, for pickups and the HUD, which think in names. */
export const MOD_BY_ID = WEAPONS.MOD_BITS

export const ZONE = DAMAGE.zones

export function hasMod(mods, bit) {
  return ((mods | 0) & (bit | 0)) !== 0
}

export function addMod(mods, bit) {
  return (mods | 0) | (bit | 0)
}

/**
 * Mod ids currently fitted, in HUD badge order. `dualWield` rides along in that order list
 * without being a mod bit, so it is filtered out here and the HUD appends it itself.
 */
export function activeModIds(mods) {
  return WEAPONS.MOD_BADGE_ORDER.filter(id => MOD_BY_ID[id] !== undefined && hasMod(mods, MOD_BY_ID[id]))
}

// ---------------------------------------------------------------------------
// Hit zones
// ---------------------------------------------------------------------------

const ZONE_MULTIPLIER = Object.freeze({
  [ZONE.head]: DAMAGE.headMultiplier,
  [ZONE.chest]: DAMAGE.chestMultiplier,
  [ZONE.body]: DAMAGE.bodyMultiplier,
})

export function zoneMultiplier(zone) {
  const multiplier = ZONE_MULTIPLIER[zone]
  if (multiplier === undefined) {
    console.warn(`[damage] unknown hit zone "${zone}" — resolving as body. Check the caller's zone lookup.`)
    return DAMAGE.bodyMultiplier
  }
  return multiplier
}

const HEAD_BONES = new Set(DAMAGE.headBones.map(bone => bone.toLowerCase()))
const CHEST_BONES = new Set(DAMAGE.chestBones.map(bone => bone.toLowerCase()))

/**
 * Unreal's FName comparison is case-insensitive, which is why the original's bone sets carry
 * both "head" and "Head" harmlessly. Anything unmatched — a limb, a wall, an empty string —
 * is Body, so a miss on the zone tables costs 1x rather than throwing.
 */
export function zoneFromBoneName(name) {
  if (typeof name !== 'string' || name.length === 0) return ZONE.body
  const key = name.toLowerCase()
  if (HEAD_BONES.has(key)) return ZONE.head
  if (CHEST_BONES.has(key)) return ZONE.chest
  return ZONE.body
}

// ---------------------------------------------------------------------------
// Spread — the laser sight's entire contribution
// ---------------------------------------------------------------------------

const DEGREES_TO_RADIANS = Math.PI / 180

/** The laser sight is the only mod that touches accuracy, and it touches nothing else. */
export function spreadHalfAngleDeg(baseSpread, mods) {
  const spread = Math.max(0, baseSpread)
  return hasMod(mods, MOD.LASER_SIGHT) ? spread * WEAPONS.MODS.laserSight.spreadFactor : spread
}

export function spreadHalfAngleRad(baseSpread, mods) {
  return spreadHalfAngleDeg(baseSpread, mods) * DEGREES_TO_RADIANS
}

// ---------------------------------------------------------------------------
// The shot resolver
// ---------------------------------------------------------------------------

/**
 * Resolve one pellet into its full damage payload. No side effects, no world access.
 *
 */
export function resolveShot(baseDamage, zone, mods = MOD.NONE, rules = DAMAGE) {
  const base = Math.max(0, baseDamage)

  const result = {
    directDamage: base * zoneMultiplier(zone),
    burnDamagePerTick: 0,
    burnTicks: 0,
    burnTickInterval: rules.incendiary.tickInterval,
    ignoresArmor: hasMod(mods, MOD.ARMOR_PIERCING),
    alertsEnemies: !hasMod(mods, MOD.SILENCER),
    zone,
  }

  if (hasMod(mods, MOD.INCENDIARY)) {
    result.burnDamagePerTick = base * rules.incendiary.tickMultiplier
    result.burnTicks = rules.incendiary.ticks
    result.burnTickInterval = rules.incendiary.tickInterval
  }

  return result
}

/**
 * What the floating damage number prints: the direct hit PLUS the full burn commitment,
 * shown up front rather than trickled out tick by tick.
 *
 * resolveShot() fixes burnDamagePerTick and burnTicks at the moment of the hit — the burn
 * is not random and does not depend on anything downstream, so "committed" is the honest
 * total, not a guess. The alternative (a fresh popup on every burn tick) would mean
 * rewriting every call site that currently fires one number per shot into one that fires
 * one per tick; that is a wider change than "what gets displayed", so it stays out of this
 * fix. One caveat that follows from showing the commitment up front: a shot that kills its
 * target outright never actually gets to apply that target's burn (weapon.js skips
 * attaching burn to a corpse), so the number will occasionally promise a few points of burn
 * that a dead target never took. That tradeoff is deliberately accepted over the two
 * alternatives — printing a number that is ALWAYS wrong by 2x-6x, or restructuring the
 * popup into a per-tick stream outside this file's ownership.
 */
export function damageNumberValue(result) {
  const burnTotal = result.burnDamagePerTick * result.burnTicks
  return Math.max(0, Math.round(result.directDamage + burnTotal))
}

// ---------------------------------------------------------------------------
// Burn (damage over time)
// ---------------------------------------------------------------------------

/**
 * Independent burn stacks on one target, ticked on the sim's fixed timestep.
 *
 * Stacks are never merged or refreshed while there is room — ten incendiary hits burn as
 * ten parallel stacks, exactly as the original did. What the original did NOT do is cap
 * them, which let 30 rounds of automatic incendiary fire stack to 450 damage/second;
 * rules.js caps the count instead of letting that compound.
 */
export class DotTracker {
  constructor({
    maxStacks = DAMAGE.incendiary.maxStacksPerTarget,
    minInterval = DAMAGE.incendiary.minInterval,
  } = {}) {
    this.maxStacks = maxStacks
    this.minInterval = minInterval
    /** Read-only to everything outside this class. Mutate through add/advance/clear. */
    this.stacks = []
  }

  get count() {
    return this.stacks.length
  }

  /** Damage already committed to this target, so a caller can avoid spending shots on a corpse. */
  get pendingDamage() {
    let pending = 0
    for (const stack of this.stacks) pending += stack.damagePerTick * stack.ticksRemaining
    return pending
  }

  add(damagePerTick, ticks, interval = DAMAGE.incendiary.tickInterval, source = null) {
    if (!(damagePerTick > 0) || !(ticks > 0)) return false

    const safeInterval = Math.max(this.minInterval, interval)
    const stack = {
      damagePerTick,
      ticksRemaining: Math.floor(ticks),
      interval: safeInterval,
      // The first tick lands one full interval after the hit, never immediately.
      timeUntilNextTick: safeInterval,
      source,
    }

    if (this.stacks.length < this.maxStacks) {
      this.stacks.push(stack)
      return true
    }

    // At the cap, restart whichever stack is closest to burning out. Dropping the new stack
    // instead would let an almost-spent stack block a fresh hit for a full interval.
    let weakest = 0
    for (let i = 1; i < this.stacks.length; i++) {
      if (this.stacks[i].ticksRemaining < this.stacks[weakest].ticksRemaining) weakest = i
    }
    this.stacks[weakest] = stack
    return true
  }

  /** Attach the burn a resolveShot() result carries, if it carries one. */
  addFromShot(result, source = null) {
    if (!result) return false
    return this.add(result.burnDamagePerTick, result.burnTicks, result.burnTickInterval, source)
  }

  /**
   * Advance every stack by `dt` and pay out any ticks it crossed.
   *
   * @param applyTick (damagePerTick, source) => boolean — return false to signal the target
   *        died, which wipes every remaining stack immediately.
   * @returns the raw burn damage dispatched; what actually landed is the callback's business.
   */
  advance(dt, applyTick) {
    if (typeof applyTick !== 'function') {
      throw new TypeError('DotTracker.advance needs an applyTick(damage, source) callback')
    }

    let ticked = 0
    if (!(dt > 0) || this.stacks.length === 0) return ticked

    for (let i = this.stacks.length - 1; i >= 0; i--) {
      const stack = this.stacks[i]
      stack.timeUntilNextTick -= dt

      // A `while`, not an `if`: a frame hitch that swallows three intervals still pays three.
      while (stack.timeUntilNextTick <= 0 && stack.ticksRemaining > 0) {
        ticked += stack.damagePerTick
        stack.ticksRemaining -= 1
        stack.timeUntilNextTick += stack.interval

        if (applyTick(stack.damagePerTick, stack.source) === false) {
          this.clear()
          return ticked
        }
      }

      if (stack.ticksRemaining <= 0) this.stacks.splice(i, 1)
    }

    return ticked
  }

  clear() {
    this.stacks.length = 0
  }
}
