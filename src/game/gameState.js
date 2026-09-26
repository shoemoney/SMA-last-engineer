/**
 * gameState.js — the run lifecycle: menu → playing → game over.
 *
 * Owns the per-run counters the original kept on AShoeGameMode (currentWave, totalKills,
 * runStartTime, runOver) and drives the wave director and the scorer. The live enemy
 * count is NOT duplicated here: the director owns it, because the director is the thing
 * that enforces the cap.
 *
 * Pure JavaScript. It is the single consumer of EV.ZOMBIE_DEATH and EV.PLAYER_DEATH —
 * entity code emits those events and must never call the director directly, or a kill
 * gets counted twice.
 */

import { RUN, WAVES, SCORE } from './rules.js'
import { bus as defaultBus, EV } from '../core/events.js'
import { rng as defaultRng } from '../core/rng.js'
import { WaveDirector, WAVE_STATE } from './waveDirector.js'
import { Scoring } from './scoring.js'
import { runScore } from './runScore.js'
import { recordRunResult } from './save.js'

const [MENU, HOW_TO_PLAY, INTERMISSION, FIGHT, GAME_OVER] = RUN.STATES

export const GAME_STATES = Object.freeze({
  menu: MENU,
  howToPlay: HOW_TO_PLAY,
  intermission: INTERMISSION,
  fight: FIGHT,
  gameOver: GAME_OVER,
})

export class GameState {
  constructor({ bus = defaultBus, rng = defaultRng, director, scoring } = {}) {
    this.bus = bus
    this.director = director ?? new WaveDirector({ bus, rng })
    this.scoring = scoring ?? new Scoring({ bus })

    this.state = MENU
    this.currentWave = WAVES.initialWaveCounter
    this.totalKills = RUN.initialTotalKills
    this.runStartTime = RUN.initialRunStartTime
    this.runOver = RUN.initialRunOver
    this.completedWaves = 0
    this.combatSeconds = 0
    this.elapsed = 0
    this.lastRunSummary = null

    this.unsubscribe = [
      bus.on(EV.ZOMBIE_DEATH, payload => this.handleZombieDeath(payload)),
      bus.on(EV.PLAYER_DEATH, () => this.playerDied()),
      bus.on(EV.PLAYER_HIT, () => this.scoring.registerDamageTaken()),
      bus.on(EV.WAVE_START, ({ wave }) => { this.currentWave = wave }),
      bus.on(EV.WAVE_CLEAR, ({ wave }) => {
        if (wave <= this.completedWaves) return
        this.completedWaves = wave
        this.scoring.registerWaveClear(wave)
      }),
    ]
  }

  /** Drop every subscription. Needed when a soak or a test builds more than one of these. */
  dispose() {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
  }

  setState(next) {
    if (next === this.state) return
    const previous = this.state
    this.state = next
    this.bus.emit(EV.STATE_CHANGE, { state: next, previous, wave: this.currentWave })
  }

  toMenu() {
    this.director.stop()
    this.setState(MENU)
  }

  showHowToPlay() { this.setState(HOW_TO_PLAY) }

  /** Loading a level built a fresh game mode in the original, so every per-run counter resets. */
  startRun() {
    this.currentWave = WAVES.initialWaveCounter
    this.totalKills = RUN.initialTotalKills
    this.runOver = RUN.initialRunOver
    this.completedWaves = 0
    this.combatSeconds = 0
    this.elapsed = 0
    this.runStartTime = RUN.initialRunStartTime
    this.lastRunSummary = null

    this.scoring.reset()
    this.director.prepare()
    this.setState(INTERMISSION)
  }

  /** The game-over screen's RETRY. Identical to a fresh start; the save already holds the last run. */
  retry() { this.startRun() }

  update(dt, realDt = dt) {
    if (this.state === MENU || this.state === HOW_TO_PLAY) return
    if (this.runOver && WAVES.haltOnPlayerDeath) return

    this.elapsed += realDt
    if ([WAVE_STATE.spawning, WAVE_STATE.fighting].includes(this.director.state)) this.combatSeconds += dt
    this.scoring.update(this.elapsed)
    this.director.update(dt, realDt)

    if (this.state === FIGHT || this.state === INTERMISSION) {
      this.setState([WAVE_STATE.preparation, WAVE_STATE.intermission].includes(this.director.state) ? INTERMISSION : FIGHT)
    }
  }

  handleZombieDeath(payload = {}) {
    this.totalKills += 1
    this.scoring.registerKill({ archetype: payload.archetype, zone: payload.zone, at: this.elapsed })
    this.director.notifyZombieRemoved()
  }

  /** spec §6.1 — idempotent, banks exactly once, and (unlike the original) stops the loop. */
  playerDied() {
    if (this.runOver) return this.lastRunSummary
    this.runOver = true

    const duration = this.elapsed - this.runStartTime
    const headshots = SCORE.trackHeadshots ? this.scoring.headshots : 0
    const banked = recordRunResult({
      waveReached: this.currentWave,
      kills: this.totalKills,
      headshots,
      duration,
    })

    if (WAVES.haltOnPlayerDeath) this.director.stop()

    this.lastRunSummary = {
      waveReached: this.currentWave,
      kills: this.totalKills,
      headshots,
      duration,
      score: this.score,
      scoringVersion: 2,
      completedWaves: this.completedWaves,
      combatSeconds: this.combatSeconds,
      previousBest: banked.previousBest,
      bestWave: banked.record.bestWave,
      isNewBest: banked.isNewBest,
      persisted: banked.persisted,
      record: banked.record,
    }

    this.setState(GAME_OVER)
    return this.lastRunSummary
  }

  get zombiesAlive() { return this.director.zombiesAlive }
  get wave() { return this.currentWave }
  get score() { return runScore(this.completedWaves, this.combatSeconds) }
  get isPlaying() { return this.state === FIGHT || this.state === INTERMISSION }

  /** The shape src/main.js folds into globalThis.__SHOE__.state() for the verify harness. */
  snapshot() {
    const d = this.director.snapshot()
    return {
      state: this.state,
      wave: this.currentWave,
      score: this.score,
      scoringVersion: 2,
      completedWaves: this.completedWaves,
      combatSeconds: this.combatSeconds,
      kills: this.totalKills,
      zombies: d.zombiesAlive,
      remaining: d.remaining,
      countdown: d.countdown,
      intermission: this.state === INTERMISSION,
      alive: !this.runOver,
      elapsed: this.elapsed,
      combo: this.scoring.multiplier,
    }
  }
}
