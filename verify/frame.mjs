/**
 * Proves the game RENDERS. Not that it builds, not that it boots, not that the
 * process stayed alive — that a human looking at the screen would see a game.
 *
 * Every scenario is isolated: a crash in one is captured and reported, never
 * allowed to abort the run and take the other five frames' evidence with it.
 */
import { chromium } from 'playwright'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { mkdir as mkdirLock, rm as rmLock, writeFile as writeLock, readFile as readLock } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { serve, assertFreshBuild } from './serve.mjs'
import { analyze, GATE, judge, gradeShardSilhouettes, SHARD_GATE, gradeViewmodelSilhouette, VIEWMODEL_GATE } from './pixels.mjs'
import { FX } from '../src/game/rules.js'

const ROOT = new URL('../dist/', import.meta.url).pathname
const OUT = new URL('./out/', import.meta.url).pathname
// A fixed port plus `pkill -f verify/frame.mjs` was a self-inflicted disaster: the
// pattern also matches the `zsh -c` wrapper that CONTAINS the string, so an agent
// killed its own shell and its siblings' runs, and every concurrent run fought over
// one port and one output directory. Nobody should have to remember to be careful.
//
// Instead: take an exclusive lock (mkdir is atomic), wait politely for a peer, and
// bind an ephemeral port nobody can collide with.
const LOCK = new URL('./.gate.lock/', import.meta.url).pathname
const LOCK_STALE_MS = 15 * 60 * 1000

async function acquireLock() {
  const deadline = Date.now() + 20 * 60 * 1000
  for (;;) {
    try {
      await mkdirLock(LOCK)
      await writeLock(`${LOCK}owner`, `${process.pid}\n${new Date().toISOString()}\n`)
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let age = Infinity
      try {
        const stamp = await readLock(`${LOCK}owner`, 'utf8')
        const [pid, iso] = stamp.split('\n')
        age = Date.now() - Date.parse(iso)
        try { process.kill(Number(pid), 0) } catch { age = Infinity }  // holder is gone
      } catch { age = Infinity }

      if (age > LOCK_STALE_MS) {
        console.log('→ clearing a stale gate lock')
        await rmLock(LOCK, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error('gate lock held for 20 minutes; giving up')
      console.log('→ another frame capture holds the gate lock, waiting…')
      await new Promise(r => setTimeout(r, 10000))
    }
  }
}

async function releaseLock() {
  await rmLock(LOCK, { recursive: true, force: true }).catch(() => {})
}
const HEADED = process.argv.includes('--headed')
const BACKEND = process.argv.includes('--webgpu') ? 'webgpu' : 'webgl'

// Boot bakes 32 procedural textures and compiles the whole post chain. Options are
// waitForFunction's THIRD argument — passing them second silently keeps the 30s default,
// which is how this harness once reported a boot failure on a game that booted fine.
const BOOT_TIMEOUT = 150000
// The firefight frame is the heaviest in the game and once blew Playwright's 30s
// screenshot default. A slow capture is not a failed capture.
const SHOT_TIMEOUT = 120000

const SCENARIOS = [
  { name: 'menu', settle: 1200 },
  { name: 'platform', settle: 1800 },
  { name: 'train', settle: 1800 },
  { name: 'firefight', settle: 1800 },
  { name: 'boss', settle: 1800 },
  { name: 'death', settle: 1400 },
  { name: 'summit', settle: 1800 },
]

await acquireLock()
// Release on any exit path, including a crash — a lock nobody clears is a deadlock.
process.on('exit', () => { try { rmSync(LOCK, { recursive: true, force: true }) } catch {} })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1))

await assertFreshBuild(ROOT, new URL('../', import.meta.url).pathname)
const server = await serve(ROOT, 0)          // 0 = let the OS pick a free port
const PORT = server.address().port
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required',
    '--mute-audio', '--js-flags=--max-old-space-size=4096',
  ],
})

const consoleErrors = []
const results = []
let crashed = null
let backend = 'unknown'

