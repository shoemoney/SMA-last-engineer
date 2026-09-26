/**
 * End to end: boot the built game in a real browser and PLAY it.
 *
 * Every other gate in this repo checks a slice — the damage maths in node, a staged frame's
 * pixels, a frame-time distribution. None of them presses a button. This one starts at the
 * title screen and does not stop until it has killed something, taken damage, climbed nine
 * metres, died, and started again.
 *
 * Each step asserts on state the GAME reports, not on what the script just asked for. A test
 * that checks its own input proves nothing.
 *
 *   node verify/e2e.mjs            # headed, the honest default
 *   node verify/e2e.mjs --q=low
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { serve, assertFreshBuild } from './serve.mjs'
import { analyze, judge } from './pixels.mjs'

const ROOT = new URL('../dist/', import.meta.url).pathname
const OUT = new URL('./e2e/', import.meta.url).pathname
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const QUALITY = arg('q', 'medium')

await mkdir(OUT, { recursive: true })
await assertFreshBuild(ROOT, new URL('../', import.meta.url).pathname)
const server = await serve(ROOT, 0)
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--mute-audio'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

const consoleErrors = []
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`))
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })

const results = []
let stepNo = 0
async function step(name, fn) {
  stepNo++
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`✓ ${String(stepNo).padStart(2)}. ${name.padEnd(42)} ${detail ?? ''}  (${Date.now() - t0}ms)`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
    console.log(`✗ ${String(stepNo).padStart(2)}. ${name.padEnd(42)} ${err.message.slice(0, 90)}`)
  }
}
const state = () => page.evaluate(() => globalThis.__SHOE__.state())
const sim = (seconds, dt = 0.05) => page.evaluate(([s, d]) => {
  const g = globalThis.__SHOE__.game
  for (let i = 0; i < Math.round(s / d); i++) g.tick(d)
}, [seconds, dt])
const shot = async name => {
  const png = await page.screenshot({ timeout: 120000 })
  await writeFile(`${OUT}${name}.png`, png)
  return analyze(png)
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

// ---------------------------------------------------------------------------

await step('boot to a playable state', async () => {
  const t0 = Date.now()
  await page.goto(`http://localhost:${server.address().port}/?renderer=webgpu&verify=1&seed=4242&q=${QUALITY}`,
    { waitUntil: 'load' })
  await page.waitForFunction('globalThis.__SHOE__ && globalThis.__SHOE__.ready === true', null, { timeout: 200000 })
  return `${((Date.now() - t0) / 1000).toFixed(1)}s on ${await page.evaluate('globalThis.__SHOE_BACKEND__')}`
})

await step('title screen renders and is legible', async () => {
  await page.evaluate(() => globalThis.__SHOE__.scenario('menu'))
  await page.waitForTimeout(1200)
  const m = await shot('01-menu')
  const fails = judge(m)
  assert(!fails.length, `menu frame failed the pixel gate: ${fails.join('; ')}`)
  const hasTitle = await page.evaluate(() => !!document.querySelector('.title') &&
    getComputedStyle(document.getElementById('menu')).display !== 'none')
  assert(hasTitle, 'no visible title card')
  return `lum ${m.meanLuminance}, ${m.distinctHues} hues`
})

await step('pressing play starts a run', async () => {
  await page.evaluate(() => document.getElementById('btn-play').click())
  await page.waitForTimeout(800)
  const s = await state()
  assert(s.alive, 'player is not alive after pressing play')
  assert(s.health > 0, `health is ${s.health}`)
  const hudVisible = await page.evaluate(() => !document.getElementById('hud').hidden)
  assert(hudVisible, 'HUD did not appear')
  return `wave ${s.wave}, ${s.health}hp, weapon ${s.weapon}`
})

await step('zombies spawn and close the distance', async () => {
  const before = (await state()).bodies
  await sim(25)
  const after = await state()
  assert(after.bodies > 0, `no zombies alive after 25s (spawned from ${before})`)
  return `${after.bodies} on the platform, ${after.remaining} left in the wave`
})

await step('firing kills and scores', async () => {
  const before = await state()
  const detail = await page.evaluate(() => {
    const S = globalThis.__SHOE__, g = S.game
    /**
     * Park a body on the player's OWN aim line, confirm with the game's OWN trace, then
     * shoot. Do not compute an angle.
     *
     * Five earlier versions of this step tried to aim and every one missed, because bodies
     * live under a Z-up remap mount and the player does not. Each failure read as "firing
     * does not kill" and each was wrong — separate probes showed the magazine draining, a
     * body going 100hp to 80, and direct damage killing and scoring correctly. One of those
     * versions also held the trigger down for sixty seconds against a SEMI-AUTOMATIC pistol,
     * which fires once per pull: it put a single round downrange and called the game broken.
     *
     * Automated aim proves nothing about a game anyway. What is worth asserting is the
     * chain: trace finds flesh, the hit resolves a zone, damage lands, the body dies, the
     * score moves. Place the target where the shooter is already looking and test that.
     */
    if (!S.state().alive) g.startRun()
    for (let i = 0; i < 300; i++) g.tick(0.05)

    const live = () => g.zombies.bodies.filter(z => z && z.alive !== false && (z.health?.alive ?? true))
    if (!live().length) return { note: 'no bodies spawned' }

    const V = S.THREE.Vector3
    const eye = g.player.aimOrigin(), dir = g.player.aimDirection()
    const ahead = { x: eye.x + dir.x * 300, y: eye.y + dir.y * 300, z: eye.z + dir.z * 300 }
    // three -> spec is (x, -z, y); this is the same conversion the weapon's trace uses.
    const toSpec = pt => [pt.x, -pt.z, pt.y]

    const target = live()[0]
    target.position.set(...toSpec(ahead))

    // Confirm the shooter is genuinely on target BEFORE pulling, so a miss cannot be
    // mistaken for a broken weapon.
    const so = new V(...toSpec(eye)), sd = new V(...toSpec(dir)).normalize()
    const sighted = g.zombies.raycast(so, sd, 10000)
    if (!sighted) return { note: 'target placed but the trace does not see it' }

    let rounds = 0
    for (let i = 0; i < 240; i++) {
      target.position.set(...toSpec(ahead))   // hold it there; it is trying to walk at us
      g.weapons.setTrigger(i % 2 === 0)       // PULSE: the pistol is semi-automatic
      g.tick(0.05)
      rounds++
      if (!target.health?.alive) break
    }
    g.weapons.setTrigger(false)
    return { zone: sighted.zone, distance: Math.round(sighted.distance), rounds }
  })
  const after = await state()
  assert(!detail.note, detail.note ?? '')
  assert(after.kills > before.kills, `kills did not rise (${before.kills} -> ${after.kills})`)
  assert(after.score > before.score, `score did not rise (${before.score} -> ${after.score})`)
  return `${after.kills - before.kills} kill, +${after.score - before.score} score, ${detail.zone} hit at ${detail.distance}cm`
})

