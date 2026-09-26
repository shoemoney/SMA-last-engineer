import { createScoreClient } from '../arcade/scoreClient.js'

const NAME_KEY = 'last-engineer.arcade.name.v1'

export function initArcadeScore({ document = globalThis.document } = {}) {
  const form = document.getElementById('arcade-score-form')
  const input = document.getElementById('arcade-score-name')
  const submit = document.getElementById('arcade-score-submit')
  const status = document.getElementById('arcade-score-status')
  const boardStatus = document.getElementById('arcade-leaderboard-status')
  const list = document.getElementById('arcade-leaderboard-list')
  const retry = document.getElementById('arcade-leaderboard-retry')
  const channel = typeof globalThis.BroadcastChannel === 'function' ? new BroadcastChannel('shoemoney-arcade-scores') : null
  try { if (input) input.value = globalThis.localStorage?.getItem(NAME_KEY) ?? '' } catch {}
  const client = createScoreClient({ onChange(state) {
    if (form) form.hidden = !['ready','submitting','submitted'].includes(state.status)
    const busy = state.status !== 'ready'
    if (input) input.disabled = busy || state.nameLocked
    if (submit) { submit.disabled = busy; submit.textContent = state.status === 'submitted' ? 'SCORE SUBMITTED' : state.status === 'submitting' ? 'SUBMITTING…' : 'SUBMIT SCORE' }
    if (status) status.textContent = state.message
    if (boardStatus) boardStatus.textContent = state.status !== 'hidden' ? state.message : state.boardStatus === 'error' ? 'Leaderboard unavailable.' : state.boardStatus === 'loading' ? 'Loading the top ten…' : state.scores.length ? 'Current top ten' : 'No ranked runs yet. Complete a wave to qualify.'
    if (retry) retry.hidden = state.status !== 'qualification-error' && state.boardStatus !== 'error'
    if (list) {
      list.replaceChildren()
      for (const row of state.scores.slice(0,10)) {
        const item = document.createElement('li')
        item.textContent = `${row.name} · ${new Intl.NumberFormat().format(row.score)}`
        list.appendChild(item)
      }
    }
  } })
  form?.addEventListener('submit', async event => {
    event.preventDefault()
    const name = input.value.trim()
    if (await client.submit(name)) {
      try { globalThis.localStorage?.setItem(NAME_KEY, name) } catch {}
      channel?.postMessage({game:'last-engineer',scoreVersion:2})
    }
  })
  const refresh = () => { if (document.visibilityState !== 'hidden') client.refreshBoard() }
  const received = event => { if (event.data?.game === 'last-engineer' && event.data.scoreVersion === 2) refresh() }
  const retryCheck = () => client.state().status === 'qualification-error' ? client.qualify() : client.refreshBoard()
  retry?.addEventListener('click', retryCheck)
  globalThis.addEventListener?.('focus',refresh)
  document.addEventListener('visibilitychange',refresh)
  channel?.addEventListener('message',received)
  return Object.assign(client,{dispose() {
    globalThis.removeEventListener?.('focus',refresh)
    document.removeEventListener('visibilitychange',refresh)
    retry?.removeEventListener('click',retryCheck)
    channel?.close()
  }})
}
