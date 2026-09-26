/**
 * cues.js — the cue sheet, as data.
 *
 * Every sound the game can make is named here exactly once, together with the file it resolves
 * to, the bus it belongs on and how many copies of it may be alive at the same time. Nothing in
 * this file touches Web Audio, the DOM or a clock, so the wave director and the voice director
 * can both be reasoned about (and tested) without a browser.
 *
 * Cue names and measured durations come from AUDIO.CUES and AUDIO.VO_CLIPS.
 * These include the original recordings and the Last Engineer combat additions.
 * Tests and the asset audit check the registry against the files on disk.
 *
 * The original had no cue sheet at all: it built a "Category/Name" string at the call site and
 * cached the result of the lookup, including the failures (spec/audio.md §1). A typo therefore
 * produced a weapon that fired silently. Here a typo produces one loud console warning.
 */

import { AUDIO, WEAPONS, ZOMBIES } from '../game/rules.js'

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

/** Names of every clip that actually ships, keyed for O(1) membership tests. */
const SFX_NAMES = Object.keys(AUDIO.CUES)
const VO_NAMES = Object.keys(AUDIO.VO_CLIPS)

export const SHIPPED_CUES = Object.freeze(new Set([...SFX_NAMES, ...VO_NAMES]))
export const VO_LINES = Object.freeze([...VO_NAMES])

/**
 * rules.js states the audio root as a site-absolute path (`/game/audio/...`), which stops
 * resolving the moment the build is served from a sub-path — a Pages deploy, a preview URL, a
 * game embedded under /play/. Re-resolving the same path against the document base keeps it
 * relative to the page and is byte-identical at a root deploy, so nothing is lost by doing it.
 */
function resolveUrl(path) {
  if (typeof document === 'undefined' || !document.baseURI) return path
  return new URL(path.replace(/^\/+/, ''), document.baseURI).href
}

function buildUrl(name, category) {
  const dir = AUDIO.CATEGORY_PATHS[category]
  if (!dir) throw new Error(`[cues] ${name} names category "${category}", which rules.js does not define`)
  return resolveUrl(`${dir}/${name}${AUDIO.fileExtension}`)
}

/** cue name -> { url, seconds, category, bus, orphan } for all registered clips. */
export const CUES = Object.freeze(
  Object.fromEntries([
    ...SFX_NAMES.map((name) => {
      const clip = AUDIO.CUES[name]
      return [
        name,
        Object.freeze({
          name,
          url: buildUrl(name, clip.category),
          seconds: clip.seconds,
          category: clip.category,
          bus: clip.category === 'ambience' ? 'ambience' : 'sfx',
          orphan: clip.orphan === true,
        }),
      ]
    }),
    ...VO_NAMES.map((name) => {
      const clip = AUDIO.VO_CLIPS[name]
      return [
        name,
        Object.freeze({
          name,
          url: buildUrl(name, 'vo'),
          seconds: clip.seconds,
          category: 'vo',
          bus: 'voice',
          orphan: clip.orphan === true,
        }),
      ]
    }),
  ])
)

const warnedMissing = new Set()

/**
 * The single resolution point. Returns null for an unknown name rather than throwing, because a
 * missing cue must never take the frame down — but it warns once per name so a typo surfaces in
 * the console instead of presenting as a gun that happens to be quiet.
 */
export function resolveCue(name) {
  const cue = CUES[name]
  if (cue) return cue
  if (name != null && !warnedMissing.has(name)) {
    warnedMissing.add(name)
    console.warn(`[audio] no cue named "${name}" — nothing will play. Known cues:`, Object.keys(CUES).join(', '))
  }
  return null
}

// ---------------------------------------------------------------------------
// Polyphony ceilings
// ---------------------------------------------------------------------------

/**
 * Per-cue voice limits. The original had none at all (spec/audio.md §1), which is how §3.5
 * measures 8 concurrent copies of an 8.351 s explosion from one shotgun pull and §4.2 measures
 * roughly 60 overlapping swipes per second per zombie.
 *
 * Rather than invent a ceiling per cue, each one is DERIVED from a number rules.js already
 * carries: how many copies the game can legitimately have in flight. A weapon cue is bounded by
 * its own fire interval, the explosion by the pellets a single trigger pull can detonate, and a
 * cue that plays once per arriving train by one. Everything unlisted inherits the global pool,
 * which is what the original effectively had.
 */
