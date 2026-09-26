import { beforeEach, afterEach, it, expect, vi } from 'vitest'

let storage, sources
beforeEach(() => {
  vi.resetModules()
  storage = new Map()
  sources = []
  vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) })
  const param = () => ({ value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} })
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 0; destination = {}
    resume() { return Promise.resolve() }
    createGain() { return { gain: param(), connect() {} } }
    createBufferSource() {
      const source = { playbackRate: param(), connect() {}, start: vi.fn(), stop: vi.fn() }
      sources.push(source)
      return source
    }
    createPanner() { return { positionX: param(), positionY: param(), positionZ: param(), connect() {} } }
    decodeAudioData(bytes) { return Promise.resolve({ duration: 1, name: new TextDecoder().decode(bytes).split('/').pop().replace('.mp3', '') }) }
  })
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer })))
})
afterEach(() => vi.unstubAllGlobals())
async function setup() {
  const audio = await import('../src/audio/audio.js')
  const { EventBus, EV } = await import('../src/core/events.js')
  const bus = new EventBus()
  audio.initAudio({ bus, autoUnlock: false })
  await audio.sound.unlock()
  return { ...audio, bus, EV }
}
const sourceFor = cue => sources.findLast(s => s.buffer?.name === cue)

it('cuts active Jeremy narration and clears queued countdowns while preserving announcer and gun audio', async () => {
  const { sound, bus, EV, disposeAudio } = await setup()
  sound.play2D('vo_armor_pickup')
  sound.say('vo_intro'); sound.sayCountdown(9)
  expect(sound.state().voice.queued).toContain('vo_countdown_9')
  sound.setJeremyMuted(true)
  expect(sourceFor('vo_intro').stop).toHaveBeenCalled()
  expect(sourceFor('vo_armor_pickup').stop).toHaveBeenCalled()
  expect(sound.state().voice.speaking).toBe(null)
  expect(sound.state().voice.queued).toEqual([])
  expect(sound.say('vo_wave_start')).toBe(false)
  bus.emit(EV.PLAYER_HIT, { damage: 5, health: 80 })
  expect(sound.state().combat.active).toBe(null)
  expect(sound.play2D('vo_hurt_ouch')).toBe(null)
  bus.emit(EV.SCORE, { reason: 'kill', chain: 4, zone: 'head' }); sound.update(.01)
  expect(sourceFor('vo_rampage').start).toHaveBeenCalled()
  sound.setJeremyMuted(true)
  expect(sourceFor('vo_rampage').stop).not.toHaveBeenCalled()
  bus.emit(EV.WEAPON_FIRE, { weapon: 'pistol' }); sound.update(.2)
  expect(sourceFor('pistol_shot').start).toHaveBeenCalled()
  expect(sourceFor('bullet_casing').start).toHaveBeenCalled()
  expect(sourceFor('station_ambience_loop').stop).not.toHaveBeenCalled()
  sourceFor('vo_rampage').onended()
  sound.setJeremyMuted(false)
  sound.update(2)
  expect(sourceFor('vo_countdown_9')).toBeUndefined()
  expect(sound.say('vo_wave_start')).toBe(true)
  disposeAudio()
})

it('cuts an active hurt reaction without consuming a silent pain slot and preserves pending awards', async () => {
  const { sound, bus, EV, disposeAudio } = await setup()
  bus.emit(EV.PLAYER_HIT, { damage: 5, health: 80 })
  const hurt = sources.findLast(s => s.buffer?.name.startsWith('vo_hurt_'))
  expect(hurt.start).toHaveBeenCalled()
  bus.emit(EV.SCORE, { reason: 'kill', chain: 2 })
  bus.emit(EV.WEAPON_FIRE, { weapon: 'pistol' })
  sound.setJeremyMuted(true)
  expect(hurt.stop).toHaveBeenCalled()
  expect(sound.state().combat.active).toBe(null)
  expect(sound.state().combat.pending).toBe('vo_killstreak')
  expect(sound.state().combat.casings).toBe(1)
  sound.update(.2)
  expect(sourceFor('vo_killstreak').start).toHaveBeenCalled()
  sourceFor('vo_killstreak').onended()
  sound.setJeremyMuted(false)
  bus.emit(EV.PLAYER_HIT, { damage: 5, health: 80 })
  expect(sound.state().combat.active).toMatch(/^vo_hurt_/)
  disposeAudio()
})

