import './support/game-dom-shim.js'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Game } from '../src/game/game.js'
import { Zombie } from '../src/entities/zombie.js'
import { HealthPool } from '../src/game/health.js'

let game
let stationBoxes
beforeAll(() => {
  const renderer = { domElement: { width: 640, height: 360, addEventListener() {}, removeEventListener() {} }, getSize: () => ({ width: 640, height: 360 }), setSize() {}, setPixelRatio() {}, getPixelRatio: () => 1, render() {}, renderAsync: async () => {} }
  game = new Game({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(70, 16 / 9, 1, 10000) })
  game.startRun()
  stationBoxes = game.colliderBoxes
})
afterAll(() => game.dispose())

function encounter(type, x, gap) {
  const zombie = new Zombie(null)
  zombie.configureForWave(type, { healthScale: 1, speedScale: 1, damageScale: 1 })
  zombie.position.set(x - gap, 0, zombie.halfHeight)
  const player = { position: new THREE.Vector3(x + gap, 0, 96), health: new HealthPool({ maxHealth: 1000, health: 1000 }) }
  return { zombie, player, world: { ...game.zombieWorld, player } }
}
function advance(zombie, world, frames = 60) {
  for (let frame = 0; frame < frames; frame++) zombie.update(1 / 60, world)
}

describe('solid geometry blocks melee contact', () => {
  for (const type of ['tank', 'boss']) {
    it(`${type} cannot damage through the real station column`, () => {
      game.colliderBoxes = stationBoxes
      const sample = new Zombie(null)
      sample.configureForWave(type, { healthScale: 1, speedScale: 1, damageScale: 1 })
      const { zombie, player, world } = encounter(type, 2800, 45 + Math.max(sample.radius, 42) + 1)
      expect(world.hasLineOfSight(zombie.position, player.position)).toBe(false)
      advance(zombie, world, 10)
      expect(world.hasLineOfSight(zombie.position, player.position)).toBe(false)
      expect(player.health.health).toBe(1000)
    })
  }
  for (const type of ['base', 'zerg', 'tank', 'boss']) {
    it(`${type} hits in open space but cannot finish a telegraphed hit through a wall`, () => {
      game.colliderBoxes = [new THREE.Box3(new THREE.Vector3(2795, 0, -200), new THREE.Vector3(2805, 450, 200))]
      const { zombie, player, world } = encounter(type, 2800, 48)
      zombie.position.x = 2800 - zombie.radius - 6
      player.position.x = zombie.position.x - zombie.radius - 43
      advance(zombie, world, 12)
      expect(player.health.health).toBeLessThan(1000)
      while (zombie.timeUntilNextAttack > 0.1) advance(zombie, world, 1)
      expect(zombie.attackT).toBeLessThan(1)
      const healthBeforeCover = player.health.health
      player.position.x = 2848
      expect(world.hasLineOfSight(zombie.position, player.position)).toBe(false)
      advance(zombie, world, 12)
      expect(player.health.health).toBe(healthBeforeCover)
      game.colliderBoxes = []
      advance(zombie, world, 1)
      expect(player.health.health).toBeLessThan(healthBeforeCover)
    })
  }
})
