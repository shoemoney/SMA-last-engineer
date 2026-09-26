import './support/game-dom-shim.js'
import { it, expect, vi } from 'vitest'
import * as THREE from 'three/webgpu'
import { Game } from '../src/game/game.js'

it('advances audio once after simulation and listener updates in menu, fight and game over', () => {
  const sound = { update: vi.fn(), setListener: vi.fn() }
  const renderer = {
    domElement: { width: 640, height: 360, addEventListener() {}, removeEventListener() {} },
    getSize: () => ({ width: 640, height: 360 }),
    getPixelRatio: () => 1,
    setSize() {}, setPixelRatio() {}, render() {},
  }
  const game = new Game({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(70, 16 / 9, 1, 10000), sound })
  const simulation = vi.spyOn(game.gameState, 'update')
  try {
    for (const state of ['menu', 'fight', 'gameOver']) {
      if (state === 'fight') game.startRun()
      else game.gameState.setState(state)
      sound.update.mockClear()
      sound.setListener.mockClear()
      simulation.mockClear()
      game.update(1 / 60)
      expect(sound.update).toHaveBeenCalledExactlyOnceWith(1 / 60)
      expect(simulation.mock.invocationCallOrder[0]).toBeLessThan(sound.update.mock.invocationCallOrder[0])
      expect(sound.setListener.mock.invocationCallOrder[0]).toBeLessThan(sound.update.mock.invocationCallOrder[0])
    }
  } finally {
    game.dispose()
  }
})
