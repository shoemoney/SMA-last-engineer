/**
 * voiceDirector.js — one mouth, 24 lines.
 *
 * Jeremy talks through a single speaking slot. The original had no slot, no queue, no priority
 * and no cooldown of any kind (spec/audio.md §1): every line was an un-stoppable fire-and-forget
 * play, which is why the 4.720 s opening line and the wave-start line both begin at t = 0.000
 * (§8.4) and why "platform clear" is still talking when "nine" arrives (§7.4). The only rules the
 * original DID have are reproduced exactly:
 *
 *   - the death line is latched behind a one-shot boolean, so repeated death events cannot
 *     re-trigger it (§6);
 *   - the countdown speaker hard-ignores anything outside 1..10, so the countdown stops speaking
 *     one full second before the wave starts (§6);
 *   - every line plays at gain 1.0 and playback rate 1.0, with no variants and no pitch jitter.
 *
 * Everything else here is the port's single-speaker channel, which spec/audio.md §9.3 names as
 * the minimum structure that fixes the audible defects without changing any number.
 *
 * No Web Audio, no DOM, no three.js: playback arrives as an injected `play2D`, so the whole
 * priority and cooldown model runs in node.
 */

import { AUDIO, WAVES } from '../game/rules.js'
import { COUNTDOWN_LINES, VO_COOLDOWNS, VO_ONCE_PER_RUN, VO_SUBTITLES, voPriority } from './cues.js'

/** Bus event the HUD subscribes to for subtitle text. Import it rather than retyping the string. */
export const EV_SUBTITLE = 'audio:subtitle'

const COUNTDOWN_SET = new Set(Object.values(COUNTDOWN_LINES))

/**
 * How long a line that lost the slot stays worth saying.
 *
 * A countdown number is stale the moment the next one is due, because the HUD is already drawing
 * the new number and hearing "nine" over "eight" is worse than not hearing "nine" at all. Every
 * other line is given its own length: a line that could not start within its own duration has
 * been overtaken by whatever is still speaking.
 */
function relevanceWindow(line) {
  if (COUNTDOWN_SET.has(line)) return WAVES.countdownTickInterval
  return AUDIO.VO_CLIPS[line]?.seconds ?? WAVES.countdownTickInterval
}

