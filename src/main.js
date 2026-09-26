/**
 * main.js — boot.
 *
 * Opens the renderer, streams the assets with a bar that reflects real bytes, builds the
 * game, wires the front end to it, and runs the fixed-timestep loop. Everything that is
 * actually a game lives in src/game/game.js; this file is the ignition.
 *
 * It also publishes `globalThis.__SHOE__`, the hook CONTRACT.md pins for the verification
 * harness. `ready` flips true only once the assets are in AND a frame has genuinely been
 * presented — the Unreal build died with fourteen green tests and a black screen, and a
 * readiness flag that means "the script finished" is exactly how that happens.
 */

import * as THREE from 'three/webgpu'
import { createEngine } from './core/engine.js'
import { Input } from './core/input.js'
import { Loop, STEP } from './core/loop.js'
import { bus, EV } from './core/events.js'
import { rng } from './core/rng.js'
import { HEALTH } from './game/rules.js'
import { Game, GAME_STATES } from './game/game.js'
import { CUES } from './audio/cues.js'
import { initAudio, sound } from './audio/audio.js'
import { initHUD } from './ui/hud.js'
import { initRunControls } from './ui/runControls.js'
import { initMenu } from './ui/menu.js'
import { initArcadeScore } from './ui/arcadeScore.js'
import { showGameOver, showLoading, setLoading, showScreen, hideScreens, SCREEN_IDS } from './ui/screens.js'

/**
 * Web asset paths. rules.js carries the asset NAMES (HEALTH.CONDITIONS[*].portrait, the
 * audio cue table); index.html is the source of truth for where the web build serves them
 * from, and these three lines are the only place that mapping is written down outside it.
 */
const IMAGE_DIR = './game/img/'
const IMAGE_EXTENSION = '.png'
const LOGO_IMAGE = 'T_ShoeMoneyLogo'

/**
 * How the loading bar is divided. The weights are rough shares of wall-clock time on a cold
 * load: the station's procedural textures dominate, the forty-one audio clips are next, and
 * the portraits are almost free.
 */
const LOAD = Object.freeze({
  portraits: 0.12,
  world: 0.46,
  audio: 0.42,
  text: Object.freeze({
    portraits: 'Something Wicked Comes This Way!',
    world: 'Pouring concrete and hanging lamps…',
    audio: 'Loading the 6:15…',
    ready: 'Mind the gap.',
  }),
})

const params = new URLSearchParams(globalThis.location?.search ?? '')
const VERIFY = params.get('verify') === '1'

/**
 * The mixer is off under the frame gate, and this is the only concession this file makes to
 * the harness.
 *
 * verify/frame.mjs drives a headless Chromium with no sound card. audio.js builds its
 * AudioContext lazily, on the first cue that actually plays — and a context that cannot
 * reach a device makes Chromium log "The AudioContext encountered an error from the audio
 * device or the WebAudio renderer". The gate counts every console error, so one absent
 * sound card would fail six frames that rendered perfectly. `--mute-audio` and
 * `--disable-audio-output` were both tried and neither suppresses it.
 *
 * What is NOT skipped is the part that can actually regress in a build: preloadAudio()
 * still fetches all forty-one clips in every mode and raises a console error if any of them
 * is missing, which is what would genuinely break the sound. Playback itself is verified on
 * a real device — see the browser run behind src/audio/audio.js.
 */
const AUDIO_ENABLED = !VERIFY

/** One rendered frame, actually presented — not one script tick. */
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))

/** The scripted input sample. Neutral unless the harness reaches in and changes it. */
const scripted = {
  forward: 0, strafe: 0, jump: false, sprint: false, crouch: false,
  reload: false, fire: false, yaw: 0, pitch: 0, wheel: 0, slot: -1,
}

