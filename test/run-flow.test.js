import './support/game-dom-shim.js'
import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Game } from '../src/game/game.js'
import { GameState } from '../src/game/gameState.js'
import { EventBus, EV } from '../src/core/events.js'
import { WaveDirector } from '../src/game/waveDirector.js'
import { runScore } from '../src/game/runScore.js'
import { PickupManager, pickupPoints } from '../src/world/pickups.js'
import { Rng } from '../src/core/rng.js'

describe('preparation and wave breaks', () => {
  it('waits30real seconds without spawning, then starts exactly once', () => {
    const bus = new EventBus(), starts = []
    bus.on(EV.WAVE_START, p => starts.push(p.wave))
    const d = new WaveDirector({ bus })
    d.prepare()
    d.update(58, 29)
    expect(d.state).toBe('preparation')
    expect(d.countdownRemaining).toBe(1)
    expect(d.zombiesAlive).toBe(0)
    d.update(2, 1)
    expect(starts).toEqual([1])
    expect(d.startNextWave()).toBe(false)
  })

  it('allows early preparation and ten-second break skips without duplicate starts', () => {
    const bus = new EventBus(), starts = []
    bus.on(EV.WAVE_START, p => starts.push(p.wave))
    const d = new WaveDirector({ bus })
    d.prepare()
    expect(d.startNextWave()).toBe(true)
    expect(d.startNextWave()).toBe(false)
    d.endWave()
    expect(d.countdownRemaining).toBe(10)
    d.update(4.5, 9)
    expect(starts).toEqual([1])
    expect(d.startNextWave()).toBe(true)
    d.update(.5, 1)
    expect(starts).toEqual([1, 2])
    d.endWave()
    d.update(20, 10)
    expect(starts).toEqual([1, 2, 3])
  })
})

describe('wave and time ranking', () => {
  it('counts completed waves once and only simulated combat time', () => {
    const bus = new EventBus(), state = new GameState({ bus })
    state.startRun()
    state.update(20, 10)
    expect(state.combatSeconds).toBe(0)
    state.director.startNextWave()
    state.update(1, 1)
    expect(state.combatSeconds).toBe(0)
    state.director.state = 'fighting'
    state.update(12, 6)
    bus.emit(EV.WAVE_CLEAR, { wave: 1 })
    bus.emit(EV.WAVE_CLEAR, { wave: 1 })
    state.director.beginIntermission()
    state.update(4, 8)
    expect(state.completedWaves).toBe(1)
    expect(state.combatSeconds).toBe(12)
    const result = state.playerDied()
    expect(result.score).toBe(10500)
    expect(result.duration).toBe(25)
    expect(result.scoringVersion).toBe(2)
    state.dispose()
  })

  it('gives waves precedence and faster clears a bounded bonus', () => {
    expect(runScore(1, 19.999999999999506)).toBe(runScore(1, 20.000000000000146))
    expect(runScore(0, 0)).toBe(0)
    expect(runScore(3, 145.25)).toBe(30123)
    expect(runScore(1, 10)).toBeGreaterThan(runScore(1, 20))
    expect(runScore(2, 1e6)).toBeGreaterThan(runScore(1, 0))
  })

  it('pauses the actual game and keeps prep real-time at every speed', () => {
    const renderer = { domElement: { width:640,height:360 }, getPixelRatio:()=>1, getSize:()=>({width:640,height:360}) }
    const game = new Game({ renderer, scene:new THREE.Scene(), camera:new THREE.PerspectiveCamera() })
    try {
      for (const speed of [.5,1,1.5,2]) {
        game.startRun()
        game.setSpeed(speed)
        game.setPaused(true)
        game.tick(2)
        expect(game.gameState.elapsed).toBe(0)
        expect(game.gameState.director.countdownRemaining).toBe(30)
        game.setPaused(false)
        game.tick(2)
        expect(game.gameState.elapsed).toBeCloseTo(2)
        expect(game.gameState.director.countdownRemaining).toBe(28)
        expect(game.gameState.combatSeconds).toBe(0)
      }
      expect(game.setSpeed(100)).toBe(false)
    } finally { game.dispose() }
  })
})

it('keeps thirty waves of uncollected rewards bounded and preserves two supplies', () => {
  const scene = new THREE.Scene()
  const manager = new PickupManager(scene, pickupPoints(), new Rng(1), { emitEvents:false })
  manager.dealOpeningLoadout()
  const lights = manager.pointLights.length
  for (let wave=1; wave<=30; wave++) {
    manager.beginWave(wave)
    manager.dropReward(wave)
    const active = manager.pickups.filter(p=>p.active)
    expect(active.length).toBeLessThanOrEqual(manager.points.length)
    expect(new Set(active.map(p=>p.pointIndex)).size).toBe(active.length)
    expect(manager.occupied.size).toBe(active.length)
    expect(active.filter(p=>p.def.kind==='health')).toHaveLength(1)
    expect(active.filter(p=>p.def.kind==='armor')).toHaveLength(1)
    expect(manager.pointLights).toHaveLength(lights)
  }
  expect(manager.place('pistol', [...manager.occupied.keys()][0])).toBe(null)
  manager.dispose()
})
