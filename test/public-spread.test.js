import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { Rng } from '../src/core/rng.js'
import { randomUnitVectorInCone } from '../src/weapons/weapon.js'

describe('public spherical-cap spread', () => {
  it('returns unit directions inside the cone for arbitrary and vertical aim', () => {
    const rng = new Rng(1729)
    for (const direction of [new Vector3(3, -2, 9), new Vector3(0, 7, 0), new Vector3(0, -7, 0)]) {
      const aim = direction.clone().normalize()
      for (let i = 0; i < 1000; i++) {
        const result = randomUnitVectorInCone(direction, 0.4, rng, new Vector3())
        expect(result.length()).toBeCloseTo(1, 12)
        expect(result.dot(aim)).toBeGreaterThanOrEqual(Math.cos(0.4) - 1e-12)
      }
    }
  })

  it('returns normalized aim at zero angle without consuming randomness', () => {
    const random = { next() { throw new Error('zero angle must not sample') } }
    const out = new Vector3(0, 5, 0)
    expect(randomUnitVectorInCone(out, 0, random, out)).toBe(out)
    expect(out.toArray()).toEqual([0, 1, 0])
  })

  it('reproduces a seeded sequence and varies with the seed', () => {
    const sample = seed => {
      const rng = new Rng(seed)
      return Array.from({ length: 20 }, () => randomUnitVectorInCone(new Vector3(0, 0, -1), 0.2, rng, new Vector3()).toArray())
    }
    expect(sample(42)).toEqual(sample(42))
    expect(sample(42)).not.toEqual(sample(43))
  })

  it('samples evenly in cosine and azimuth rather than bunching toward the axis', () => {
    const rng = new Rng(314159)
    const out = new Vector3()
    const aim = new Vector3(0, 0, -1)
    const halfAngle = 0.6
    const edgeCos = Math.cos(halfAngle)
    let radialMean = 0, x = 0, y = 0
    const count = 10000
    for (let i = 0; i < count; i++) {
      randomUnitVectorInCone(aim, halfAngle, rng, out)
      radialMean += (1 - out.dot(aim)) / (1 - edgeCos)
      x += out.x
      y += out.y
    }
    expect(radialMean / count).toBeGreaterThan(0.48)
    expect(radialMean / count).toBeLessThan(0.52)
    expect(Math.abs(x / count)).toBeLessThan(0.01)
    expect(Math.abs(y / count)).toBeLessThan(0.01)
  })
})
