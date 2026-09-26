/**
 * The in-game HUD.
 *
 * DOM and CSS only — this file must never import three.js (CONTRACT.md). It
 * binds to the ids already in index.html and the classes already in
 * styles.css; the two readouts this file OWNS outright — the Conductor's health
 * bar and the kill-feedback stack — bring their own markup and their own sheet
 * (./hud-extra.css), because a readout that only exists while a Conductor is
 * breathing has no business being static markup, and because index.html and
 * styles.css are single-owner files this round.
 *
 * The original HUD was immediate-mode: it re-read the player every frame and
 * drew from scratch. That shape is preserved here as `hud.update(snapshot)`,
 * which main.js may call every frame with the whole player state. The event
 * bus drives the punctual feedback on top of it (hit markers, banners, the
 * damage flash), so the HUD still reads correctly if nothing ever calls
 * update().
 *
 * Snapshot shape — every field optional, last value sticks:
 *   { health, armor, maxHealth, overhealCap, maxArmor, overArmorCap,
 *     dead, burning, wave, zombiesRemaining, countdown, intermission, score,
 *     weapon: { name, mag, reserve, dry }, mods, dualWield }
 * `mods` is either the bitmask from ShoeCharacter or a list/Set of mod ids.
 */

import { HEALTH, HUD, FX, WEAPONS, AUDIO, ZOMBIES, SCORE, DAMAGE } from '../game/rules.js'
import { EV } from '../core/events.js'
import { SCORE_REASON } from '../game/scoring.js'
import { byId, clamp, hex, formatNumber } from './screens.js'
import HUD_EXTRA_CSS from './hud-extra.css?raw'

/** index.html hardcodes the same root on the favicon, the portrait and the menu logo. */
const IMG_ROOT = './game/img'

const CONDITION_ORDER = Object.freeze(['confident', 'steady', 'hurt', 'critical', 'dead'])

/** The bar's soft-cap run and its overfill headroom, in the original's pixels. */
const OVERFILL_WIDTH = HUD.barWidth * HUD.overfillFraction
const BAR_TOTAL_WIDTH = HUD.barWidth + OVERFILL_WIDTH

/**
 * The C++ drew four nested edge bands; they all overlap at the outermost pixel,
 * so the alpha the player actually sees at the screen edge is their sum.
 * One CSS radial-gradient reproduces that read without the banding.
 */
const FLASH_EDGE_ALPHA = (() => {
  const f = FX.DAMAGE_FLASH
  let sum = 0
  for (let band = 0; band < f.vignetteBandCount; band++) {
    sum += (1 - band / f.vignetteBandCount) * f.vignetteAlphaScale
  }
  return sum
})()

/** Presentation only, in the same register as the px values in styles.css: the burn glow's blur radius. */
const BURN_GLOW_PX = 34

const EXTRA_STYLE_ID = 'hud-extra-style'

/**
 * The climb readout.
 *
 * Both belong to the storey above the mezzanine, which did not exist when index.html and
 * styles.css were written — and both of those are single-owner files this round, exactly as
 * hud-extra.css says of the Conductor bar. So this sheet ships the same way that one does:
 * as a string, injected once, under its own id.
 *
 * The gauge is deliberately a RAIL and not a number. "690 cm" tells a player nothing; three
 * ticks with a bead sliding between them tells them there is a storey above the one they
 * are standing on, which is the whole problem the roost was built to solve — nothing in the
 * station pointed up.
 */
const ROOST_STYLE_ID = 'hud-roost-style'
const ROOST_CSS = `
.hud .climb {
  position: absolute;
  left: 26px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: stretch;
  gap: 10px;
  opacity: 0;
  pointer-events: none;
}
.hud .climb__rail {
  position: relative;
  width: 5px;
  height: 188px;
  border-radius: 3px;
  background: linear-gradient(to top, rgba(255,255,255,.10), rgba(255,255,255,.04));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.55);
}
.hud .climb__fill {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: calc(var(--climb, 0) * 100%);
  border-radius: 3px;
  background: linear-gradient(to top, rgba(var(--roost-rgb), .35), rgba(var(--roost-rgb), .95));
  box-shadow: 0 0 10px rgba(var(--roost-rgb), .55);
}
.hud .climb__bead {
  position: absolute;
  left: 50%;
  bottom: calc(var(--climb, 0) * 100%);
  width: 15px; height: 15px;
  margin: -7px 0 0 -7px;
  transform: rotate(45deg);
  background: var(--roost);
  box-shadow: 0 0 12px rgba(var(--roost-rgb), .8), inset 0 0 0 2px rgba(0,0,0,.45);
}
.hud .climb__ticks {
  position: relative;
  width: 150px;
  height: 188px;
  font: 700 18px/1.5 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .16em;
  color: rgba(255,255,255,.85);
  text-shadow: 0 1px 2px rgba(0,0,0,.9);
}
.hud .climb__tick {
  position: absolute;
  left: 0;
  bottom: calc(var(--at) * 100%);
  transform: translateY(50%);
  white-space: nowrap;
}
.hud .climb__tick::before {
  content: '';
  display: inline-block;
  width: 7px; height: 1px;
  margin: 0 5px 3px -5px;
  background: rgba(255,255,255,.35);
}
.hud .climb__tick.reached { color: rgba(var(--roost-rgb), .95); }
.hud .climb__tick.reached::before { background: rgba(var(--roost-rgb), .8); }
.hud .climb__stock {
  position: absolute;
  left: 0;
  bottom: 100%;
  margin-bottom: 9px;
  font: 800 18px/1.5 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .2em;
  color: var(--roost);
  text-shadow: 0 0 10px rgba(var(--roost-rgb), .6), 0 1px 2px rgba(0,0,0,.9);
  opacity: 0;
}

`

/**
 * The roost's colour, and the one number the gauge has to be told: the rail is drawn against
 * the height of the highest floor in the game, so a tick lands where the floor actually is.
 */
const ROOST_HEX = 0xf5c542
const ROOST_RGB = [(ROOST_HEX >> 16) & 255, (ROOST_HEX >> 8) & 255, ROOST_HEX & 255].join(', ')
/** Above this, in cm off the slab, the gauge is worth drawing at all. */
const CLIMB_SHOW_ABOVE = 20
/** How long a discovery's caption stays on the subtitle line. */
const DISCOVERY_SECONDS = 3.6

/**
 * The Conductor's own numbers. The bar reads the same archetype entry the model's furnace
 * glow is built from, so the fill and the light coming off the boss can never drift apart.
 */
const BOSS = ZOMBIES.ARCHETYPES.boss
const BOSS_RGB = [(BOSS.emissiveHex >> 16) & 255, (BOSS.emissiveHex >> 8) & 255, BOSS.emissiveHex & 255].join(', ')

/** The chip above the bar. The player meets five archetypes; only one of them gets a bar. */
const BOSS_TAG = 'WAVE BOSS'
const BOSS_STATE_ENGAGED = 'ENGAGED'
const BOSS_STATE_CRITICAL = 'CRITICAL — FINISH IT'

/*
 * Presentation constants, declared here for the same reason BURN_GLOW_PX is: they are
 * pixels and seconds of motion, not game rules, and rules.js is the spec-diffable file.
 */
/** One block per 5% of the Conductor's pool, so a shotgun blast visibly eats one. */
const BOSS_BAR_SEGMENTS = 20
/**
 * How long the white chase bar takes to run down onto the new health level. The speed is
 * fixed once per hit rather than re-derived per frame: re-deriving it is an exponential
 * with this as its time constant, which never actually lands.
 */
