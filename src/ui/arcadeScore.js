import { createScoreClient } from '../arcade/scoreClient.js'

const NAME_KEY = 'last-engineer.arcade.name.v1'

export function initArcadeScore({ document = globalThis.document } = {}) {
  const form = document.getElementById('arcade-score-form')
  const input = document.getElementById('arcade-score-name')
  const submit = document.getElementById('arcade-score-submit')
  const status = document.getElementById('arcade-score-status')
  try { if (input) input.value = globalThis.localStorage?.getItem(NAME_KEY) ?? '' } catch {}
  const client = createScoreClient({ onChange(state) {
    if (!form) return
    form.hidden = state.status === 'hidden'
    const busyOrClosed = ['submitting', 'submitted', 'terminal'].includes(state.status)
    input.disabled = busyOrClosed || state.nameLocked
    submit.disabled = busyOrClosed
    submit.textContent = state.status === 'terminal' ? 'RUN CLOSED' : state.status === 'submitted' ? 'SCORE SUBMITTED' : state.status === 'submitting' ? 'SUBMITTING…' : 'SUBMIT SCORE'
    status.textContent = state.message
  } })
  form?.addEventListener('submit', async event => {
    event.preventDefault()
    const name = input.value.trim()
    if (await client.submit(name)) {
      try { globalThis.localStorage?.setItem(NAME_KEY, name) } catch {}
    }
  })
  return client
}
