import { afterEach, expect, it, vi } from 'vitest'
import { Input, NEUTRAL } from '../src/core/input.js'
afterEach(() => vi.unstubAllGlobals())
function rig() {
  const doc = new EventTarget(), win = new EventTarget(), canvas = new EventTarget()
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  const input = new Input(canvas)
  const emit = (target, type, props = {}) => {
    const e = new Event(type)
    for (const [key, value] of Object.entries(props)) Object.defineProperty(e, key, { value })
    target.dispatchEvent(e)
  }
  const lock = () => { doc.pointerLockElement = canvas; emit(doc, 'pointerlockchange') }
  const held = () => { emit(doc, 'keydown', { code:'KeyW' }); emit(doc, 'mousedown', { button:0 }); emit(doc, 'wheel', { deltaY:1 }); emit(doc, 'mousemove', { movementX:3, movementY:4 }) }
  return { doc, win, canvas, input, emit, lock, held }
}
it('clears held controls on blur and does not revive them after relock', () => {
  const r = rig(); r.lock(); r.held(); r.emit(r.win,'blur')
  expect(r.input.sample()).toEqual(NEUTRAL)
  r.lock(); expect(r.input.sample()).toEqual(NEUTRAL)
})
it('clears held controls on pointer unlock and document hiding', () => {
  const r = rig(); r.lock(); r.held(); r.doc.pointerLockElement = null; r.emit(r.doc,'pointerlockchange')
  expect(r.input.sample()).toEqual(NEUTRAL)
  r.lock(); r.held(); r.doc.hidden = true; r.emit(r.doc,'visibilitychange')
  expect(r.input.sample()).toEqual(NEUTRAL)
})
it('does not turn unlocked page interactions into gameplay commands', () => {
  const r = rig(); r.held(); expect(r.input.sample()).toEqual(NEUTRAL)
  r.lock(); expect(r.input.sample()).toEqual(NEUTRAL)
  r.held(); expect(r.input.sample()).toMatchObject({forward:1,fire:true,wheel:1,yaw:3,pitch:4})
})
it('keeps an explicit scripted driver working without pointer lock', () => {
  const r = rig(); r.input.drive(() => ({...NEUTRAL, forward:1}))
  expect(r.input.sample().forward).toBe(1)
})