const BOSS_GHOST_CATCHUP_SECONDS = 0.55
/** Floor on that speed, in bar-fractions per second, so a small hit still closes visibly. */
const BOSS_GHOST_MIN_RATE = 0.22
/** Matches the .callout animation in hud-extra.css; a louder callout may cut in early. */
const CALLOUT_SECONDS = 0.62
/** Rows on screen at once. Deeper than this and the stack reaches the weapon readout. */
const KILL_FEED_MAX = 5
/**
 * A row outlives the chain that produced it, so when the wick runs out you can still
 * see what you had going. Derived, not picked: twice the scorer's own combo window.
 */
const KILL_ROW_LIFE_SECONDS = SCORE.comboWindow * 2

/**
 * Pellets from one shotgun blast arrive as separate EV.ZOMBIE_HIT events in the same
 * tick. Merging them inside the hit marker's own life turns eight "-70"s into the
 * one "-560" that actually happened.
 */
const BOSS_DELTA_MERGE_SECONDS = FX.HIT_MARKER.lifeSeconds

/**
 * What a zone is worth, said out loud. DAMAGE owns the multipliers, so the callout can
 * never claim a 5x the damage model does not actually apply.
 */
const ZONE_CALLOUT = Object.freeze({
  [DAMAGE.zones.head]: Object.freeze({
    label: 'HEADSHOT',
    killLabel: 'HEADSHOT KILL',
    multiplier: DAMAGE.headMultiplier,
    colorHex: FX.DAMAGE_NUMBER.colorHeadHex,
    tag: 'HEAD',
  }),
  [DAMAGE.zones.chest]: Object.freeze({
    label: 'CENTRE MASS',
    killLabel: 'CENTRE MASS KILL',
    multiplier: DAMAGE.chestMultiplier,
    colorHex: FX.DAMAGE_NUMBER.colorChestHex,
    tag: 'CHEST',
  }),
})

const BODY_ZONE_TAG = Object.freeze({ tag: 'BODY', colorHex: FX.DAMAGE_NUMBER.colorBodyHex })

/** Presentation only: the chain's colour walks the amber-to-headshot-red ramp as it climbs. */
function mixHex(a, b, t) {
  const lerp = (lo, hi) => Math.round(lo + (hi - lo) * t)
  const r = lerp((a >> 16) & 255, (b >> 16) & 255)
  const g = lerp((a >> 8) & 255, (b >> 8) & 255)
  const bl = lerp(a & 255, b & 255)
  return `rgb(${r}, ${g}, ${bl})`
}

/**
 * Builds the Conductor readout and the kill-feedback stack into the HUD root that already
 * exists, and injects their sheet.
 *
 * The sheet goes in from here rather than through a <link> in index.html so it always
 * lands after styles.css, whatever order the bundler picks for its chunks. Everything is
 * guarded so a second initHUD() adopts what is already on the page.
 */
function mountHudExtras(el) {
  if (!document.getElementById(EXTRA_STYLE_ID)) {
    const sheet = document.createElement('style')
    sheet.id = EXTRA_STYLE_ID
    sheet.textContent = HUD_EXTRA_CSS
    document.head.append(sheet)
  }

  // The banner writes into a plate instead of straight onto the element, so the boss banner
  // can carry an opaque backing that hugs its own text rather than a full-width black band
  // across the Conductor's head.
  if (el.banner) {
    el.bannerPlate = el.banner.querySelector('.hud__banner__plate')
    if (!el.bannerPlate) {
      el.bannerPlate = document.createElement('span')
      el.bannerPlate.className = 'hud__banner__plate'
      el.banner.replaceChildren(el.bannerPlate)
    }
  }

  if (!el.root) return

  // Every colour and clock the sheet needs, handed over from rules.js. Nothing tunable
  // is written down in the CSS.
  const vars = {
    '--boss': hex(BOSS.emissiveHex),
    '--boss-rgb': BOSS_RGB,
    '--boss-seg': String(BOSS_BAR_SEGMENTS),
    '--row-life': `${KILL_ROW_LIFE_SECONDS}s`,
    '--zone-head': hex(FX.DAMAGE_NUMBER.colorHeadHex),
    '--roost': hex(ROOST_HEX),
    '--roost-rgb': ROOST_RGB,
  }
  for (const [key, value] of Object.entries(vars)) el.root.style.setProperty(key, value)

  mountBossBar(el)
  mountKillFeedback(el)
  mountRoost(el)
}

/**
 * The climb gauge. Built rather than queried, for the same reason
 * the Conductor's bar is: a readout that only exists while the player is off the slab has
 * no business being static markup in a file this module does not own.
 */
function mountRoost(el) {
  if (!document.getElementById(ROOST_STYLE_ID)) {
    const sheet = document.createElement('style')
    sheet.id = ROOST_STYLE_ID
    sheet.textContent = ROOST_CSS
    document.head.append(sheet)
  }

  let climb = el.root.querySelector('.climb')
  if (!climb) {
    climb = document.createElement('div')
    climb.className = 'climb'

    const rail = document.createElement('div')
    rail.className = 'climb__rail'
    const fill = document.createElement('i')
    fill.className = 'climb__fill'
    const bead = document.createElement('b')
    bead.className = 'climb__bead'
    rail.append(fill, bead)

    const ticks = document.createElement('div')
    ticks.className = 'climb__ticks'
    const stock = document.createElement('span')
    stock.className = 'climb__stock'
    ticks.append(stock)

    climb.append(rail, ticks)
    el.root.append(climb)
  }
  el.climb = climb
  el.climbRail = climb.querySelector('.climb__rail')
  el.climbTicks = climb.querySelector('.climb__ticks')
  el.climbStock = climb.querySelector('.climb__stock')
}

function mountBossBar(el) {
  const existing = el.root.querySelector('.bossbar')
  if (!existing) {
    const bar = document.createElement('div')
    bar.className = 'bossbar'

    const head = document.createElement('div')
    head.className = 'bossbar__head'
    const tag = document.createElement('span')
    tag.className = 'bossbar__tag'
    tag.textContent = BOSS_TAG
    const name = document.createElement('span')
    name.className = 'bossbar__name'
    name.textContent = BOSS.displayName
    const hp = document.createElement('span')
    hp.className = 'bossbar__hp'
    head.append(tag, name, hp)

    const armor = document.createElement('div')
    armor.className = 'bossbar__armor'
    armor.append(document.createElement('i'))

    const rail = document.createElement('div')
    rail.className = 'bossbar__rail'
    const track = document.createElement('div')
    track.className = 'bossbar__track'
    for (const cls of ['bossbar__ghost', 'bossbar__fill', 'bossbar__edge', 'bossbar__segs', 'bossbar__flash']) {
      const layer = document.createElement('div')
      layer.className = cls
      track.append(layer)
    }
    rail.append(track)

    const foot = document.createElement('div')
    foot.className = 'bossbar__foot'
    const state = document.createElement('span')
    state.className = 'bossbar__state'
    state.textContent = BOSS_STATE_ENGAGED
    const delta = document.createElement('span')
    delta.className = 'bossbar__delta'
    foot.append(state, delta)

    bar.append(head, armor, rail, foot)
    el.root.append(bar)
  }

  el.bossBar = el.root.querySelector('.bossbar')
  el.bossName = el.root.querySelector('.bossbar__name')
  el.bossHp = el.root.querySelector('.bossbar__hp')
  el.bossArmor = el.root.querySelector('.bossbar__armor')
  el.bossState = el.root.querySelector('.bossbar__state')
  el.bossDelta = el.root.querySelector('.bossbar__delta')
}

