/**
 * waveDirector.js — the wave composition formula, the spawn queue, and the timers that
 * pace a run. Pure JavaScript: no three.js, no DOM, no Math.random. The headless soak
 * and the browser build drive the identical object.
 *
 * Every number comes from rules.js. Provenance for the formulas is
 * spec/waves-progression.md §2 (composition), §4 (state machine), §4.5 (batch rule),
 * §4.10 (countdown) — which in turn came out of ShoeWaveDirector.cpp / ShoeGameMode.cpp.
 */

import { WAVES, ZOMBIES, TRAIN, AUDIO, HUD } from './rules.js'
import { bus as defaultBus, EV } from '../core/events.js'
import { rng as defaultRng } from '../core/rng.js'

/**
 * The director's five internal states. These are NOT the game's menu/fight/gameOver
 * states (RUN.STATES) — they describe where one wave is in its own life cycle, and the
 * original tracked them on a different object.
 */
export const WAVE_STATE = Object.freeze({
  idle: 'idle',
  preparation: 'preparation',
  trainArriving: 'trainArriving',
  spawning: 'spawning',
  fighting: 'fighting',
  intermission: 'intermission',
})

/** Which phase of its shuttle run the train was just told to perform. */
export const TRAIN_PHASE = Object.freeze({ arriving: 'arriving', departing: 'departing' })

const BASE_ARCHETYPE = WAVES.spawnQueueOrder[0]

/**
 * Every non-boss count shares one shape, so rules.js stores the four sets of parameters
 * rather than four hand-written expressions.
 */
function countFromFormula(formula, waveNumber) {
  if (waveNumber < formula.firstWave) return 0
  return formula.base + formula.perWave * Math.floor((waveNumber - formula.firstWave) / formula.divisor)
}

function bossCountForWave(waveNumber) {
  const f = WAVES.BOSS_FORMULA
  if (waveNumber % f.everyNthWave !== 0) return 0
  return f.base + Math.floor(waveNumber / f.extraPerWaves)
}

function scaleFromCurve(curve, waveNumber) {
  return Math.min(curve.base + curve.perWave * (waveNumber - WAVES.firstWaveNumber), curve.cap)
}

/**
 * The wave record, computed purely — no randomness, no state. Field names match
 * spec/waves-progression.md §2 verbatim so the §2.1 regression table can be asserted
 * against this object without translation.
 */
export function buildWave(waveNumber) {
  const composition = { waveNumber }
  let totalCount = 0

  for (const id of WAVES.spawnQueueOrder) {
    const count = id === 'boss'
      ? bossCountForWave(waveNumber)
      : countFromFormula(WAVES.COUNT_FORMULAS[id], waveNumber)
    composition[`${id}Count`] = count
    totalCount += count
  }

  composition.totalCount = totalCount
  composition.healthScale = scaleFromCurve(WAVES.SCALING.health, waveNumber)
  composition.speedScale = scaleFromCurve(WAVES.SCALING.speed, waveNumber)
  composition.damageScale = scaleFromCurve(WAVES.SCALING.damage, waveNumber)
  return composition
}

/**
 * Flatten to a FIFO in WAVES.spawnQueueOrder. Spawns pop from the front, which is why the
 * boss is always the last thing off the train. Never shuffle this — it is the pacing.
 */
export function flattenComposition(composition) {
  const queue = []
  for (const id of WAVES.spawnQueueOrder) {
    for (let i = 0; i < composition[`${id}Count`]; i++) queue.push(id)
  }
  return queue
}

/**
 * Resolve one enemy's stats for the wave it is spawning into. Armor, ranges, cooldown and
 * body scale are deliberately absent from the scaling — a Tank has 200 armor on wave 1 and
 * on wave 200.
 */
export function resolveZombieForWave(archetypeId, composition) {
  let archetype = ZOMBIES.ARCHETYPES[archetypeId]
  if (!archetype) {
    // ShoeWaveDirector.cpp fell back to the base class on an out-of-range slot index, and
    // did it silently — which is exactly how all five archetypes ended up identical.
    console.warn(`[waves] unknown archetype "${archetypeId}", falling back to "${BASE_ARCHETYPE}"`)
    archetype = ZOMBIES.ARCHETYPES[BASE_ARCHETYPE]
  }

  const maxHealth = archetype.health * composition.healthScale
  return {
    archetype: archetype.id,
    maxHealth,
    health: maxHealth,
    armor: archetype.armor,
    speed: archetype.speed * composition.speedScale,
    meleeDamage: archetype.meleeDamage * composition.damageScale,
    projectileDamage: archetype.projectileDamage * composition.damageScale,
    attackRange: archetype.attackRange,
    attackCooldown: archetype.attackCooldown,
    desiredRange: archetype.desiredRange,
    scale: archetype.scale,
    capsuleRadius: archetype.capsuleRadius * archetype.scale,
    capsuleHalfHeight: archetype.capsuleHalfHeight * archetype.scale,
  }
}

