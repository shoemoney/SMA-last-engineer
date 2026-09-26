/**
 * Pistol voice headroom under dual wield.
 *
 * weapon.js WeaponSystem#startFire() (see the comment above it) is explicit: the primary
 * receives EVERY press, never gated by the fireLeftNext alternation, and the left pistol
 * joins every other press. Neither gun's cooldown is affected by the other's — they are two
 * independent Weapon instances (primary + `this.left`, both built from WEAPONS.PISTOL), each
 * capable on its own of reaching 1/fireInterval shots/sec. So the alternation does not trade
 * output between the two guns, it ADDS a second emitter on top of the first: the worst-case
 * combined rate for the shared `pistol_shot` cue is bounded by two independent pistols firing
 * at their own cap, not by one pistol's solo rate.
 *
 * This pins the required voice pool to that combined rate, derived from the real constants
 * (clip length, fire interval, and "dual wield is exactly two pistols") rather than a bare
 * number, so a change to the clip or the fire rate moves the requirement instead of silently
 * invalidating it.
 */
import { describe, it, expect } from 'vitest'
import { AUDIO, WEAPONS } from '../src/game/rules.js'
import { cueVoiceLimit } from '../src/audio/cues.js'

describe('pistol voice pool vs dual-wield fire rate', () => {
  it('covers a full clip at the combined dual-wield rate, not just one gun', () => {
    // Dual wield is always exactly one primary pistol plus one left pistol (weapon.js
    // WeaponSystem#left) — never more, never fewer — so this is a structural fact about the
    // feature, not a tunable rate.
    const independentPistols = 2
    const clipSeconds = AUDIO.CUES[WEAPONS.PISTOL.fireSound].seconds
    const soloRate = 1 / WEAPONS.PISTOL.fireInterval // shots/sec one gun can sustain
    const combinedRate = independentPistols * soloRate // worst case: both guns saturated

    const requiredVoices = Math.ceil(clipSeconds * combinedRate)
    const actualLimit = cueVoiceLimit(WEAPONS.PISTOL.fireSound)

    expect(actualLimit, `pistol_shot needs ${requiredVoices} voices for ${clipSeconds}s clips ` +
      `at ${combinedRate}/s combined dual-wield rate, but the cue sheet only grants ${actualLimit}`
    ).toBeGreaterThanOrEqual(requiredVoices)
  })
})
