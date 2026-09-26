import './support/game-dom-shim.js'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Game } from '../src/game/game.js'
import { Projectile } from '../src/entities/projectile.js'
import { HealthPool } from '../src/game/health.js'
let game
beforeAll(() => {
  const renderer = { domElement: { width: 640, height: 360, addEventListener() {}, removeEventListener() {} }, getSize: () => ({ width: 640, height: 360 }), setSize() {}, setPixelRatio() {}, getPixelRatio: () => 1, render() {}, renderAsync: async () => {} }
  game = new Game({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(70, 16 / 9, 1, 10000) })
  game.startRun()
})
afterAll(() => game.dispose())
const wave = { healthScale: 1, speedScale: 1, damageScale: 1 }
function pawn(x, y = 0) { return { position: new THREE.Vector3(x, y, 96), radius: 42, halfHeight: 96, health: new HealthPool() } }
function flight(from, target, colliders = [], seconds = 1) {
  const projectile = new Projectile()
  projectile.launch({ position: from, direction: target.position.clone().sub(from) })
  for (let n = 0; n < seconds * 60 && projectile.alive; n++) projectile.advance(1 / 60, [target], colliders)
  return projectile
}
describe('ranged cover behavior', () => {
  it('repositions around a station column and reacquires fire instead of holding forever', () => {
    const zombie = game.zombies.spawn('ranged', wave, 2350, 0, 0)
    const player = pawn(3250)
    const start = zombie.position.clone()
    let fired = 0
    const spawn = game.zombies.projectiles.spawn
    game.zombies.projectiles.spawn = () => { fired++ }
    try {
      expect(game.zombieWorld.hasLineOfSight(zombie.headPoint(new THREE.Vector3()), player.position)).toBe(false)
      for (let n = 0; n < 1800; n++) zombie.update(1 / 60, { ...game.zombieWorld, player })
      expect(zombie.position.distanceTo(start)).toBeGreaterThan(50)
      expect(fired).toBeGreaterThan(0)
    } finally { game.zombies.projectiles.spawn = spawn }
  })
  it('holds its firing range when the lane is clear', () => {
    const zombie = game.zombies.spawn('ranged', wave, 2350, -300, 0)
    const player = pawn(3250, -300)
    const start = zombie.position.clone()
    let fired = 0
    const spawn = game.zombies.projectiles.spawn
    game.zombies.projectiles.spawn = () => { fired++ }
    try {
      for (let n = 0; n < 180; n++) zombie.update(1 / 60, { ...game.zombieWorld, player })
      expect(zombie.position.distanceTo(start)).toBeLessThan(1)
      expect(fired).toBeGreaterThan(0)
    } finally { game.zombies.projectiles.spawn = spawn }
  })
  it('intercepts a real spitter attack at the station turnstile', () => {
    game.zombies.projectiles.clear()
    const zombie = game.zombies.spawn('ranged', wave, 5585, -375, 0)
    const player = pawn(5815, -375)
    expect(game.zombieWorld.hasLineOfSight(zombie.headPoint(new THREE.Vector3()), player.position)).toBe(true)
    expect(game.zombieWorld.hasLineOfSight(zombie.position, player.position)).toBe(false)
    for (let n = 0; n < 12; n++) zombie.update(1 / 60, { ...game.zombieWorld, player })
    expect(game.zombies.projectiles.live.length).toBe(1)
    for (let n = 0; n < 60; n++) game.zombies.projectiles.update(1 / 60, [player], game.colliderBoxes)
    expect(player.health.health).toBe(100)
    expect(game.zombies.projectiles.live.length).toBe(0)
  })
  it('blocks bile at a solid column and preserves open-lane damage', () => {
    const blocked = pawn(2920)
    flight(new THREE.Vector3(2680, 0, 96), blocked, game.colliderBoxes)
    expect(blocked.health.health).toBe(100)
    const open = pawn(2920, 200)
    flight(new THREE.Vector3(2680, 200, 96), open, game.colliderBoxes)
    expect(open.health.health).toBe(88)
  })
  it('hits a pawn before a wall even when one step crosses both', () => {
    const target = pawn(100)
    const wall = new THREE.Box3(new THREE.Vector3(200, 0, -100), new THREE.Vector3(220, 200, 100))
    const p = new Projectile()
    p.launch({ position: new THREE.Vector3(0, 0, 96), direction: new THREE.Vector3(1, 0, 0) })
    p.advance(0.2, [target], [wall])
    expect(target.health.health).toBe(88)
  })
  it('hits the nearest pawn rather than array order', () => {
    const near = pawn(100), far = pawn(220)
    const p = new Projectile()
    p.launch({ position: new THREE.Vector3(0, 0, 96), direction: new THREE.Vector3(1, 0, 0) })
    p.advance(0.2, [far, near])
    expect(near.health.health).toBe(88)
    expect(far.health.health).toBe(100)
  })
})
