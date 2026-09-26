import { afterEach, expect, it, vi } from 'vitest'
import { emptySave, loadSave, recordRunResult } from '../src/game/save.js'
import { SAVE } from '../src/game/rules.js'

afterEach(() => vi.unstubAllGlobals())

function storage(entries) {
  const values = new Map(entries)
  const getItem = vi.fn(key => values.get(key) ?? null)
  const setItem = vi.fn((key, value) => values.set(key, value))
  vi.stubGlobal('localStorage', { getItem, setItem })
  return { values, getItem, setItem }
}

it('loads an existing career from the previous namespace without writing on read', () => {
  const career = { ...emptySave(), bestWave: 12, totalKills: 87, totalHeadshots: 23, totalPlayTime: 210, gamesPlayed: 4, recentWaveScores: [7, 12] }
  const store = storage([['shoeinator.save.v1', JSON.stringify(career)]])
  expect(loadSave()).toEqual(career)
  expect(store.setItem).not.toHaveBeenCalled()
})

it('prefers the new career and never reads the old slot when the new one exists', () => {
  const career = { ...emptySave(), bestWave: 3, gamesPlayed: 1 }
  const store = storage([
    ['SMA-last-engineer', JSON.stringify(career)],
    ['shoeinator.save.v1', JSON.stringify({ ...career, bestWave: 99 })],
  ])
  expect(loadSave()).toEqual(career)
  expect(store.getItem.mock.calls).toEqual([['SMA-last-engineer']])
})

it('banks the migrated career into the new namespace and leaves the old record intact', () => {
  const legacy = JSON.stringify({ ...emptySave(), bestWave: 8, totalKills: 10, gamesPlayed: 2 })
  const store = storage([['shoeinator.save.v1', legacy]])
  const banked = recordRunResult({ waveReached: 9, kills: 5, headshots: 2, duration: 30 })
  expect(SAVE.storageKey).toBe('SMA-last-engineer')
  expect(banked.record).toMatchObject({ bestWave: 9, totalKills: 15, gamesPlayed: 3, totalHeadshots: 2, totalPlayTime: 30 })
  expect(store.setItem.mock.calls.map(([key]) => key)).toEqual(['SMA-last-engineer'])
  expect(store.values.get('shoeinator.save.v1')).toBe(legacy)
  expect(JSON.parse(store.values.get('SMA-last-engineer'))).toEqual(banked.record)
})