function overlapsWithin(seconds, interval) {
  return clampToPool(Math.ceil(seconds / interval))
}

function clampToPool(n) {
  return Math.max(1, Math.min(AUDIO.MIX.maxSimultaneousVoices, n))
}

const VOICE_LIMITS = Object.freeze({
  pistol_suppressed: overlapsWithin(AUDIO.CUES.pistol_suppressed.seconds, WEAPONS.PISTOL.fireInterval / 2),
  // The off-hand pistol fires on a trigger EDGE and ADDS output rather than trading it: the
  // primary receives every press regardless of the fireLeftNext alternation (weapon.js
  // WeaponSystem#startFire), and the left pistol joins every other press on its own
  // independent cooldown. Dual wield is exactly two pistols, so the cue this shot shares has
  // to cover both guns saturated at once, using the current recording duration.
  [WEAPONS.PISTOL.fireSound]: overlapsWithin(AUDIO.CUES[WEAPONS.PISTOL.fireSound].seconds, WEAPONS.PISTOL.fireInterval / 2),
  // A held rifle trigger may overlap several recording tails.
  [WEAPONS.RIFLE.fireSound]: overlapsWithin(AUDIO.CUES[WEAPONS.RIFLE.fireSound].seconds, WEAPONS.RIFLE.fireInterval),
  [WEAPONS.SHOTGUN.fireSound]: overlapsWithin(AUDIO.CUES[WEAPONS.SHOTGUN.fireSound].seconds, WEAPONS.SHOTGUN.fireInterval),
  // One detonation per connecting pellet, all in the same frame, so the pellet count IS the ceiling.
  explosion: clampToPool(WEAPONS.SHOTGUN.pelletCount),
  // A second arrival can only mean the first train has been replaced; 16.195 s of the last one is
  // still playing when it happens (spec/audio.md §5.2).
  [AUDIO.TRAIN.arrivingCue]: 1,
  [AUDIO.AMBIENCE.cue]: 1,
})

export function cueVoiceLimit(name) {
  if (name in VOICE_LIMITS) return VOICE_LIMITS[name]
  // The voice director owns a single speaking slot, so a second copy of a line is always a bug.
  if (CUES[name]?.bus === 'voice') return 1
  return AUDIO.MIX.maxSimultaneousVoices
}

// ---------------------------------------------------------------------------
// Variant pools
// ---------------------------------------------------------------------------

function variantNames(prefix, min, max) {
  const out = []
  for (let n = min; n <= max; n++) out.push(`${prefix}${n}`)
  return Object.freeze(out)
}

export const GROWL_CUES = variantNames('zombie_growl_', ZOMBIES.SOUND.growlVariantMin, ZOMBIES.SOUND.growlVariantMax)
export const DEATH_CUES = variantNames('zombie_death_', ZOMBIES.SOUND.deathVariantMin, ZOMBIES.SOUND.deathVariantMax)
export const SWIPE_CUE = 'zombie_attack_swipe'

/**
 * The cues rules.js names only as keys of AUDIO.CUES, because the C++ built their lookup strings
 * inline at the call site. Spelled once here so nothing downstream types a cue name.
 */
export const RELOAD_CUE = 'magazine_reload'
export const DRY_FIRE_CUE = 'empty_chamber_click'
export const EXPLOSION_CUE = 'explosion'

export const COUNTDOWN_LINES = Object.freeze(
  Object.fromEntries(
    Array.from(
      { length: AUDIO.VOICE.countdownMaxSpeakable - AUDIO.VOICE.countdownMinSpeakable + 1 },
      (_, i) => AUDIO.VOICE.countdownMinSpeakable + i
    ).map((n) => [n, `vo_countdown_${n}`])
  )
)

/** modId -> voice line, plus dual wield, which rides alongside the mod bits but is not one. */
export const MOD_LINES = Object.freeze({ ...AUDIO.VOICE.modLines, dualWield: AUDIO.VOICE.dualWieldLine })

/**
 * Clips that are on disk and stay deliberately silent. rules.js wires the other ten orphans
 * (train_doors_open and the nine unused voice lines); these two it does not, and inventing a
 * trigger for them would mean inventing a constant to hang it on. spec/audio.md §9.5 sketches
 * homes for both — a boss-wave siren and a boss-spawn scream — if a future pass wants to add the
 * rules entries first.
 */
