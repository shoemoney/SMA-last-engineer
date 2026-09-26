import { it, expect, vi } from 'vitest'
import { createScoreClient } from '../src/arcade/scoreClient.js'

const summary = () => ({ score: 100, waveReached: 3, kills: 12, headshots: 4, duration: 19.5 })
const ok = body => ({ ok: true, json: async () => body })
const accepted = (name = 'Jeremy', score = 100) => ({ accepted: true, score: { id: 1, name, score, createdAt: '2026-09-25T20:00:00Z' } })
const rejected = (status, retryAfter = null) => ({ ok: false, status, json: async () => ({ error: 'Rejected' }), headers: { get: () => retryAfter } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

it('does not block a run on token issuance and submits the frozen death result once', async () => {
  const token = deferred()
  const request = vi.fn().mockReturnValueOnce(token.promise).mockResolvedValue(ok(accepted()))
  const client = createScoreClient({ request })
  expect(client.begin()).toBeUndefined()
  const run = summary()
  client.finish(run)
  run.score = 9999
  const submitting = client.submit('  Jeremy  ')
  expect(client.state().status).toBe('submitting')
  expect(await client.submit('Other')).toBe(false)
  token.resolve(ok({ runToken: 'first', expiresAt: '2099-01-01' }))
  expect(await submitting).toBe(true)
  expect(request.mock.calls[1][0]).toBe('/api/games/last-engineer/scores')
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ runToken: 'first', name: 'Jeremy', score: 100, wave: 3, kills: 12, headshots: 4, duration: 19.5 })
  expect(await client.submit('Jeremy')).toBe(false)
  expect(request).toHaveBeenCalledTimes(2)
})

it('ignores a late token from the previous run', async () => {
  const old = deferred(), current = deferred()
  const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue(ok(accepted('New', 200)))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  const oldSubmit = client.submit('Old')
  client.begin(); client.finish({ ...summary(), score: 200 })
  old.resolve(ok({ runToken: 'old' }))
  expect(await oldSubmit).toBe(false)
  current.resolve(ok({ runToken: 'new' }))
  expect(await client.submit('New')).toBe(true)
  expect(JSON.parse(request.mock.calls[2][1].body)).toMatchObject({ runToken: 'new', score: 200, name: 'New' })
})

it('keeps a new run untouched by the previous submission response', async () => {
  const submission = deferred()
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'old' })).mockReturnValueOnce(submission.promise).mockResolvedValue(ok({ runToken: 'new' }))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  const pending = client.submit('Old')
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  client.begin()
  submission.resolve(ok(accepted()))
  expect(await pending).toBe(false)
  expect(client.state().status).toBe('hidden')
})

it('retries token and submission failures without inventing success or issuing a second token for an existing run', async () => {
  const request = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(ok({ runToken: 'retry' })).mockResolvedValueOnce(rejected(503)).mockResolvedValueOnce(ok(accepted()))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  await vi.waitFor(() => expect(client.state().message).toContain('connection unavailable'))
  expect(await client.submit('Jeremy')).toBe(false)
  expect(client.state().status).toBe('ready')
  expect(client.state().message).toContain('Could not confirm')
  expect(await client.submit('Jeremy')).toBe(true)
  expect(request.mock.calls.filter(([url]) => url.endsWith('/runs'))).toHaveLength(2)
  const sends = request.mock.calls.filter(([url]) => url.endsWith('/scores')).map(([,r])=>JSON.parse(r.body))
  expect(sends[0]).toEqual(sends[1])
})

it('rejects empty or excessive names and preserves an existing result on duplicate death', async () => {
  const request = vi.fn().mockResolvedValue(ok({ runToken: 'token' }))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary()); client.finish({ ...summary(), score: 9999 })
  expect(await client.submit('   ')).toBe(false)
  expect(await client.submit('A'.repeat(25))).toBe(false)
  expect(client.state().summary.score).toBe(100)
  expect(request).toHaveBeenCalledTimes(1)
})

it.each([404, 409, 410])('closes a run rejected with HTTP %s instead of endlessly retrying', async status => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockResolvedValue(rejected(status))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit('Jeremy')).toBe(false)
  expect(client.state().status).toBe('terminal')
  expect(client.state().message).toContain('Start a new run')
  expect(await client.submit('Jeremy')).toBe(false)
  expect(request).toHaveBeenCalledTimes(2)
})

it('locks the first attempted name after an ambiguous network failure and retries byte-identical payload', async () => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockRejectedValueOnce(Error('connection lost after save')).mockResolvedValue(ok(accepted()))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit(' Jeremy ')).toBe(false)
  expect(client.state().nameLocked).toBe(true)
  expect(await client.submit('Different')).toBe(false)
  expect(request).toHaveBeenCalledTimes(2)
  expect(await client.submit('Jeremy')).toBe(true)
  expect(request.mock.calls[1][1].body).toBe(request.mock.calls[2][1].body)
})

it('allows name correction after known validation failure', async () => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockResolvedValueOnce(rejected(400)).mockResolvedValue(ok(accepted('Corrected')))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit('Wrong')).toBe(false)
  expect(client.state().nameLocked).toBe(false)
  expect(await client.submit('Corrected')).toBe(true)
})

it('reports a useful wait on rate limiting and accepts only explicit valid confirmation', async () => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockResolvedValueOnce(rejected(429, '30')).mockResolvedValueOnce(ok({ id: 1 })).mockResolvedValueOnce(ok({ accepted: true, score: { ...accepted().score, score: 9999 } })).mockResolvedValueOnce(ok(accepted()))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit('Jeremy')).toBe(false)
  expect(client.state().message).toContain('Wait 30 seconds')
  expect(await client.submit('Jeremy')).toBe(false)
  expect(client.state().status).toBe('ready')
  expect(await client.submit('Jeremy')).toBe(false)
  expect(await client.submit('Jeremy')).toBe(true)
})


it.each([
  ['Alice  Smith', 'Alice Smith'],
  ['Ａlice', 'Alice'],
  ['  Alice\u00a0\u00a0Smith  ', 'Alice Smith'],
])('confirms the arcade canonical name for %s', async (rawName, canonicalName) => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockResolvedValue(ok(accepted(canonicalName)))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit(rawName)).toBe(true)
  expect(client.state().status).toBe('submitted')
  expect(JSON.parse(request.mock.calls[1][1].body).name).toBe(canonicalName)
})

it('retries a canonical name with the identical payload after an ambiguous save', async () => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockRejectedValueOnce(Error('response lost')).mockResolvedValue(ok(accepted('Alice Smith')))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit('Ａlice  Smith')).toBe(false)
  expect(await client.submit('Alice Smith')).toBe(true)
  expect(request.mock.calls[1][1].body).toBe(request.mock.calls[2][1].body)
})

it('does not confirm a score belonging to a different name', async () => {
  const request = vi.fn().mockResolvedValueOnce(ok({ runToken: 'token' })).mockResolvedValue(ok(accepted('Bob')))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit('Ａlice')).toBe(false)
  expect(client.state()).toMatchObject({ status: 'ready', nameLocked: true })
  expect(client.state().message).toContain('Could not confirm')
})

it('validates the canonical name length before sending a score', async () => {
  const request = vi.fn().mockResolvedValue(ok({ runToken: 'token' }))
  const client = createScoreClient({ request })
  client.begin(); client.finish(summary())
  expect(await client.submit('ﬃ'.repeat(9))).toBe(false)
  expect(client.state().nameLocked).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
})