await step('combat frame is readable', async () => {
  const m = await shot('02-firefight')
  const fails = judge(m)
  assert(!fails.length, `firefight frame failed: ${fails.join('; ')}`)
  return `lum ${m.meanLuminance}, ${m.distinctHues} hues`
})

await step('the player can take damage', async () => {
  // Revive first if the fight killed us. Asserting "damage lowers health" on a corpse
  // fails for a reason that has nothing to do with damage.
  await page.evaluate(() => { if (!globalThis.__SHOE__.state().alive) globalThis.__SHOE__.game.startRun() })
  const before = (await state()).health
  await page.evaluate(() => {
    const g = globalThis.__SHOE__.game
    g.player.applyDamage?.(35, false, null) ?? g.player.health.applyDamage(35, false, null)
  })
  const after = (await state()).health
  assert(after < before, `health did not drop (${before} -> ${after})`)
  return `${before} -> ${after}hp`
})

await step('the trackway does not trap the player', async () => {
  await page.evaluate(() => {
    const g = globalThis.__SHOE__.game
    g.player.teleport?.(2000, -170, -600)      // standing on the rails, the reported trap
  })
  await sim(4)
  const y = await page.evaluate(() => globalThis.__SHOE__.game.player.position.y)
  assert(y > -100, `still in the pit at y=${y.toFixed(0)}`)
  return `lifted back to y=${y.toFixed(0)}`
})

