/**
 * Pins two HUD defects against the REAL src/ui/hud.js, driven by the REAL EventBus.
 *
 * hud.js binds to `document` and to the ids/classes index.html + styles.css already
 * carry (see the file's own header comment), and this suite runs in vitest's `node`
 * environment (see vitest.config.js) — there is no jsdom dependency in this repo. So this
 * file brings the smallest DOM the module actually touches: element construction,
 * id lookup, classList, inline style (both direct assignment and setProperty, both of
 * which hud.js uses), textContent, append/replaceChildren, and single-class querySelector.
 * Nothing here fakes hud.js's own logic — only the browser surface under it.
 *
 * 1) The reticle used to be one static cross for all three guns even though their cones
 *    (rules.js WEAPONS.*.baseSpread, degrees) are 5.3x apart. Pinned by reading the
 *    crosshair element's own `--spread` custom property after equipping each weapon.
 * 2) The wave-start banner had no code-driven auto-hide, only its own 2.6s CSS animation
 *    (styles.css .hud__banner.show) — so it was still fading while the wave's own first
 *    zombie (EV.ZOMBIE_SPAWN) was already on the platform. Pinned by asserting the banner's
 *    `show` class is gone the instant that event fires, without waiting on the animation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventBus, EV } from '../src/core/events.js'
import { FX, WEAPONS } from '../src/game/rules.js'

// ---------------------------------------------------------------------------
// The smallest fake DOM hud.js actually exercises. See file header.
// ---------------------------------------------------------------------------

function createFakeDom() {
  const registry = new Map()

  class FakeClassList {
    constructor() { this.set = new Set() }
    add(...cls) { for (const c of cls) this.set.add(c) }
    remove(...cls) { for (const c of cls) this.set.delete(c) }
    toggle(cls, force) {
      const want = force === undefined ? !this.set.has(cls) : !!force
      if (want) this.set.add(cls); else this.set.delete(cls)
      return want
    }
    contains(cls) { return this.set.has(cls) }
  }

  function matchesSelector(el, sel) {
    return sel.startsWith('.') ? el.classList.contains(sel.slice(1)) : false
  }
  function findFirst(root, sel) {
    for (const c of root.children) {
      if (matchesSelector(c, sel)) return c
      const nested = findFirst(c, sel)
      if (nested) return nested
    }
    return null
  }
  function findAll(root, sel, out = []) {
    for (const c of root.children) {
      if (matchesSelector(c, sel)) out.push(c)
      findAll(c, sel, out)
    }
    return out
  }

  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName
      this._id = ''
      this.children = []
      this.parentElement = null
      this.classList = new FakeClassList()
      this.style = {
        setProperty: (k, v) => { this.style[k] = v },
        getPropertyValue: (k) => (k in this.style ? this.style[k] : ''),
        removeProperty: (k) => { delete this.style[k] },
      }
      this.dataset = {}
      this._text = ''
      this.hidden = false
      this.offsetWidth = 0
    }
    get id() { return this._id }
    set id(v) {
      if (this._id) registry.delete(this._id)
      this._id = v
      if (v) registry.set(v, this)
    }
    get className() { return [...this.classList.set].join(' ') }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)) }
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text
    }
    set textContent(v) {
      for (const c of this.children) c.parentElement = null
      this.children = []
      this._text = v ?? ''
    }
    append(...nodes) {
      for (const n of nodes) { if (n) { n.parentElement = this; this.children.push(n) } }
    }
    appendChild(n) { this.append(n); return n }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parentElement = null
      this.children = []
      this.append(...nodes)
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this)
        this.parentElement = null
      }
    }
    addEventListener() {}
    removeEventListener() {}
    querySelector(sel) { return findFirst(this, sel) }
    querySelectorAll(sel) { return findAll(this, sel) }
  }

  const head = new FakeElement('head')
  const document = {
    head,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => registry.get(id) ?? null,
  }

  function mount(id) {
    const el = new FakeElement('div')
    el.id = id
    return el
  }

  // Every id hud.js's initHUD() looks up via byId(). All are optional-chained downstream
  // except a handful this suite doesn't exercise (health/armor bars), so a bare div for
  // each is enough.
  const ids = [
    'hud', 'vignette', 'crosshair', 'hitmarker', 'wave-readout', 'wave-num', 'wave-left',
    'score-val', 'banner', 'subtitle', 'portrait-wrap', 'portrait', 'health-fill',
    'health-num', 'armor-fill', 'armor-num', 'weapon-readout', 'weapon-name', 'ammo-mag',
    'ammo-reserve', 'mod-strip', 'damage-numbers',
  ]
  for (const id of ids) mount(id)

  return { document }
}

// ---------------------------------------------------------------------------
// Shared setup: a fresh DOM, a real EventBus, requestAnimationFrame under our control.
// ---------------------------------------------------------------------------

let rafQueue
let restoreGlobals

beforeEach(() => {
  const { document } = createFakeDom()
  rafQueue = []
  const prev = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    Image: globalThis.Image,
  }
  restoreGlobals = () => Object.assign(globalThis, prev)
  globalThis.document = document
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length }
  globalThis.cancelAnimationFrame = () => {}
  // hud.js preloads portrait <img> probes on init; this suite doesn't touch the portrait,
  // it just needs `new Image()` to exist.
  globalThis.Image = class {
    addEventListener() {}
    set src(_v) {}
  }
})

afterEach(() => restoreGlobals())

/** Pops and runs the HUD's own queued rAF callback, so its decay/repaint loop advances once. */
function tick(now) {
  const cb = rafQueue.shift()
  if (cb) cb(now)
}

