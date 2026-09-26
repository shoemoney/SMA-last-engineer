/**
 * Every mod must be spelled out somewhere the player can read it.
 *
 * The chips on the HUD are three-letter codes (SIL, AP, INC, EXP, LAS) and that is fine — a
 * persistent readout should be terse. The defect was that the ONE moment the game explains a
 * mod, the pickup banner, printed the same three letters: "SIL ONLINE". The abbreviation was
 * introduced by the abbreviation, and the word "silencer" appeared nowhere in the game.
 */
import { describe, it, expect } from 'vitest'
import { WEAPONS } from '../src/game/rules.js'

describe('mods are spelled out before they are abbreviated', () => {
  const ids = Object.keys(WEAPONS.MODS)

  it('there are mods to check', () => expect(ids.length).toBeGreaterThan(0))

  for (const id of ids) {
    it(`${id} has a full name that is not just its chip code`, () => {
      const mod = WEAPONS.MODS[id]
      expect(mod.name, `${id} has no readable name`).toBeTruthy()
      expect(mod.name, `${id}'s name is the abbreviation again`).not.toBe(mod.label)
      expect(mod.name.length, `${id}'s name is no longer than its chip code`)
        .toBeGreaterThan(mod.label.length)
    })
  }

  it('every chip code is an abbreviation OF its name, not an unrelated string', () => {
    for (const id of ids) {
      const { label, name } = WEAPONS.MODS[id]
      const initials = name.split(/[\s-]+/).map(w => w[0]).join('')
      const isPrefix = name.replace(/[\s-]/g, '').startsWith(label)
      expect(initials === label || isPrefix, `${label} does not abbreviate "${name}"`).toBe(true)
    }
  })
})
