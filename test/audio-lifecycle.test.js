import { afterEach, expect, it, vi } from 'vitest'
import { initAudio, disposeAudio, sound } from '../src/audio/audio.js'
import { EventBus, EV } from '../src/core/events.js'
import { GameState, GAME_STATES } from '../src/game/gameState.js'
import { AUDIO, SCORE } from '../src/game/rules.js'

let game
afterEach(() => { game?.dispose(); disposeAudio(); vi.unstubAllGlobals() })

it('restores combat feedback and narrative latches on retry, preserving ordinary wave transitions', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  const bus = new EventBus()
  initAudio({ bus, autoUnlock: false })
  game = new GameState({ bus })
  const starts = []
  bus.on(EV.COMBAT_CALLOUT, p => { if (p.phase === 'start') starts.push(p) })
  const headshot = () => {
    game.scoring.registerKill({ archetype: Object.keys(SCORE.perKill)[0], zone: 'head' })
    sound.update(.016)
  }
  game.startRun()
  expect(sound.state().combat.dead).toBe(false)
  headshot()
  expect(starts).toHaveLength(1)

  game.setState(GAME_STATES.intermission)
  game.setState(GAME_STATES.fight)
  expect(sound.state().combat.active).toBe('vo_headshot')

  bus.emit(EV.PLAYER_DEATH)
  expect(sound.state().combat.dead).toBe(true)
  expect(sound.state().voice.latched).toContain(AUDIO.VOICE.gameOverLine)
  game.retry()
  expect(sound.state().combat.dead).toBe(false)
  expect(sound.state().voice.latched).not.toContain(AUDIO.VOICE.gameOverLine)
  headshot()
  expect(starts).toHaveLength(2)
})
