import { it, expect, vi, afterEach } from 'vitest'
import { initArcadeScore } from '../src/ui/arcadeScore.js'

afterEach(() => vi.unstubAllGlobals())
it('uses the saved name, submits through a native form, and stores a name only after success', async () => {
  const nodes = new Map()
  const handlers = new Map()
  for (const id of ['arcade-score-form', 'arcade-score-name', 'arcade-score-submit', 'arcade-score-status']) {
    nodes.set(id, { hidden: true, textContent: '', value: '', addEventListener: (event, fn) => handlers.set(event, fn) })
  }
  const setItem = vi.fn()
  vi.stubGlobal('localStorage', { getItem: () => '<b>Player</b>', setItem })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ runToken: 'token' }) }).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: true, score: { id: 1, name: '<b>Player</b>', score: 10, createdAt: '2026-09-25T20:00:00Z' } }) }))
  const client = initArcadeScore({ document: { getElementById: id => nodes.get(id) } })
  expect(nodes.get('arcade-score-name').value).toBe('<b>Player</b>')
  client.begin()
  client.finish({ score: 10, waveReached: 1, kills: 1, headshots: 0, duration: 10 })
  expect(nodes.get('arcade-score-form').hidden).toBe(false)
  const preventDefault = vi.fn()
  await handlers.get('submit')({ preventDefault })
  expect(preventDefault).toHaveBeenCalled()
  expect(setItem).not.toHaveBeenCalled()
  expect(nodes.get('arcade-score-status').textContent).toContain('Could not confirm')
  expect(nodes.get('arcade-score-name').disabled).toBe(true)
  expect(nodes.get('arcade-score-submit').disabled).toBe(false)
  await handlers.get('submit')({ preventDefault })
  expect(setItem).toHaveBeenCalledWith('last-engineer.arcade.name.v1', '<b>Player</b>')
  expect(nodes.get('arcade-score-submit').disabled).toBe(true)
  expect(nodes.get('arcade-score-status').textContent).toContain('Score submitted')
})
