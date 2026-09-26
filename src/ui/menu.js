/**
 * Title screen and the buttons on the game-over screen.
 *
 * DOM and CSS only — this file must never import three.js (CONTRACT.md).
 *
 * The original was an immediate-mode list the player walked with W/S and
 * confirmed with Enter. index.html gives it real buttons instead, so both
 * paths are wired: click, and the keys named in MENU.KEYS.
 */

import { MENU } from '../game/rules.js'
import {
  byId,
  showScreen,
  hideScreens,
  isScreenVisible,
  renderStatGrid,
  readCareer,
  formatNumber,
  formatDuration,
  SCREEN_IDS,
} from './screens.js'

/** MENU.TITLE_LAYOUT.statsRows names the four panels the original drew; this binds each to its save field. */
const CAREER_FIELD_BY_ROW = Object.freeze({
  'BEST WAVE': 'bestWave',
  'TOTAL KILLS': 'totalKills',
  HEADSHOTS: 'totalHeadshots',
  'GAMES PLAYED': 'gamesPlayed',
})

/** totalPlayTime was banked on every run and never shown anywhere. The port shows it. */
const EXTRA_CAREER_ROW = Object.freeze(['TIME SURVIVED', 'totalPlayTime'])

/**
 * @param {object} handlers
 * @param {() => void} handlers.onPlay   start a run (fired by ENTER THE STATION and by RETRY)
 * @param {() => void} [handlers.onMenu] return to the title screen from game over
 */
export function initMenu({ onPlay, onMenu, jeremyMuted = false, onJeremyMutedChange } = {}) {
  if (typeof onPlay !== 'function') {
    console.error('[menu] initMenu was given no onPlay handler — the play button will do nothing.')
  }

  const btnPlay = byId('btn-play')
  const btnRetry = byId('btn-retry')
  const btnMenu = byId('btn-menu')
  const muteJeremy = byId('mute-jeremy')
  if (muteJeremy) muteJeremy.checked = Boolean(jeremyMuted)
  const changeJeremyMute = () => onJeremyMutedChange?.(muteJeremy.checked)
  muteJeremy?.addEventListener('change', changeJeremyMute)

  function play() {
    hideScreens()
    onPlay?.()
  }

  function toTitle() {
    showScreen(SCREEN_IDS.menu)
    refreshStats()
    onMenu?.()
  }

  btnPlay?.addEventListener('click', play)
  btnRetry?.addEventListener('click', play)
  btnMenu?.addEventListener('click', toTitle)

  /**
   * Keyboard parity with the original list menu. Confirm activates whichever
   * primary button belongs to the screen currently on top; back only means
   * anything on the game-over screen, where it walks to the title.
   */
  function onKeyDown(event) {
    if (event.target === muteJeremy || event.target?.closest?.('input, textarea, select, button, [contenteditable="true"]')) return
    const menuUp = isScreenVisible(SCREEN_IDS.menu)
    const overUp = isScreenVisible(SCREEN_IDS.gameover)
    if (!menuUp && !overUp) return

    if (MENU.KEYS.confirm.includes(event.code)) {
      event.preventDefault()
      play()
      return
    }
    if (overUp && MENU.KEYS.back.includes(event.code)) {
      event.preventDefault()
      toTitle()
    }
  }

  window.addEventListener('keydown', onKeyDown)

  async function refreshStats() {
    const career = await readCareer()
    const rows = MENU.TITLE_LAYOUT.statsRows.map(label => {
      const field = CAREER_FIELD_BY_ROW[label]
      if (!field) {
        console.warn(`[menu] MENU.TITLE_LAYOUT.statsRows lists "${label}" but no save field is bound to it.`)
        return [label, '--']
      }
      return [label, formatNumber(career[field] ?? 0)]
    })
    rows.push([EXTRA_CAREER_ROW[0], formatDuration(career[EXTRA_CAREER_ROW[1]] ?? 0)])
    renderStatGrid(byId('menu-stats'), rows)
  }

  refreshStats()

  return {
    show: toTitle,
    hide: hideScreens,
    refreshStats,
    destroy() {
      window.removeEventListener('keydown', onKeyDown)
      btnPlay?.removeEventListener('click', play)
      btnRetry?.removeEventListener('click', play)
      btnMenu?.removeEventListener('click', toTitle)
      muteJeremy?.removeEventListener('change', changeJeremyMute)
    },
  }
}
