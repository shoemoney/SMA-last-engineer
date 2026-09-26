import { afterEach, expect, it, vi } from 'vitest'
import { Input } from '../src/core/input.js'

afterEach(() => vi.unstubAllGlobals())

function harness() {
  const listeners = new Map()
  vi.stubGlobal('document', { addEventListener: (type, listener) => listeners.set(type, listener) })
  const canvas = { tagName: 'CANVAS', addEventListener() {} }
  const input = new Input(canvas)
  const key = (type, code, target) => {
    const event = { code, target, preventDefault: vi.fn() }
    listeners.get(type)(event)
    return event
  }
  return { input, canvas, key }
}

it('leaves checkbox Space to the browser and does not consume it as jump', () => {
  const { input, key } = harness()
  const event = key('keydown', 'Space', { tagName: 'INPUT', type: 'checkbox' })
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(input.sample().jump).toBe(false)
})

it.each(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'])('does not move the player while %s has focus', tagName => {
  const { input, key } = harness()
  key('keydown', 'KeyW', { tagName })
  expect(input.sample().forward).toBe(0)
})

it('leaves editable text alone and clears released game keys even after focus changes', () => {
  const { input, canvas, key } = harness()
  key('keydown', 'KeyW', canvas)
  key('keyup', 'KeyW', { tagName: 'INPUT' })
  key('keydown', 'KeyW', { tagName: 'DIV', isContentEditable: true })
  expect(input.sample().forward).toBe(0)
})

it.each(['CANVAS', 'BODY'])('keeps Space and movement controlled on %s', tagName => {
  const { input, key } = harness()
  const target = { tagName }
  expect(key('keydown', 'Space', target).preventDefault).toHaveBeenCalledOnce()
  key('keydown', 'KeyW', target)
  expect(input.sample()).toMatchObject({ jump: true, forward: 1 })
})
