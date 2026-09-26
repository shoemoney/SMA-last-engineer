/**
 * The character key vs. the scene-wide light budget.
 *
 * game.js applies optimize.js's limitLights() LAST, after every module has added its own
 * lights, with tier budgets of 8/20/30 costly lights (low/medium/high — see game.js:908).
 * limitLights() sorts every light that is not FREE (ambient/hemisphere) or RESERVED
 * (reserveFromLightBudget()) by intensity and drops whatever falls outside the budget.
 *
 * src/weapons/viewmodel.js already hit this once: its three camera-rigged lights measured
 * 260-2150 cd against the station's 122,880-1,594,320 cd spots, so an unreserved viewmodel
 * rig sorted permanently last and the player's own gun rendered unlit. The fix there was
 * reserveFromLightBudget(), not a brighter light. RIG.characterKey in lighting.js is the same
 * class of fixture — camera-space, stated as irradiance (1.4) rather than candela, nothing
 * close to a station spot — and it was never sent through that same reservation call.
 *
 * That makes it just another COSTLY light in the sort, and because it is the dimmest light in
 * the entire rig by a wide margin, it loses the sort at every tier and gets dropped. It is not
 * almost lost — it never survives. This test builds the real rig at each tier, runs the real
 * scene-wide cull, and checks both halves of the contract: the costly bucket stays inside its
 * budget (the budget itself is not moved), and the character key survives regardless.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { createStationMaterials } from '../src/world/materials.js'
import { createLighting } from '../src/world/lighting.js'
import { limitLights } from '../src/world/optimize.js'

// Mirrors game.js:908 exactly — the test must fail the moment that contract drifts too.
const TIER_BUDGETS = { low: 8, medium: 20, high: 30 }

/** Builds the real rig, with a camera present so the character key actually mounts
 *  (it parents to the first camera it finds in the scene — see lighting.js mountCharacterKey). */
function buildCulledScene(tier, budget) {
  globalThis.__SHOE_QUALITY__ = tier
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  scene.add(camera)

  const materials = createStationMaterials()
  const lighting = createLighting(scene, materials)
  expect(lighting.characterKey.parent).toBe(camera) // sanity: the mount itself must have worked

  limitLights(scene, budget)

  const survivors = []
  scene.traverse((node) => { if (node.isLight && node.visible) survivors.push(node) })
  const free = survivors.filter((l) => l.isAmbientLight || l.isHemisphereLight)
  const costly = survivors.filter(
    (l) => !l.isAmbientLight && !l.isHemisphereLight && !l.userData?.excludeFromLightBudget,
  )
  return { lighting, survivors, free, costly }
}

describe('lighting.js characterKey vs. the scene-wide light budget (optimize.js limitLights)', () => {
  for (const [tier, budget] of Object.entries(TIER_BUDGETS)) {
    it(`${tier} tier (budget ${budget}): costly lights stay in budget AND the character key survives`, () => {
      const { lighting, survivors, costly } = buildCulledScene(tier, budget)

      // The budget itself is the contract — never raised to make a count fit.
      expect(costly.length).toBeLessThanOrEqual(budget)

      // The actual defect: an unreserved character key is the dimmest light in the rig by a
      // huge margin (1.4 irradiance vs. 122,880+ cd station spots), so it always loses the
      // intensity sort and is dropped — it must instead survive unconditionally, exactly like
      // the viewmodel's reserved rig.
      expect(survivors).toContain(lighting.characterKey)
      expect(lighting.characterKey.visible).toBe(true)
      expect(lighting.characterKey.intensity).toBeGreaterThan(0)
    })
  }
})
