import { describe, it, expect } from 'vitest'
import { createVoiceDirector } from '../src/audio/voiceDirector.js'

describe('voice decode readiness', () => {
  function fixture() {
    let ready = false, muted = false
    const played = [], subtitles = []
    const voice = createVoiceDirector({
      canSpeak: () => !muted,
      play2D: line => {
        if (!ready) return null
        played.push(line)
        return { stop() {} }
      },
    })
    voice.onSubtitle(value => subtitles.push(value))
    return { voice, played, subtitles, ready: () => { ready = true }, mute: () => { muted = true; voice.silence() } }
  }
  it('retries first intro once on readiness without a gameplay tick or false subtitle', () => {
    const f = fixture()
    expect(f.voice.say('vo_intro')).toBe(false)
    expect(f.voice.state().latched).toEqual([])
    expect(f.subtitles).toEqual([])
    f.ready()
    expect(f.voice.retryPending()).toBe(true)
    expect(f.voice.retryPending()).toBe(false)
    expect(f.voice.say('vo_intro')).toBe(false)
    expect(f.played).toEqual(['vo_intro'])
  })
  it.each(['silence', 'reset', 'mute'])('does not revive cancelled intro after %s', action => {
    const f = fixture()
    f.voice.say('vo_intro')
    if (action === 'mute') f.mute()
    else f.voice[action]()
    f.ready()
    expect(f.voice.retryPending()).toBe(false)
    expect(f.played).toEqual([])
  })
  it('death supersedes the pending intro before decode completes', () => {
    const f = fixture()
    f.voice.say('vo_intro')
    f.voice.silence()
    f.voice.say('vo_game_over')
    f.ready()
    f.voice.retryPending()
    expect(f.played).not.toContain('vo_intro')
  })
  it('clears the interrupted subtitle when a higher priority cue cannot start', () => {
    const subtitles = []
    const voice = createVoiceDirector({ play2D: line => line === 'vo_intro' ? { stop() {} } : null })
    voice.onSubtitle(value => subtitles.push(value))
    voice.say('vo_intro')
    voice.say('vo_game_over')
    expect(subtitles.at(-1).text).toBe('')
    expect(voice.state().speaking).toBe(null)
  })
  it('removes a deferred line when a direct request starts it before the decode flush', () => {
    const f = fixture()
    f.voice.say('vo_intro')
    f.voice.say('vo_health_pickup')
    f.ready()
    expect(f.voice.say('vo_intro')).toBe(true)
    expect(f.voice.state().queued).toEqual(['vo_health_pickup'])
    f.voice.update(6)
    expect(f.played).toEqual(['vo_intro', 'vo_health_pickup'])
    expect(f.voice.retryPending()).toBe(false)
  })
  it('expires unavailable cues and allows the next run intro', () => {
    const f = fixture()
    f.voice.say('vo_intro')
    f.voice.update(30)
    f.ready()
    expect(f.voice.retryPending()).toBe(false)
    f.voice.reset()
    expect(f.voice.say('vo_intro')).toBe(true)
  })
})
