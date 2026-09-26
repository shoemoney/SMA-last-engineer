/**
 * Two integration-layer bugs, pinned against the REAL src/game/game.js — not a rewritten
 * copy of its logic, and not the pure modules underneath it. Both live in methods that
 * belong to game.js itself (hudSnapshot's field selection, #restockSummit's pedestal
 * choice), so there is no smaller module to import instead the way weapons.test.js reaches
 * for weapon.js. That means a real `new Game(...)`, which needs a renderer, a scene, a
 * camera and — three layers down, inside station.js/materials.js/train.js/sky.js/etc. — a
 * canvas to bake procedural textures onto. test/support/game-dom-shim.js supplies the
 * canvas; a bare object literal stands in for the renderer, since nothing here ever calls
 * `render()`, only `update()`. Import order matters: the shim runs first so
 * `globalThis.document` exists before anything downstream of game.js is evaluated.
 *
 * 1. hudSnapshot().zombiesRemaining published `this.zombies.aliveCount` — how many bodies
 *    are on screen right now, capped at WAVES.spawnBatchSize per release and topped back up
 *    from the queue on every kill — instead of the wave director's own remainingThisWave,
 *    which is what actually counts down to a wave clear.
 * 2. #restockSummit only ever restocked an EMPTY pedestal, and the three pedestals are only
 *    freed by a player who climbs and takes one. A player who never climbs therefore never
 *    saw a single restock in the whole run.
 *
 * Both games below run on the SHARED bus (game.js's own default), not an injected one:
 * src/entities/zombie.js imports `bus` from core/events.js directly rather than accepting
 * one through its constructor, so Zombie.die() always emits EV.ZOMBIE_DEATH on the
 * singleton. A Game built on its own private EventBus would spawn correctly (WaveDirector
 * and game.js's own subscriptions honour the injected bus) but every kill would go
 * unheard — the wave would never clear and this would not be testing the finding, it would
 * be testing a wiring mismatch. Each test disposes its Game before the next one runs, which
 * drops every one of ITS listeners off the shared bus (game.js's own `dispose()` calls
 * `gameState.dispose()` too), so the two tests below do not see each other's events.
 */
import './support/game-dom-shim.js'
import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three/webgpu'
import { Game } from '../src/game/game.js'
import { buildWave } from '../src/game/waveDirector.js'
import { WAVES, TRAIN } from '../src/game/rules.js'

let activeGame = null
afterEach(() => {
  activeGame?.dispose()
  activeGame = null
})

const ARRIVAL_AND_DOORS = TRAIN.arrivalTime + WAVES.spawnDelayAfterArrival + 0.5
const INTERMISSION_TO_NEXT_SPAWN = WAVES.intermissionSeconds + ARRIVAL_AND_DOORS

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
  // No bus/rng override — see the header note on why these must share game.js's default
  // (shared) bus with zombie.js's own hardcoded import.
  const game = new Game({ renderer: makeRenderer(), scene, camera })
  activeGame = game
  game.startRun()
  expect(game.summitPickups.pickups.map(p => p.def.id)).not.toContain('explosive')
  return game
}

/** Every living body's real Zombie.die() — the same idempotent call a bullet or a burn tick
 *  makes, which sets state='dead' and emits EV.ZOMBIE_DEATH on the game's own bus. */
function killEveryoneAlive(game) {
  let n = 0
  for (const zombie of game.zombies.bodies) {
    if (zombie.state !== 'dead') {
      zombie.die()
      n += 1
    }
  }
  return n
}

/** Kill through an entire wave by real simulation: kill what is on screen, tick long enough
 *  for the director to release the next staggered batch from its queue, repeat. Stops the
 *  moment remainingThisWave hits 0, which is also the instant EV.WAVE_CLEAR fires. */
function clearCurrentWave(game, maxSimSeconds = 120) {
  const director = game.gameState.director
  let spent = 0
  while (director.remainingThisWave > 0 && spent < maxSimSeconds) {
    killEveryoneAlive(game)
    game.tick(0.3)
    spent += 0.3
  }
  if (director.remainingThisWave > 0) {
    throw new Error(`wave ${director.currentWave} never cleared in ${maxSimSeconds}s of sim time`)
  }
}

