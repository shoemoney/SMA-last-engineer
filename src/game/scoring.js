/**
 * scoring.js — points, hit-zone bonuses and the kill chain.
 *
 * The original had NO points system: it counted raw kills and weighted nothing. Every
 * number here is therefore marked `CHOSEN: not in original spec` in rules.js, and every
 * one of them lives there rather than in this file.
 *
 * Pure JavaScript. It never reads the clock itself — the caller supplies run time so the
 * headless soak and the browser agree on when a chain lapses.
 */

import { SCORE, DAMAGE } from './rules.js'
import { bus as defaultBus, EV } from '../core/events.js'

/** Why a bundle of points landed, so the HUD can style a wave bonus differently from a kill. */
export const SCORE_REASON = Object.freeze({
  kill: 'kill',
  waveClear: 'waveClear',
  noDamageWave: 'noDamageWave',
})

/**
 * Body is the neutral hit zone: SCORE names a multiplier for head and chest only, because
 * a body shot is worth exactly the archetype's face value. DAMAGE.bodyMultiplier is that
 * same neutral 1.0, named rather than typed as a literal.
 */
function zoneMultiplier(zone) {
  if (zone === DAMAGE.zones.head) return SCORE.headshotMultiplier
  if (zone === DAMAGE.zones.chest) return SCORE.chestMultiplier
  return DAMAGE.bodyMultiplier
}

export class Scoring {
  constructor({ bus = defaultBus } = {}) {
    this.bus = bus
    this.warnedArchetypes = new Set()
    this.reset()
  }

  reset() {
    this.score = 0
    this.kills = 0
    this.headshots = 0
    this.chestHits = 0
    this.comboChain = 0
    this.lastKillAt = -Infinity
    this.now = 0
    this.tookDamageThisWave = false
  }

  /** Advance the chain clock. Called every simulation step with the run's elapsed seconds. */
  update(now) {
    this.now = now
    if (this.comboChain > 0 && now - this.lastKillAt > SCORE.comboWindow) this.comboChain = 0
  }

  /** 1.0 with no chain; +comboStep per chained kill, clamped at comboMax. */
  get multiplier() {
    return Math.min(SCORE.comboMax, 1 + SCORE.comboStep * this.comboChain)
  }

  get comboActive() { return this.comboChain > 0 }

  registerKill({ archetype, zone = DAMAGE.zones.body, at = this.now } = {}) {
    const base = SCORE.perKill[archetype]
    if (base === undefined && !this.warnedArchetypes.has(archetype)) {
      this.warnedArchetypes.add(archetype)
      console.warn(`[score] no per-kill value for archetype "${archetype}"; it is scoring zero`)
    }

    // The chain extends only if this kill landed inside the window opened by the last one.
    this.comboChain = at - this.lastKillAt <= SCORE.comboWindow ? this.comboChain + 1 : 0
    this.lastKillAt = at
    this.now = at

    const points = Math.round((base ?? 0) * zoneMultiplier(zone) * this.multiplier)
    this.score += points
    this.kills += 1
    if (zone === DAMAGE.zones.head) this.headshots += 1
    if (zone === DAMAGE.zones.chest) this.chestHits += 1

    this.bus.emit(EV.SCORE, {
      reason: SCORE_REASON.kill,
      points,
      score: this.score,
      multiplier: this.multiplier,
      chain: this.comboChain,
      archetype,
      zone,
    })
    return points
  }

  /** Any damage the player takes voids the flawless bonus for the wave in progress. */
  registerDamageTaken() { this.tookDamageThisWave = true }

  registerWaveClear(waveNumber) {
    const clearBonus = waveNumber * SCORE.waveClearBonusPerWave
    this.score += clearBonus
    this.bus.emit(EV.SCORE, {
      reason: SCORE_REASON.waveClear,
      points: clearBonus,
      score: this.score,
      wave: waveNumber,
    })

    let flawlessBonus = 0
    if (!this.tookDamageThisWave) {
      flawlessBonus = SCORE.noDamageWaveBonus
      this.score += flawlessBonus
      this.bus.emit(EV.SCORE, {
        reason: SCORE_REASON.noDamageWave,
        points: flawlessBonus,
        score: this.score,
        wave: waveNumber,
      })
    }

    this.tookDamageThisWave = false
    return clearBonus + flawlessBonus
  }

  snapshot() {
    return {
      score: this.score,
      kills: this.kills,
      headshots: this.headshots,
      chestHits: this.chestHits,
      multiplier: this.multiplier,
      chain: this.comboChain,
    }
  }
}
