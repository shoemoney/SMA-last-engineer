/**
 * Fixed-timestep simulation with a decoupled render.
 * Gameplay always advances in STEP-sized slices, so physics and damage-over-time
 * behave identically at 30fps, 144fps, and in the headless soak where there is no
 * frame at all.
 */
export const STEP = 1 / 60
const MAX_FRAME = 0.25

export class Loop {
  constructor({ update, render }) {
    this.update = update
    this.render = render
    this.acc = 0
    this.last = 0
    this.running = false
    this.elapsed = 0
    this.frame = this.frame.bind(this)
  }

  start(now = 0) {
    this.running = true
    this.last = now
    requestAnimationFrame(this.frame)
  }

  stop() { this.running = false }

  frame(now) {
    if (!this.running) return
    const dt = Math.min(MAX_FRAME, (now - this.last) / 1000)
    this.last = now
    this.acc += dt
    while (this.acc >= STEP) {
      this.update(STEP)
      this.elapsed += STEP
      this.acc -= STEP
    }
    this.render(dt, this.acc / STEP)
    requestAnimationFrame(this.frame)
  }

  /** Headless: advance N seconds of simulation with no renderer involved. */
  runHeadless(seconds) {
    const steps = Math.round(seconds / STEP)
    for (let i = 0; i < steps; i++) {
      this.update(STEP)
      this.elapsed += STEP
    }
  }
}
