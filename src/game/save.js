/**
 * save.js — the six persistent career fields, in localStorage.
 *
 * The original wrote one UE save slot ("ShoeinatorSave", user index 0) immediately every
 * time a run was banked. The web port keeps the same six fields and the same banking
 * rules; only the storage backend changed.
 *
 * Every localStorage touch is wrapped: the accessor itself throws in a private window,
 * with site data blocked, and inside the headless verify harness. A browser that cannot
 * persist still plays — it just forgets.
 */

import { SAVE } from './rules.js'

/** Warn once per process. Node has no localStorage at all, and the soak must not spam. */
let warnedUnavailable = false

function storage() {
  try {
    const store = globalThis.localStorage
    if (!store) throw new Error('localStorage is undefined in this environment')
    return store
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      console.warn('[save] localStorage unavailable — career stats will not persist this session:', err.message)
    }
    return null
  }
}

/** A fresh record. recentWaveScores must be copied: SAVE.DEFAULTS is frozen. */
export function emptySave() {
  return { ...SAVE.DEFAULTS, recentWaveScores: [] }
}

const int = (value, fallback) => (Number.isFinite(value) ? Math.trunc(value) : fallback)
const num = (value, fallback) => (Number.isFinite(value) ? value : fallback)

/**
 * Read the slot. A record written by an older build, or hand-edited to nonsense, is
 * coerced field by field rather than trusted, so one bad key cannot NaN the whole HUD.
 */
export function loadSave() {
  const store = storage()
  if (!store) return emptySave()

  let raw = null
  try {
    raw = store.getItem(SAVE.storageKey)
    // Keep careers from the previous game name; all future writes use the new slot.
    if (raw === null) raw = store.getItem('shoeinator.save.v1')
  } catch (err) {
    console.warn(`[save] could not read "${SAVE.storageKey}":`, err.message)
    return emptySave()
  }
  if (raw === null) return emptySave()

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[save] "${SAVE.storageKey}" is not valid JSON, starting from an empty record:`, err.message)
    return emptySave()
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[save] "${SAVE.storageKey}" held ${typeof parsed}, not a record; starting from an empty one`)
    return emptySave()
  }

  const d = SAVE.DEFAULTS
  const recent = Array.isArray(parsed.recentWaveScores) ? parsed.recentWaveScores : []
  return {
    bestWave: int(parsed.bestWave, d.bestWave),
    totalKills: int(parsed.totalKills, d.totalKills),
    totalHeadshots: int(parsed.totalHeadshots, d.totalHeadshots),
    totalPlayTime: num(parsed.totalPlayTime, d.totalPlayTime),
    gamesPlayed: int(parsed.gamesPlayed, d.gamesPlayed),
    recentWaveScores: recent.map(v => int(v, 0)).slice(-SAVE.maxRecentScores),
  }
}

/** Returns whether the write actually reached disk, so a caller can tell the player. */
export function writeSave(record) {
  const store = storage()
  if (!store) return false
  try {
    store.setItem(SAVE.storageKey, JSON.stringify(record))
    return true
  } catch (err) {
    console.warn(`[save] could not persist "${SAVE.storageKey}" (quota or private mode?):`, err.message)
    return false
  }
}

/**
 * Bank a finished run. Mutates all six fields, then writes — the original's order.
 *
 * `previousBest` is snapshotted BEFORE the merge and handed back because the original's
 * game-over screen re-read bestWave after banking, making `n > n` false, so its
 * "NEW BEST WAVE!" banner could never fire. See MENU.GAME_OVER_LAYOUT.newBestUsesPreviousBest.
 *
 * `headshots` was a hardcoded 0 in the original with a comment saying they were not
 * tracked; the port counts them for real (SCORE.trackHeadshots).
 */
export function recordRunResult({ waveReached = 0, kills = 0, headshots = 0, duration = 0 } = {}) {
  const record = loadSave()
  const previousBest = record.bestWave

  record.bestWave = Math.max(record.bestWave, waveReached)
  record.totalKills += kills
  record.totalHeadshots += headshots
  record.totalPlayTime += duration
  record.gamesPlayed += 1

  record.recentWaveScores.push(waveReached)
  while (record.recentWaveScores.length > SAVE.maxRecentScores) record.recentWaveScores.shift()

  const persisted = writeSave(record)
  return { record, previousBest, persisted, isNewBest: waveReached > previousBest }
}