async function makeHud() {
  const { initHUD } = await import('../src/ui/hud.js')
  const bus = new EventBus()
  const hud = initHUD(bus)
  const now = performance.now()
  tick(now)
  tick(now + 16)
  return { hud, bus }
}

function spreadPx() {
  const raw = document.getElementById('crosshair').style['--spread']
  return Number(String(raw).replace('px', ''))
}

// ---------------------------------------------------------------------------
// 1) The reticle must reflect the equipped weapon's real cone.
// ---------------------------------------------------------------------------

describe('crosshair reflects the equipped weapon\'s real cone', () => {
  it('opens for the wide-cone shotgun and stays tight for the narrow-cone pistol', async () => {
    const { hud } = await makeHud()

    hud.update({ weapon: { name: 'PISTOL', mag: 15, reserve: 150, dry: false } })
    tick(performance.now())
    const pistolSpread = spreadPx()

    hud.update({ weapon: { name: 'RIFLE', mag: 30, reserve: 240, dry: false } })
    tick(performance.now())
    const rifleSpread = spreadPx()

    hud.update({ weapon: { name: 'SHOTGUN', mag: 6, reserve: 48, dry: false } })
    tick(performance.now())
    const shotgunSpread = spreadPx()

    // The old code sized the reticle from a constant plus the hit-marker kick and never
    // read the weapon at all, so all three of these used to come back identical.
    expect(shotgunSpread).not.toBe(pistolSpread)
    expect(rifleSpread).not.toBe(pistolSpread)

    // Ordering must track rules.js's real cone constants: pistol 1.5deg < rifle 2.5deg <
    // shotgun 8.0deg (WEAPONS.PISTOL/RIFLE/SHOTGUN.baseSpread) — not any particular pixel
    // value, so a future rebalance of those degrees is still allowed to move the reticle.
    expect(WEAPONS.PISTOL.baseSpread).toBeLessThan(WEAPONS.RIFLE.baseSpread)
    expect(WEAPONS.RIFLE.baseSpread).toBeLessThan(WEAPONS.SHOTGUN.baseSpread)
    expect(pistolSpread).toBeLessThan(rifleSpread)
    expect(rifleSpread).toBeLessThan(shotgunSpread)

    // It doesn't just move in the right direction, it tracks the real degree gaps
    // proportionally: the shotgun-vs-pistol gap should sit at the same ratio to the
    // rifle-vs-pistol gap as the underlying cones do. This is what "changing the constant
    // moves the reticle" means in practice — the pixels are a function of rules.js's own
    // numbers, not a hardcoded snapshot of them.
    const pixelRatio = (shotgunSpread - pistolSpread) / (rifleSpread - pistolSpread)
    const degreeRatio =
      (WEAPONS.SHOTGUN.baseSpread - WEAPONS.PISTOL.baseSpread) /
      (WEAPONS.RIFLE.baseSpread - WEAPONS.PISTOL.baseSpread)
    expect(pixelRatio).toBeCloseTo(degreeRatio, 5)

    // Sanity: the ratio pins above pass trivially if every spread is 0. Guard against that.
    expect(Math.abs(shotgunSpread - pistolSpread)).toBeGreaterThan(0.01)
  })

  it('keeps the existing laser-sight and hit-marker-kick behaviour on top of the weapon term', async () => {
    const { hud } = await makeHud()

    hud.update({ weapon: { name: 'PISTOL', mag: 15, reserve: 150, dry: false } })
    tick(performance.now())
    const bare = spreadPx()

    // FX.CROSSHAIR laser numbers are real constants (gap, laserGapMultiplier); the point is
    // only that equipping the laser sight still tightens the resting reticle as before.
    hud.update({ mods: WEAPONS.MOD_BITS.laserSight })
    tick(performance.now())
    const withLaser = spreadPx()
    expect(withLaser).toBeLessThan(bare)
  })
})

