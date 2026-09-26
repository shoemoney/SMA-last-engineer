/**
 * audio.js — the Web Audio engine and the bus-bound sound facade.
 *
 * Gameplay never calls this module. It emits on the event bus and the facade listens, which is
 * what keeps `src/game/**` free of any playback dependency and lets the headless soak run the
 * real wave director with no audio device in sight.
 *
 * What the original had (spec/audio.md §1): three primitives — a spatial one-shot, a flat
 * one-shot and one attached loop — with no attenuation, no buses, no concurrency limits, no
 * voice stealing, no cooldowns and no ducking. A "spatial" gunshot 10,000 cm away played at
 * exactly the same loudness as one at the player's feet, because the position argument fed
 * nothing. Everything this file adds on top of that is named in rules.js under AUDIO.ATTENUATION,
 * AUDIO.MIX and AUDIO.VOICE, each entry marked `CHOSEN: not in original spec`.
 *
 * Coordinates: positions are game-world centimetres in the Unreal-derived frame rules.js uses
 * (X along the platform, Y across it, Z up — AUDIO.AMBIENCE.position is [3000, 0, 150], i.e.
 * 150 cm above the walking surface). Web Audio is Y-up with -Z forward, so every position and
 * orientation is converted at the boundary; see `toAudioSpace`.
 */

import { AUDIO, TRAIN, WEAPONS, ZOMBIES } from '../game/rules.js'
import { bus as defaultBus, EV } from '../core/events.js'
import { Rng } from '../core/rng.js'
import {
  CUES,
  VO_SUBTITLES,
  DEATH_CUES,
  DRY_FIRE_CUE,
  EXPLOSION_CUE,
  GROWL_CUES,
  MOD_LINES,
  RELOAD_CUE,
  SWIPE_CUE,
  cueVoiceLimit,
  resolveCue,
} from './cues.js'
import { createCombatFeedback } from './combatFeedback.js'
import { EV_SUBTITLE, createVoiceDirector } from './voiceDirector.js'

export { EV_SUBTITLE }

const AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null

/**
 * Pitch and variant jitter runs on its own stream. Sharing `core/rng.js`'s global instance would
 * mean the browser (which plays sound) and the headless soak (which does not) draw a different
 * number of values and diverge, which is exactly the reproducibility the seeded RNG exists to
 * protect. Math.random() is never an option here for the same reason.
 */
const rng = new Rng()
export const JEREMY_MUTE_STORAGE_KEY = 'last-engineer.audio.jeremy-muted.v1'
let jeremyMuted = false
try { jeremyMuted = globalThis.localStorage?.getItem(JEREMY_MUTE_STORAGE_KEY) === 'true' } catch {}
const isJeremyCue = name => name in VO_SUBTITLES || AUDIO.COMBAT.hurtCues.includes(name)

/** Unreal-style Z-up world cm -> Web Audio's Y-up, -Z-forward frame. */
function toAudioSpace([x, y, z]) {
  return [y, z, -x]
}

/** For a caller that has already converted to three.js's Y-up space; see `setWorldSpace`. */
function passThrough([x, y, z]) {
  return [x, y, z]
}

/**
 * Every emitter owns its position differently — a plain triple from rules.js, a `position` field,
 * a three.js Vector3 on an entity. Accepting all of them here keeps the shape of a bus payload
 * out of the contract between the audio layer and five other agents' modules.
 */
function positionOf(payload, fallback = null) {
  if (!payload) return fallback
  if (Array.isArray(payload)) return payload
  const p = payload.position ?? payload.pos ?? payload
  if (Array.isArray(p)) return p
  if (p && typeof p.x === 'number') return [p.x, p.y, p.z ?? 0]
  return fallback
}

const FIRE_CUES = Object.freeze(
  Object.fromEntries(WEAPONS.ORDER.map((id) => [id, WEAPONS[id.toUpperCase()].fireSound]))
)

function isSilenced(payload) {
  if (typeof payload?.suppressed === 'boolean') return payload.suppressed
  if (typeof payload?.silenced === 'boolean') return payload.silenced
  if (typeof payload?.mods === 'number') return (payload.mods & WEAPONS.MOD_BITS.silencer) !== 0
  return false
}

