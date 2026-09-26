/**
 * Browser integration gate for controls, combat, lifecycle, and staged graphics.
 * Uses scripted input and silent audio. Enemy aiming and summit/death frames are staged;
 * native pointer-lock, audible sound, earned traversal, and SQLite ranking need their own gates.
 * The local server supplies an explicit empty leaderboard fixture, never production scores.
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
    if (detail?.skipped) {
      results.push({ name, ok:null, skipped:true, detail:detail.reason })
      console.log(`SKIPPED ${stepNo}. ${name}: ${detail.reason}`)
      return
    }
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

await step('preparation waits, then skipping starts one wave', async () => {
  const initial = await state()
  assert(initial.phase === 'preparation', `expected preparation, got ${initial.phase}`)
  assert(initial.zombies === 0, 'enemies spawned during preparation')
  await sim(5)
  const waiting = await state()
  assert(waiting.phase === 'preparation' && waiting.zombies === 0, 'preparation ended early')
  const skipped = await page.evaluate(() => {
    const game = globalThis.__SHOE__.game
    return [game.startNextWave(),game.startNextWave()]
  })
  assert(skipped[0] === true && skipped[1] === false, 'wave skip is not idempotent')
  return 'five seconds safe; one wave started'
})

await step('train arrives and releases zombies', async () => {
  const before = (await state()).bodies
  await sim(6)
  const after = await state()
  assert(after.bodies > 0, `no zombies alive after train arrival (spawned from ${before})`)
  return `${after.bodies} on the platform, ${after.remaining} left in the wave`
})

await step('pistol firing resolves damage and a kill', async () => {
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
     * kill count moves. Place the target where the shooter is already looking and test that.
     */
    if (!S.state().alive) { g.startRun(); g.startNextWave(); g.tick(6) }

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

    const killsBefore = S.state().kills
    let rounds = 0
    for (let i = 0; i < 240; i++) {
      target.position.set(...toSpec(ahead))   // hold it there; it is trying to walk at us
      g.weapons.setTrigger(i % 2 === 0)       // PULSE: the pistol is semi-automatic
      g.tick(0.05)
      rounds++
      if (!target.health?.alive) break
    }
    g.weapons.setTrigger(false)
    return { zone: sighted.zone, distance: Math.round(sighted.distance), rounds, killsBefore }
  })
  const after = await state()
  assert(!detail.note, detail.note ?? '')
  assert(after.kills > detail.killsBefore, `kills did not rise (${detail.killsBefore} -> ${after.kills})`)
  return `${after.kills - detail.killsBefore} kill, ${detail.zone} hit at ${detail.distance}cm; ranking waits for wave completion`
})

await step('combat frame is readable', async () => {
  const m = await shot('02-firefight')
  const fails = judge(m)
  assert(!fails.length, `firefight frame failed: ${fails.join('; ')}`)
  return `lum ${m.meanLuminance}, ${m.distinctHues} hues`
})

await step('wave completion ranks and advances into the next wave', async () => {
  const detail = await page.evaluate(() => {
    const game = globalThis.__SHOE__.game
    if (!game.playing) { game.startRun(); game.startNextWave() }
    const before = game.snapshot().completedWaves
    let steps = 0
    while (game.snapshot().completedWaves === before && steps++ < 1200) {
      game.tick(1 / 60)
      for (const zombie of game.zombies.bodies) {
        if (zombie.health?.alive) zombie.hit(100000,{ignoresArmor:true,instigator:game.player})
      }
    }
    const clear = game.snapshot()
    game.tick(9)
    const waiting = game.snapshot()
    game.tick(1.1)
    const next = game.snapshot()
    return {before,clear,waiting,next}
  })
  assert(detail.clear.completedWaves === detail.before + 1, 'spawn/death sequence did not clear one wave')
  assert(detail.clear.score >= detail.clear.completedWaves * 10000, 'completed-wave score was not applied')
  assert(detail.waiting.phase === 'intermission', 'ten-second break ended before nine seconds')
  assert(detail.next.wave === detail.clear.wave + 1 && detail.next.phase === 'trainArriving', 'next wave did not arrive after break')
  return `wave ${detail.clear.wave} cleared via deterministic damage; next wave ${detail.next.wave}`
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

await step('staged summit frame renders at street altitude', async () => {
  await page.evaluate(() => globalThis.__SHOE__.scenario('summit'))
  await page.waitForTimeout(1500)
  const s = await state()
  assert(s.altitude >= 900, `altitude only ${s.altitude}`)
  const m = await shot('03-summit')
  const fails = judge(m)
  assert(!fails.length, `summit frame failed: ${fails.join('; ')}`)
  return `altitude ${s.altitude}, lum ${m.meanLuminance}`
})

await step('staged crowd keeps milling without a player target', async () => {
  const { n, moved, survivors } = await page.evaluate(() => {
    const S = globalThis.__SHOE__
    S.scenario('firefight')
    const g = S.game
    g.stage = null
    g.weapons.setTrigger(false)
    g.zombieWorld.player = null
    const live = g.zombies.bodies.filter(z => z && z.health?.alive)
    const before = live.map(z => ({ x: z.position.x, y: z.position.y }))
    for (let i = 0; i < 60; i++) g.tick(0.05)
    const survivors = live.filter(z => z.health?.alive).length
    const moved = live.filter((z, i) => z.health?.alive
      && Math.hypot(z.position.x - before[i].x, z.position.y - before[i].y) > 3).length
    return { n: live.length, moved, survivors }
  })
  assert(n >= 3, `staged firefight supplied only ${n} live bodies; need at least three`)
  assert(survivors === n, `only ${survivors} of ${n} tracked bodies survived the noncombat milling probe`)
  assert(moved >= 3, `only ${moved} of ${n} bodies moved — the crowd is freezing, not milling`)
  return `${moved} of ${n} staged bodies still milling through actual updates`
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
  await page.locator('#btn-retry').click()
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

const failed = results.filter(r => r.ok === false)
const skipped = results.filter(r => r.skipped)
const passed = results.filter(r => r.ok === true)
await writeFile(`${OUT}results.json`,JSON.stringify({passed:passed.length,failed:failed.length,skipped:skipped.length,results},null,2))
console.log(`\nframes: ${OUT}`)
if (failed.length) {
  console.error(`\nE2E FAILED — ${failed.length}/${results.length} steps`)
  failed.forEach(f => console.error(`  ✗ ${f.name}: ${f.detail}`))
  process.exit(1)
}
console.log(`\nE2E PASSED — ${passed.length} passed, ${skipped.length} skipped, ${results.length} total steps on q=${QUALITY}`)