function mountKillFeedback(el) {
  if (!el.root.querySelector('.killstack')) {
    const stack = document.createElement('div')
    stack.className = 'killstack'

    const combo = document.createElement('div')
    combo.className = 'combo'
    const mult = document.createElement('div')
    mult.className = 'combo__mult'
    const meta = document.createElement('div')
    meta.className = 'combo__meta'
    const hs = document.createElement('div')
    hs.className = 'combo__hs'
    const wick = document.createElement('div')
    wick.className = 'combo__wick'
    wick.append(document.createElement('i'))
    combo.append(mult, meta, hs, wick)

    const feed = document.createElement('div')
    feed.className = 'killfeed'

    stack.append(combo, feed)
    el.root.append(stack)
  }

  if (!el.root.querySelector('.callout')) {
    const callout = document.createElement('div')
    callout.className = 'callout'
    const zone = document.createElement('span')
    zone.className = 'callout__zone'
    const mult = document.createElement('span')
    mult.className = 'callout__mult'
    callout.append(zone, mult)
    el.root.append(callout)
  }

  if (!el.root.querySelector('.streak')) {
    const streak = document.createElement('div')
    streak.className = 'streak'
    const plate = document.createElement('span')
    plate.className = 'streak__plate'
    streak.append(plate)
    el.root.append(streak)
  }

  el.killStack = el.root.querySelector('.killstack')
  el.combo = el.root.querySelector('.combo')
  el.comboMult = el.root.querySelector('.combo__mult')
  el.comboMeta = el.root.querySelector('.combo__meta')
  el.comboHs = el.root.querySelector('.combo__hs')
  el.comboWick = el.root.querySelector('.combo__wick')
  el.killFeed = el.root.querySelector('.killfeed')
  el.callout = el.root.querySelector('.callout')
  el.calloutZone = el.root.querySelector('.callout__zone')
  el.calloutMult = el.root.querySelector('.callout__mult')
  el.streak = el.root.querySelector('.streak')
  el.streakPlate = el.root.querySelector('.streak__plate')
}

/** Crosshair arms kick out by this much per shot and slide back over the hit-marker's life. */
const SPREAD_RECOVERY_PER_SECOND = FX.HIT_MARKER.spreadPx / FX.HIT_MARKER.lifeSeconds

/**
 * The pistol, rifle and shotgun fire cones 5.3x apart (rules.js baseSpread, the cone
 * HALF-angle in degrees: pistol 1.5, rifle 2.5, shotgun 8.0), but the resting reticle used
 * to be the same four ticks for all three. This maps the HUD's own weapon label
 * (readout.weaponName, set from WEAPONS.<GUN>.displayName) back to that gun's real cone so
 * weaponSpreadDelta() below can open the reticle to match it.
 */
const WEAPON_BASE_SPREAD_DEG = new Map(
  ['PISTOL', 'RIFLE', 'SHOTGUN'].map((key) => [WEAPONS[key].displayName, WEAPONS[key].baseSpread])
)

/**
 * EV has no voice-over entry, so the voice director's event name is not fixed
 * yet. Both plausible names are bound; whichever it emits lands on the subtitle.
 */
const VOICE_EVENTS = Object.freeze(['vo:line', 'audio:vo'])

/** Spec §4: dead wins outright, armor only breaks the CONFIDENT/STEADY tie. */
function conditionFor(v) {
  if (v.dead) return HEALTH.CONDITIONS.dead
  const percent = v.maxHealth > 0 ? v.health / v.maxHealth : 0
  if (percent < HEALTH.criticalThreshold) return HEALTH.CONDITIONS.critical
  if (percent < HEALTH.hurtThreshold) return HEALTH.CONDITIONS.hurt
  return v.armor > 0 ? HEALTH.CONDITIONS.confident : HEALTH.CONDITIONS.steady
}

/**
 * Maps the original's 260 px main bar plus 91 px overfill tail onto one DOM
 * element, so the soft cap always lands at the same place along the bar and the
 * overheal reads as the last quarter rather than spilling off the element.
 */
function barFraction(current, softCap, hardCap) {
  if (softCap <= 0) return 0
  const c = clamp(current, 0, hardCap)
  const main = HUD.barWidth * clamp(c / softCap, 0, 1)
  const over = c > softCap && hardCap > softCap
    ? OVERFILL_WIDTH * clamp((c - softCap) / (hardCap - softCap), 0, 1)
    : 0
  return (main + over) / BAR_TOTAL_WIDTH
}

function modsInclude(mods, id) {
  if (typeof mods === 'number') return (mods & WEAPONS.MOD_BITS[id]) !== 0
  if (mods instanceof Set) return mods.has(id)
  if (Array.isArray(mods)) return mods.includes(id)
  if (mods && typeof mods === 'object') return !!mods[id]
  return false
}

/** Restarting a CSS animation needs the class off, a reflow, then the class back on. */
function retrigger(el, ...classes) {
  if (!el) return
  el.classList.remove(...classes)
  void el.offsetWidth
  el.classList.add(...classes)
}

