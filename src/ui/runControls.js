import { isInteractiveTarget } from '../core/input.js'

const SPEEDS = [0.5, 1, 1.5, 2]

export function initRunControls({ document = globalThis.document, onStartWave, onResume, onPause, onSpeedChange } = {}) {
  const byId = id => document.getElementById(id)
  const panel = byId('run-controls')
  const hud = byId('run-controls-hint')
  const start = byId('btn-start-wave')
  const resume = byId('btn-resume')
  const slower = byId('btn-slower')
  const faster = byId('btn-faster')
  const status = byId('run-controls-status')
  const cleanups = []
  let current = { playing:false, paused:false, speed:1, phase:'idle', countdown:0 }
  let error = ''
  let renderedKey = ''
  const canStart = () => ['preparation', 'intermission'].includes(current.phase)
  const listen = (target, type, fn) => {
    target?.addEventListener(type, fn)
    cleanups.push(() => target?.removeEventListener(type, fn))
  }
  const changeSpeed = direction => {
    const index = Math.max(0, SPEEDS.indexOf(current.speed))
    onSpeedChange?.(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, index + direction))])
  }
  listen(start, 'click', () => { if (canStart()) onStartWave?.() })
  listen(resume, 'click', () => onResume?.())
  listen(slower, 'click', () => changeSpeed(-1))
  listen(faster, 'click', () => changeSpeed(1))
  listen(document, 'keydown', event => {
    if (!current.playing) return
    if (event.code === 'Tab' && current.paused) {
      const buttons = [start, resume, slower, faster].filter(button => !button.hidden && !button.disabled)
      const index = buttons.indexOf(document.activeElement)
      const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length
      event.preventDefault()
      buttons[next]?.focus?.()
      return
    }
    if (isInteractiveTarget(event.target) || event.repeat) return
    if (event.code === 'Escape') { event.preventDefault(); onPause?.(); return }
    if (event.code === 'KeyE' && canStart()) { event.preventDefault(); onStartWave?.() }
    if (event.code === 'BracketLeft') { event.preventDefault(); changeSpeed(-1) }
    if (event.code === 'BracketRight') { event.preventDefault(); changeSpeed(1) }
  })
  function render(state) {
    const key = [state.playing,state.paused,state.speed,state.phase,Math.ceil(state.countdown),error].join('|')
    if (key === renderedKey) return
    renderedKey = key
    const wasPaused = current.paused
    current = state
    panel.hidden = !state.playing || !state.paused
    hud.hidden = !state.playing || state.paused
    const preparing = canStart()
    const seconds = Math.max(0, Math.ceil(state.countdown))
    start.hidden = !preparing
    start.textContent = state.phase === 'preparation' ? 'START WAVE 1 · E' : 'START NEXT WAVE · E'
    byId('run-countdown').textContent = preparing ? `${state.phase === 'preparation' ? 'GET READY' : 'NEXT WAVE'} · ${seconds}s` : 'RUN PAUSED'
    byId('run-controls-title').textContent = preparing ? 'Ready when you are.' : 'Take a breath.'
    byId('run-speed').textContent = `${state.speed}×`
    slower.disabled = state.speed <= SPEEDS[0]
    faster.disabled = state.speed >= SPEEDS.at(-1)
    hud.textContent = preparing ? `${state.phase === 'preparation' ? 'PREPARE' : 'NEXT WAVE'} ${seconds}s · E START WAVE · ESC CONTROLS · ${state.speed}×` : `ESC CONTROLS · [ SLOWER · ] FASTER · ${state.speed}×`
    status.textContent = error || 'The run is paused. Resume to capture the mouse.'
    if (state.paused && !wasPaused) (preparing ? start : resume)?.focus?.({ preventScroll:true })
    if (!state.paused) error = ''
  }
  return {
    render,
    showError(message) { error = message; status.textContent = message },
    destroy() { cleanups.forEach(fn => fn()) },
  }
}
