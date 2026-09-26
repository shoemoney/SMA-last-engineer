/**
 * mods.js — the weapon-side face of the four mods.
 *
 * A mod changes three separable things, and only one of them is damage:
 *
 *   1. what the damage pipeline produces  -> src/game/damage.js owns it
 *   2. how wide the pellet cone is        -> src/game/damage.js owns it
 *   3. how loud and how bright it reads   -> nobody owned it, so it lives here
 *
 * Which makes this module thin on purpose. It re-exports the bitmask helpers so weapons
 * have one import instead of two, and it adds the presentation layer the pure damage model
 * has no business knowing about: gain, pitch, shake scale and which muzzle-flash profile to
 * burn. There is no arithmetic on a damage number anywhere below this line — if one ever
 * appears, the port has two damage models and they will drift.
 *
 * Mods live on the PLAYER, not the weapon, and can never be removed, which is why every
 * entry point takes the mask as an argument instead of holding one.
 */
import { FX, WEAPONS } from '../game/rules.js'
import {
  MOD,
  MOD_BY_ID,
  ZONE,
  activeModIds,
  addMod,
  hasMod,
  damageNumberValue,
  resolveShot,
  spreadHalfAngleDeg,
  spreadHalfAngleRad,
  zoneFromBoneName,
} from '../game/damage.js'

export {
  MOD,
  MOD_BY_ID,
  ZONE,
  activeModIds,
  addMod,
  hasMod,
  damageNumberValue,
  spreadHalfAngleDeg,
  spreadHalfAngleRad,
  zoneFromBoneName,
}

const { MODS, MOD_BADGE_ORDER, FIRE_AUDIO, dualWieldBadgeLabel } = WEAPONS

/** Mod ids in HUD badge order, minus the dual-wield pseudo-badge, which is not a bit. */
export const MOD_IDS = Object.freeze(MOD_BADGE_ORDER.filter((id) => MOD_BY_ID[id] !== undefined))

/**
 * Pickups identify the mod they grant by id, not by bit, so a typo in a pickup table would
 * otherwise OR in a zero and silently grant nothing at all.
 */
export function modBitOf(id) {
  const bit = MOD_BY_ID[id]
  if (bit === undefined) {
    console.warn(`[mods] unknown mod id "${id}" — nothing granted; expected one of ${MOD_IDS.join(', ')}`)
    return MOD.NONE
  }
  return bit
}

/** HUD badge row, already in the right-to-left draw order the HUD lays out. */
export function modBadges(mask, dualWield = false) {
  const labels = []
  for (const id of MOD_BADGE_ORDER) {
    if (id === 'dualWield') {
      if (dualWield) labels.push(dualWieldBadgeLabel)
    } else if (hasMod(mask, MOD_BY_ID[id])) {
      labels.push(MODS[id].label)
    }
  }
  return labels
}

/**
 * Everything a shot's presentation needs, resolved once per trigger pull.
 *
 * The audio layer selects a dedicated quiet pistol recording. Suppression also reduces
 * camera shake and gives the muzzle flash a short, cold-blue profile.
 */
export function firePresentation(mask, random) {
  const suppressed = hasMod(mask, MOD.SILENCER)
  return {
    suppressed,
    volume: suppressed ? FIRE_AUDIO.suppressedVolume : FIRE_AUDIO.normalVolume,
    pitch: suppressed
      ? FIRE_AUDIO.suppressedPitch
      : random.range(FIRE_AUDIO.normalPitchMin, FIRE_AUDIO.normalPitchMax),
    shakeScale: suppressed ? FX.SHAKE.scaleSuppressedShot : FX.SHAKE.scaleNormalShot,
    flash: suppressed ? FX.MUZZLE.suppressed : FX.MUZZLE.normal,
  }
}

/**
 * The single seam between a weapon and the damage model. Zone scaling,
 * the burn stack and the armor-piercing flag are all decided on the far side
 * of this call, in a module that cannot import three.js.
 */
export function resolveModdedShot(baseDamage, zone, mask) {
  return resolveShot(baseDamage, zone, mask | 0)
}