/**
 * Pick a door and jitter the spawn point. Returns the door index rather than a rotation:
 * the door's real world orientation belongs to the train mesh, which lives in src/world
 * and must not be reached into from here.
 */
export function pickSpawnTransform(rngSource, trainOrigin = TRAIN.platformStopLocation) {
  const door = rngSource.int(0, TRAIN.doorCount - 1)
  const scatter = WAVES.spawnScatterRadius
  return {
    door,
    x: trainOrigin[0] + TRAIN.doorLocalXs[door] + rngSource.range(-scatter, scatter),
    y: trainOrigin[1] + TRAIN.doorLateralOffset + rngSource.range(-scatter, scatter),
    z: trainOrigin[2] + TRAIN.doorLocalZ,
  }
}

/** The mod the player is handed for clearing wave N. Implemented and never called in the original. */
export function rewardForWave(waveNumber) {
  const cycle = WAVES.REWARD.cycle
  return cycle[waveNumber % cycle.length]
}

function countdownVoiceLine(seconds) {
  const v = AUDIO.VOICE
  if (seconds < v.countdownMinSpeakable || seconds > v.countdownMaxSpeakable) return null
  return `vo_countdown_${seconds}`
}

export class WaveDirector {
  /**
   * `bus` and `rng` are injectable so the soak can run an isolated, seeded director while
   * the browser build shares the singletons.
   */
  constructor({ bus = defaultBus, rng = defaultRng, trainOrigin = TRAIN.platformStopLocation } = {}) {
    this.bus = bus
    this.rng = rng
    this.trainOrigin = trainOrigin
    this.reset()
  }

  reset() {
    this.state = WAVE_STATE.idle
    this.currentWave = WAVES.initialWaveCounter
    this.composition = null
    this.queue = []
    this.remainingThisWave = 0
    this.zombiesAlive = 0
    this.spawnedThisWave = 0

    this.pendingRelease = 0
    this.staggerTimer = 0
    this.arrivalTimer = 0
    this.spawnDelayTimer = 0
    this.countdownTimer = 0
    this.countdownRemaining = HUD.initialCountdown // the sentinel the HUD tests with `>= 0` before it draws a countdown at all

    this.running = false
  }

  /** Begin a run. The original called this with 1 on level begin-play. */
  start(waveNumber = WAVES.firstWaveNumber) {
    this.reset()
    this.running = true
    this.startWave(waveNumber)
  }

  prepare() {
    this.reset()
    this.running = true
    this.state = WAVE_STATE.preparation
    this.countdownRemaining = 30
    this.countdownTimer = WAVES.countdownTickInterval
    this.emitCountdown()
  }

  startNextWave() {
    if (!this.running || ![WAVE_STATE.preparation, WAVE_STATE.intermission].includes(this.state)) return false
    this.startWave(this.currentWave + 1)
    return true
  }

  /** Freeze the loop. The original left it running under the game-over screen; the port halts. */
  stop() { this.running = false }

  resume() { this.running = true }

  /** spec §4.1 + §4.2 — the exact start sequence, then hand off to the train gate. */
  startWave(waveNumber) {
    this.currentWave = waveNumber
    this.zombiesAlive = 0
    this.spawnedThisWave = 0
    this.pendingRelease = 0
    this.staggerTimer = 0
    this.countdownRemaining = HUD.initialCountdown

    const composition = buildWave(waveNumber)
    this.composition = composition
    this.queue = flattenComposition(composition)
    this.remainingThisWave = composition.totalCount

    const hasBoss = composition.bossCount > 0
    this.bus.emit(EV.WAVE_START, {
      wave: waveNumber,
      composition,
      zombiesAlive: 0,
      voiceLine: hasBoss ? AUDIO.VOICE.bossIncomingLine : AUDIO.VOICE.waveStartLine,
    })
    if (hasBoss) this.bus.emit(EV.BOSS_INCOMING, { wave: waveNumber, bossCount: composition.bossCount })

    this.state = WAVE_STATE.trainArriving
    this.arrivalTimer = TRAIN.arrivalTime
    this.bus.emit(EV.TRAIN_INBOUND, { phase: TRAIN_PHASE.arriving, seconds: TRAIN.arrivalTime, wave: waveNumber })
  }

  update(dt, realDt = dt) {
    if (!this.running) return

    switch (this.state) {
      case WAVE_STATE.trainArriving:
        this.arrivalTimer -= dt
        if (this.arrivalTimer <= 0) this.onTrainArrived()
        break

      case WAVE_STATE.spawning:
        this.spawnDelayTimer -= dt
        if (this.spawnDelayTimer <= 0) {
          this.state = WAVE_STATE.fighting
          this.pulse()
          this.releaseTick(-this.spawnDelayTimer) // spend the overshoot, so a coarse dt does not stall the first zombie
        }
        break

      case WAVE_STATE.fighting:
        this.releaseTick(dt)
        break

      case WAVE_STATE.preparation:
      case WAVE_STATE.intermission:
        this.tickCountdown(realDt)
        break
    }
  }