/**
 * spec/audio.md §4.2: the ranged archetype routes to the projectile path and the projectile
 * attack has no sound of any kind — no launch, no travel, no impact. Melee is the only zombie
 * damage source that makes a noise, so a hit is treated as melee unless it names itself
 * otherwise.
 */
function isMeleeHit(payload) {
  if (payload?.melee === true || payload?.kind === 'melee') return true
  if (payload?.melee === false) return false
  if (payload?.projectile === true) return false
  if (payload?.kind === 'projectile' || payload?.kind === 'ranged') return false
  return payload?.archetype !== ZOMBIES.ARCHETYPES.ranged.id
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function createEngine() {
  let ctx = null
  let master = null
  const busGain = { sfx: null, voice: null, ambience: null }
  let toSpace = toAudioSpace

  /** Decoded clips. Cleared entries are re-fetched, which reproduces the original's weak cache. */
  const buffers = new Map()
  /** Undecoded bytes, pulled before there is a context to decode them with. */
  const encoded = new Map()
  /** VO failures are pinned forever; SFX failures are retried. spec/audio.md §1 and §8.6. */
  const pinnedFailures = new Set()
  const warned = new Set()
  let loading = null
  let prefetching = null

  /** Push-ordered, so index 0 is always the oldest voice and 'oldest' stealing is a linear scan. */
  const active = []
  let ambienceVoice = null
  let speakingVoices = 0
  let unlocked = false
  let disabledWarned = false
  let masterVolume = 1

  const counters = { played: 0, dropped: 0, stolen: 0, missing: 0 }

  function warnOnce(key, ...args) {
    if (warned.has(key)) return
    warned.add(key)
    console.warn(...args)
  }

  function available() {
    if (AudioContextCtor) return true
    if (!disabledWarned) {
      disabledWarned = true
      // Node and the headless soak have no Web Audio. That is expected, not a failure, so it is
      // stated once at info level and every cue after it degrades to silence.
      console.info('[audio] no Web Audio in this environment — the sound layer is running silent')
    }
    return false
  }

  function ensureContext() {
    if (ctx || !available()) return ctx
    ctx = new AudioContextCtor()

    master = ctx.createGain()
    master.gain.value = masterVolume * AUDIO.MIX.master
    master.connect(ctx.destination)

    for (const name of ['sfx', 'voice', 'ambience']) {
      const g = ctx.createGain()
      g.gain.value = AUDIO.MIX[name]
      g.connect(master)
      busGain[name] = g
    }
    return ctx
  }

  function failed(name, cue, err) {
    counters.missing++
    // The original cached the failure and went quiet forever with no log at a visible level
    // (spec/audio.md §1, §8.6) — a typo produced a gun that fired silently. Same degradation,
    // with the warning the original never had.
    warnOnce(`load:${name}`, `[audio] "${name}" failed to load from ${cue.url} — it will be silent.`, err)
    if (cue.bus === 'voice') pinnedFailures.add(name)
    return null
  }

  async function fetchBytes(name) {
    const cue = resolveCue(name)
    if (!cue || pinnedFailures.has(name)) return null
    if (encoded.has(name)) return encoded.get(name)
    try {
      const res = await fetch(cue.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      encoded.set(name, bytes)
      return bytes
    } catch (err) {
      return failed(name, cue, err)
    }
  }

  const decoding = new Map()

  function fetchBuffer(name) {
    const cue = resolveCue(name)
    if (!cue) {
      counters.missing++
      return Promise.resolve(null)
    }
    if (buffers.has(name)) return Promise.resolve(buffers.get(name))
    if (pinnedFailures.has(name) || !ensureContext()) return Promise.resolve(null)
    // decodeAudioData detaches the ArrayBuffer it is given, so two concurrent decodes of one clip
    // would hand the second call a spent buffer. One in-flight promise per name, shared.
    if (decoding.has(name)) return decoding.get(name)

    const job = (async () => {
      const bytes = await fetchBytes(name)
      if (!bytes) return null
      try {
        const decoded = await ctx.decodeAudioData(bytes)
        buffers.set(name, decoded)
        return decoded
      } catch (err) {
        return failed(name, cue, err)
      } finally {
        encoded.delete(name)
        decoding.delete(name)
      }
    })()
    decoding.set(name, job)
    return job
  }

  /**
   * Pull the bytes for all registered clips before anyone clicks. This needs no AudioContext, which is
   * the point: constructing one before a gesture makes Chrome log an autoplay warning that looks
   * like a bug, so the context waits for the gesture and only the decode happens there.
   */
  function prefetch() {
    if (!available() || typeof fetch !== 'function') return Promise.resolve()
    if (prefetching) return prefetching
    prefetching = Promise.all(Object.keys(CUES).map((name) => fetchBytes(name))).then(() => undefined)
    return prefetching
  }

  /** Decode everything into the context. Called from unlock(), once the gesture has landed. */
  function preload() {
    if (!ensureContext()) return Promise.resolve()
    if (loading) return loading
    loading = Promise.all(Object.keys(CUES).map((name) => fetchBuffer(name))).then((decoded) => {
      const missing = decoded.filter((b) => b === null).length
      if (missing > 0) console.warn(`[audio] ${missing} of ${decoded.length} clips failed to load`)
      return undefined
    })
    return loading
  }

  function pruneFinished() {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].done) active.splice(i, 1)
    }
  }

  /**
   * Voice stealing is 'oldest' (AUDIO.MIX.voiceStealing): the newest shot always survives.
   *
   * Two voices are never candidates for a GLOBAL steal. The looping room tone is the oldest voice
   * in every run by definition, so an un-guarded "steal the oldest" silences the station the
   * first time 32 things happen at once — and since the original could never stop it, nothing
   * would ever bring it back. Whatever Jeremy is saying is the second: it already has a
   * single-slot channel of its own, and cutting him off to make room for the fortieth growl is a
   * worse mix than dropping the growl. A per-cue steal still reaches both, which is how a second
   * train arrival replaces the first.
   */
  function stealOldest(match) {
    if (!match && stealOldest('pistol_suppressed')) return true
    for (const voice of active) {
      if (voice.done) continue
      if (match) {
        if (voice.cue !== match) continue
      } else if (voice.loop || voice.bus === 'voice') {
        continue
      }
      counters.stolen++
      release(voice)
      return true
    }
    return false
  }

  function release(voice) {
    if (voice.done) return
    voice.done = true
    const now = ctx.currentTime
    // Reuse the only gain-ramp constant the ruleset defines rather than inventing a second one;
    // a hard .stop() on a mid-cycle buffer clicks.
    const fade = AUDIO.VOICE.duckAttack
    try {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
      voice.gain.gain.linearRampToValueAtTime(0, now + fade)
      voice.source.stop(now + fade)
    } catch (err) {
      console.warn('[audio] could not stop a voice cleanly', err)
    }
  }

  function setDucked(ducked) {
    if (!AUDIO.VOICE.ducksOtherChannels || !ctx) return
    const now = ctx.currentTime
    const seconds = ducked ? AUDIO.VOICE.duckAttack : AUDIO.VOICE.duckRelease
    for (const name of ['sfx', 'ambience']) {
      const g = busGain[name].gain
      const target = ducked ? AUDIO.MIX[name] * AUDIO.VOICE.duckAmount : AUDIO.MIX[name]
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(target, now + seconds)
    }
  }

  function makePanner(position) {
    const panner = ctx.createPanner()
    panner.panningModel = AUDIO.ATTENUATION.panningModel
    panner.distanceModel = AUDIO.ATTENUATION.distanceModel
    panner.refDistance = AUDIO.ATTENUATION.refDistance
    panner.maxDistance = AUDIO.ATTENUATION.maxDistance
    panner.rolloffFactor = AUDIO.ATTENUATION.rolloffFactor
    panner.coneInnerAngle = AUDIO.ATTENUATION.coneInnerAngle

    const [x, y, z] = toSpace(position)
    if (panner.positionX) {
      panner.positionX.value = x
      panner.positionY.value = y
      panner.positionZ.value = z
    } else {
      panner.setPosition(x, y, z) // Safari before 14.1
    }
    return panner
  }

  /**
   * The one playback path. `position` null means a flat, non-spatial play — every voice line and
   * nothing else, matching the original's play2D (spec/audio.md §1).
   */
  function play(name, { position = null, volume = 1, pitch = 1, loop = false, fadeIn = 0 } = {}) {
    if (jeremyMuted && isJeremyCue(name)) return null
    if (!available()) {
      counters.dropped++
      return null
    }
    if (!ensureContext()) return null

    // A context that has not been resumed queues everything and dumps it in one burst on the
    // first gesture, so a pre-unlock cue is dropped rather than deferred. A context that was
    // running and has since been suspended (backgrounded tab, an audio device that went away)
    // is nudged back, because nothing else in the game will ever ask it to resume.
    if (ctx.state !== 'running') {
      if (unlocked && ctx.state === 'suspended') ctx.resume().catch((err) => console.warn('[audio] resume failed', err))
      counters.dropped++
      return null
    }

    const cue = resolveCue(name)
    if (!cue) return null

    const buffer = buffers.get(name)
    if (!buffer) {
      if (!pinnedFailures.has(name)) fetchBuffer(name) // SFX cache is re-resolvable; VO is not.
      counters.dropped++
      return null
    }

    pruneFinished()
    const limit = cueVoiceLimit(name)
    let sameCue = 0
    for (const v of active) if (!v.done && v.cue === name) sameCue++
    if (sameCue >= limit) stealOldest(name)
    if (active.length >= AUDIO.MIX.maxSimultaneousVoices && !stealOldest(name === 'pistol_suppressed' ? name : null)) {
      // Nothing stealable left, so the pool stays at its ceiling instead of drifting past it.
      counters.dropped++
      return null
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = pitch
    source.loop = loop

    const gain = ctx.createGain()
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, ctx.currentTime)
      gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + fadeIn)
    } else {
      gain.gain.value = volume
    }

    source.connect(gain)
    if (position) {
      const panner = makePanner(position)
      gain.connect(panner)
      panner.connect(busGain[cue.bus])
    } else {
      gain.connect(busGain[cue.bus])
    }

    const voice = { cue: name, source, gain, bus: cue.bus, loop, startedAt: ctx.currentTime, done: false, ended: [] }
    const finish = () => {
      voice.done = true
      if (cue.bus === 'voice') {
        speakingVoices = Math.max(0, speakingVoices - 1)
        if (speakingVoices === 0) setDucked(false)
      }
      for (const fn of voice.ended) {
        try {
          fn()
        } catch (err) {
          console.error(`[audio] end callback for "${name}" threw`, err)
        }
      }
      voice.ended.length = 0
    }
    source.onended = finish

    if (cue.bus === 'voice') {
      speakingVoices++
      setDucked(true)
    }

    active.push(voice)
    counters.played++
    source.start()

    return {
      cue: name,
      seconds: buffer.duration / pitch,
      stop() {
        release(voice)
      },
      whenEnded(fn) {
        if (voice.done) fn()
        else voice.ended.push(fn)
      },
    }
  }

  function startAmbience() {
    if (ambienceVoice) return ambienceVoice
    ambienceVoice = play(AUDIO.AMBIENCE.cue, {
      position: AUDIO.AMBIENCE.isUiSound ? null : AUDIO.AMBIENCE.position,
      volume: AUDIO.AMBIENCE.volume,
      pitch: AUDIO.DEFAULTS.spatialPitch,
      loop: AUDIO.AMBIENCE.loop,
      fadeIn: AUDIO.AMBIENCE.fadeInSeconds,
    })
    if (!ambienceVoice) return null
    const handle = ambienceVoice
    // A looping bed that ends was killed by something — a stolen voice, a decode that came back
    // short. The original could never stop it, so silence here is always a fault worth naming.
    // An intentional stopAll() clears the handle first, so this does not fire on that path.
    handle.whenEnded(() => {
      if (ambienceVoice !== handle) return
      console.warn('[audio] the station ambience bed ended; the platform is now silent')
      ambienceVoice = null
    })
    return handle
  }

  return {
    get context() {
      return ctx
    },
    get unlocked() {
      return unlocked
    },
    counters,
    isSilent: (name) => !AudioContextCtor || masterVolume <= 0 || pinnedFailures.has(name),
    play,
    preload,
    prefetch,
    startAmbience,
    /**
     * Which frame incoming positions are in. The default 'z-up' is the frame rules.js states
     * every position in, so nothing has to convert before calling. A caller that has already
     * moved into three.js's Y-up space passes 'y-up' once at startup instead of converting back.
     */
    setWorldSpace(space) {
      toSpace = space === 'y-up' ? passThrough : toAudioSpace
    },
    setListener(position, forward = null, up = null) {
      if (!ctx) return
      const l = ctx.listener
      const [px, py, pz] = toSpace(position)
      if (l.positionX) {
        l.positionX.value = px
        l.positionY.value = py
        l.positionZ.value = pz
      } else {
        l.setPosition(px, py, pz)
      }
      if (!forward) return
      const [fx, fy, fz] = toSpace(forward)
      // The player can look up and down but never rolls, so world up is a safe default for a
      // caller that only has a look vector to hand.
      const [ux, uy, uz] = toSpace(up ?? [0, 0, 1])
      if (l.forwardX) {
        l.forwardX.value = fx
        l.forwardY.value = fy
        l.forwardZ.value = fz
        l.upX.value = ux
        l.upY.value = uy
        l.upZ.value = uz
      } else {
        l.setOrientation(fx, fy, fz, ux, uy, uz)
      }
    },
    setMasterVolume(v) {
      masterVolume = v
      if (master) master.gain.value = v * AUDIO.MIX.master
    },
    stopJeremyVoices() {
      for (const voice of active) if (isJeremyCue(voice.cue)) release(voice)
    },
    stopAll() {
      ambienceVoice = null // cleared first, so the bed's end callback reads this as intentional
      for (const voice of [...active]) release(voice)
      speakingVoices = 0
      setDucked(false)
    },
    async unlock() {
      if (unlocked || !ensureContext()) return false
      try {
        await ctx.resume()
      } catch (err) {
        console.warn('[audio] AudioContext.resume() was refused — the game will be silent', err)
        return false
      }
      if (ctx.state !== 'running') return false
      unlocked = true
      // The room tone is what turns a box of concrete into a station, so it starts on its own
      // decode instead of queueing behind the other forty.
      if (AUDIO.AMBIENCE.autoActivate) {
        await fetchBuffer(AUDIO.AMBIENCE.cue)
        startAmbience()
      }
      await preload()
      return true
    },
    state() {
      pruneFinished()
      return {
        unlocked,
        contextState: ctx?.state ?? 'none',
        active: active.length,
        ambience: ambienceVoice !== null,
        ...counters,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

const engine = createEngine()
const voice = createVoiceDirector({
  canSpeak: () => !jeremyMuted && !combat.speaking,
  play2D: (line, { volume, pitch }) => {
    if (jeremyMuted || combat.speaking) return null
    const handle = engine.play(line, { position: null, volume, pitch })
    // Permanent silence (no Web Audio, mute, or failed asset) retains subtitle-only
    // narration. A transient null may still be awaiting the gesture or decode.
    return engine.isSilent(line) ? undefined : handle
  },
})

let unbind = []
let boundBus = null
const combat = createCombatFeedback({
  play: (cue, options) => engine.play(cue, options),
  emit: (type, payload) => boundBus?.emit(type, payload),
  silenceNarration: () => voice.silence(),
  isSilent: (cue) => engine.isSilent(cue),
  canHurt: () => !jeremyMuted,
  random: () => rng.range(0, 1),
})

/** Everything gameplay can make a noise about, reachable without knowing Web Audio exists. */
export const sound = {
  getJeremyMuted: () => jeremyMuted,
  setJeremyMuted(muted) {
    jeremyMuted = Boolean(muted)
    if (jeremyMuted) {
      voice.silence()
      combat.silenceHurt()
      engine.stopJeremyVoices()
    }
    try { globalThis.localStorage?.setItem(JEREMY_MUTE_STORAGE_KEY, String(jeremyMuted)) } catch {}
  },
  async unlock() {
    const unlocked = await engine.unlock()
    if (unlocked) voice.retryPending()
    return unlocked
  },
  preload: () => engine.prefetch(),
  update: (dt) => { combat.update(dt); voice.update(dt) },
  setListener: (position, forward, up) => engine.setListener(position, forward, up),
  setWorldSpace: (space) => engine.setWorldSpace(space),
  setMasterVolume: (v) => engine.setMasterVolume(v),
  stopAll: () => {
    combat.reset()
    voice.silence()
    engine.stopAll()
  },
  onSubtitle: (fn) => voice.onSubtitle(fn),

  say: (line) => voice.say(line),
  sayCountdown: (n) => voice.sayCountdown(n),

  playAt: (cue, position, opts = {}) => engine.play(cue, { ...opts, position }),
  play2D: (cue, opts = {}) => engine.play(cue, { ...opts, position: null }),

  weaponFire(cue, position, silenced = false) {
    const suppressedPistol = silenced && cue === WEAPONS.PISTOL.fireSound
    return engine.play(suppressedPistol ? 'pistol_suppressed' : cue, {
      position,
      volume: silenced ? WEAPONS.FIRE_AUDIO.suppressedVolume : WEAPONS.FIRE_AUDIO.normalVolume,
      pitch: silenced
        ? (suppressedPistol ? WEAPONS.FIRE_AUDIO.suppressedPitch : 0.75)
        : rng.range(WEAPONS.FIRE_AUDIO.normalPitchMin, WEAPONS.FIRE_AUDIO.normalPitchMax),
    })
  },

  zombieGrowl(position) {
    const cue = GROWL_CUES[rng.int(0, GROWL_CUES.length - 1)]
    return engine.play(cue, {
      position,
      volume: ZOMBIES.SOUND.growlVolume,
      pitch: rng.range(ZOMBIES.SOUND.growlPitchMin, ZOMBIES.SOUND.growlPitchMax),
    })
  },

  zombieSwipe(position) {
    return engine.play(SWIPE_CUE, {
      position,
      volume: ZOMBIES.SOUND.swipeVolume,
      pitch: rng.range(ZOMBIES.SOUND.swipePitchMin, ZOMBIES.SOUND.swipePitchMax),
    })
  },

  zombieDeath(position) {
    const cue = DEATH_CUES[rng.int(0, DEATH_CUES.length - 1)]
    return engine.play(cue, {
      position,
      volume: ZOMBIES.SOUND.deathVolume,
      pitch: rng.range(ZOMBIES.SOUND.deathPitchMin, ZOMBIES.SOUND.deathPitchMax),
    })
  },

  state: () => ({ ...engine.state(), voice: voice.state(), combat: combat.state() }),
}

/**
 * Bind the facade to the bus and arm the gesture that unlocks playback. Safe to call twice: the
 * previous subscriptions are dropped first, so a hot reload does not double every gunshot.
 */
export function initAudio({ bus = defaultBus, autoUnlock = true } = {}) {
  for (const off of unbind) off()
  unbind = []
  combat.reset()
  voice.silence()
  boundBus = bus

  const on = (type, fn) => unbind.push(bus.on(type, fn))

  // The director is a module singleton built before any bus exists, so its subtitle output is
  // re-pointed at whichever bus this call binds.
  unbind.push(voice.onSubtitle((payload) => bus.emit(EV_SUBTITLE, payload)))

  // --- weapons ---
  on(EV.WEAPON_FIRE, (p) => {
    const cue = p?.cue ?? FIRE_CUES[p?.weapon] ?? WEAPONS.DEFAULTS.fireSound
    sound.weaponFire(cue, positionOf(p), isSilenced(p))
    combat.fire(p, positionOf(p))
  })
  on(EV.WEAPON_RELOAD, (p) => {
    // The original played this ahead of the legality check, so a press with a full magazine still
    // clicked, and dual wield produced two in one frame (spec/audio.md §3.2, §3.4). Whether the
    // press was legal is the weapon's business; if it emits, it clicks.
    engine.play(RELOAD_CUE, {
      position: positionOf(p),
      volume: WEAPONS.FIRE_AUDIO.reloadVolume,
      pitch: AUDIO.DEFAULTS.spatialPitch,
    })
  })
  on(EV.WEAPON_DRY, (p) => {
    // Unreachable in the original: the ammo check that guarded it had already returned one line
    // earlier (spec/audio.md §8.1). rules.js keeps the gain; the port makes it reachable.
    engine.play(DRY_FIRE_CUE, {
      position: positionOf(p),
      volume: WEAPONS.FIRE_AUDIO.emptyChamberVolume,
      pitch: AUDIO.DEFAULTS.spatialPitch,
    })
  })
  on(EV.EXPLOSION, (p) => {
    engine.play(EXPLOSION_CUE, {
      position: positionOf(p),
      volume: WEAPONS.FIRE_AUDIO.explosionVolume,
      pitch: AUDIO.DEFAULTS.spatialPitch,
    })
  })

  // --- zombies ---
  on(EV.ZOMBIE_SPAWN, (p) => sound.zombieGrowl(positionOf(p)))
  on(EV.ZOMBIE_DEATH, (p) => sound.zombieDeath(positionOf(p)))
  on(EV.SCORE, (p) => combat.score(p))
  on(EV.ZOMBIE_HIT, (p) => combat.headHit({ ...p, position: positionOf(p) }))
  on(EV.PLAYER_HIT, (p) => {
    combat.hurt(p)
    if (isMeleeHit(p)) sound.zombieSwipe(positionOf(p))
  })

  // --- the train ---
  on(EV.TRAIN_INBOUND, (p) => {
    voice.say(AUDIO.VOICE.trainInboundLine)
    // rules.js keeps the original's staging-point emission, which spec/audio.md §8.5 flags as a
    // defect the moment attenuation exists — the arrival would come from behind a wall. A train
    // that hands over its own position gets it right instead.
    engine.play(AUDIO.TRAIN.arrivingCue, {
      position: positionOf(p, AUDIO.TRAIN.arrivingPosition),
      volume: AUDIO.TRAIN.arrivingVolume,
      pitch: AUDIO.DEFAULTS.spatialPitch,
    })
  })
  on(EV.TRAIN_DOORS, (p) => {
    engine.play(AUDIO.TRAIN.doorsOpenCue, {
      position: positionOf(p, TRAIN.platformStopLocation),
      volume: AUDIO.DEFAULTS.spatialVolume,
      pitch: AUDIO.DEFAULTS.spatialPitch,
    })
  })

  // --- the voice ---
  on(EV.WAVE_START, (p) => voice.sayWaveStart(p?.bossCount ?? 0))
  on(EV.BOSS_INCOMING, () => voice.say(AUDIO.VOICE.bossIncomingLine))
  on(EV.WAVE_CLEAR, () => voice.say(AUDIO.VOICE.waveClearLine))
  on(EV.COUNTDOWN, (p) => voice.sayCountdown(typeof p === 'number' ? p : (p?.seconds ?? p?.remaining ?? p?.n)))
  on(EV.PLAYER_DEATH, () => {
    combat.reset({ lethal: true })
    voice.silence()
    voice.say(AUDIO.VOICE.gameOverLine)
  })
  on(EV.LOW_HEALTH, () => voice.say(AUDIO.VOICE.lowHealthLine))
  on(EV.PICKUP, (p) => {
    const kind = p?.kind ?? p?.id
    if (kind === 'armor') voice.say(AUDIO.VOICE.armorPickupLine)
    if (kind === 'health') voice.say(AUDIO.VOICE.healthPickupLine)
  })
  on(EV.MOD_GAINED, (p) => {
    const line = MOD_LINES[p?.mod ?? p?.id]
    if (line) voice.say(line)
  })
  on(EV.STATE_CHANGE, (p) => {
    const state = p?.state ?? p
    if (['fight', 'intermission'].includes(state) && ['menu', 'howToPlay', 'gameOver'].includes(p?.previous)) {
      combat.reset()
      voice.reset()
    }
    if (state === 'gameOver') combat.reset({ lethal: true })
    if (state === 'menu') {
      combat.reset()
      // A new run lifts the intro and game-over latches; the ambience bed is deliberately left
      // running, because the original never stopped it under any circumstance.
      voice.reset()
      return
    }
    if (state === 'fight' || state === 'intermission') voice.say(AUDIO.VOICE.introLine)
  })

  if (autoUnlock && typeof window !== 'undefined') {
    const GESTURES = ['pointerdown', 'keydown', 'touchstart']
    const drop = () => {
      for (const type of GESTURES) window.removeEventListener(type, gesture)
    }
    // Browsers keep an AudioContext suspended until a real gesture. A resume can still be
    // refused, so the listeners stay armed until one actually succeeds rather than burning
    // themselves on the first click.
    async function gesture() {
      if (await sound.unlock()) drop()
    }
    for (const type of GESTURES) window.addEventListener(type, gesture, { passive: true })
    unbind.push(drop)
  }

  engine.prefetch()
  return sound
}

export function disposeAudio() {
  for (const off of unbind) off()
  unbind = []
  sound.stopAll()
  boundBus = null
}

/** Which bus the facade is currently listening on; null before initAudio. */
export function audioBus() {
  return boundBus
}
