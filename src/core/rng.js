/**
 * Deterministic RNG. The headless soak replays the same 25 waves every run,
 * so a crash is reproducible from its seed alone.
 */
export class Rng {
  constructor(seed = 0x5eed1e) {
    this.s = seed >>> 0
    if (this.s === 0) this.s = 0x9e3779b9
  }

  /** xorshift32 — fast, seedable, good enough for gameplay. */
  next() {
    let x = this.s
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.s = x
    return x / 0x100000000
  }

  range(min, max) { return min + this.next() * (max - min) }
  int(min, max) { return Math.floor(this.range(min, max + 1)) }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))] }
  chance(p) { return this.next() < p }
}

export const rng = new Rng()