export const UNWIRED_CUES = Object.freeze(['alarm_siren', 'zombie_scream'])

// ---------------------------------------------------------------------------
// Voice-over: priority, and what Jeremy actually says
// ---------------------------------------------------------------------------

/**
 * Speaking order, highest priority first. The original had no priority at all — every line was
 * an un-stoppable fire-and-forget play, which is why spec/audio.md §8.4 has the 4.720 s opening
 * line and the wave-start line both starting at t = 0.000, and §7.4 has "wave clear" still
 * talking when "nine" arrives.
 *
 * This is an ORDER, not a set of tunable numbers, so it lives with the cue sheet the way
 * WEAPONS.MOD_BADGE_ORDER lives with the mods. The shape of it: the run ending outranks
 * everything, then anything that changes what the player must do right now, then status, then
 * the countdown — which is the only stream where dropping a line is harmless, because the HUD
 * is already drawing the same number.
 */
export const VO_PRIORITY = Object.freeze([
  AUDIO.VOICE.gameOverLine,
  AUDIO.VOICE.bossIncomingLine,
  AUDIO.VOICE.waveClearLine,
  AUDIO.VOICE.introLine,
  AUDIO.VOICE.waveStartLine,
  AUDIO.VOICE.lowHealthLine,
  AUDIO.VOICE.trainInboundLine,
  AUDIO.VOICE.dualWieldLine,
  AUDIO.VOICE.modLines.incendiary,
  AUDIO.VOICE.modLines.armorPiercing,
  AUDIO.VOICE.modLines.laserSight,
  AUDIO.VOICE.modLines.silencer,
  AUDIO.VOICE.healthPickupLine,
  AUDIO.VOICE.armorPickupLine,
  ...Object.values(COUNTDOWN_LINES).reverse(),
])

const PRIORITY_INDEX = new Map(VO_PRIORITY.map((line, i) => [line, i]))

/** Lower is louder. An unlisted line sorts below every listed one rather than above. */
export function voPriority(line) {
  return PRIORITY_INDEX.has(line) ? PRIORITY_INDEX.get(line) : VO_PRIORITY.length
}

/**
 * The intro uses the supplied Last Engineer script and a JeremySay recording.
 * Other lines were transcribed from the original recordings with whisper.cpp.
 */
export const VO_SUBTITLES = Object.freeze({
  vo_intro: 'One day I woke up... it was dark... and I realized... I was the last engineer.',
  vo_wave_start: 'Here they come.',
  vo_boss_incoming: 'Something big just got off that train.',
  vo_wave_clear: 'Platform clear. That’s the whole train.',
  vo_game_over: 'That’s it for me. Hit restart.',
  vo_countdown_10: 'Ten.',
  vo_countdown_9: 'Nine.',
  vo_countdown_8: 'Eight.',
  vo_countdown_7: 'Seven.',
  vo_countdown_6: 'Six.',
  vo_countdown_5: 'Five.',
  vo_countdown_4: 'Four.',
  vo_countdown_3: 'Three.',
  vo_countdown_2: 'Two.',
  vo_countdown_1: 'One.',
  vo_health_pickup: 'OHHH THAT’S THE STUFF!!!',
  vo_armor_pickup: 'Armor Baby!',
  vo_dual_wield: 'Now we’re talking — two pistols.',
  vo_low_health: 'I’m hit bad. I need a medkit.',
  vo_train_inbound: 'Next train inbound. Get ready.',
  vo_mod_armorpierce: 'Armor piercing. Nothing’s safe.',
  vo_mod_incendiary: 'Incendiary rounds loaded.',
  vo_mod_laser: 'Laser sight. No more missing.',
  vo_mod_silencer: 'Silencer on. Let’s do this quietly.',
})

/**
 * Lines that may be spoken at most once per run. The original latched only the death line, with
 * an explicit one-shot boolean (spec/audio.md §6); the opening line is latched here too because
 * §6 states it "fires exactly once per session" and the port can re-enter the play state from
 * the menu, which the original could not.
 */
export const VO_ONCE_PER_RUN = Object.freeze(new Set([AUDIO.VOICE.gameOverLine, AUDIO.VOICE.introLine]))

/** The only per-line cooldown that exists anywhere in the ruleset. */
export const VO_COOLDOWNS = Object.freeze({ [AUDIO.VOICE.lowHealthLine]: AUDIO.VOICE.lowHealthCooldown })