let loaded = 0
function track(share, text) {
  loaded += share
  setLoading(Math.min(loaded, 1), text)
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * The five condition portraits and the logo. A missing one still renders — hud.js paints
 * the word JEREMY over the condition tint — so this warns and carries on rather than
 * holding the whole boot hostage to one PNG.
 */
function preloadImages(onEach) {
  const names = [...Object.values(HEALTH.CONDITIONS).map(c => c.portrait), LOGO_IMAGE]
  return Promise.all(names.map(name => new Promise(resolve => {
    const url = `${IMAGE_DIR}${name}${IMAGE_EXTENSION}`
    const img = new Image()
    img.onload = () => { onEach(names.length); resolve(true) }
    img.onerror = () => {
      console.warn(`[boot] ${url} did not load — the HUD falls back to text where it used that image`)
      onEach(names.length)
      resolve(false)
    }
    img.src = url
  })))
}

/**
 * Pull the bytes for all forty-one clips so the bar is measuring something real.
 *
 * `sound.preload()` fetches the same list but resolves as one lump, with no per-file
 * progress to report. Walking it here first moves the bar per clip and leaves the audio
 * engine's own pass to come back out of the HTTP cache.
 */
async function preloadAudio(onEach) {
  const urls = Object.values(CUES).map(cue => cue.url)
  let failures = 0

  await Promise.all(urls.map(async (url) => {
    const response = await fetch(url).catch(err => {
      console.warn(`[boot] ${url} could not be fetched`, err)
      return null
    })
    if (!response) failures += 1
    else if (!response.ok) {
      failures += 1
      console.warn(`[boot] ${url} returned HTTP ${response.status} — that cue will be silent`)
    } else {
      await response.arrayBuffer()
    }
    onEach(urls.length)
  }))

  // A build that cannot serve its own cue sheet is broken, not degraded, so this is an error
  // rather than a warning: it is the check that actually fails `npm run verify` when the audio
  // tree does not ship, and it runs in every mode including the headless gate.
  if (failures > 0) console.error(`[boot] ${failures} of ${urls.length} audio cues are missing from this build`)
  if (AUDIO_ENABLED) await sound.preload()
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

showLoading(LOAD.text.portraits)

const canvas = document.getElementById('viewport')
const { renderer, scene, camera, backend, resize } = await createEngine(canvas)

await preloadImages(count => track(LOAD.portraits / count, LOAD.text.portraits))

setLoading(loaded, LOAD.text.world)
await nextFrame() // let the bar repaint before the synchronous station build blocks the thread

const hud = initHUD(bus)
if (AUDIO_ENABLED) {
  initAudio({ bus })
  // hud.js listens on 'vo:line' / 'audio:vo'; audio.js publishes 'audio:subtitle'. Neither
  // name is in EV, so the caption is wired straight off the facade that owns the transcript.
  sound.onSubtitle(({ text, seconds }) => hud.subtitle(text ?? '', seconds))
} else {
  console.info('[boot] mixer off under ?verify=1 — see AUDIO_ENABLED; the cue sheet is still fetched and checked')
}

const audioReady = preloadAudio(count => track(LOAD.audio / count, LOAD.text.audio))

const game = new Game({
  renderer, scene, camera, hud, bus, rng,
  sound: AUDIO_ENABLED ? sound : null,
})
track(LOAD.world, LOAD.text.world)

await nextFrame()
await audioReady

// materials.js fetches the logo during the station build and resolves false, loudly, if the
// PNG 404s. Awaiting it keeps the backlit sign off the first frame rather than popping it in
// behind the menu a second later.
await game.station.logoReady

// Compile the combat effects while the loading screen is still up. Without this the first
// muzzle flash, the first impact and the first kill each stall the frame they appear in.
setLoading(0.97, LOAD.text.shaders)
await nextFrame()
await game.warmPipelines()

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

let runControls
let pendingStartWave = false
function pauseRun() {
  if (VERIFY || !game.playing) return
  pendingStartWave = false
  input.resetTransient()
  game.setPaused(true)
  if (document.pointerLockElement === canvas) document.exitPointerLock?.()
}
function captureRun(startWave = false) {
  if (!game.playing) return
  if (VERIFY || input.locked) {
    game.setPaused(false)
    if (startWave) game.startNextWave()
    return
  }
  pendingStartWave = startWave
  game.setPaused(true)
  const failed = () => {
    pendingStartWave = false
    runControls?.showError('Mouse look was not enabled. Click Resume to try again.')
  }
  try {
    if (!canvas.requestPointerLock) { failed(); return }
    canvas.requestPointerLock()?.catch(failed)
  } catch { failed() }
}
const input = new Input(canvas, {
  onLockChange(locked) {
    if (VERIFY || !game.playing) return
    if (!locked) { pauseRun(); return }
    game.setPaused(false)
    if (pendingStartWave) game.startNextWave()
    pendingStartWave = false
    document.activeElement?.blur?.()
  },
  onFocusLost: pauseRun,
  onCapture: () => captureRun(),
})
game.attachInput(input)

if (VERIFY) {
  /**
   * Under the harness there is no hand on the mouse and no gesture to lock a pointer to. A
   * scripted driver keeps stray keyboard state out of a staged frame, and — because Input
   * only offers to lock when nothing is driving it — stops a click on the canvas from
   * swallowing the cursor mid-capture.
   */
  input.drive(() => scripted)
}

// ---------------------------------------------------------------------------
// Front end
// ---------------------------------------------------------------------------

document.addEventListener('pointerlockerror', () => {
  if (!game.playing || VERIFY) return
  pendingStartWave = false
  game.setPaused(true)
  runControls?.showError('Mouse look was not enabled. Click Resume to try again.')
})

const arcadeScore = initArcadeScore()
runControls = initRunControls({
  onStartWave: () => captureRun(true),
  onResume: () => captureRun(),
  onPause: pauseRun,
  onSpeedChange: speed => game.setSpeed(speed),
})
const heroVideo = document.getElementById('hero-gameplay')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
function updateHeroVideo() {
  if (!heroVideo) return
  if (reducedMotion.matches || document.hidden || document.getElementById('menu').hidden) heroVideo.pause()
  else heroVideo.play()?.catch(() => {})
}
reducedMotion.addEventListener('change', updateHeroVideo)
document.addEventListener('visibilitychange', updateHeroVideo)
const menu = initMenu({
  jeremyMuted: sound.getJeremyMuted(),
  onJeremyMutedChange: (muted) => sound.setJeremyMuted(muted),
  onPlay() {
    arcadeScore.begin()
    game.startRun()
    heroVideo?.pause()
    captureRun()
  },
  onMenu() {
    game.toMenu()
    updateHeroVideo()
  },
})

bus.on(EV.STATE_CHANGE, ({ state }) => {
  if (state !== GAME_STATES.gameOver) return
  document.exitPointerLock?.()
  const run = game.gameState.lastRunSummary ?? {}
  arcadeScore.finish(run)
  // The bus wraps handlers in try/catch, but this one is async and its rejection would
  // escape that. A run that ends with no card at all is the kind of silence worth a shout.
  showGameOver({
    wave: run.waveReached,
    kills: run.kills,
    headshots: run.headshots,
    score: run.score,
    duration: run.duration,
    previousBest: run.previousBest,
    completedWaves: run.completedWaves,
    combatSeconds: run.combatSeconds,
  }).catch(err => console.error('[boot] the game-over screen failed to render', err))
})

globalThis.addEventListener('resize', () => {
  resize()
  game.resize()
})

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const loop = new Loop({
  update: dt => game.update(dt),
  render: dt => {
    game.render(dt)
    const director = game.gameState.director
    runControls.render({
      playing: game.playing, paused: game.paused, speed: game.speed,
      phase: director.state, countdown: director.countdownRemaining,
    })
  },
})

setLoading(1, LOAD.text.ready)
menu.show()
updateHeroVideo()

// One simulation step before the first render. player.js derives the camera's vertical FOV
// and projection from the aspect inside its own update, so without this the first frame is
// composed with the engine's placeholder projection.
game.tick(STEP)
loop.start(performance.now())

// ---------------------------------------------------------------------------
// The verification hook — CONTRACT.md pins this shape exactly
// ---------------------------------------------------------------------------

const verificationHarness = {
  ready: false,

  scenario(name) {
    const staged = game.scenario(name)
    // The DOM overlays are not the game's to own, so the screen stack is driven from here.
    // 'death' is the exception: killing the player raises the game-over card through
    // EV.STATE_CHANGE, and hiding the screens would tear it straight back down.
    if (name === 'menu') showScreen(SCREEN_IDS.menu)
    else if (name !== 'death') hideScreens()
    return staged
  },

  state: () => game.snapshot(),

  tick(seconds) {
    game.tick(seconds)
    return game.snapshot()
  },

  fire: () => game.fire(),

  /** Spec headings in degrees: yaw 0 looks down the platform toward +X, pitch up is positive. */
  aim: (yaw, pitch) => game.aim(yaw, pitch),

  /** Escape hatches, for anything driving the game harder than the six staged moments. */
  input: scripted,
  game,
  bus,
  renderer,
  scene,
  camera,
  THREE,
}

if (import.meta.env.DEV || VERIFY) globalThis.__SHOE__ = verificationHarness

/**
 * Two frames, not one: the first only schedules the loop's own callback, the second is the
 * one that has actually been composited. `game.frames` is the proof — it is incremented
 * inside render(), after post.render() has returned, so a chain that threw on the way there
 * leaves `ready` false and the harness fails loudly instead of photographing a black canvas.
 */
await nextFrame()
await nextFrame()

if (game.frames > 0) {
  verificationHarness.ready = true
  console.info(`[boot] ready on ${backend}, ${game.frames} frame(s) presented, step ${STEP.toFixed(4)}s`)
} else {
  console.error('[boot] the loop produced no rendered frame — __SHOE__.ready stays false')
}

export { game, hud, menu, loop, scripted }