describe('hudSnapshot().zombiesRemaining — finding #1', () => {
  it('equals the wave director\'s true remaining count, not the on-screen body count, and decreases toward zero as kills land', () => {
    const game = makeGame()
    const director = game.gameState.director

    // Wave 20's total (79, per spec/waves-progression.md via buildWave) is far past
    // WAVES.spawnBatchSize (6 released per pulse), so most of it is still queued, unspawned,
    // long after the first batch is on screen — exactly the gap the bug reports as wrong.
    const waveNumber = 20
    const totalCount = buildWave(waveNumber).totalCount
    expect(totalCount).toBeGreaterThan(WAVES.spawnBatchSize)

    director.startWave(waveNumber)
    game.tick(ARRIVAL_AND_DOORS)

    const aliveAfterFirstBatch = game.zombies.aliveCount
    expect(aliveAfterFirstBatch).toBeGreaterThan(0)
    // The whole point of the scenario: most of the wave has not spawned yet.
    expect(aliveAfterFirstBatch).toBeLessThan(totalCount)
    expect(director.remainingThisWave).toBe(totalCount)

    // Kill part of the first batch. The queue still holds the rest of the wave, so this
    // triggers a replenishing pulse — the on-screen count will climb back up, not settle at
    // totalCount - killed.
    const firstKill = Math.min(3, aliveAfterFirstBatch)
    const alive = game.zombies.bodies.filter(z => z.state !== 'dead')
    for (let i = 0; i < firstKill; i++) alive[i].die()

    const expectedAfterFirstKill = totalCount - firstKill
    const snapshotAfterFirstKill = game.hudSnapshot().zombiesRemaining
    expect(director.remainingThisWave).toBe(expectedAfterFirstKill)
    expect(snapshotAfterFirstKill).toBe(expectedAfterFirstKill)
    // Ground truth, not the pool's aliveCount: with a queue that deep, they diverge.
    expect(snapshotAfterFirstKill).not.toBe(game.zombies.aliveCount)

    // Let the replenishing pulse actually land, then kill more. The published count must
    // still fall — the on-screen count is free to rise.
    game.tick(2.0)
    const secondKill = Math.min(3, game.zombies.bodies.filter(z => z.state !== 'dead').length)
    const aliveBeforeSecondKill = game.zombies.bodies.filter(z => z.state !== 'dead')
    for (let i = 0; i < secondKill; i++) aliveBeforeSecondKill[i].die()

    const expectedAfterSecondKill = expectedAfterFirstKill - secondKill
    const snapshotAfterSecondKill = game.hudSnapshot().zombiesRemaining
    expect(snapshotAfterSecondKill).toBe(expectedAfterSecondKill)
    expect(snapshotAfterSecondKill).toBeLessThan(snapshotAfterFirstKill)
  })
})

describe('#restockSummit — finding #2', () => {
  it('restocks the street cache at wave clear even when the player never leaves the platform', () => {
    const game = makeGame()

    // Nothing here ever moves game.player toward the summit. #dealSummitCache() seats all
    // three pedestals at startRun(), and nothing frees one unless a pickup is actually taken.
    const initialOccupants = [...game.summitPickups.occupied.values()]
    expect(initialOccupants).toHaveLength(3)

    const WAVES_TO_CLEAR = 3
    for (let i = 0; i < WAVES_TO_CLEAR; i++) {
      clearCurrentWave(game)
      game.tick(INTERMISSION_TO_NEXT_SPAWN)
    }

    const laterOccupants = [...game.summitPickups.occupied.values()]
    expect(laterOccupants).toHaveLength(3)

    // At least one pedestal must have been re-seated with a NEW Pickup instance across three
    // wave clears — object identity, not the item id, so this does not depend on which entry
    // SUMMIT.RESTOCK happens to rotate to.
    const anyPedestalRestocked = laterOccupants.some((pickup, i) => pickup !== initialOccupants[i])
    expect(anyPedestalRestocked).toBe(true)
  }, 30000)
})