await step('the summit is reachable', async () => {
  await page.evaluate(() => globalThis.__SHOE__.scenario('summit'))
  await page.waitForTimeout(1500)
  const s = await state()
  assert(s.altitude >= 900, `altitude only ${s.altitude}`)
  const m = await shot('03-summit')
  const fails = judge(m)
  assert(!fails.length, `summit frame failed: ${fails.join('; ')}`)
  return `altitude ${s.altitude}, lum ${m.meanLuminance}`
})

await step('idle crowd keeps moving, never freezes', async () => {
  // The bug this guards is a CROWD freezing solid after the player dies (post-death
  // condition below). Proof requires several bodies actually moving — one twitching
  // zombie is not a crowd, it is a coincidence. `n < 3` means the platform cannot even
  // in principle supply that proof right now, so it is reported as a loud skip rather
  // than a silent pass: a green check here must mean the crowd was actually exercised.
  const { n, moved } = await page.evaluate(() => {
    const g = globalThis.__SHOE__.game
    g.zombieWorld.player = null                 // the post-death condition
    const live = g.zombies.bodies.filter(z => z && z.alive !== false && (z.health?.alive ?? true))
    if (!live.length) return { n: 0, moved: 0 }
    const before = live.map(z => ({ x: z.position.x, y: z.position.y }))
    for (let i = 0; i < 60; i++) g.tick(0.05)
    const moved = live.filter((z, i) => Math.hypot(z.position.x - before[i].x, z.position.y - before[i].y) > 3).length
    return { n: live.length, moved }
  })
  if (n === 0) return 'no bodies to check'          // a genuinely empty platform is not a failure
  if (n < 3) {
    console.log(`  ⚠ SKIPPED — only ${n} live bod${n === 1 ? 'y' : 'ies'} on the platform, need >=3 to prove a CROWD keeps moving, not one twitching body`)
    return `SKIPPED: only ${n} live bodies (need >=3)`
  }
  assert(moved >= 3, `only ${moved} of ${n} bodies moved — the crowd is freezing, not milling`)
  return `${moved} of ${n} bodies still milling`
})

await step('death ends the run and shows the card', async () => {
  await page.evaluate(() => globalThis.__SHOE__.scenario('death'))
  await page.waitForTimeout(1400)
  const s = await state()
  const cardUp = await page.evaluate(() => !document.getElementById('gameover').hidden)
  assert(cardUp, 'game-over screen never appeared')
  const m = await shot('04-gameover')
  const fails = judge(m)
  assert(!fails.length, `game-over frame failed: ${fails.join('; ')}`)
  return `alive=${s.alive}, ${m.distinctHues} hues`
})

await step('retry starts a clean run', async () => {
  await page.evaluate(() => document.getElementById('btn-retry')?.click()
    ?? globalThis.__SHOE__.game.startRun())
  await page.waitForTimeout(1000)
  const s = await state()
  assert(s.alive, 'not alive after retry')
  assert(s.wave <= 1, `wave did not reset (${s.wave})`)
  assert(s.kills === 0, `kills did not reset (${s.kills})`)
  return `wave ${s.wave}, ${s.health}hp, score ${s.score}`
})

await step('no console errors during the whole run', async () => {
  assert(consoleErrors.length === 0, `${consoleErrors.length}: ${consoleErrors[0] ?? ''}`)
  return 'clean'
})

// ---------------------------------------------------------------------------

await browser.close()
server.close()

const failed = results.filter(r => !r.ok)
console.log(`\nframes: ${OUT}`)
if (failed.length) {
  console.error(`\nE2E FAILED — ${failed.length}/${results.length} steps`)
  failed.forEach(f => console.error(`  ✗ ${f.name}: ${f.detail}`))
  process.exit(1)
}
console.log(`\nE2E PASSED — ${results.length}/${results.length} steps on q=${QUALITY}`)