// ---------------------------------------------------------------------------
// 2) The wave banner must be gone once the wave's first zombie is actually on the platform.
// ---------------------------------------------------------------------------

describe('wave banner is dismissed once the fight is actually joined', () => {
  it('takes the banner down on the wave\'s first EV.ZOMBIE_SPAWN instead of riding out its 2.6s fade', async () => {
    const { bus } = await makeHud()
    const banner = document.getElementById('banner')

    bus.emit(EV.WAVE_START, { wave: 3, zombiesAlive: 0 })
    expect(banner.classList.contains('show')).toBe(true)

    // This is the wave's own first body hitting the platform (waveDirector.js emits
    // zombiesAlive: 0 on WAVE_START, so the first EV.ZOMBIE_SPAWN after it is unambiguous),
    // i.e. the moment the fight is actually joined.
    bus.emit(EV.ZOMBIE_SPAWN, { archetype: 'base', alive: 1 })

    expect(banner.classList.contains('show')).toBe(false)
  })

  it('leaves a later banner alone — only the wave-start announce is fast-dismissed', async () => {
    const { bus } = await makeHud()
    const banner = document.getElementById('banner')

    bus.emit(EV.WAVE_START, { wave: 3, zombiesAlive: 0 })
    bus.emit(EV.ZOMBIE_SPAWN, { archetype: 'base', alive: 1 })
    expect(banner.classList.contains('show')).toBe(false)

    // A later, unrelated banner call (e.g. PLATFORM CLEAR at wave end) still shows and is
    // left for its own animation — the fast-dismiss is scoped to the wave-start announce.
    bus.emit(EV.WAVE_CLEAR)
    expect(banner.classList.contains('show')).toBe(true)
  })
})

describe('audio synchronized combat callouts', () => {
  it('shows the playback event duration and ignores end events from an interrupted award', async () => {
    const { hud, bus } = await makeHud()
    const root = document.getElementById('hud')
    const streak = root.querySelector('.streak')
    bus.emit(EV.SCORE, { reason: 'kill', points: 10, chain: 4, multiplier: 1.4 })
    expect(streak.classList.contains('show')).toBe(false)
    bus.emit(EV.COMBAT_CALLOUT, { id: 1, phase: 'start', text: 'HEADSHOT!!', seconds: 1.56, audible: true })
    expect(streak.querySelector('.streak__plate').textContent).toBe('HEADSHOT!!')
    expect(streak.style['--callout-seconds']).toBe('1.56s')
    expect(streak.classList.contains('show')).toBe(true)
    bus.emit(EV.COMBAT_CALLOUT, { id: 2, phase: 'start', text: 'RAMPAGE!!', seconds: 2.04, audible: true })
    bus.emit(EV.COMBAT_CALLOUT, { id: 1, phase: 'end' })
    expect(streak.classList.contains('show')).toBe(true)
    expect(streak.querySelector('.streak__plate').textContent).toBe('RAMPAGE!!')
    bus.emit(EV.COMBAT_CALLOUT, { id: 2, phase: 'end' })
    expect(streak.classList.contains('show')).toBe(false)
  })
})
