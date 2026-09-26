import { AUDIO, DAMAGE, SCORE } from '../game/rules.js'
import { SCORE_REASON } from '../game/scoring.js'
import { EV } from '../core/events.js'

/** One pending award, one speaking slot, and a bounded simulation-time casing queue. */
export function createCombatFeedback({ play, emit, silenceNarration, isSilent = () => false, canHurt = () => true, random = Math.random }) {
  const rules = AUDIO.COMBAT
  let active = null, pending = null, painCooldown = 0, lastPain = -1
  let lastChain = 0, tier = 0, chainLife = 0, splatCooldown = 0, sequence = 0, dead = false
  const casings = []

  function finish(id) {
    if (active?.id !== id) return
    const ended = active
    active = null
    if (ended.text) emit(EV.COMBAT_CALLOUT, { id, text: ended.text, phase: 'end', seconds: 0, audible: ended.audible })
  }
  function stop() {
    if (!active) return
    const old = active
    finish(old.id)
    old.handle?.stop?.()
  }
  function start(cue, text, priority) {
    if (active && active.priority >= priority) return false
    const fallback = isSilent(cue)
    // Do not interrupt current speech for an undecoded or temporarily unavailable clip.
    const handle = fallback ? null : play(cue, { volume: AUDIO.VOICE.volume, pitch: 1 })
    if (!handle && !fallback) return false
    stop()
    silenceNarration()
    const seconds = handle?.seconds ?? AUDIO.VO_CLIPS[cue].seconds
    const id = ++sequence
    active = { id, cue, text, priority, handle, seconds, remaining: seconds, audible: !!handle }
    if (text) emit(EV.COMBAT_CALLOUT, { id, text, seconds, phase: 'start', audible: !!handle })
    handle?.whenEnded?.(() => finish(id))
    return true
  }
  function award(cue, text, priority) {
    if (dead || (pending && pending.priority >= priority)) return
    pending = { cue, text, priority, remaining: rules.pendingSeconds }
  }
  return {
    get speaking() { return active !== null },
    score(p = {}) {
      if (dead || p.reason !== SCORE_REASON.kill || !Number.isFinite(p.chain)) return
      const run = p.chain + 1
      if (run === lastChain && run > 1 && chainLife > 0) return
      if (run < lastChain || chainLife <= 0) tier = 0
      lastChain = run
      chainLife = SCORE.comboWindow
      if (p.zone === DAMAGE.zones.head) award('vo_headshot', 'HEADSHOT!!', 1)
      for (let i = rules.milestones.length - 1; i >= 0; i--) {
        const entry = rules.milestones[i]
        if (run >= entry.kills && entry.kills > tier) {
          tier = entry.kills
          award(entry.cue, entry.text, i + 2)
          break
        }
      }
    },
    hurt(p = {}) {
      if (!canHurt() || dead || !(p.damage > 0) || !(p.health > 0) || painCooldown > 0 || active || pending) return
      const count = rules.hurtCues.length
      let pick = Math.floor(random() * (lastPain < 0 ? count : count - 1))
      if (lastPain >= 0 && pick >= lastPain) pick++
      pick = Math.min(count - 1, pick)
      if (start(rules.hurtCues[pick], '', 0)) {
        lastPain = pick
        painCooldown = rules.hurtCooldown
      }
    },
    silenceHurt() {
      if (active && rules.hurtCues.includes(active.cue)) stop()
      painCooldown = 0
    },
    headHit(p = {}) {
      if (dead || p.zone !== DAMAGE.zones.head || !(p.damage > 0) || splatCooldown > 0) return
      play('headshot_splat', { position: p.position ?? p.pos ?? null, volume: rules.splatVolume, pitch: 1 })
      splatCooldown = rules.splatCooldown
    },
    fire(p = {}, position = null) {
      if (dead) return
      if (casings.length >= rules.maxCasings) casings.shift()
      casings.push({ remaining: rules.casingDelay[p.weapon] ?? rules.casingDelay.pistol, position: position ? [...position] : null })
    },
    update(dt) {
      if (!(dt > 0)) return
      painCooldown = Math.max(0, painCooldown - dt)
      splatCooldown = Math.max(0, splatCooldown - dt)
      chainLife = Math.max(0, chainLife - dt)
      if (active) {
        active.remaining -= dt
        if (active.remaining <= 0) { const old = active; finish(old.id); old.handle?.stop?.() }
      }
      for (let i = casings.length - 1; i >= 0; i--) {
        const casing = casings[i]
        casing.remaining -= dt
        if (casing.remaining <= 0) {
          play('bullet_casing', { position: casing.position, volume: rules.casingVolume, pitch: 0.94 + random() * 0.12 })
          casings.splice(i, 1)
        }
      }
      if (pending) {
        pending.remaining -= dt
        if (pending.remaining <= 0) pending = null
        else if (start(pending.cue, pending.text, pending.priority)) pending = null
      }
    },
    reset({ lethal = false } = {}) {
      stop()
      pending = null
      casings.length = 0
      painCooldown = splatCooldown = chainLife = lastChain = tier = 0
      lastPain = -1
      dead = lethal
    },
    state: () => ({ active: active?.cue ?? null, pending: pending?.cue ?? null, casings: casings.length, dead }),
  }
}
