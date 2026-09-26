import { describe, it, expect, vi } from 'vitest'
import { createCombatFeedback } from '../src/audio/combatFeedback.js'
import { createVoiceDirector } from '../src/audio/voiceDirector.js'
import { AUDIO } from '../src/game/rules.js'
import { SCORE_REASON } from '../src/game/scoring.js'
import { CUES } from '../src/audio/cues.js'

function rig(overrides = {}) {
  const handles = []
  const play = vi.fn((cue) => {
    const handle = { seconds: AUDIO.VO_CLIPS[cue]?.seconds, stop: vi.fn(), whenEnded(fn) { this.end = fn } }
    handles.push(handle)
    return handle
  })
  const emit = vi.fn(), silenceNarration = vi.fn()
  const director = createCombatFeedback({ play, emit, silenceNarration, random: () => 0, ...overrides })
  return { director, play, emit, handles, silenceNarration }
}
const kill = (chain, zone = 'body') => ({ reason: SCORE_REASON.kill, chain, zone })

describe('combat speech and sound feedback', () => {
  it('coalesces a same-frame headshot with the highest milestone and starts visuals after accepted playback', () => {
    const r = rig()
    r.director.score(kill(4, 'head'))
    expect(r.emit).not.toHaveBeenCalled()
    r.director.update(.016)
    expect(r.play.mock.calls[0][0]).toBe('vo_rampage')
    expect(r.emit.mock.calls[0][1]).toMatchObject({ text: 'RAMPAGE!!', seconds: AUDIO.VO_CLIPS.vo_rampage.seconds, phase: 'start', audible: true })
    expect(r.play.mock.invocationCallOrder[0]).toBeLessThan(r.emit.mock.invocationCallOrder[0])
    r.handles[0].end()
    expect(r.emit.mock.calls[1][1]).toMatchObject({ phase: 'end', id: r.emit.mock.calls[0][1].id })
  })
  it('never claims synchronization for null playback, retries decoding, and expires stale awards', () => {
    let ready = false
    const r = rig({ play: () => ready ? { seconds: .9 } : null })
    r.director.score(kill(2))
    r.director.update(.1)
    expect(r.emit).not.toHaveBeenCalled()
    ready = true
    r.director.update(.1)
    expect(r.emit.mock.calls[0][1]).toMatchObject({ seconds: .9, audible: true })
    const missing = rig({ play: () => null })
    missing.director.score(kill(4))
    missing.director.update(AUDIO.COMBAT.pendingSeconds + .01)
    expect(missing.director.state().pending).toBe(null)
    expect(missing.emit).not.toHaveBeenCalled()
  })
  it('keeps explicit silent visual feedback when muted or unavailable', () => {
    const r = rig({ isSilent: () => true })
    r.director.score(kill(0, 'head'))
    r.director.update(.01)
    expect(r.play).not.toHaveBeenCalled()
    expect(r.emit.mock.calls[0][1]).toMatchObject({ audible: false, text: 'HEADSHOT!!' })
  })
  it('does not repeat an announced milestone, and allows it in a new chain', () => {
    const r = rig()
    r.director.score(kill(2)); r.director.update(.01)
    r.handles[0].end()
    r.director.score(kill(2)); r.director.score(kill(3)); r.director.update(.01)
    expect(r.play).toHaveBeenCalledTimes(1)
    r.director.score(kill(0)); r.director.score(kill(2)); r.director.update(.01)
    expect(r.play).toHaveBeenCalledTimes(2)
  })
  it('uses a shared pain cooldown, avoids immediate repeats, and ignores lethal or zero damage', () => {
    const r = rig(), hit = { damage: 4, health: 80 }
    r.director.hurt({ damage: 0, health: 80 }); r.director.hurt({ damage: 4, health: 0 })
    expect(r.play).not.toHaveBeenCalled()
    r.director.hurt(hit); r.handles[0].end(); r.director.hurt(hit)
    expect(r.play).toHaveBeenCalledTimes(1)
    r.director.update(AUDIO.COMBAT.hurtCooldown)
    r.director.hurt(hit)
    expect(r.play.mock.calls.map(c => c[0])).toEqual(['vo_hurt_ouch', 'vo_hurt_ooh'])
  })
  it('coalesces shotgun head pellets and requires positive head damage', () => {
    const r = rig()
    r.director.headHit({ zone: 'body', damage: 10 }); r.director.headHit({ zone: 'head', damage: 0 })
    expect(r.play).not.toHaveBeenCalled()
    for (let i = 0; i < 8; i++) r.director.headHit({ zone: 'head', damage: 10 })
    expect(r.play).toHaveBeenCalledTimes(1)
    r.director.update(AUDIO.COMBAT.splatCooldown)
    r.director.headHit({ zone: 'head', damage: 10 })
    expect(r.play).toHaveBeenCalledTimes(2)
  })
  it('delays each dual-wield casing and bounds the queue; death clears all scheduled feedback', () => {
    const r = rig()
    r.director.fire({ weapon: 'pistol' }, [1, 2, 3]); r.director.fire({ weapon: 'pistol' }, [4, 5, 6])
    r.director.update(.1)
    expect(r.play).not.toHaveBeenCalled()
    r.director.update(.09)
    expect(r.play).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 50; i++) r.director.fire({ weapon: 'shotgun' })
    expect(r.director.state().casings).toBe(AUDIO.COMBAT.maxCasings)
    r.director.score(kill(4)); r.director.update(.01)
    const handle = r.handles.at(-1)
    r.director.score(kill(9)); r.director.reset({ lethal: true }); r.director.update(5)
    expect(handle.stop).toHaveBeenCalled()
    expect(r.director.state()).toEqual({ active: null, pending: null, casings: 0, dead: true })
    const count = r.play.mock.calls.length
    r.director.hurt({ damage: 10, health: 10 }); r.director.score(kill(19)); r.director.update(.1)
    expect(r.play).toHaveBeenCalledTimes(count)
    r.director.reset(); r.director.fire({ weapon: 'rifle' }); r.director.update(.21)
    expect(r.play).toHaveBeenCalledTimes(count + 1)
  })
  it('ignores stale end callbacks after a higher award interrupts', () => {
    const r = rig()
    r.director.score(kill(0, 'head')); r.director.update(.01)
    const old = r.handles[0]
    r.director.score(kill(4)); r.director.update(.01)
    old.end()
    expect(r.director.state().active).toBe('vo_rampage')
    expect(r.emit.mock.calls.at(-1)[1].phase).toBe('start')
  })
  it('gates narrative requests while combat speaks without consuming a once-per-run latch', () => {
    let available = false
    const play2D = vi.fn(() => ({}))
    const voice = createVoiceDirector({ play2D, canSpeak: () => available })
    expect(voice.say(AUDIO.VOICE.introLine)).toBe(false)
    expect(voice.state().latched).toEqual([])
    available = true
    expect(voice.say(AUDIO.VOICE.introLine)).toBe(true)
  })
  it('registers every combat cue with the expected mixer bus', () => {
    for (const cue of [...AUDIO.COMBAT.hurtCues, ...AUDIO.COMBAT.milestones.map(m => m.cue), 'vo_headshot']) {
      expect(CUES[cue]?.bus).toBe('voice')
      expect(CUES[cue]?.seconds).toBeGreaterThan(0)
    }
    expect(CUES.headshot_splat.bus).toBe('sfx')
    expect(CUES.bullet_casing.bus).toBe('sfx')
  })
})