export function createVoiceDirector({ play2D, bus = null, canSpeak = () => true } = {}) {
  if (typeof play2D !== 'function') {
    throw new Error('[voice] createVoiceDirector needs a play2D(line, options) function')
  }

  /** The single speaking slot. Null means the mouth is free. */
  let slot = null
  /** Lines that lost the slot and are still inside their relevance window. */
  const queue = []
  const spoken = new Set()
  const cooldowns = new Map()
  const subtitleListeners = new Set()
  const warnedUnknown = new Set()

  function emitSubtitle(payload) {
    bus?.emit(EV_SUBTITLE, payload)
    for (const fn of subtitleListeners) {
      try {
        fn(payload)
      } catch (err) {
        console.error('[voice] subtitle listener threw', err)
      }
    }
  }

  function clearSubtitle() {
    emitSubtitle({ line: null, text: '', seconds: 0 })
  }

  function endSlot() {
    if (!slot) return
    slot = null
    clearSubtitle()
  }

  function start(line) {
    if (!canSpeak()) return false
    if (slot) {
      // A higher-priority line has taken the mouth. Cut the current one rather than layering,
      // which is the entire point of the single slot.
      slot.handle?.stop?.()
      slot = null
    }

    if (VO_ONCE_PER_RUN.has(line)) spoken.add(line)
    const cooldown = VO_COOLDOWNS[line]
    if (cooldown != null) cooldowns.set(line, cooldown)

    const seconds = AUDIO.VO_CLIPS[line]?.seconds ?? 0
    const handle = play2D(line, { volume: AUDIO.VOICE.volume, pitch: AUDIO.DEFAULTS.uiPitch })

    // The clip length from rules.js is the source of truth for when the slot frees, so the queue
    // drains identically in node where there is no audio at all. A real handle finishing early
    // (a decode that came back short, a stolen voice) releases the slot ahead of that.
    slot = { line, remaining: seconds, handle }
    handle?.whenEnded?.(() => {
      if (slot?.handle === handle) endSlot()
    })

    emitSubtitle({ line, text: VO_SUBTITLES[line] ?? '', seconds })
    return true
  }

  function enqueue(line) {
    const existing = queue.findIndex((q) => q.line === line)
    // Re-requesting a queued line refreshes its deadline instead of stacking a duplicate; two
    // copies of one line can never be useful through a single-slot channel.
    if (existing >= 0) {
      queue[existing].deadline = relevanceWindow(line)
      return false
    }
    queue.push({ line, priority: voPriority(line), deadline: relevanceWindow(line) })
    return false
  }

  const director = {
    /**
     * Request a line. Returns true if it started speaking immediately, false if it was queued,
     * latched, on cooldown or unknown.
     */
    say(line) {
      if (!canSpeak()) return false
      if (!(line in VO_SUBTITLES)) {
        if (!warnedUnknown.has(line)) {
          warnedUnknown.add(line)
          console.warn(`[voice] "${line}" is not one of the 24 shipped voice lines — ignoring`)
        }
        return false
      }
      if (VO_ONCE_PER_RUN.has(line) && spoken.has(line)) return false
      if ((cooldowns.get(line) ?? 0) > 0) return false

      if (!slot) return start(line)
      if (voPriority(line) < voPriority(slot.line)) return start(line)
      return enqueue(line)
    },

    /**
     * The intermission speaker. Out-of-range numbers are dropped without a warning because that
     * is the documented shipped behaviour, not a mistake: the countdown is driven from 10 down
     * to 0 and the request for 0 is expected to be ignored (spec/audio.md §6).
     */
    sayCountdown(n) {
      const value = Math.round(Number(n))
      if (!Number.isFinite(value)) return false
      if (value < AUDIO.VOICE.countdownMinSpeakable || value > AUDIO.VOICE.countdownMaxSpeakable) return false
      return director.say(COUNTDOWN_LINES[value])
    },

    /** Start of a wave: boss waves get the boss line instead, never both (spec/audio.md §6). */
    sayWaveStart(bossCount = 0) {
      return director.say(bossCount > 0 ? AUDIO.VOICE.bossIncomingLine : AUDIO.VOICE.waveStartLine)
    },

    /** Drive from the game loop. Nothing here needs wall-clock time, so the soak advances it too. */
    update(dt) {
      if (!(dt > 0)) return

      for (const [line, left] of cooldowns) {
        const next = left - dt
        if (next <= 0) cooldowns.delete(line)
        else cooldowns.set(line, next)
      }

      if (slot) {
        slot.remaining -= dt
        if (slot.remaining <= 0) endSlot()
      }

      for (const entry of queue) entry.deadline -= dt

      // The pop happens BEFORE stale entries are dropped, so a line whose window expires on the
      // exact tick the slot frees still gets to speak. Without that, the coarser the timestep the
      // more lines fall through the crack between the two.
      if (!slot && queue.length > 0) {
        let best = 0
        for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i
        start(queue.splice(best, 1)[0].line)
      }

      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].deadline <= 0) queue.splice(i, 1)
      }
    },

    /** Subscribe to subtitle changes without going through the bus (the HUD may prefer either). */
    onSubtitle(fn) {
      subtitleListeners.add(fn)
      return () => subtitleListeners.delete(fn)
    },

    /** Cut whatever is speaking and forget the queue. Used on a state change back to the menu. */
    silence() {
      slot?.handle?.stop?.()
      queue.length = 0
      endSlot()
    },

    /** New run: the death and intro latches lift, cooldowns clear. */
    reset() {
      director.silence()
      spoken.clear()
      cooldowns.clear()
      warnedUnknown.clear()
    },

    /** For the verification harness and tests. */
    state() {
      return {
        speaking: slot?.line ?? null,
        remaining: slot?.remaining ?? 0,
        queued: queue.map((q) => q.line),
        latched: [...spoken],
        cooling: [...cooldowns.keys()],
        subtitle: slot ? (VO_SUBTITLES[slot.line] ?? '') : '',
      }
    },
  }

  return director
}
