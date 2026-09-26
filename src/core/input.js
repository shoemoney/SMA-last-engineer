/**
 * Pointer-lock FPS input. Also exposes a scripted driver so the verification
 * harness can play the game without a human hand on the mouse.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas
    this.keys = new Set()
    this.mouseDx = 0
    this.mouseDy = 0
    this.firing = false
    this.locked = false
    this.scripted = null
    this.wheel = 0
    this.bind()
  }

  bind() {
    const d = globalThis.document
    if (!d) return
    d.addEventListener('keydown', e => {
      // Native controls own their keyboard actions, including Space toggling checkboxes.
      const target = e.target
      if (target?.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(target?.tagName)
        || target?.closest?.('button, a[href], summary')) return
      this.keys.add(e.code)
      if (e.code === 'Space') e.preventDefault()
    })
    d.addEventListener('keyup', e => this.keys.delete(e.code))
    d.addEventListener('pointerlockchange', () => {
      this.locked = d.pointerLockElement === this.canvas
    })
    d.addEventListener('mousemove', e => {
      if (!this.locked) return
      this.mouseDx += e.movementX
      this.mouseDy += e.movementY
    })
    d.addEventListener('mousedown', e => { if (e.button === 0) this.firing = true })
    d.addEventListener('mouseup', e => { if (e.button === 0) this.firing = false })
    d.addEventListener('wheel', e => { this.wheel += Math.sign(e.deltaY) }, { passive: true })
    this.canvas.addEventListener('click', () => {
      if (!this.locked && !this.scripted) {
        this.canvas.requestPointerLock?.()?.catch(error => {
          console.warn('[input] mouse look was not enabled; click to retry', error.message)
        })
      }
    })
  }

  /** Install a function that synthesizes input each tick. Used by verify/ and demos. */
  drive(fn) { this.scripted = fn }

  down(code) { return this.keys.has(code) }

  /** Consume the frame's accumulated state. */
  sample(dt, ctx) {
    if (this.scripted) return this.scripted(dt, ctx)
    const s = {
      forward: (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0),
      strafe: (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0),
      jump: this.down('Space'),
      sprint: this.down('ShiftLeft') || this.down('ShiftRight'),
      crouch: this.down('ControlLeft') || this.down('KeyC'),
      reload: this.down('KeyR'),
      fire: this.firing,
      yaw: this.mouseDx,
      pitch: this.mouseDy,
      wheel: this.wheel,
      slot: [null, 'Digit1', 'Digit2', 'Digit3'].findIndex((c, i) => i > 0 && this.down(c)),
    }
    this.mouseDx = 0
    this.mouseDy = 0
    this.wheel = 0
    return s
  }
}

export const NEUTRAL = {
  forward: 0, strafe: 0, jump: false, sprint: false, crouch: false,
  reload: false, fire: false, yaw: 0, pitch: 0, wheel: 0, slot: -1,
}
