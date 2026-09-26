/**
 * game-dom-shim.js — the minimum fake DOM that lets `new Game(...)` run in plain node.
 *
 * game.js is the file CONTRACT.md's purity rule exempts, because it is the integration
 * layer and integration needs meshes (see the header comment in src/game/game.js). Every
 * other test in this suite avoids importing it for exactly that reason. Two of the three
 * findings this file's companion test proves live ONLY inside game.js's own methods
 * (hudSnapshot's field selection, #restockSummit's pedestal logic) — there is no smaller
 * real module to import instead, the way weapons.test.js reaches for weapon.js or
 * melee-telegraph.test.js reaches for zombie.js. Proving them wrong on the REAL code, not a
 * rewritten copy of it, means constructing a real Game.
 *
 * Every consumer here only wants to bake a procedural texture onto an offscreen canvas —
 * materials.js, station.js, summit.js, train.js, sky.js, viewmodel.js, zombie.js, and the
 * fx/* modules all do this and none of it is rendered by this test, so the shim does not
 * need to draw anything correctly. It only needs to not throw, and to hand back
 * correctly-shaped objects where the caller reads a return value back (ImageData's `.data`
 * length, a gradient's `.addColorStop`, a measured text width). Two modules already carry
 * their own `typeof document === 'undefined'` guard for a headless build (zombie.js's flesh
 * texture, materials.js's logo loader) and degrade gracefully on their own; this shim exists
 * for the many more that do not guard and call `document.createElement('canvas')` outright.
 *
 * Imported for its side effect, and imported FIRST in the test file: static imports run in
 * the order they are written, so this sets `globalThis.document` before anything downstream
 * of `../src/game/game.js` is evaluated.
 */

function makeGradient() {
  return { addColorStop() {} }
}

function makeImageData(width, height) {
  return { width, height, data: new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4) }
}

/** Any unlisted 2D method becomes a no-op; the handful whose return value is actually read
 *  back (image data, gradients, measured text) get a real, correctly-shaped stand-in. */
function makeContext2D(canvas) {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'canvas') return canvas
      if (prop === 'createImageData') return (w, h) => makeImageData(w, h)
      if (prop === 'getImageData') return (_x, _y, w, h) => makeImageData(w, h)
      if (prop === 'putImageData') return () => {}
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 8 })
      if (prop === 'createLinearGradient') return () => makeGradient()
      if (prop === 'createRadialGradient') return () => makeGradient()
      if (prop === 'createPattern') return () => ({})
      if (prop === 'drawImage') return () => {}
      if (prop in target) return target[prop]
      return () => {}
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  })
}

function makeCanvasElement() {
  const canvas = { width: 0, height: 0, style: {} }
  canvas.getContext = (type) => (type === '2d' ? makeContext2D(canvas) : null)
  canvas.toDataURL = () => ''
  return canvas
}

/** A generic element for the rare `createElement('div')` — damage-numbers.js is the one
 *  caller, and it only reaches this far when a #damage-numbers host already resolved, which
 *  `getElementById` below never hands it, so this exists only so nothing throws on the way. */
function makeGenericElement() {
  return {
    style: {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }
}

globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvasElement() : makeGenericElement()),
  // materials.js's logo loader resolves a relative texture path against this, then hands it
  // to THREE.TextureLoader — which is left to fail async against a URL nothing serves. That
  // failure is caught internally (materials.js logs and resolves false); nothing here awaits it.
  createElementNS: () => ({
    addEventListener() {},
    removeEventListener() {},
    style: {},
    set src(_v) {},
    get src() { return '' },
  }),
  baseURI: 'http://localhost/',
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  body: { appendChild() {}, style: {} },
}
globalThis.window = globalThis

// Post-processing is real WebGPU render-target work this shim's fake renderer cannot honour;
// 'low' quality is the documented, load-bearing branch in the Game constructor that skips it
// entirely (see src/game/game.js's `initPostFX` call), not a workaround invented here.
globalThis.__SHOE_QUALITY__ = 'low'