it('persists independently across module reload, menu, death and retry', async () => {
  let r = await setup()
  r.sound.setJeremyMuted(true)
  expect(storage.get(r.JEREMY_MUTE_STORAGE_KEY)).toBe('true')
  r.bus.emit(r.EV.PLAYER_DEATH)
  r.bus.emit(r.EV.STATE_CHANGE, { state: 'menu' })
  r.bus.emit(r.EV.STATE_CHANGE, { state: 'fight', previous: 'menu' })
  expect(r.sound.getJeremyMuted()).toBe(true)
  expect(r.sound.state().voice.speaking).toBe(null)
  r.disposeAudio()
  vi.resetModules()
  r = await setup()
  expect(r.sound.getJeremyMuted()).toBe(true)
  expect(r.sound.say('vo_intro')).toBe(false)
  r.disposeAudio()
})

it('defaults malformed storage to audible and tolerates unavailable storage on read and write', async () => {
  storage.set('last-engineer.audio.jeremy-muted.v1', 'garbage')
  let r = await setup()
  expect(r.sound.getJeremyMuted()).toBe(false)
  r.disposeAudio()
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } })
  r = await setup()
  expect(r.sound.getJeremyMuted()).toBe(false)
  expect(() => r.sound.setJeremyMuted(true)).not.toThrow()
  expect(r.sound.getJeremyMuted()).toBe(true)
  expect(() => r.sound.setJeremyMuted(false)).not.toThrow()
  expect(r.sound.say('vo_wave_start')).toBe(true)
  r.disposeAudio()
})


it('uses the dedicated suppressed pistol take without changing other suppressed weapons', async () => {
  const { sound, disposeAudio } = await setup()
  sound.weaponFire('pistol_shot', null, true)
  expect(sourceFor('pistol_suppressed').playbackRate.value).toBe(1)
  expect(sourceFor('pistol_shot')).toBeUndefined()
  sound.weaponFire('rifle_shot', null, true)
  expect(sourceFor('rifle_shot').playbackRate.value).toBe(.75)
  disposeAudio()
})

it('sacrifices quiet pistol shots before other effects at the global voice limit', async () => {
  const { sound, disposeAudio } = await setup()
  const { AUDIO } = await import('../src/game/rules.js')
  sound.weaponFire('pistol_shot', null, true)
  const suppressed = sourceFor('pistol_suppressed')
  while (sound.state().active < AUDIO.MIX.maxSimultaneousVoices) sound.play2D('bullet_casing')
  sound.play2D('zombie_scream')
  expect(suppressed.stop).toHaveBeenCalled()
  const before = sources.length
  expect(sound.weaponFire('pistol_shot', null, true)).toBe(null)
  expect(sources).toHaveLength(before)
  expect(sourceFor('zombie_scream').stop).not.toHaveBeenCalled()
  disposeAudio()
})

it.each(['health', 'armor'])('plays new %s pickup audio until Jeremy is muted', async kind => {
  const { sound, bus, EV, disposeAudio } = await setup()
  bus.emit(EV.PICKUP, { kind })
  const cue = `vo_${kind}_pickup`
  expect(sourceFor(cue).start).toHaveBeenCalled()
  sound.setJeremyMuted(true)
  expect(sourceFor(cue).stop).toHaveBeenCalled()
  const before = sources.length
  bus.emit(EV.PICKUP, { kind })
  expect(sources).toHaveLength(before)
  disposeAudio()
})


it.each(['none', 'mute', 'menu', 'death', 'retry'])('handles startup decode race with %s before readiness while gameplay updates are paused', async action => {
  const audio = await import('../src/audio/audio.js')
  const { EventBus, EV } = await import('../src/core/events.js')
  const bus = new EventBus()
  audio.initAudio({ bus, autoUnlock: false })
  const unlocking = audio.sound.unlock()
  bus.emit(EV.STATE_CHANGE, { state: 'intermission', previous: 'menu' })
  expect(sourceFor('vo_intro')).toBeUndefined()
  expect(audio.sound.state().voice.latched).not.toContain('vo_intro')
  if (action === 'mute') audio.sound.setJeremyMuted(true)
  if (action === 'menu') bus.emit(EV.STATE_CHANGE, { state: 'menu' })
  if (action === 'death') bus.emit(EV.PLAYER_DEATH)
  if (action === 'retry') bus.emit(EV.STATE_CHANGE, { state: 'intermission', previous: 'gameOver' })
  await unlocking
  const intros = sources.filter(s => s.buffer?.name === 'vo_intro')
  expect(intros).toHaveLength(['none', 'retry'].includes(action) ? 1 : 0)
  if (action === 'death') expect(sourceFor('vo_game_over').start).toHaveBeenCalled()
  audio.disposeAudio()
})
