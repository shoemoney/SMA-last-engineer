import { afterEach, expect, it, vi } from 'vitest'
import { initAudio, disposeAudio, sound } from '../src/audio/audio.js'
import { EventBus, EV } from '../src/core/events.js'
import { AUDIO, WEAPONS } from '../src/game/rules.js'
import { CUES, cueVoiceLimit } from '../src/audio/cues.js'

afterEach(() => { disposeAudio(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('routes the actual suppressed weapon payload and registers its dedicated short cue', () => {
  const bus = new EventBus()
  initAudio({ bus, autoUnlock: false })
  const fire = vi.spyOn(sound, 'weaponFire').mockReturnValue(null)
  bus.emit(EV.WEAPON_FIRE, { weapon: 'pistol', suppressed: true, position: [1, 2, 3] })
  expect(fire).toHaveBeenCalledWith(WEAPONS.PISTOL.fireSound, [1, 2, 3], true)
  expect(CUES.pistol_suppressed.url).toContain('/game/audio/sfx/pistol_suppressed.mp3')
  expect(WEAPONS.FIRE_AUDIO.suppressedPitch).toBe(1)
  expect(cueVoiceLimit('pistol_suppressed')).toBeGreaterThanOrEqual(Math.ceil(AUDIO.CUES.pistol_suppressed.seconds * 2 / WEAPONS.PISTOL.fireInterval))
})

it.each([
  ['health', 'vo_health_pickup', 'OHHH THAT’S THE STUFF!!!'],
  ['armor', 'vo_armor_pickup', 'Armor Baby!'],
])('speaks the %s pickup line and respects Mute Jeremy', (kind, line, text) => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  const bus = new EventBus()
  const subtitles = []
  bus.on('audio:subtitle', p => { if (p.line) subtitles.push(p) })
  initAudio({ bus, autoUnlock: false })
  sound.setJeremyMuted(false)
  bus.emit(EV.PICKUP, { kind })
  expect(subtitles).toContainEqual(expect.objectContaining({ line, text }))
  sound.setJeremyMuted(true)
  subtitles.length = 0
  bus.emit(EV.PICKUP, { kind })
  expect(subtitles).toEqual([])
  sound.setJeremyMuted(false)
})
