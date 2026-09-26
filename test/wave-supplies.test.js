import './support/game-dom-shim.js'
import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three/webgpu'
import { Game } from '../src/game/game.js'

let activeGame = null
afterEach(() => {
  activeGame?.dispose()
  activeGame = null
})


/** A fake WebGPURenderer: game.js's constructor never calls render(), only stores it and
 *  (at quality != 'low', which the shim disables) hands it to initPostFX. */
function makeRenderer() {
  return {
    domElement: { width: 640, height: 360, addEventListener() {}, removeEventListener() {} },
    getSize: () => ({ width: 640, height: 360 }),
    setSize() {},
    setPixelRatio() {},
    getPixelRatio: () => 1,
    render() {},
    renderAsync: async () => {},
  }
}

function makeGame() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 1, 10000)
  const game = new Game({ renderer: makeRenderer(), scene, camera })
  activeGame = game
  game.startRun()
  expect(game.summitPickups.pickups.map(p => p.def.id)).not.toContain('explosive')
  return game
}


function supplies(game) {
  return [game.pickups, game.summitPickups].filter(Boolean).flatMap(manager => manager.pickups)
    .filter(pickup => pickup.def.kind === 'health' || pickup.def.kind === 'armor')
}

describe('one random health and armor supply per wave', () => {
  it('starts with one each across both floors, never respawns or adds more mid-wave', () => {
    const game = makeGame()
    expect(supplies(game).map(p => p.def.id).sort()).toEqual(['armor', 'health'])
    const initial = supplies(game)
    expect(new Set(initial.map(p => p.pointIndex)).size).toBe(2)
    for (const pickup of initial) {
      expect(pickup.respawns).toBe(false)
      game.player.position.copy(pickup.worldPosition)
      game.player.health.health = 10
      game.player.health.armor = 0
      game.pickups.update(0.01, game.player)
      expect(pickup.active).toBe(false)
    }
    game.pickups.update(120, null)
    game.pickups.beginWave(1)
    expect(supplies(game).filter(p => p.active)).toHaveLength(0)
  })

  it('replaces uncollected supplies without accumulation and samples vacant positions each wave', () => {
    const game = makeGame()
    const positions = new Set()
    let previous = supplies(game)
    for (let wave = 2; wave <= 12; wave++) {
      game.gameState.director.startWave(wave)
      const current = supplies(game)
      expect(current.map(p => p.def.id).sort()).toEqual(['armor', 'health'])
      for (const pickup of current) {
        expect(previous).not.toContain(pickup)
        expect(game.pickups.occupied.get(pickup.pointIndex)).toBe(pickup)
        expect(game.pickups.pickups.filter(p => p.active && p.pointIndex === pickup.pointIndex)).toHaveLength(1)
        positions.add(pickup.pointIndex)
      }
      for (const old of previous) expect(old.root.parent).toBe(null)
      previous = current
    }
    expect(positions.size).toBeGreaterThan(2)
    game.startRun()
    expect(supplies(game).map(p => p.def.id).sort()).toEqual(['armor', 'health'])
  })
})
