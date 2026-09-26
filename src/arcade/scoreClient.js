const RUNS_URL = '/api/games/last-engineer/runs'
const SCORES_URL = '/api/games/last-engineer/scores'

export function createScoreClient({ request = globalThis.fetch, onChange = () => {} } = {}) {
  let generation = 0
  let run = null
  const state = () => ({ status: run?.status ?? 'hidden', message: run?.message ?? '', summary: run?.summary ?? null, nameLocked: Boolean(run?.attempt) })
  const publish = () => onChange(state())

  async function post(url, payload) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 8000)
    try {
      const response = await request(url, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: abort.signal,
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const error = new Error(typeof body?.error === 'string' ? body.error : 'Arcade request failed')
        error.status = response.status
        error.endpoint = url
        error.detail = body
        const retry = response.headers?.get?.('Retry-After')
        error.retryAfter = retry && Number.isFinite(Number(retry)) ? Math.max(1, Math.ceil(Number(retry))) : null
        throw error
      }
      return body
    } finally { clearTimeout(timer) }
  }

  function issue(current) {
    if (current.issuePromise) return current.issuePromise
    current.issuePromise = post(RUNS_URL, {}).then(result => {
      if (!result?.runToken || typeof result.runToken !== 'string') throw new Error('Missing run token')
      if (run !== current) return null
      current.token = result.runToken
      return current.token
    }).catch(error => {
      current.issueError = error
      if (run === current && current.summary && current.status !== 'submitting') {
        current.message = 'Arcade connection unavailable. Submit score to try again.'
        publish()
      }
      return null
    }).finally(() => { current.issuePromise = null })
    return current.issuePromise
  }

  return {
    state,
    begin() {
      run = { generation: ++generation, status: 'hidden', message: '', token: null, issuePromise: null, summary: null, attempt: null, issueError: null }
      issue(run)
      publish()
    },
    finish(summary) {
      if (!run || run.summary) return
      run.summary = Object.freeze({
        score: summary.score, wave: summary.waveReached,
        kills: summary.kills, headshots: summary.headshots, duration: summary.duration,
      })
      run.status = 'ready'
      run.message = 'Add your name to the arcade leaderboard, or keep playing.'
      publish()
    },
    async submit(rawName) {
      const current = run
      if (!current?.summary || current.status === 'submitting' || current.status === 'submitted' || current.status === 'terminal') return false
      const name = String(rawName ?? '').normalize('NFC').trim()
      if (current.attempt && name !== current.attempt.name) {
        current.message = 'This submission may already be saved. Retry with the original name, or start a new run.'
        publish()
        return false
      }
      if (!name || [...name].length > 24) {
        current.message = 'Enter a name between 1 and 24 characters.'
        publish()
        return false
      }
      current.status = 'submitting'
      current.message = 'Submitting your score…'
      publish()
      try {
        const token = current.token ?? await issue(current)
        if (run !== current) return false
        if (!token) throw current.issueError ?? new Error('No connection')
        current.attempt ??= Object.freeze({ runToken: token, name, ...current.summary })
        publish()
        const result = await post(SCORES_URL, current.attempt)
        const accepted = result?.score
        if (result?.accepted !== true || !Number.isSafeInteger(accepted?.id) || accepted.id <= 0 ||
            accepted.name !== current.attempt.name || accepted.score !== current.attempt.score ||
            typeof accepted.createdAt !== 'string' || !Number.isFinite(Date.parse(accepted.createdAt))) {
          throw new Error('The arcade did not confirm this score')
        }
        if (run !== current) return false
        current.status = 'submitted'
        current.message = 'Score submitted to the arcade leaderboard.'
        publish()
        return true
      } catch (error) {
        if (run !== current) return false
        current.status = 'ready'
        if (error.endpoint === SCORES_URL && [404, 409, 410].includes(error.status)) {
          current.status = 'terminal'
          current.message = 'This run can no longer be submitted. Start a new run to post another score.'
        } else if (error.status === 400) {
          current.attempt = null
          current.message = 'The arcade rejected this submission. Check your name and try again.'
        } else if (error.status === 429) {
          current.message = error.retryAfter
            ? `Too many requests. Wait ${error.retryAfter} seconds, then retry.`
            : 'Too many requests. Wait a moment, then retry.'
        } else {
          current.message = current.attempt
            ? 'Could not confirm your score. Your name is locked so retry can safely check the same submission.'
            : 'Could not submit your score. Try again, or keep playing.'
        }
        publish()
        return false
      }
    },
  }
}
