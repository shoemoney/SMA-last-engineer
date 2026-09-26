/**
 * Two correctness/perf bugs in the blood/shard impact pool (src/fx/impacts.js):
 *
 * 1. Each shard pool's InstancedMesh submitted its full capacity every frame
 *    regardless of how many instances were actually live — including at idle,
 *    with nothing ever shot. mesh.count must track the live instance count.
 *
 * 2. burst() clamps the requested shard count against the global `liveShards`
 *    budget BEFORE takeBurst() runs, so when the burst ring is full, the
 *    eviction that takeBurst() performs (freeing shard slots from the oldest
 *    burst) happens too late to be counted — a hit lands with zero shards.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { createImpactFX, createLightRing } from '../src/fx/impacts.js'
import { FX } from '../src/game/rules.js'
import { Rng } from '../src/core/rng.js'

function makeHarness() {
  const scene = new THREE.Scene()
  const lights = createLightRing({ scene, size: 8 })
  const impactFX = createImpactFX({ scene, lights, rng: new Rng(1) })
  return { scene, impactFX }
}

const POINT = new THREE.Vector3(0, 0, 0)
const NORMAL = new THREE.Vector3(0, 1, 0)

describe('flesh hits produce visible blood through the real spawn path', () => {
  it('spawns varied round beads at the hit without changing beads from earlier hits', () => {
    const { scene, impactFX } = makeHarness()
    const point = new THREE.Vector3(120, 180, -240)
    impactFX.burst(point, NORMAL, { surface: 'flesh' })
    impactFX.update(0)

    const blood = scene.getObjectByName('fx:shards:blood')
    expect(blood.count).toBe(FX.IMPACT.shardCountBloody)
    expect(scene.getObjectByName('fx:shards:spark').count).toBe(0)
    expect(scene.getObjectByName('fx:shards:dust').count).toBe(0)
    expect(blood.geometry.type).toBe('SphereGeometry')
    expect(blood.geometry.parameters.radius).toBe(FX.IMPACT.referenceCubeSize / 2)

    const matrices = []
    const scales = []
    for (let i = 0; i < blood.count; i++) {
      const matrix = new THREE.Matrix4()
      blood.getMatrixAt(i, matrix)
      const position = new THREE.Vector3()
      const scale = new THREE.Vector3()
      matrix.decompose(position, new THREE.Quaternion(), scale)
      expect(position.distanceTo(point)).toBeLessThan(1e-5)
      for (const axis of scale.toArray()) {
        expect(Number.isFinite(axis)).toBe(true)
        expect(axis).toBeGreaterThanOrEqual(FX.IMPACT.bloodScaleMin * FX.IMPACT.bloodStretchMin - 1e-7)
        expect(axis).toBeLessThanOrEqual(FX.IMPACT.bloodScaleMax * FX.IMPACT.bloodStretchMax + 1e-7)
      }
      matrices.push(matrix)
      scales.push(scale.toArray())
    }
    expect(scales.some(s => Math.max(...s) - Math.min(...s) > 1e-5)).toBe(true)
    const ratios = scales.map(s => (s[0] / s[1]).toFixed(5))
    expect(new Set(ratios).size).toBeGreaterThan(1)

    impactFX.burst(new THREE.Vector3(-90, 50, 40), NORMAL, { bloody: true })
    impactFX.update(0)
    expect(blood.count).toBe(FX.IMPACT.shardCountBloody * 2)
    for (let i = 0; i < matrices.length; i++) {
      const current = new THREE.Matrix4()
      blood.getMatrixAt(i, current)
      expect(current.elements).toEqual(matrices[i].elements)
    }
    impactFX.dispose()
  })
})

describe('impact shard pools submit only live instances (finding #1)', () => {
  it('submits zero instances per pool on an idle scene', () => {
    const { scene, impactFX } = makeHarness()
    impactFX.update(0) // first-frame flush, nothing has been shot

    const blood = scene.getObjectByName('fx:shards:blood')
    const spark = scene.getObjectByName('fx:shards:spark')
    const dust = scene.getObjectByName('fx:shards:dust')

    expect(blood.count).toBe(0)
    expect(spark.count).toBe(0)
    expect(dust.count).toBe(0)
  })

  it('tracks mesh.count to the live shard count, not the full 240-instance capacity', () => {
    const { scene, impactFX } = makeHarness()
    impactFX.burst(POINT, NORMAL, { bloody: true }) // FX.IMPACT.shardCountBloody = 8
    impactFX.update(0)

    const blood = scene.getObjectByName('fx:shards:blood')
    expect(blood.count).toBe(FX.IMPACT.shardCountBloody)
    expect(blood.count).toBeLessThan(FX.BUDGET.maxShardsTotal)
  })

  it('drops mesh.count back to zero once every shard in the pool has died', () => {
    const { scene, impactFX } = makeHarness()
    impactFX.burst(POINT, NORMAL, { bloody: true })
    impactFX.update(0)
    const blood = scene.getObjectByName('fx:shards:blood')
    expect(blood.count).toBeGreaterThan(0)

    impactFX.update(FX.IMPACT.lifeSeconds + 0.1) // outlive every shard in the one burst
    expect(blood.count).toBe(0)
  })
})

describe('a full burst ring still renders shards on the next hit (finding #4)', () => {
  it('recovers to the shard cap after evicting the oldest burst to make room', () => {
    const { impactFX } = makeHarness()

    // BUDGET.maxImpactBursts (24) * IMPACT.shardCountHeadshot (10) == BUDGET.maxShardsTotal
    // (240): saturating the burst ring with headshots also exactly saturates the shard
    // budget, which is the scenario the latent bug needs to fire.
    expect(FX.BUDGET.maxImpactBursts * FX.IMPACT.shardCountHeadshot).toBe(FX.BUDGET.maxShardsTotal)

    for (let i = 0; i < FX.BUDGET.maxImpactBursts; i++) {
      impactFX.burst(POINT, NORMAL, { bloody: true, headshot: true })
    }
    expect(impactFX.burstCount).toBe(FX.BUDGET.maxImpactBursts)
    expect(impactFX.shardCount).toBe(FX.BUDGET.maxShardsTotal)

    // The ring is full AND the shard budget is maxed. This next hit must evict the
    // oldest burst (freeing 10 shard slots) and then actually use them — a player who
    // fires into a saturated crowd still needs to see the hit they just landed.
    impactFX.burst(POINT, NORMAL, { bloody: true, headshot: true })

    expect(impactFX.burstCount).toBe(FX.BUDGET.maxImpactBursts) // ring stays full, one swapped
    expect(impactFX.shardCount).toBe(FX.BUDGET.maxShardsTotal) // budget refilled, not drained
  })
})
