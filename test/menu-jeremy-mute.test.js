import { it, expect, vi, afterEach } from 'vitest'

const nodes = new Map()
vi.mock('../src/ui/screens.js', () => ({
  byId: id => nodes.get(id), showScreen: vi.fn(), hideScreens: vi.fn(),
  isScreenVisible: id => id === 'menu', renderStatGrid: vi.fn(), readCareer: async () => ({}),
  formatNumber: String, formatDuration: String, SCREEN_IDS: { menu: 'menu', gameover: 'gameover' },
}))
afterEach(() => { vi.unstubAllGlobals(); nodes.clear() })
it('reflects the saved mute preference, reports changes, and leaves focused checkbox keys to the browser', async () => {
  const listeners = new Map()
  vi.stubGlobal('window', { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) })
  const checkboxListeners = new Map()
  const checkbox = {
    checked: false,
    addEventListener: (type, fn) => checkboxListeners.set(type, fn),
    removeEventListener: type => checkboxListeners.delete(type),
  }
  nodes.set('mute-jeremy', checkbox)
  const { initMenu } = await import('../src/ui/menu.js')
  const onPlay = vi.fn(), onJeremyMutedChange = vi.fn()
  const menu = initMenu({ onPlay, jeremyMuted: true, onJeremyMutedChange })
  expect(checkbox.checked).toBe(true)
  const preventDefault = vi.fn()
  listeners.get('keydown')({ target: checkbox, code: 'Enter', preventDefault })
  listeners.get('keydown')({ target: checkbox, code: 'Space', preventDefault })
  expect(onPlay).not.toHaveBeenCalled()
  expect(preventDefault).not.toHaveBeenCalled()
  checkbox.checked = false
  checkboxListeners.get('change')()
  expect(onJeremyMutedChange).toHaveBeenCalledWith(false)
  menu.destroy()
  expect(checkboxListeners.size).toBe(0)
})
