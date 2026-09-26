import './support/game-dom-shim.js'
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { initSky } from '../src/world/sky.js'

describe('rain instancing on a 16 KiB WebGL uniform-block device', () => {
  it('keeps every UBO-backed rain batch within capacity while preserving all drops and lifecycle', () => {
    const scene = new THREE.Scene()
    const sky = initSky(scene)
    try {
      const shaft = sky.fields.filter(field => field.mesh.name.startsWith('rain-stairwell'))
      expect(shaft.reduce((sum, field) => sum + field.mesh.count, 0)).toBe(600)
      expect(sky.fields.reduce((sum, field) => sum + field.mesh.count, 0)).toBe(1700)
      for (const field of sky.fields) {
        const matrices = field.mesh.instanceMatrix.count
        // Three uses matrix uniforms through 1000, then instanced attributes above it.
        if (matrices <= 1000) expect(matrices * 64).toBeLessThanOrEqual(16384)
      }
      sky.update(1 / 60)
      const positions = shaft.map(field => Array.from(field.mesh.instanceMatrix.array.slice(12, 15)))
      expect(new Set(positions.map(value => JSON.stringify(value))).size).toBe(shaft.length)
      const versions = shaft.map(field => field.mesh.instanceMatrix.version)
      sky.update(1 / 60)
      shaft.forEach((field, index) => {
        expect(field.mesh.instanceMatrix.version).toBeGreaterThan(versions[index])
        expect(Array.from(field.mesh.instanceMatrix.array.slice(12, 15))).not.toEqual(positions[index])
      })
      sky.setIntensity(0)
      for (const field of shaft) expect(field.material.opacity).toBe(0)
      sky.setIntensity(1)
      for (const field of shaft) expect(field.material.opacity).toBeGreaterThan(0)
      let geometriesDisposed = 0, materialsDisposed = 0
      for (const field of shaft) {
        field.mesh.geometry.addEventListener('dispose', () => geometriesDisposed++)
        field.material.addEventListener('dispose', () => materialsDisposed++)
      }
      sky.dispose()
      expect(geometriesDisposed).toBe(shaft.length)
      expect(materialsDisposed).toBe(shaft.length)
      expect(scene.children).not.toContain(sky.group)
    } finally {
      if (scene.children.includes(sky.group)) sky.dispose()
    }
  })
})
