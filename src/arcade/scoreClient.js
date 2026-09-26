import { runScore as rankedScore } from '../game/runScore.js'
const RUNS_URL = '/api/games/last-engineer/runs'
const SCORES_URL = '/api/games/last-engineer/scores'
const QUALIFY_URL = '/api/games/last-engineer/qualify'

export function createScoreClient({ request = globalThis.fetch, onChange = () => {} } = {}) {
  let generation = 0
  let run = null
  const state = () => ({ status: run?.status ?? 'hidden', message: run?.message ?? '', summary: run?.summary ?? null, nameLocked: Boolean(run?.attempt), scores: run?.scores ?? [], boardStatus: run?.boardStatus ?? 'idle' })
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
    current.issuePromise = post(RUNS_URL, {scoreVersion:2}).then(result => {
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

  async function refreshBoard() {
    const current = run
    if (!current || current.boardPromise) return current?.boardPromise
    current.boardStatus = 'loading'; publish()
    current.boardPromise = (async () => {
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(),8000)
      try {
        const response = await request(`${SCORES_URL}?scoreVersion=2`, {credentials:'same-origin',signal:abort.signal})
        const body = await response.json()
        if (!response.ok || !Array.isArray(body?.scores)) throw new Error('Leaderboard unavailable')
        if (run !== current) return
        current.scores = body.scores; current.boardStatus = 'ready'
      } catch { if (run === current) current.boardStatus = 'error' }
      finally { clearTimeout(timeout); current.boardPromise = null; if (run === current) publish() }
    })()
    return current.boardPromise
  }

  async function qualify() {
    const current = run
    if (!current?.summary || current.qualifyPromise || ['submitted','submitting','terminal'].includes(current.status)) return current?.qualifyPromise
    current.status = 'qualifying'; current.message = 'Checking the top ten…'; publish()
    current.qualifyPromise = (async () => {
      try {
        const token = current.token ?? await issue(current)
        if (run !== current) return
        if (!token) throw current.issueError ?? new Error('No connection')
        const result = await post(QUALIFY_URL,{runToken:token,scoreVersion:2,...current.summary})
        if (typeof result?.qualified !== 'boolean' || result.score !== current.summary.score || result.scoreVersion !== 2) throw new Error('Invalid qualification')
        if (run !== current) return
        current.scores = result.scores ?? []; current.boardStatus = 'ready'
        current.status = result.qualified ? 'ready' : 'unqualified'
        current.message = result.qualified ? 'You made the top ten. Enter your name.' : result.reason === 'complete_wave' ? 'Complete a wave to qualify.' : 'Outside the top ten. Your next run could make it.'
      } catch (error) {
        if (run !== current) return
        current.status = [404,409,410].includes(error.status) ? 'terminal' : 'qualification-error'
        current.message = current.status === 'terminal' ? 'This run can no longer be submitted.' : 'Leaderboard check unavailable. Retry to check your place.'
      } finally { current.qualifyPromise = null; if (run === current) publish() }
    })()
    return current.qualifyPromise
  }

  return {
    state, refreshBoard, qualify,
    begin() {
      run = {generation:++generation,status:'hidden',message:'',token:null,issuePromise:null,summary:null,attempt:null,issueError:null,scores:[],boardStatus:'idle'}
      issue(run); refreshBoard(); publish()
    },
    finish(summary) {
      if (!run || run.summary) return
      run.summary = Object.freeze({score:rankedScore(summary.completedWaves,summary.combatSeconds),completedWaves:summary.completedWaves,combatSeconds:summary.combatSeconds,wave:summary.waveReached,kills:summary.kills,headshots:summary.headshots,duration:summary.duration})
      return qualify()
    },
    async submit(rawName) {
      const current = run
      if (!current?.summary || current.status !== 'ready') return false
      const name = String(rawName ?? '').normalize('NFKC').trim().replace(/ +/g,' ')
      if (current.attempt && name !== current.attempt.name) {
        current.message = 'Retry with the original name to confirm this submission.'; publish(); return false
      }
      if (!name || [...name].length > 24 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name)) {
        current.message = 'Enter a name between 1 and 24 printable characters.';publish();return false
      }
      current.status = 'submitting';current.message = 'Submitting your score…';publish()
      try {
        current.attempt ??= Object.freeze({runToken:current.token,scoreVersion:2,name})
        const result = await post(SCORES_URL,current.attempt)
        if (run !== current) return false
        if (result?.accepted === false && result.qualified === false) {
          current.status='unqualified';current.message=result.reason === 'board_changed' ? 'The board changed. This run is now outside the top ten.' : 'Complete a wave to qualify.'
          current.scores=result.scores ?? [];current.boardStatus='ready';publish();return false
        }
        const saved=result?.score
        if (result?.accepted !== true || result.scoreVersion !== 2 || !Number.isSafeInteger(saved?.id) || saved.id <= 0 || saved.name !== name || saved.score !== current.summary.score || !Number.isFinite(Date.parse(saved.createdAt))) throw new Error('Score not confirmed')
        current.status='submitted';current.message='Score submitted to the arcade leaderboard.';publish();await refreshBoard();return true
      } catch(error) {
        if (run !== current) return false
        current.status=[404,409,410].includes(error.status) ? 'terminal' : 'ready'
        if (error.status === 400) current.attempt=null
        current.message=current.status === 'terminal' ? 'This run can no longer be submitted.' : error.status === 400 ? 'Check your name and try again.' : error.status === 429 ? `Too many requests. Wait ${error.retryAfter ?? 60} seconds, then retry.` : 'Could not confirm your score. Retry with the same name.'
        publish();return false
      }
    },
  }
}