const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
let page = await context.newPage()
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
page.on('crash', () => consoleErrors.push('PAGE CRASHED (renderer process died)'))

const url = `http://localhost:${PORT}/?renderer=${BACKEND}&verify=1&seed=1337`
console.log(`→ ${url}`)

try {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('globalThis.__SHOE__ && globalThis.__SHOE__.ready === true', null, { timeout: BOOT_TIMEOUT })
  backend = await page.evaluate('globalThis.__SHOE_BACKEND__')
  console.log(`→ backend: ${backend}`)
} catch (err) {
  crashed = `boot: ${err.message.split('\n')[0]}`
  console.error(`✗ BOOT FAILED — ${crashed}`)
}

let failed = 0

if (!crashed) {
  for (const s of SCENARIOS) {
    try {
      await page.evaluate(n => globalThis.__SHOE__.scenario(n), s.name)
      await page.waitForTimeout(s.settle)

      const png = await page.screenshot({ timeout: SHOT_TIMEOUT })
      await writeFile(`${OUT}${s.name}.png`, png)   // write it ourselves; never trust a flush we did not do

      const m = analyze(png)
      const fails = judge(m)
      results.push({ scenario: s.name, ...m, fails })

      console.log(
        `${fails.length ? '✗ FAIL' : '✓ pass'}  ${s.name.padEnd(10)} ` +
        `lum=${String(m.meanLuminance).padStart(6)} sd=${String(m.stdDev).padStart(6)} ` +
        `black=${String(m.blackPct).padStart(5)}% hues=${String(m.distinctHues).padStart(2)} ` +
        `(${png.length >> 10}KB)`
      )
      if (fails.length) { failed++; fails.forEach(f => console.log(`        ↳ ${f}`)) }
    } catch (err) {
      failed++
      const msg = err.message.split('\n')[0]
      results.push({ scenario: s.name, error: msg })
      console.log(`✗ CRASH ${s.name.padEnd(10)} ${msg}`)

      // The renderer died. Rebuild the page so the remaining scenarios still get judged.
      try {
        if (page.isClosed?.() || msg.includes('closed') || msg.includes('crash')) {
          page = await context.newPage()
          page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
          page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
          await page.goto(url, { waitUntil: 'load' })
          await page.waitForFunction('globalThis.__SHOE__ && globalThis.__SHOE__.ready === true', null, { timeout: BOOT_TIMEOUT })
          console.log(`        ↳ recovered, page reloaded`)
        }
      } catch (e2) {
        console.log(`        ↳ could not recover: ${e2.message.split('\n')[0]}`)
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shard silhouettes — runs LAST, on purpose
// ---------------------------------------------------------------------------
//
// This step MUTATES the live scene, so it must never run before the seven scenario frames
// are captured and judged. It is the only check here that grades the SHAPE of a piece of
// geometry rather than the light in the frame.
//
// It stages nine blood gobs in a 3x3 grid 150 cm in front of the eye, each at a different
// fixed rotation, against a flat unlit panel 65 cm further out. No burst is live, so
// nothing rewrites the matrices and the frame is deterministic — it does not depend on
// blood velocity or on screenshot latency.
//
// WHY A BACKDROP PANEL, AND WHAT IT DOES NOT CHANGE: the gob keeps its real geometry, its
// real material and the real lights and post chain; only what is BEHIND it is replaced.
// That is the difference between a silhouette that can be measured and one that cannot.
// Measured on the first attempt without it, against the live platform: the station's own
// clutter and the orange "NEXT TRAIN INBOUND" banner cut straight across the top row, and
// a colour mask found 1 gob of 9 because a dark object is black on its unlit side. The
// panel is unlit MeshBasic and well under the 1.05 pre-tonemap bloom threshold, so the
// backdrop itself cannot bloom and eat into the silhouette.
//
// It is SATURATED BLUE, which is not decoration: it is the one hue a blood gob never has,
// so the grader can separate gob from panel by hue instead of by brightness. See the long
// note in pixels.mjs for the two brightness tests that were measured and thrown away — one
// let the highlight's bloom grow a spur past the rim, the other cut the bright specular
// crescent off the rim entirely.
//
// The DOM HUD and the weapon viewmodel are hidden for the same reason: both are composited
// over the gobs and neither is the geometry under test.
//
// The gobs are rendered at 26 cm, not their true 2.0-3.5 cm, because a 5 px blob cannot be
// hulled. See the caveat in pixels.mjs: this gates shape, which is scale-invariant, and
// says nothing about size.

const SHARD_EULERS = [
  [0.00, 0.00, 0.00], [0.41, 0.93, 0.22], [1.12, 0.28, 0.84],
  [0.19, 1.44, 1.21], [0.88, 0.62, 0.07], [1.33, 1.09, 0.51],
  [0.54, 0.17, 1.52], [0.73, 1.26, 0.95], [1.47, 0.79, 0.33],
]

// The stretch comes from the SHIPPED tunable, not from a number written here, and the nine
// gobs walk its extremes at nine different rotations. Widening FX.IMPACT.bloodStretchMax
// therefore re-aims this gate at the new worst case instead of sliding under it: gob 0 is
// the unstretched baseline and the rest carry the full min/max anisotropy.
const { bloodStretchMin: SMIN, bloodStretchMax: SMAX } = FX.IMPACT
const SMID = (SMIN + SMAX) / 2
const SHARD_STRETCH = [
  [1, 1, 1],
  [SMAX, SMIN, SMID], [SMIN, SMAX, SMID], [SMID, SMAX, SMIN],
  [SMAX, SMID, SMIN], [SMIN, SMID, SMAX], [SMID, SMIN, SMAX],
  [SMAX, SMIN, SMIN], [SMAX, SMAX, SMIN],
]

let shardGobs = null
if (!crashed) {
  try {
    await page.evaluate(() => globalThis.__SHOE__.scenario('platform'))
    await page.waitForTimeout(1500)

    const points = await page.evaluate(({ eulers, stretches }) => {
      const S = globalThis.__SHOE__
      const T = S.THREE
      const root = S.scene.getObjectByName('fx:impacts')
      if (!root) throw new Error('no object named fx:impacts in the scene')
      const blood = root.getObjectByName('fx:shards:blood')
      if (!blood) throw new Error('no object named fx:shards:blood under fx:impacts')
      const pool = blood.userData.pool
      if (!pool) throw new Error('fx:shards:blood has no userData.pool — cannot reserve slots')

      // postfx's own master dial, not a switch added for this test: it zeroes bloom, grain,
      // vignette and AO and leaves the tone curve and grade. Bloom is LIGHT, not SHAPE, and
      // it is the one thing that makes this frame unmeasurable — a blown specular highlight
      // on the rim throws a fully clamped white plume PAST the silhouette, and 255,255,255
      // outside the gob is indistinguishable from 255,255,255 on it, by hue or by anything
      // else. Measured with bloom on: gob 2 read 41.1 deg against an analytic silhouette of
      // 28.7 deg. The seven scenario frames above still gate the full chain at full
      // intensity; this one frame asks a question about geometry.
      S.game?.post?.setIntensity(0)
      for (const el of document.querySelectorAll('#hud, .screen')) el.style.display = 'none'
      root.traverse((o) => { if (o.isSprite) o.visible = false })
      const vm = S.scene.getObjectByName('viewmodel')
      if (vm) vm.visible = false

      const cam = S.camera
      cam.updateMatrixWorld(true)

      const panel = new T.Mesh(
        new T.PlaneGeometry(900, 600),
        new T.MeshBasicNodeMaterial({ color: 0x001860, fog: false, toneMapped: false })
      )
      panel.name = 'probe:backdrop'
      panel.frustumCulled = false
      panel.renderOrder = -1
      panel.position.set(0, 0, -215)
      cam.add(panel)
      if (!cam.parent) S.scene.add(cam)

      const pts = []
      let i = 0
      for (let gy = 1; gy >= -1; gy--) {
        for (let gx = -1; gx <= 1; gx++, i++) {
          const world = new T.Vector3(gx * 46, gy * 46, -150).applyMatrix4(cam.matrixWorld)
          const q = new T.Quaternion().setFromEuler(new T.Euler(...eulers[i]))
          const st = stretches[i]
          const m = new T.Matrix4().compose(
            world, q, new T.Vector3(0.26 * st[0], 0.26 * st[1], 0.26 * st[2]),
          )
          pool.write(pool.take(), m)
          const ndc = world.clone().project(cam)
          pts.push({
            x: (ndc.x * 0.5 + 0.5) * window.innerWidth,
            y: (-ndc.y * 0.5 + 0.5) * window.innerHeight,
          })
        }
      }
      pool.flush()

      // THE PROBE RESERVES REAL SLOTS, IT DOES NOT WRITE BEHIND THE POOL'S BACK.
      //
      // It used to call blood.setMatrixAt() directly, which rendered only because the pool
      // submitted its full 240-instance capacity every frame whether anything was live or
      // not. The moment that waste was fixed, this gate went blank — nine "probe found no
      // gob" failures — because an InstancedMesh draws only [0, count) and a matrix written
      // into an unreserved slot is outside it. The staging had been riding on the bug.
      //
      // Going through take()/write()/flush() means the pool's own bookkeeping is exercised by
      // this gate rather than bypassed by it, so a regression in the live-count logic now
      // shows up here as a blank frame instead of hiding behind a probe that faked its own
      // count. Deterministic placement is preserved, which is what the silhouette grader
      // needs: it seeds each gob from a known screen point.
      return pts
    }, { eulers: SHARD_EULERS, stretches: SHARD_STRETCH })

    await page.waitForTimeout(600)
    const png = await page.screenshot({ timeout: SHOT_TIMEOUT })
    await writeFile(`${OUT}shards.png`, png)

    shardGobs = gradeShardSilhouettes(png, points)
    const bad = shardGobs.filter(g => g.fails.length)
    console.log(
      `${bad.length ? '\u2717 FAIL' : '\u2713 pass'}  ${'shards'.padEnd(10)} ` +
      `${shardGobs.length - bad.length}/${shardGobs.length} gobs round  ` +
      `turn=${shardGobs.map(g => g.maxTurn ?? '--').join('/')}  ` +
      `circ=${shardGobs.map(g => g.circularity ?? '--').join('/')}`
    )
    if (bad.length) {
      failed++
      bad.forEach(g => console.log(`        \u21b3 gob ${g.i}: ${g.fails.join('; ')}`))
    }
  } catch (err) {
    failed++
    const msg = err.message.split('\n')[0]
    shardGobs = { error: msg }
    console.log(`\u2717 CRASH ${'shards'.padEnd(10)} ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Viewmodel silhouette — also LAST, and for the same reason
// ---------------------------------------------------------------------------
//
// This grants weapons the player has not picked up, so it mutates the live run and must come
// after the seven scenario frames. It asks the one question those frames cannot: the gun in
// the player's hands is ~7% of the frame, so a black gun moves whole-frame mean luminance by
// under a point and every scenario still passes with it unlit.
//
// ONE scenario, ONE camera, ONE lighting setup for all three weapons, so scenario lighting is
// not a variable. For each weapon: grant it, settle, screenshot with the viewmodel visible,
// then screenshot again with it hidden. Every other pixel in those two frames is identical, so
// the difference is the weapon, its glove and its sleeve — and nothing else. See the long note
// in pixels.mjs for why a difference beats a hand-drawn rectangle here.
//
// The post chain stays at FULL intensity, unlike the shard step: bloom is part of how a lit gun
// reads, and the question here is light, not shape.

const VIEWMODEL_WEAPONS = ['pistol', 'rifle', 'shotgun']

const viewmodelGrades = []
if (!crashed) {
  try {
    await page.evaluate(() => globalThis.__SHOE__.scenario('platform'))
    await page.waitForTimeout(1500)
    // The shard step left a backdrop panel on the camera and the impacts sprites hidden.
    // Undo both, or this frame grades the gun against a blue card.
    await page.evaluate(() => {
      const S = globalThis.__SHOE__
      const panel = S.camera.getObjectByName('probe:backdrop')
      if (panel) { S.camera.remove(panel); panel.geometry.dispose(); panel.material.dispose() }
      S.game?.post?.setIntensity(1)
      const root = S.scene.getObjectByName('fx:impacts')
      root?.traverse((o) => { if (o.isSprite) o.visible = true })
      const vm = S.scene.getObjectByName('viewmodel')
      if (vm) vm.visible = true
    })
    await page.waitForTimeout(600)

    for (const id of VIEWMODEL_WEAPONS) {
      await page.evaluate(w => globalThis.__SHOE__.game.weapons.grant(w), id)
      // A grant starts a draw, and the holster group is mid-raise for WEAPONS.switchCooldown.
      // Photographing that gives a gun half out of frame, which is a smaller silhouette, not a
      // darker one — but it is also not the pose anyone plays with. Let it settle.
      await page.waitForTimeout(1400)

      const on = await page.screenshot({ timeout: SHOT_TIMEOUT })
      // Hiding the root also takes its three point lights out of the light list, which is the
      // point: on a fixed exposure the difference is then exactly the lit weapon. three
      // recompiles materials when the light count changes, so settle again before the second
      // shot or the frame is a picture of the compiler.
      await page.evaluate(() => { globalThis.__SHOE__.scene.getObjectByName('viewmodel').visible = false })
      await page.waitForTimeout(900)
      const off = await page.screenshot({ timeout: SHOT_TIMEOUT })
      await page.evaluate(() => { globalThis.__SHOE__.scene.getObjectByName('viewmodel').visible = true })
      await page.waitForTimeout(900)

      await writeFile(`${OUT}viewmodel-${id}.png`, on)
      await writeFile(`${OUT}viewmodel-${id}-off.png`, off)
      const g = gradeViewmodelSilhouette(on, off, id)
      viewmodelGrades.push(g)

      console.log(
        `${g.fails.length ? '\u2717 FAIL' : '\u2713 pass'}  ${('vm:' + id).padEnd(10)} ` +
        `medianL=${String(g.medianL ?? '--').padStart(6)} ` +
        `under20=${String(g.pctUnder20 ?? '--').padStart(6)}% ` +
        `patchSd=${String(g.patchLsd_p50 ?? '--').padStart(5)} ` +
        `area=${g.area}px bbox=${(g.bbox ?? []).join(',')}`
      )
      if (g.fails.length) { failed++; g.fails.forEach(f => console.log(`        \u21b3 ${f}`)) }
    }
  } catch (err) {
    failed++
    const msg = err.message.split('\n')[0]
    viewmodelGrades.push({ error: msg })
    console.log(`\u2717 CRASH ${'viewmodel'.padEnd(10)} ${msg}`)
  }
}

let playState = null
try { playState = await page.evaluate('globalThis.__SHOE__.state()') } catch {}

await writeFile(`${OUT}report.json`, JSON.stringify(
  { backend, gate: GATE, shardGate: SHARD_GATE, viewmodelGate: VIEWMODEL_GATE, crashed, results,
    shardGobs, viewmodelGrades, playState, consoleErrors }, null, 2))

await browser.close()
server.close()
await releaseLock()

console.log(`\nframes: ${OUT}`)
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`)
  consoleErrors.slice(0, 15).forEach(e => console.log(`  ! ${e.slice(0, 220)}`))
}

const passed = results.filter(r => !r.error && !r.fails?.length).length
if (crashed || failed || consoleErrors.length) {
  console.error(`\nFRAME GATE FAILED — ${passed}/${SCENARIOS.length} rendered, ${consoleErrors.length} console errors`)
  process.exit(1)
}
console.log(`\nFRAME GATE PASSED — ${passed}/${SCENARIOS.length} scenarios on ${backend}`)
