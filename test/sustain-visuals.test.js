import { describe, expect, it } from 'vitest'
import * as THREE from 'three/webgpu'
import { PICKUPS } from '../src/game/rules.js'
import { buildSustainGeometries, createSustainVisual } from '../src/world/sustainVisuals.js'

describe('sustain pickup sculptures', () => {
  it('keeps solid heart and chestplate meshes above the platform using shared materials', () => {
    const geometry = buildSustainGeometries(25)
    const material = new THREE.MeshStandardMaterial()
    for (const kind of ['health', 'armor']) {
      const visual = createSustainVisual(kind, geometry, material)
      const box = new THREE.Box3().setFromObject(visual)
      const size = box.getSize(new THREE.Vector3())
      expect(box.min.y + 10 - PICKUPS.bobAmplitude).toBeGreaterThan(0)
      expect(size.x).toBeGreaterThan(35)
      expect(size.y).toBeGreaterThan(35)
      expect(size.z).toBeGreaterThan(10)
      visual.traverse(node => {
        if (node.isMesh) expect(node.material.emissiveIntensity).toBeLessThanOrEqual(0.4)
        expect(node.isLight).toBeFalsy()
      })
      const repeated = createSustainVisual(kind, geometry, material)
      const firstMaterials = []
      const repeatedMaterials = []
      visual.traverse(node => { if (node.isMesh) firstMaterials.push(node.material) })
      repeated.traverse(node => { if (node.isMesh) repeatedMaterials.push(node.material) })
      expect(repeatedMaterials).toEqual(firstMaterials)
      for (let i = 0; i < firstMaterials.length; i++) expect(repeatedMaterials[i]).toBe(firstMaterials[i])
      visual.rotation.y = Math.PI / 2
      visual.updateMatrixWorld(true)
      const edge = new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3())
      expect(edge.x).toBeGreaterThan(10)
    }
    expect(createSustainVisual('mod', geometry, material)).toBeNull()
    Object.values(geometry).forEach(item => item.dispose())
    material.dispose()
  })
})