  /** spec §4.4, plus the port's small door-open gap so a batch reads as a train unloading. */
  onTrainArrived() {
    this.state = WAVE_STATE.spawning
    this.spawnDelayTimer = WAVES.spawnDelayAfterArrival
    this.bus.emit(EV.TRAIN_DOORS, { wave: this.currentWave, openSeconds: TRAIN.doorOpenSeconds })
  }

  /**
   * spec §4.5 — the batch rule. `pendingRelease` is subtracted from the room calculation
   * because the port staggers a batch over time instead of materialising it in one frame:
   * without it, a kill landing mid-stagger would let two overlapping batches commit past
   * the live cap of 60.
   */
  pulse() {
    if (this.queue.length === 0) return
    const roomAvailable = Math.max(0, WAVES.maxLiveZombies - this.zombiesAlive - this.pendingRelease)
    this.pendingRelease += Math.min(WAVES.spawnBatchSize, roomAvailable, this.queue.length)
  }

  releaseTick(dt) {
    this.staggerTimer -= dt
    while (this.pendingRelease > 0 && this.staggerTimer <= 0) {
      if (this.queue.length === 0) { this.pendingRelease = 0; break }
      if (this.zombiesAlive >= WAVES.maxLiveZombies) { this.staggerTimer = 0; break }
      this.releaseOne()
      this.pendingRelease -= 1
      this.staggerTimer += WAVES.spawnStagger
    }
    // With nothing left to release, do not bank negative time: the next batch should open
    // with a zombie immediately, not with a burst of however long the queue sat empty.
    if (this.pendingRelease <= 0 && this.staggerTimer < 0) this.staggerTimer = 0
  }

  releaseOne() {
    const archetypeId = this.queue.shift()
    const stats = resolveZombieForWave(archetypeId, this.composition)
    const transform = pickSpawnTransform(this.rng, this.trainOrigin)

    this.zombiesAlive += 1
    this.spawnedThisWave += 1
    this.bus.emit(EV.ZOMBIE_SPAWN, {
      archetype: archetypeId,
      stats,
      transform,
      wave: this.currentWave,
      alive: this.zombiesAlive,
    })
  }

  /**
   * spec §4.7 — order matters. The live count drops first, then the wave's remaining count;
   * the last kill ends the wave and deliberately does NOT top up the queue.
   * Returns true when this death cleared the wave.
   */
  notifyZombieRemoved() {
    this.zombiesAlive = Math.max(0, this.zombiesAlive - 1)

    // A corpse from an already-cleared wave must not push the counter negative and fire
    // endWave a second time.
    if (this.remainingThisWave <= 0) return false

    this.remainingThisWave -= 1
    if (this.remainingThisWave <= 0) {
      this.state = WAVE_STATE.idle
      this.queue.length = 0
      this.pendingRelease = 0
      this.endWave()
      return true
    }

    if (this.queue.length > 0) this.pulse()
    return false
  }

  /** spec §4.9 */
  endWave() {
    this.bus.emit(EV.WAVE_CLEAR, {
      wave: this.currentWave,
      spawned: this.spawnedThisWave,
      voiceLine: AUDIO.VOICE.waveClearLine,
      reward: WAVES.REWARD.trigger === 'waveClear' ? rewardForWave(this.currentWave) : null,
    })
    this.beginIntermission()
  }

  /** spec §4.10 — the countdown broadcasts its opening value immediately, then once a second. */
  beginIntermission() {
    this.state = WAVE_STATE.intermission
    this.countdownRemaining = WAVES.intermissionSeconds
    this.countdownTimer = WAVES.countdownTickInterval
    this.emitCountdown()

    // The original re-issued an arrival on the same tick it ordered the departure, so from
    // wave 2 on the train never left. TRAIN.departsBetweenWaves restores the round trip:
    // 4 s out, ~2 s parked off-screen, then the 4 s arrival ordered at countdown zero.
    if (TRAIN.departsBetweenWaves) {
      this.bus.emit(EV.TRAIN_INBOUND, { phase: TRAIN_PHASE.departing, seconds: TRAIN.departTime, wave: this.currentWave })
    }
  }

  emitCountdown() {
    this.bus.emit(EV.COUNTDOWN, {
      seconds: this.countdownRemaining,
      voiceLine: countdownVoiceLine(this.countdownRemaining),
    })
  }

  tickCountdown(dt) {
    this.countdownTimer -= dt
    while (this.countdownTimer <= 1e-9) {
      this.countdownRemaining -= 1
      this.emitCountdown()
      if (this.countdownRemaining <= 0) {
        this.startWave(this.currentWave + 1)
        return
      }
      this.countdownTimer += WAVES.countdownTickInterval
    }
  }

  get isIntermission() { return this.state === WAVE_STATE.intermission }

  snapshot() {
    return {
      state: this.state,
      wave: this.currentWave,
      zombiesAlive: this.zombiesAlive,
      remaining: this.remainingThisWave,
      queued: this.queue.length,
      spawned: this.spawnedThisWave,
      countdown: this.countdownRemaining,
      composition: this.composition,
      running: this.running,
    }
  }
}
