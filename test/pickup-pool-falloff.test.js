/**
 * Pickup floor-pool glow: verifies the radial falloff fix for the hard-edged "sticker"
 * disc bug — src/world/pickups.js built the pool as a flat CircleGeometry with a
 * MeshBasicMaterial (AdditiveBlending, no map), so it rendered as a colour disc with a
 * crisp rim instead of a soft glow. Confirms the fix's texture fades alpha smoothly from
 * centre to rim, and that it is one shared instance — not rebuilt per pickup or per colour,
 * which would break the project's "never mint per-spawn GPU resources" rule.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { pickupMaterials, POOL_FALLOFF_TEXTURE } from '../src/world/pickups.js'

function alphaAt(texture, size, x, y) {
  const i = (y * size + x) * 4
  return texture.image.data[i + 3]
}

describe('pickup pool glow falloff', () => {
  it('gives the pool material a texture with a soft radial alpha falloff', () => {
    const tex = POOL_FALLOFF_TEXTURE
    expect(tex).toBeInstanceOf(THREE.DataTexture)
    const size = tex.image.width
    const centre = Math.floor(size / 2)

    const alphaCentre = alphaAt(tex, size, centre, centre)
    const alphaMid = alphaAt(tex, size, centre + Math.floor(size / 4), centre)
    const alphaRim = alphaAt(tex, size, size - 1, centre)

    // Centre is bright, the rim is fully transparent, and it falls off monotonically
    // in between -- no hard edge anywhere on the disc.
    expect(alphaCentre).toBeGreaterThan(alphaMid)
    expect(alphaMid).toBeGreaterThan(alphaRim)
    expect(alphaRim).toBe(0)
  })

  it('shares one falloff texture across every pickup colour, never minting a new one', () => {
    const a = pickupMaterials(0xff8800).pool
    const b = pickupMaterials(0x33ccff).pool
    const c = pickupMaterials(0xff8800).pool // same colour, second call

    expect(a.map).toBe(POOL_FALLOFF_TEXTURE)
    expect(b.map).toBe(POOL_FALLOFF_TEXTURE) // same texture object across colours
    expect(a).toBe(c) // pickupMaterials() itself still caches per colour
  })
})
