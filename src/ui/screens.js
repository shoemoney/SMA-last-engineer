/**
 * Full-screen states: loading, main menu, game over — plus the DOM helpers the
 * other two UI modules share.
 *
 * DOM and CSS only. This file must never import three.js (CONTRACT.md).
 * Every element id here already exists in index.html and every class already
 * exists in styles.css; nothing is invented.
 */

import { MENU, SAVE } from '../game/rules.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Ids we have already complained about, so a missing element warns once, not once per frame. */
const missingIds = new Set()

/** index.html is a hard dependency; a missing id is a build break, not a runtime nicety. */
export function byId(id) {
  const el = document.getElementById(id)
  if (!el && !missingIds.has(id)) {
    missingIds.add(id)
    console.error(`[ui] #${id} is missing from index.html — that part of the UI will not render.`)
  }
  return el
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** rules.js stores colours as 0xRRGGBB integers; CSS wants the string. */
export function hex(value) {
  return `#${(value >>> 0).toString(16).padStart(6, '0')}`
}

/** Same 0xRRGGBB source, but split into channels so an accent can cast a halo. */
export function hexRgba(value, alpha) {
  const v = value >>> 0
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}

export function rgba(rgbTriple, alpha) {
  const [r, g, b] = rgbTriple
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`
}

const groupedInteger = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function formatNumber(n) {
  return Number.isFinite(n) ? groupedInteger.format(Math.round(n)) : '--'
}

/** Run durations are minutes long at most; hours would mean the soak is driving. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const whole = Math.floor(seconds)
  const m = Math.floor(whole / 60)
  const s = whole % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Screen stack
// ---------------------------------------------------------------------------

const SCREEN_IDS = Object.freeze({ menu: 'menu', gameover: 'gameover', loading: 'loading' })

function setHidden(id, hidden) {
  const el = byId(id)
  if (el) el.hidden = hidden
}

/** Show exactly one full-screen overlay, or none when name is null. The HUD is hidden behind any of them. */
export function showScreen(name) {
  for (const id of Object.values(SCREEN_IDS)) setHidden(id, id !== name)
  setHidden('hud', name !== null)
}

export function hideScreens() {
  showScreen(null)
}

export function isScreenVisible(name) {
  const el = byId(SCREEN_IDS[name] ?? name)
  return !!el && !el.hidden
}

// ---------------------------------------------------------------------------
// Stat grids — the same markup shape feeds the menu's career panel and the
// game-over run panel, because styles.css gives .stats and .runstats one rule.
// ---------------------------------------------------------------------------

/** rows: [label, value, accentHex?, emphasis?][] — built with the DOM API so a stat value can never inject markup. */
export function renderStatGrid(container, rows) {
  if (!container) return
  container.replaceChildren()
  for (const [label, value, accentHex, emphasis] of rows) {
    const cell = document.createElement('div')
    cell.className = 'stat'

    const val = document.createElement('span')
    val.className = 'stat__val'
    val.textContent = String(value)
    if (accentHex !== undefined) val.style.color = hex(accentHex)

    const lab = document.createElement('span')
    lab.className = 'stat__label'
    lab.textContent = label

    // Optional, and deliberately not what the game-over card celebrates a record
    // with: a colour swap inside a grid of six identical numbers is not an
    // accent, it is a slightly different number, which is exactly how the record
    // went unnoticed. That moment now owns a row of its own (see renderRecord).
    // This stays for a caller that wants one cell to carry a halo and a matching
    // label; the inline properties mean it lands with or without a stylesheet rule.
    if (emphasis && accentHex !== undefined) {
      cell.classList.add('stat--accent')
      val.style.textShadow = `0 0 26px ${hexRgba(accentHex, 0.55)}, 0 0 7px ${hexRgba(accentHex, 0.4)}`
      lab.style.color = hex(accentHex)
      lab.style.textShadow = `0 0 14px ${hexRgba(accentHex, 0.35)}`
    }

    cell.append(val, lab)
    container.append(cell)
  }
}

// ---------------------------------------------------------------------------
// Career save
//
// src/game/save.js is owned by another module and may land after this one, so
// it is imported dynamically and its shape is sniffed rather than assumed. When
// it is absent the raw localStorage slot named in rules.js is read instead, so
// the career panel still shows real numbers rather than dashes.
// ---------------------------------------------------------------------------

const SAVE_READER_NAMES = Object.freeze(['loadSave', 'load', 'read', 'readSave', 'getSave', 'career'])

let careerReader = null

async function resolveCareerReader() {
  if (careerReader) return careerReader
  try {
    const mod = await import('../game/save.js')
    const fn = SAVE_READER_NAMES.map(n => mod[n]).find(f => typeof f === 'function')
    if (fn) {
      careerReader = () => fn()
      return careerReader
    }
    const obj = mod.save ?? mod.default
    if (obj && typeof obj === 'object') {
      const method = SAVE_READER_NAMES.map(n => obj[n]).find(f => typeof f === 'function')
      careerReader = method ? () => method.call(obj) : () => obj
      return careerReader
    }
    console.warn(
      `[ui] src/game/save.js exports none of ${SAVE_READER_NAMES.join('/')} — falling back to localStorage['${SAVE.storageKey}'].`
    )
  } catch (err) {
    console.warn(`[ui] src/game/save.js could not be loaded, reading localStorage['${SAVE.storageKey}'] instead.`, err)
  }
  careerReader = readCareerFromStorage
  return careerReader
}

function readCareerFromStorage() {
  try {
    const raw = localStorage.getItem(SAVE.storageKey)
    return raw ? JSON.parse(raw) : {}
  } catch (err) {
    console.warn(`[ui] localStorage['${SAVE.storageKey}'] is unreadable; the career panel will show defaults.`, err)
    return {}
  }
}

/** Never rejects: a broken save must not keep the player off the title screen. */
export async function readCareer() {
  const reader = await resolveCareerReader()
  let raw = {}
  try {
    raw = (await reader()) ?? {}
  } catch (err) {
    console.warn('[ui] the save module threw while reading the career record; showing defaults.', err)
  }
  return { ...SAVE.DEFAULTS, ...raw }
}

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------

let loadingDone = false

/**
 * @param {number} pct   progress as a 0..1 fraction; anything above 1 is read as an already-scaled percentage
 * @param {string} [text] status line, e.g. the asset currently streaming in
 */
export function setLoading(pct, text) {
  const fill = byId('load-fill')
  const label = byId('load-text')
  const percent = clamp(pct > 1 ? pct : pct * 100, 0, 100)

  if (fill) fill.style.width = `${percent}%`
  if (label && text !== undefined) label.textContent = text

  // The bar only ever moves forward, so crossing 100 once is the signal to get out of the way.
  if (percent >= 100 && !loadingDone) {
    loadingDone = true
    setHidden('loading', true)
  } else if (percent < 100 && loadingDone) {
    loadingDone = false
    setHidden('loading', false)
  }
}

export function showLoading(text) {
  loadingDone = false
  setLoading(0, text)
  showScreen(SCREEN_IDS.loading)
}

// ---------------------------------------------------------------------------
// Game over
//
// Death is not the title card with a red word on it.
//
// The menu is a warm amber room with the station crisp behind it. This is the
// cold end of the same platform seen through a head that is going out: the
// tunnel light gone blue overhead, arterial red pooled at your back, an EXIT
// sign burning green somewhere you never reached, and the station itself shoved
// four times further out of focus than the title card ever pushes it.
//
// styles.css owns that light, under .screen--over. This file owns the copy, the
// numbers, and the one moment on a death screen worth celebrating.
// ---------------------------------------------------------------------------

/**
 * The colour a personal record is painted in.
 *
 * MENU.PALETTE.amberHex is 0xffb020 and every other stat value used to render in
 * the stylesheet's --amber, #ffb43a — a 4/4/26 delta, which is to say no delta at
 * all on screen. Painting the one good moment on a death screen in it made the
 * celebration invisible, and a colour swap alone would not have saved it either:
 * a green number in a grid is still a number in a grid. The record gets its own
 * row, its own rule, its own light. Green is the only hue this screen does not
 * already spend on something, so it reads instantly against blood and bone.
 *
 * CHOSEN: not in the original spec. rules.js owns the palette, so the value is
 * taken from MENU.PALETTE.newBestHex the moment that key exists there, and is
 * handed to the stylesheet as a custom property rather than as inline paint.
 */
const NEW_BEST_HEX = MENU.PALETTE.newBestHex ?? 0x5ef08a

/**
 * CHOSEN: not in the original spec. The title screen announces the 6:15 arriving
 * on platform one; this answers it in the same voice, so the two screens read as
 * two ends of one night rather than one card with the headline swapped.
 */
const EPITAPH = 'The 6:15 left without you.'

/**
 * byId() logs console.error for an id index.html does not carry, and the frame
 * gate fails a run on any console error — so nodes this file CREATES are looked
 * up with the raw API and built on first miss.
 */
function ensureNode(parent, id, tag, className, before) {
  let el = document.getElementById(id)
  if (!el) {
    if (!parent) return null
    el = document.createElement(tag)
    el.id = id
    parent.insertBefore(el, before ?? null)
  }
  el.className = className
  return el
}

/** One span per slot, reused across runs so a retry never stacks a second copy. */
function ensureChild(parent, index, className) {
  let el = parent.children[index]
  if (!el) {
    el = document.createElement('span')
    parent.append(el)
  }
  el.className = className
  return el
}

/**
 * The record row. Same footprint whether or not the run beat anything, so the
 * layout never jumps between a good night and a bad one — only the light does.
 */
function renderRecord(inner, { wave, previousBest, isRecord }) {
  const row = ensureNode(inner, 'run-record', 'div', 'over__record', document.getElementById('btn-retry'))
  if (!row) return

  const kicker = ensureChild(row, 0, 'over__record-kicker')
  const value = ensureChild(row, 1, 'over__record-val')
  const sub = ensureChild(row, 2, 'over__record-sub')

  if (isRecord) {
    row.classList.add('is-record')
    row.style.setProperty('--record', hex(NEW_BEST_HEX))
    row.style.setProperty('--record-glow', hexRgba(NEW_BEST_HEX, 0.5))
    kicker.textContent = 'New personal best'
    value.textContent = `WAVE ${formatNumber(wave)}`
    sub.textContent = previousBest > 0 ? `beats ${formatNumber(previousBest)}` : 'first record'
  } else {
    row.classList.remove('is-record')
    kicker.textContent = 'Personal best'
    value.textContent = `WAVE ${formatNumber(previousBest)}`
    sub.textContent = `you reached ${formatNumber(wave)}`
  }
}

/**
 * @param {object} stats
 * @param {number} stats.wave          wave reached
 * @param {number} stats.kills         zombies killed this run
 * @param {number} [stats.headshots]
 * @param {number} [stats.score]
 * @param {number} [stats.duration]    run length in seconds
 * @param {number} [stats.accuracy]    shots landed, 0..1 or 0..100 — see below
 * @param {number} [stats.previousBest] best wave BEFORE this run was banked — see MENU.GAME_OVER_LAYOUT
 */
export async function showGameOver(stats = {}) {
  const over = byId('gameover')
  const inner = over?.querySelector('.screen__inner')

  const wave = Number.isFinite(stats.wave) ? stats.wave : 0
  const kills = Number.isFinite(stats.kills) ? stats.kills : 0
  const headshots = Number.isFinite(stats.headshots) ? stats.headshots : 0

  // Nothing in src/game/** banks a shot counter, so a true accuracy figure only
  // exists if a caller measured it. Inventing one would put a fabricated number
  // on the most-read screen in the game; what this card can always tell the
  // truth about is how many of the kills were called shots.
  const measured = Number.isFinite(stats.accuracy)
  const precision = measured
    ? clamp(stats.accuracy > 1 ? stats.accuracy : stats.accuracy * 100, 0, 100)
    : kills > 0
      ? (100 * headshots) / kills
      : 0

  // Six cells against .runstats' three columns — two full rows, no orphan left
  // hanging against the left edge at 1280x720.
  renderStatGrid(byId('run-stats'), [
    [Number.isFinite(stats.completedWaves) ? 'Waves completed' : 'Wave reached', formatNumber(stats.completedWaves ?? wave)],
    ['Kills', formatNumber(kills)],
    [Number.isFinite(stats.combatSeconds) ? 'Combat survived' : 'Time survived', formatDuration(stats.combatSeconds ?? stats.duration ?? 0)],
    ['Headshots', formatNumber(headshots)],
    [measured ? 'Accuracy' : 'Headshot rate', `${formatNumber(precision)}%`],
    ['Score', formatNumber(stats.score ?? 0)],
  ])

  // The original banked the run before reading the stored best, so the celebration
  // could never fire. rules.js opts the port into the snapshot that makes it work.
  let previousBest = stats.previousBest
  if (!Number.isFinite(previousBest)) previousBest = (await readCareer()).bestWave ?? 0

  renderRecord(inner, {
    wave,
    previousBest,
    isRecord: MENU.GAME_OVER_LAYOUT.newBestUsesPreviousBest && wave > previousBest,
  })

  const headline = over?.querySelector('.title--dead')
  if (headline) headline.textContent = MENU.GAME_OVER_LAYOUT.headline
  const epitaph = ensureNode(inner, 'over-epitaph', 'p', 'over__epitaph', byId('run-stats'))
  if (epitaph) epitaph.textContent = EPITAPH

  showScreen(SCREEN_IDS.gameover)
}

export { SCREEN_IDS }