export function initHUD(bus) {
  const el = {
    root: byId('hud'),
    vignette: byId('vignette'),
    crosshair: byId('crosshair'),
    hitmarker: byId('hitmarker'),
    waveLabel: byId('wave-readout')?.querySelector('.wave__label') ?? null,
    waveNum: byId('wave-num'),
    waveLeft: byId('wave-left'),
    scoreVal: byId('score-val'),
    banner: byId('banner'),
    subtitle: byId('subtitle'),
    portraitWrap: byId('portrait-wrap'),
    portrait: byId('portrait'),
    portraitFrame: byId('portrait-wrap')?.querySelector('.portrait__frame') ?? null,
    healthFill: byId('health-fill'),
    healthNum: byId('health-num'),
    armorFill: byId('armor-fill'),
    armorNum: byId('armor-num'),
    healthBar: byId('health-fill')?.parentElement ?? null,
    armorBar: byId('armor-fill')?.parentElement ?? null,
    weapon: byId('weapon-readout'),
    weaponName: byId('weapon-name'),
    ammoMag: byId('ammo-mag'),
    ammoReserve: byId('ammo-reserve'),
    modStrip: byId('mod-strip'),
    damageNumbers: byId('damage-numbers'),
  }

  mountHudExtras(el)

  /**
   * The Conductor readout. `body` is the live zombie EV.ZOMBIE_HIT hands over; the HUD reads
   * scalars off its health pool and touches nothing else, so src/ui stays clear of the
   * renderer exactly as CONTRACT.md requires.
   *
   * `ghost` is the white chase bar: it holds the health the Conductor HAD and runs down to
   * where it is now, which is what turns a number going down into a hit landing.
   */
  const boss = {
    body: null,
    current: 0,
    max: BOSS.health,
    armor: 0,
    maxArmor: BOSS.armor,
    overArmorCap: BOSS.armor,
    live: false,
    ghost: 0,
    ghostRate: 0,
    delta: 0,
    deltaClock: 0,
  }

  /**
   * The kill-feedback stack. `chain` and `multiplier` are the scorer's own, arriving on
   * EV.SCORE — the HUD never recomputes them, so the number on screen is the number that
   * was actually banked.
   */
  const kill = {
    chain: 0,
    multiplier: 1,
    window: 0,
    headRun: 0,
    tier: -1,
    pendingRow: null,
  }

  // Authoritative HUD state. Mirrors the fields the C++ HUD polled off the pawn.
  const vitals = {
    health: HEALTH.FALLBACK.health,
    armor: HEALTH.FALLBACK.armor,
    maxHealth: HEALTH.FALLBACK.maxHealth,
    overhealCap: HEALTH.FALLBACK.overhealCap,
    maxArmor: HEALTH.FALLBACK.maxArmor,
    overArmorCap: HEALTH.FALLBACK.overArmorCap,
    dead: false,
    burning: false,
  }

  /**
   * The climb. `top` and `mezzanine` arrive on the snapshot rather than being imported,
   * because the storey above the mezzanine is built in game.js and rules.js has no section
   * for a floor the original never had — so the gauge is TOLD where the floors are instead
   * of assuming them, and cannot drift when the tower is retuned.
   */
  const climb = {
    altitude: 0,
    top: 0,
    mezzanine: 0,
    atSummit: false,
    stock: 0,
    painted: NaN,
    ticked: NaN,
  }

  const readout = {
    wave: HUD.initialWaveNumber,
    zombiesRemaining: HUD.initialZombiesRemaining,
    countdown: HUD.initialCountdown,
    intermission: false,
    score: 0,
    weaponName: WEAPONS.PISTOL.displayName,
    mag: WEAPONS.PISTOL.magazineSize,
    reserve: WEAPONS.PISTOL.reserveAmmo,
    dry: false,
    mods: 0,
    dualWield: WEAPONS.DUAL_WIELD.startsEnabled,
  }

  // Animated scalars, decayed in the HUD's own rAF so they run whether or not
  // the game loop is ticking (menu, pause, the ?verify=1 harness).
  let flashAlpha = 0
  let crosshairKick = 0
  let burnClock = 0
  let subtitleTimer = 0
  let subtitleSeconds = 0
  let calloutClock = 0
  let calloutRank = 0
  // True from the wave-start banner going up until the wave's first zombie is on the
  // platform (EV.ZOMBIE_SPAWN) — see the dismiss call in the ZOMBIE_SPAWN handler below.
  let waveBannerArmed = false

  const warnedVoiceLines = new Set()

  // Last-painted values, so a repaint is skipped when nothing changed. null is the
  // "never painted" sentinel: a mod signature can legitimately be the empty string.
  const painted = { portrait: null, mods: null, condition: null }
  let paintedBossFraction = NaN
  let paintedGhost = NaN
  let paintedWick = NaN

  preloadPortraits()

  function preloadPortraits() {
    for (const id of CONDITION_ORDER) {
      const src = portraitSrc(id)
      const probe = new Image()
      probe.addEventListener(
        'error',
        () => console.warn(`[hud] portrait ${src} failed to load — the ${id} portrait falls back to its condition tint.`),
        { once: true }
      )
      probe.src = src
    }
  }

  function portraitSrc(conditionId) {
    return `${IMG_ROOT}/${HEALTH.CONDITIONS[conditionId].portrait}.png`
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function paintVitals() {
    const condition = conditionFor(vitals)

    if (el.healthFill) {
      el.healthFill.style.transform = `scaleX(${barFraction(vitals.health, vitals.maxHealth, vitals.overhealCap)})`
    }
    if (el.armorFill) {
      el.armorFill.style.transform = `scaleX(${barFraction(vitals.armor, vitals.maxArmor, vitals.overArmorCap)})`
    }
    el.healthBar?.classList.toggle('overfilled', vitals.health > vitals.maxHealth)
    el.armorBar?.classList.toggle('overfilled', vitals.armor > vitals.maxArmor)

    if (el.healthNum) el.healthNum.textContent = String(Math.round(vitals.health))
    if (el.armorNum) el.armorNum.textContent = String(Math.round(vitals.armor))

    if (painted.condition !== condition.id) {
      painted.condition = condition.id
      paintPortrait(condition)
    }
  }

  function paintPortrait(condition) {
    const tint = hex(condition.tintHex)

    if (el.portrait) {
      const src = portraitSrc(condition.id)
      if (painted.portrait !== src) {
        painted.portrait = src
        el.portrait.src = src
        // A broken <img> renders its alt text, which is exactly the C++ fallback:
        // the word JEREMY over a plate in the condition tint.
        el.portrait.alt = 'JEREMY'
      }
    }
    if (el.portraitWrap) {
      el.portraitWrap.style.background = tint
      el.portraitWrap.classList.toggle('critical', condition.id === HEALTH.CONDITIONS.critical.id)
    }
    // The frame carrying the tint is what makes the condition readable at a glance
    // when the five portraits themselves look alike in peripheral vision.
    if (el.portraitFrame) el.portraitFrame.style.borderColor = tint
  }

  function paintWaveHeader() {
    const counting = readout.intermission && readout.countdown >= 0
    if (el.waveLabel) el.waveLabel.textContent = counting ? 'NEXT TRAIN' : 'WAVE'
    if (el.waveNum) el.waveNum.textContent = String(counting ? readout.countdown : readout.wave)
    if (el.waveLeft) {
      el.waveLeft.textContent = counting ? 'INBOUND' : `${readout.zombiesRemaining} ZOMBIES REMAINING`
      el.waveLeft.style.color = counting ? '' : hex(HUD.zombiesRemainingColorHex)
    }
  }

  // -------------------------------------------------------------------------
  // The Conductor
  // -------------------------------------------------------------------------

  /**
   * The one readout that answers "am I winning or about to die" during wave 10.
   *
   * The fill is the boss's own emissive red and the segments break it into twentieths so
   * a glance reads how many blasts are left rather than "some red". Below
   * HEALTH.criticalThreshold the whole unit goes hot — the same threshold that turns the
   * player's own portrait frame red, so both readouts speak one language.
   */
  function paintBoss() {
    if (!el.bossBar) return
    el.bossBar.classList.toggle('live', boss.live)
    if (!boss.live) {
      paintedBossFraction = NaN
      paintedGhost = NaN
      return
    }

    const fraction = boss.max > 0 ? clamp(boss.current / boss.max, 0, 1) : 0
    if (fraction !== paintedBossFraction) {
      paintedBossFraction = fraction
      boss.ghostRate = 0
      el.bossBar.style.setProperty('--frac', String(fraction))
      if (el.bossHp) el.bossHp.textContent = `${formatNumber(boss.current)} / ${formatNumber(boss.max)}`
      const critical = fraction < HEALTH.criticalThreshold
      el.bossBar.classList.toggle('critical', critical)
      if (el.bossState) el.bossState.textContent = critical ? BOSS_STATE_CRITICAL : BOSS_STATE_ENGAGED
    }

    if (el.bossArmor) {
      const showArmor = boss.armor > 0 && boss.maxArmor > 0
      el.bossArmor.classList.toggle('live', showArmor)
      if (showArmor) {
        const ceiling = Math.max(boss.maxArmor, boss.armor)
        el.bossArmor.style.setProperty('--armor', String(clamp(boss.armor / ceiling, 0, 1)))
      }
    }
  }

  function paintGhost() {
    if (!el.bossBar || boss.ghost === paintedGhost) return
    paintedGhost = boss.ghost
    el.bossBar.style.setProperty('--ghost', String(boss.ghost))
  }

  /** The chunk that just came off, merged across a shotgun's pellets so it reads as one blast. */
  function bossDamage(amount) {
    if (!(amount > 0)) return
    boss.delta = boss.deltaClock > 0 ? boss.delta + amount : amount
    boss.deltaClock = BOSS_DELTA_MERGE_SECONDS
    if (el.bossDelta) {
      el.bossDelta.textContent = `-${formatNumber(boss.delta)}`
      retrigger(el.bossDelta, 'show')
    }
    retrigger(el.bossBar, 'hit')
  }

  /** EV.ZOMBIE_HIT is the only event that hands over the body itself, so it is the binding. */
  function bindBoss(body, damage) {
    const pool = body?.health
    if (!pool || typeof pool.health !== 'number') return
    const hadBody = boss.body === body
    boss.body = body
    boss.max = pool.maxHealth > 0 ? pool.maxHealth : BOSS.health
    if (!hadBody) boss.ghost = boss.max > 0 ? clamp((pool.health + (damage ?? 0)) / boss.max, 0, 1) : 0
    boss.current = Math.max(0, pool.health)
    boss.armor = Math.max(0, pool.armor ?? 0)
    boss.maxArmor = pool.maxArmor > 0 ? pool.maxArmor : BOSS.armor
    boss.overArmorCap = pool.overArmorCap > 0 ? pool.overArmorCap : boss.maxArmor
    boss.live = !pool.isDead && boss.current > 0
    bossDamage(damage)
    paintBoss()
  }

  function clearBoss() {
    boss.body = null
    boss.live = false
    boss.ghost = 0
    boss.ghostRate = 0
    boss.delta = 0
    boss.deltaClock = 0
    el.bossBar?.classList.remove('hit', 'critical')
    el.bossDelta?.classList.remove('show')
    paintBoss()
  }

  /** Polled, not event-driven: a Conductor bleeding out on a burn stack fires no hit event. */
  function pollBoss() {
    if (!boss.live || !boss.body) return
    const pool = boss.body.health
    if (!pool || pool.isDead || pool.health <= 0) {
      clearBoss()
      return
    }
    if (pool.health === boss.current && pool.armor === boss.armor) return
    boss.current = Math.max(0, pool.health)
    boss.armor = Math.max(0, pool.armor ?? 0)
    paintBoss()
  }

  // -------------------------------------------------------------------------
  // Kill feedback
  // -------------------------------------------------------------------------

  function comboColor() {
    const span = SCORE.comboMax - 1
    const t = span > 0 ? clamp((kill.multiplier - 1) / span, 0, 1) : 0
    return mixHex(HUD.modTextColorHex, FX.DAMAGE_NUMBER.colorHeadHex, t)
  }

  /** The stack's scrim exists to make type legible; with nothing on it, it is just a dark box. */
  function paintStackScrim() {
    el.killStack?.classList.toggle(
      'live',
      kill.window > 0 || (el.killFeed?.childElementCount ?? 0) > 0
    )
  }

  function paintCombo(punch = false) {
    if (!el.combo) return
    const live = kill.window > 0
    el.combo.classList.toggle('live', live)
    paintStackScrim()
    if (!live) {
      el.comboHs?.classList.remove('live')
      return
    }
    el.combo.style.setProperty('--combo-color', comboColor())
    // comboChain counts the kills that EXTENDED the chain, so the run itself is one longer.
    if (el.comboMult) el.comboMult.textContent = `x${kill.multiplier.toFixed(1)}`
    if (el.comboMeta) el.comboMeta.textContent = `${kill.chain + 1} KILL CHAIN`
    if (el.comboHs) {
      const run = kill.headRun > 1
      el.comboHs.classList.toggle('live', run)
      if (run) el.comboHs.textContent = `${kill.headRun} HEADSHOTS IN A ROW`
    }
    if (punch) retrigger(el.combo, 'punch')
  }

  function endCombo() {
    kill.chain = 0
    kill.multiplier = 1
    kill.window = 0
    kill.headRun = 0
    kill.tier = -1
    paintedWick = NaN
    el.comboWick?.style.setProperty('--wick', '0')
    paintCombo()
  }

  let combatCalloutId = null
  function combatCallout(p = {}) {
    if (!el.streak || !el.streakPlate) return
    if (p.phase === 'end') {
      if (p.id === combatCalloutId) {
        el.streak.classList.remove('show')
        combatCalloutId = null
      }
      return
    }
    if (p.phase !== 'start' || !p.text || !(p.seconds > 0)) return
    combatCalloutId = p.id
    el.streakPlate.textContent = p.text
    el.streak.style.setProperty('--callout-seconds', `${p.seconds}s`)
    el.streak.dataset.audible = String(p.audible)
    retrigger(el.streak, 'show')
  }

  /**
   * The zone callout, printed where the eye already is. Rank stops a body-shot line from
   * stepping on a headshot kill that is still on screen; an equal or louder one cuts in.
   */
  function callout(zone, killed) {
    const spec = ZONE_CALLOUT[zone]
    if (!spec || !el.callout) return
    const rank = (zone === DAMAGE.zones.head ? 2 : 1) + (killed ? 1 : 0)
    if (calloutClock > 0 && rank < calloutRank) return
    calloutRank = rank
    calloutClock = CALLOUT_SECONDS
    el.callout.style.setProperty('--callout-color', hex(killed ? FX.HIT_MARKER.killColorHex : spec.colorHex))
    if (el.calloutZone) el.calloutZone.textContent = killed ? spec.killLabel : spec.label
    if (el.calloutMult) el.calloutMult.textContent = `x${spec.multiplier}`
    retrigger(el.callout, 'show')
  }

  function feedRow(zoneColorHex) {
    const row = document.createElement('div')
    row.className = 'killrow'
    row.style.setProperty('--row-zone', hex(zoneColorHex))
    row.addEventListener('animationend', () => { row.remove(); paintStackScrim() }, { once: true })
    return row
  }

  function pushRow(row) {
    if (!el.killFeed) return
    el.killFeed.append(row)
    while (el.killFeed.childElementCount > KILL_FEED_MAX) el.killFeed.firstElementChild.remove()
    paintStackScrim()
  }

  function killRow(label, zone) {
    if (!el.killFeed) return null
    const spec = ZONE_CALLOUT[zone] ?? BODY_ZONE_TAG
    const row = feedRow(spec.colorHex)

    const name = document.createElement('b')
    name.textContent = label
    const tag = document.createElement('i')
    tag.textContent = spec.tag
    const points = document.createElement('span')
    points.textContent = ''

    row.append(name, tag, points)
    pushRow(row)
    return points
  }

  function clearKillFeed() {
    el.killFeed?.replaceChildren()
    paintStackScrim()
    kill.pendingRow = null
    el.callout?.classList.remove('show')
    el.streak?.classList.remove('show')
    calloutClock = 0
    calloutRank = 0
    endCombo()
  }

  function paintScore() {
    if (el.scoreVal) el.scoreVal.textContent = formatNumber(readout.score)
  }

  function paintWeapon() {
    if (el.weaponName) el.weaponName.textContent = readout.weaponName
    if (el.ammoMag) el.ammoMag.textContent = String(readout.mag)
    if (el.ammoReserve) el.ammoReserve.textContent = String(readout.reserve)
    el.weapon?.classList.toggle('dry', readout.dry || readout.mag <= 0)
  }

  function paintMods() {
    if (!el.modStrip) return
    const chips = []
    for (const id of WEAPONS.MOD_BADGE_ORDER) {
      if (id === 'dualWield') {
        if (readout.dualWield) chips.push([id, WEAPONS.dualWieldBadgeLabel])
        continue
      }
      if (modsInclude(readout.mods, id)) chips.push([id, WEAPONS.MODS[id].label])
    }

    const signature = chips.map(c => c[1]).join(' ')
    if (signature === painted.mods) return
    painted.mods = signature

    el.modStrip.replaceChildren()
    for (const [id, label] of chips) {
      const chip = document.createElement('span')
      // styles.css spells the modifiers lowercase and unhyphenated: .mod--armorpiercing, .mod--lasersight.
      chip.className = `mod mod--${id.toLowerCase()}`
      chip.textContent = label
      el.modStrip.append(chip)
    }

    // The laser sight is the one mod that changes the reticle: tighter gap, red dot.
    const laser = modsInclude(readout.mods, WEAPONS.MODS.laserSight.id)
    el.crosshair?.classList.toggle('laser', laser)
  }

  function laserSpreadBaseline() {
    if (!modsInclude(readout.mods, WEAPONS.MODS.laserSight.id)) return 0
    return FX.CROSSHAIR.gap * FX.CROSSHAIR.laserGapMultiplier - FX.CROSSHAIR.gap
  }

  /**
   * How far the resting reticle opens beyond FX.CROSSHAIR.gap for the EQUIPPED weapon's
   * real cone (WEAPON_BASE_SPREAD_DEG), relative to the pistol — the gun FX.CROSSHAIR.gap
   * was already sized for (WEAPONS.DEFAULTS.baseSpread === WEAPONS.PISTOL.baseSpread).
   * 0px for the pistol, ~5.3px for the rifle, ~34.7px for the shotgun: the reticle now
   * tells the truth about which of the three cones is loaded instead of drawing one
   * identical cross for a 1.5deg spread and an 8deg one.
   */
  function weaponSpreadDelta() {
    const baseSpread = WEAPON_BASE_SPREAD_DEG.get(readout.weaponName)
    if (!Number.isFinite(baseSpread)) return 0
    return FX.CROSSHAIR.gap * (baseSpread / WEAPONS.DEFAULTS.baseSpread - 1)
  }

  // -------------------------------------------------------------------------
  // Punctual feedback
  // -------------------------------------------------------------------------

  /**
   * Redraw the tick labels. Only when the tower's own height changes, which in practice is
   * once — the alternative is three DOM writes a frame for a readout that never moves.
   */
  function paintClimbTicks() {
    if (!el.climbTicks || !(climb.top > 0)) return
    if (climb.ticked === climb.top) return
    climb.ticked = climb.top

    const stops = [
      { at: 0, label: 'PLATFORM' },
      { at: climb.mezzanine / climb.top, label: 'MEZZANINE' },
      { at: 1, label: 'STREET' },
    ]
    const marks = stops.map((stop) => {
      const tick = document.createElement('span')
      tick.className = 'climb__tick'
      tick.style.setProperty('--at', String(clamp(stop.at, 0, 1)))
      tick.textContent = stop.label
      return tick
    })
    el.climbTicks.replaceChildren(el.climbStock, ...marks)
  }

  function paintClimb() {
    if (!el.climb) return
    const live = climb.altitude > CLIMB_SHOW_ABOVE && climb.top > 0
    el.climb.classList.toggle('live', live)
    el.climb.style.opacity = live ? '1' : '0'
    if (!live) return

    paintClimbTicks()
    const t = clamp(climb.altitude / climb.top, 0, 1)
    if (t !== climb.painted) {
      climb.painted = t
      el.climbRail?.style.setProperty('--climb', t.toFixed(4))
    }
    for (const tick of el.climbTicks?.querySelectorAll('.climb__tick') ?? []) {
      const at = Number(tick.style.getPropertyValue('--at')) || 0
      // A hair of tolerance, or standing exactly on the deck leaves its own tick unlit.
      tick.classList.toggle('reached', t >= at - 0.01)
    }
    if (el.climbStock) {
      el.climbStock.style.opacity = climb.stock > 0 ? '1' : '0'
      if (climb.stock > 0) el.climbStock.textContent = `CACHE ${climb.stock}`
    }
  }

  /**
   * Finding a PLACE, announced with the two readouts this HUD already has.
   *
   * It used to be its own card, and the card is why this comment exists. It laid out
   * correctly — right box, right position, opacity 1, gold 34 px type on a black plate —
   * and it painted NOTHING, in six consecutive captures, through a transition, through an
   * animation, and finally through an inline opacity set from JavaScript one frame before
   * the shutter. A clone of the same element created a moment earlier rendered fine.
   *
   * The lesson is not about that element. It is that the banner and the subtitle are
   * DEMONSTRABLY on screen in every frame this game has ever been graded on, and a beat
   * routed through them cannot fail to be seen. A bespoke card that is right in the DOM
   * inspector and absent in the photograph is worth less than no card at all.
   */
  function discovery(title, sub = '') {
    if (!title) return
    banner(title)
    if (sub) subtitle(sub, DISCOVERY_SECONDS)
  }

  function banner(text, danger = false) {
    if (!el.banner || !text) return

    /*
     * game.js announces the Conductor by his own displayName, which is the word the bar's
     * nameplate already carries. Printed twice it reads as a bug rather than a reveal, and
     * that is worth fixing — but not by hiding the nameplate for the length of the
     * announce, which is what this used to do. Measured on verify/out/boss.png, the
     * nameplate band came back rgb(30,24,25) — scene, and nothing else — because the
     * announce runs 4.2 s and the harness shoots 1.8 s into it. The bar was unnamed in the
     * one frame anyone grades.
     *
     * So the transient card yields and the permanent readout keeps the name. Clearing
     * `show` rather than returning early matters: this call is also what takes the
     * PREVIOUS banner down, and without it the boss frame keeps NEXT TRAIN INBOUND up
     * across the Conductor's arrival.
     *
     * BOSS INCOMING is unaffected. It fires before he is on the platform, so there is no
     * bar for it to duplicate.
     */
    if (danger && boss.live && text === BOSS.displayName) {
      dismissBanner()
      return
    }

    if (el.bannerPlate) el.bannerPlate.textContent = text
    else el.banner.textContent = text
    el.banner.classList.toggle('danger', danger)
    retrigger(el.banner, 'show')
  }

  /**
   * Takes the banner down immediately instead of waiting on its own 2.6s CSS animation
   * (styles.css .hud__banner.show). Used to dismiss the wave-start announcement the moment
   * the wave's first zombie is on the platform (EV.ZOMBIE_SPAWN, see below) — the announce
   * has done its job once there is something to shoot at, and a banner sized to read across
   * the room has no business still fading while zombies are already closing.
   */
  function dismissBanner() {
    el.banner?.classList.remove('show', 'danger')
  }

  function subtitle(text, seconds) {
    if (!el.subtitle) return
    if (!text) {
      el.subtitle.classList.remove('show')
      subtitleSeconds = 0
      return
    }
    el.subtitle.textContent = text
    el.subtitle.classList.add('show')
    // With no duration the line stays up until the next one replaces it, rather
    // than guessing a reading speed that is not in the spec.
    subtitleSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
    subtitleTimer = 0
  }

  function hitMarker({ killed = false, zone = 'body' } = {}) {
    if (!FX.HIT_MARKER.enabled || !el.hitmarker) return
    const color = killed
      ? FX.HIT_MARKER.killColorHex
      : zone === 'head' ? FX.HIT_MARKER.headshotColorHex : FX.HIT_MARKER.colorHex
    el.hitmarker.style.borderColor = hex(color)
    retrigger(el.hitmarker, 'show')
    el.hitmarker.classList.toggle('kill', killed)
    crosshairKick = FX.HIT_MARKER.spreadPx
  }

  /** Spec §6.8: the flash is SET, never accumulated, and only a negative delta sets it. */
  function damageFlash() {
    flashAlpha = FX.DAMAGE_FLASH.triggerValue
  }

  function fireKick() {
    crosshairKick = FX.HIT_MARKER.spreadPx
  }

  /**
   * The 2D fallback for floating damage numbers. src/fx owns the world-space
   * sprites the spec describes, so this is deliberately NOT bound to the bus —
   * main.js wires it only when the 3D layer is unavailable.
   */
  function damageNumber({ x, y, value, zone = 'body' }) {
    if (!el.damageNumbers) return
    const node = document.createElement('span')
    node.className = `dmgnum${zone === 'head' ? ' head' : zone === 'chest' ? ' chest' : zone === 'burn' ? ' burn' : ''}`
    node.textContent = String(Math.max(Math.round(value), FX.DAMAGE_NUMBER.minValue))
    node.style.left = `${x}px`
    node.style.top = `${y}px`
    node.addEventListener('animationend', () => node.remove(), { once: true })
    el.damageNumbers.append(node)
    while (el.damageNumbers.childElementCount > FX.DAMAGE_NUMBER.maxLive) {
      el.damageNumbers.firstElementChild.remove()
    }
  }

  // -------------------------------------------------------------------------
  // Animation — flash decay, crosshair recovery, burn pulse, chase bar, combo wick
  // -------------------------------------------------------------------------

  let rafId = 0
  let lastFrame = performance.now()
  let paintedSpread = NaN

  function frame(now) {
    // A backgrounded tab hands back a huge delta; never advance a decay by more
    // than one whole decay in a single step or the flash vanishes mid-fade.
    const dt = clamp((now - lastFrame) / 1000, 0, FX.DAMAGE_FLASH.fullDecaySeconds)
    lastFrame = now

    if (flashAlpha > 0) {
      flashAlpha = Math.max(0, flashAlpha - dt * FX.DAMAGE_FLASH.decayRate)
      if (el.vignette) {
        el.vignette.style.setProperty(
          '--dmg',
          `${hex(FX.DAMAGE_FLASH.vignetteColorHex)}${Math.round(clamp(flashAlpha * FLASH_EDGE_ALPHA, 0, 1) * 255)
            .toString(16)
            .padStart(2, '0')}`
        )
      }
    } else if (el.vignette) {
      el.vignette.style.removeProperty('--dmg')
    }

    if (crosshairKick > 0) crosshairKick = Math.max(0, crosshairKick - dt * SPREAD_RECOVERY_PER_SECOND)
    const spread = laserSpreadBaseline() + weaponSpreadDelta() + crosshairKick
    if (spread !== paintedSpread) {
      paintedSpread = spread
      el.crosshair?.style.setProperty('--spread', `${spread}px`)
    }

    if (vitals.burning && el.portraitWrap) {
      burnClock += dt
      const pulse = 0.5 + 0.5 * Math.sin(burnClock * HUD.burnPulseFrequency)
      const alpha = HUD.burnOverlayAlphaBase + HUD.burnOverlayAlphaSwing * pulse
      const [r, g, b] = HUD.burnOverlayRgb
      const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`
      const ring = HUD.portraitFallbackBackingInset
      el.portraitWrap.style.boxShadow = `0 0 0 ${ring}px rgba(${rgb}, ${alpha}), 0 0 ${BURN_GLOW_PX}px rgba(${rgb}, ${alpha})`
      el.portraitWrap.style.filter = `saturate(${1 + alpha})`
    } else if (el.portraitWrap && el.portraitWrap.style.boxShadow) {
      burnClock = 0
      el.portraitWrap.style.boxShadow = ''
      el.portraitWrap.style.filter = ''
    }

    if (subtitleSeconds > 0) {
      subtitleTimer += dt
      if (subtitleTimer >= subtitleSeconds) subtitle(null)
    }

    if (calloutClock > 0) calloutClock = Math.max(0, calloutClock - dt)
    if (boss.deltaClock > 0) boss.deltaClock = Math.max(0, boss.deltaClock - dt)

    pollBoss()

    // The chase bar runs down onto the current health over a fixed time, so the gap it
    // leaves behind is the size of the hit rather than the size of the frame budget.
    if (boss.live) {
      const target = paintedBossFraction
      if (Number.isFinite(target)) {
        if (boss.ghost > target) {
          if (boss.ghostRate <= 0) {
            boss.ghostRate = Math.max(BOSS_GHOST_MIN_RATE, (boss.ghost - target) / BOSS_GHOST_CATCHUP_SECONDS)
          }
          boss.ghost = Math.max(target, boss.ghost - dt * boss.ghostRate)
          if (boss.ghost === target) boss.ghostRate = 0
        } else if (boss.ghost < target) {
          boss.ghost = target
          boss.ghostRate = 0
        }
      }
      paintGhost()
    }

    if (kill.window > 0) {
      kill.window = Math.max(0, kill.window - dt)
      const wick = clamp(kill.window / SCORE.comboWindow, 0, 1)
      if (wick !== paintedWick) {
        paintedWick = wick
        el.comboWick?.style.setProperty('--wick', String(wick))
      }
      if (kill.window === 0) endCombo()
    }

    rafId = requestAnimationFrame(frame)
  }

  rafId = requestAnimationFrame(frame)

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  function update(snapshot = {}) {
    let touchedVitals = false
    for (const key of Object.keys(vitals)) {
      if (snapshot[key] !== undefined && snapshot[key] !== vitals[key]) {
        vitals[key] = snapshot[key]
        touchedVitals = true
      }
    }

    const weapon = snapshot.weapon
    if (weapon) {
      if (weapon.name !== undefined) readout.weaponName = String(weapon.name).toUpperCase()
      if (weapon.mag !== undefined) readout.mag = weapon.mag
      if (weapon.reserve !== undefined) readout.reserve = weapon.reserve
      if (weapon.dry !== undefined) readout.dry = weapon.dry
      paintWeapon()
    }

    let touchedHeader = false
    for (const key of ['wave', 'zombiesRemaining', 'countdown', 'intermission']) {
      if (snapshot[key] !== undefined && snapshot[key] !== readout[key]) {
        readout[key] = snapshot[key]
        touchedHeader = true
      }
    }

    if (snapshot.score !== undefined && snapshot.score !== readout.score) {
      readout.score = snapshot.score
      paintScore()
    }
    if (snapshot.mods !== undefined) readout.mods = snapshot.mods
    if (snapshot.dualWield !== undefined) readout.dualWield = snapshot.dualWield
    if (snapshot.mods !== undefined || snapshot.dualWield !== undefined) paintMods()

    let touchedClimb = false
    for (const [key, field] of [['altitude', 'altitude'], ['summitTopZ', 'top'], ['mezzanineZ', 'mezzanine'], ['atSummit', 'atSummit'], ['summitStock', 'stock']]) {
      if (snapshot[key] !== undefined && snapshot[key] !== climb[field]) {
        climb[field] = snapshot[key]
        touchedClimb = true
      }
    }

    if (touchedVitals) paintVitals()
    if (touchedHeader) paintWaveHeader()
    if (touchedClimb) paintClimb()
  }

  function show() { if (el.root) el.root.hidden = false }
  function hide() { if (el.root) el.root.hidden = true }

  function reset() {
    vitals.health = HEALTH.maxHealth
    vitals.armor = HEALTH.FALLBACK.armor
    vitals.maxHealth = HEALTH.maxHealth
    vitals.overhealCap = HEALTH.overhealCap
    vitals.maxArmor = HEALTH.maxArmor
    vitals.overArmorCap = HEALTH.overArmorCap
    vitals.dead = false
    vitals.burning = false

    readout.wave = HUD.initialWaveNumber
    readout.zombiesRemaining = HUD.initialZombiesRemaining
    readout.countdown = HUD.initialCountdown
    readout.intermission = false
    readout.score = 0
    readout.mods = 0
    readout.dualWield = WEAPONS.DUAL_WIELD.startsEnabled
    readout.dry = false

    climb.altitude = 0
    climb.atSummit = false
    climb.stock = 0
    climb.painted = NaN
    paintClimb()

    flashAlpha = 0
    crosshairKick = 0
    waveBannerArmed = false
    painted.condition = null
    painted.mods = null
    clearBoss()
    clearKillFeed()
    subtitle(null)
    paintAll()
  }

  function paintAll() {
    paintVitals()
    paintWaveHeader()
    paintScore()
    paintWeapon()
    paintMods()
    paintBoss()
    paintCombo()
  }

  function destroy() {
    cancelAnimationFrame(rafId)
    for (const off of unbind) off()
    unbind.length = 0
  }

  // -------------------------------------------------------------------------
  // Bus bindings
  // -------------------------------------------------------------------------

  const unbind = []
  const on = (type, fn) => unbind.push(bus.on(type, fn))

  on(EV.WAVE_START, (p = {}) => {
    readout.wave = p.wave ?? p.waveNumber ?? readout.wave + 1
    readout.intermission = false
    readout.countdown = HUD.initialCountdown
    if (p.zombiesRemaining !== undefined) readout.zombiesRemaining = p.zombiesRemaining
    clearBoss()
    paintWaveHeader()
    banner(`WAVE ${readout.wave}`)
    waveBannerArmed = true
  })

  on(EV.WAVE_CLEAR, () => {
    readout.intermission = true
    clearBoss()
    paintWaveHeader()
    banner('PLATFORM CLEAR')
  })

  on(EV.BOSS_INCOMING, () => banner('BOSS INCOMING', true))

  on(EV.COUNTDOWN, (p = {}) => {
    readout.intermission = true
    readout.countdown = p.seconds ?? p.secondsRemaining ?? HUD.initialCountdown
    paintWaveHeader()
  })

  on(EV.TRAIN_INBOUND, () => banner(HUD.countdownSubtitle))

  on(EV.ZOMBIE_SPAWN, (p = {}) => {
    // The wave-start / boss-incoming / next-train banner is still up from EV.WAVE_START
    // until this fires: zombiesAlive:0 at WAVE_START means EV.ZOMBIE_SPAWN is genuinely the
    // wave's first body on the platform, i.e. the fight is joined. Take the banner down
    // right then rather than leaving it to its own 2.6s fade (styles.css .hud__banner.show),
    // which was still running while zombies were already closing.
    if (waveBannerArmed) {
      waveBannerArmed = false
      dismissBanner()
    }

    // The director spawns through the bus and carries the rolled stats but not the body, which
    // is what puts a full bar on screen the moment the Conductor steps off the train. The body
    // itself arrives with the first hit, and bindBoss() takes over from there.
    if (p.archetype === BOSS.id) {
      boss.body = null
      boss.max = p.stats?.health > 0 ? p.stats.health : BOSS.health
      boss.current = boss.max
      boss.armor = p.stats?.armor ?? BOSS.armor
      boss.maxArmor = boss.armor > 0 ? boss.armor : BOSS.armor
      boss.overArmorCap = boss.maxArmor
      boss.ghost = 1
      boss.live = true
      paintBoss()
      paintGhost()
    }
    if (p.alive === undefined) return
    readout.zombiesRemaining = p.alive
    paintWaveHeader()
  })

  on(EV.ZOMBIE_HIT, (p = {}) => {
    hitMarker({ killed: false, zone: p.zone })
    callout(p.zone, false)
    if (p.archetype === BOSS.id) bindBoss(p.zombie, p.damage)
  })

  on(EV.ZOMBIE_DEATH, (p = {}) => {
    hitMarker({ killed: true, zone: p.zone })
    callout(p.zone, true)

    kill.headRun = p.zone === DAMAGE.zones.head ? kill.headRun + 1 : 0
    kill.pendingRow = killRow(ZOMBIES.ARCHETYPES[p.archetype]?.displayName ?? String(p.archetype).toUpperCase(), p.zone)

    if (p.archetype === BOSS.id) clearBoss()
    if (p.alive !== undefined) {
      readout.zombiesRemaining = p.alive
      paintWaveHeader()
    }
  })

  on(EV.PLAYER_HIT, (p = {}) => {
    damageFlash()
    update(p)
  })

  on(EV.PLAYER_HEAL, p => update(p ?? {}))
  on(EV.PICKUP, p => update(p ?? {}))

  on(EV.PLAYER_DEATH, (p = {}) => {
    damageFlash()
    update({ ...p, dead: true })
  })

  on(EV.WEAPON_FIRE, (p = {}) => {
    fireKick()
    update({ weapon: p.weapon ?? p })
  })

  on(EV.WEAPON_DRY, () => {
    readout.dry = true
    paintWeapon()
  })

  on(EV.WEAPON_RELOAD, (p = {}) => {
    readout.dry = false
    update({ weapon: p.weapon ?? p })
  })

  on(EV.WEAPON_SWITCH, (p = {}) => {
    readout.dry = false
    update({ weapon: p.weapon ?? p })
  })

  on(EV.MOD_GAINED, (p = {}) => {
    if (p.mods !== undefined) readout.mods = p.mods
    else if (p.mod && WEAPONS.MOD_BITS[p.mod] !== undefined && typeof readout.mods === 'number') {
      readout.mods |= WEAPONS.MOD_BITS[p.mod]
    }
    if (p.dualWield !== undefined) readout.dualWield = p.dualWield
    paintMods()
    // The banner is the ONLY moment the game explains a mod, so it spells the whole word.
    // It used to print `label`, which is the three-letter chip code — "SIL ONLINE" introduces
    // the abbreviation with the abbreviation, and nothing anywhere else in the game ever says
    // "silencer". The chip stays terse; the teaching moment does not.
    const mod = WEAPONS.MODS[p.mod]
    const label = p.mod === 'dualWield' ? WEAPONS.dualWieldBadgeLabel : (mod?.name ?? mod?.label)
    if (label) banner(`${label} ONLINE`)
  })

  /**
   * The scorer is the authority on the chain, so the HUD reads it rather than counting its
   * own kills. gameState subscribes to EV.ZOMBIE_DEATH after the HUD does, so the row for a
   * kill is already on screen by the time the points for it land and only needs filling in.
   */
  on(EV.COMBAT_CALLOUT, combatCallout)
  on(EV.SCORE, (p = {}) => {
    if (p.points === undefined) return
    if (p.reason === SCORE_REASON.kill) {
      if (kill.pendingRow) {
        kill.pendingRow.textContent = ''
        kill.pendingRow = null
      }
      kill.chain = p.chain ?? kill.chain
      kill.multiplier = p.multiplier ?? 1
      kill.window = SCORE.comboWindow
      paintedWick = NaN
      paintCombo(true)
    }
  })

  on(EV.STATE_CHANGE, (p = {}) => {
    const state = p.state ?? p
    if (state === 'fight' || state === 'intermission' || state === 'preparation') show()
    else hide()
  })

  for (const type of VOICE_EVENTS) {
    on(type, (p = {}) => {
      const line = p.line ?? p.cue ?? p.id
      const text = p.text ?? p.subtitle
      if (!text) {
        if (line && !warnedVoiceLines.has(line)) {
          warnedVoiceLines.add(line)
          console.warn(`[hud] voice line "${line}" carried no subtitle text — the subtitle line stays blank for it.`)
        }
        return
      }
      subtitle(text, p.seconds ?? AUDIO.VO_CLIPS[line]?.seconds)
    })
  }

  paintAll()

  return {
    update,
    show,
    hide,
    reset,
    destroy,
    banner,
    discovery,
    subtitle,
    hitMarker,
    damageFlash,
    fireKick,
    damageNumber,
    conditionFor: () => conditionFor(vitals).id,
  }
}
