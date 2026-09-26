/**
 * The gate this project didn't have.
 *
 * verify/frame.mjs grades whether a frame LOOKS right — luminance, contrast, black ratio,
 * hue diversity. It passed 6/6 on a build that ran at a few frames per second and locked up
 * an M4 Max. Every check was true and none of them was playing the game.
 *
 * That is the same failure as the Unreal build it replaced: fourteen green tests and a black
 * screen became six green frames and no framerate. So this measures the other half — whether
 * frames ARRIVE — and fails the build when they don't.
 *
 * It reports the 95th percentile frame time, not the mean. A mean of 16ms hides a stutter
 * every twelfth frame, and stutter is what a player actually feels.
 *
 *   node verify/fps.mjs              # all tiers, gate on the default tier
 *   node verify/fps.mjs --q=low      # one tier
 *   node verify/fps.mjs --scene=boss # the heaviest moment
 */
import { chromium } from 'playwright'
import { serve, assertFreshBuild } from './serve.mjs'

const ROOT = new URL('../dist/', import.meta.url).pathname
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]

const TIERS = arg('q', '') ? [arg('q', '')] : ['low', 'medium', 'high']
const SCENE = arg('scene', 'firefight')
const SECONDS = Number(arg('seconds', 5))

/**
 * The budget. 60fps is 16.7ms; 33ms is a playable 30fps floor. We gate the DEFAULT tier
 * only — 'high' is allowed to be a screenshot mode, and saying so out loud is better than
 * pretending the full rig is playable.
 *
 * `boot` gates load-to-ready time — measured but previously never checked, so boot regressed
 * 0.8-1.4s at every tier with nothing to catch it. Budgets below were set from this build's
 * OWN measured boot time (seven runs on the dev machine, 2026-09-25): low 7.6-8.0s, medium
 * 12.8-13.5s, high 19.1-20.8s. Each budget sits ~0.6-0.8s over the observed MAX for its tier,
 * not the mean — low/medium jitter under a second so that headroom still catches a further
 * 1s regression cleanly. 'high' is noisier: 1.7s of run-to-run spread was observed on an
 * otherwise idle box, likely from other work sharing the machine during headed Chrome runs,
 * so its budget cannot both absorb that spread AND guarantee catching an additional full 1s
 * regression the way low/medium do — flagged here rather than pretending otherwise.
 */
const BUDGET = {
  low: { p95: 22, boot: 8.6, name: 'must be comfortable on a modest GPU' },
  medium: { p95: 33, boot: 14.2, name: 'the default — must hold a playable 30fps floor' },
  // 'high' was ungated as "screenshot mode" and promptly measured 0.2fps — an exemption is
  // how a broken tier stays broken. 50ms is a 20fps floor: slow, but a human can move in it.
  high: { p95: 50, boot: 21.6, name: 'the full look — must stay above a 20fps floor' },
}
const GATED = ['low', 'medium', 'high']

await assertFreshBuild(ROOT, new URL('../', import.meta.url).pathname)
const server = await serve(ROOT, 0)
const port = server.address().port
/**
 * HEADED ON PURPOSE. Headless Chrome quantises requestAnimationFrame to fixed caps —
 * measured at exactly 33.3ms with one flag set and 49.9ms with another, with p50, p95 and
 * p99 all within 0.2ms of each other. A game does not produce a distribution that tight.
 * Every headless FPS number this project produced was the browser's cap, and one of them
 * hid a 26fps firefight behind a flat 30fps reading for hours.
 *
 * --disable-frame-rate-limit is NOT set either: uncapping pushes 120fps+, doubles the
 * allocation rate and manufactures GC stutter that a vsynced player would never see.
 */
const browser = await chromium.launch({
  headless: false,
  args: [
    '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--mute-audio',
    // --uncap is for A/B DIAGNOSIS ONLY, never for judging a build. Removing the frame limit
    // pushes 120fps+, which doubles the allocation rate and manufactures GC stutter a
    // vsynced player would never see. It is here so two builds can be compared when the
    // window is throttled and every frame would otherwise read as a flat 33.3ms.
    ...(process.argv.includes('--uncap') ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
  ],
})

const results = []

for (const tier of TIERS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)))
  const t0 = Date.now()

  try {
    await page.goto(`http://localhost:${port}/?renderer=webgpu&verify=1&seed=1337&q=${tier}`, { waitUntil: 'load' })
    await page.waitForFunction('globalThis.__SHOE__ && globalThis.__SHOE__.ready === true', null, { timeout: 200000 })
    const bootSeconds = (Date.now() - t0) / 1000

    await page.evaluate(s => globalThis.__SHOE__.scenario(s), SCENE)

    /**
     * WARM UP PROPERLY, then measure.
     *
     * A 1.5s settle was not enough and it produced nonsense: the same tier measured 6165ms
     * at pixelRatio 1.25 and 16.9ms at 1.35, which fillrate cannot do. Whichever tier ran
     * first in a batch was paying pipeline compilation inside the sample window, so the
     * gate was timing the compiler rather than the renderer.
     *
     * Spin until frames are actually cheap, or give up and measure anyway — never silently
     * report a warm-up as a steady state.
     */
    const warm = await page.evaluate(() => new Promise(resolve => {
      const start = performance.now()
      let last = start, streak = 0
      const tick = now => {
        if (now - last < 25) streak++; else streak = 0
        last = now
        if (streak >= 30) return resolve({ warmedMs: now - start, warmed: true })
        if (now - start > 30000) return resolve({ warmedMs: now - start, warmed: false })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }))
    if (!warm.warmed) console.log(`        (never settled in 30s — the number below includes compilation)`)

    // Sample real frame deltas from inside the page, REPEATED, and take the median across
    // windows instead of trusting one. A single window can land in a stutter or a lull —
    // that made a budget failure indistinguishable from noise, worst at the 'high' tier
    // where the budget is loosest and a regression has the most room to hide. rAF is the
    // only honest clock here: it reports when the compositor actually presented, not when
    // our script finished.
    const REPS = 3
    const pctOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

    const reps = []
    for (let i = 0; i < REPS; i++) {
      const frames = await page.evaluate(sec => new Promise(resolve => {
        const deltas = []
        let last = performance.now()
        const start = last
        const tick = now => {
          deltas.push(now - last)
          last = now
          if (now - start < sec * 1000) requestAnimationFrame(tick)
          else resolve(deltas)
        }
        requestAnimationFrame(tick)
      }), SECONDS)
      const sorted = [...frames].sort((a, b) => a - b)
      reps.push({
        p50: pctOf(sorted, 0.5), p95: pctOf(sorted, 0.95), p99: pctOf(sorted, 0.99),
        mean: frames.reduce((a, b) => a + b, 0) / frames.length,
        count: frames.length,
      })
    }

    const p50 = median(reps.map(r => r.p50))
    const p95 = median(reps.map(r => r.p95))
    const p99 = median(reps.map(r => r.p99))
    const mean = median(reps.map(r => r.mean))
    const frameCount = reps.reduce((a, r) => a + r.count, 0)
    // Spread of the p95 across the REPS windows — how much the gated number itself moved
    // run to run, so a reader can see whether it's trustworthy before acting on it.
    const p95Spread = Math.max(...reps.map(r => r.p95)) - Math.min(...reps.map(r => r.p95))

    const backend = await page.evaluate('globalThis.__SHOE_BACKEND__')
    const quality = await page.evaluate('globalThis.__SHOE_QUALITY__')

    const budget = BUDGET[tier] ?? BUDGET.medium

    /**
     * Tell a CAP from a bottleneck before failing anything.
     *
     * A display or a throttled background window pins every frame to a refresh interval,
     * and the signature is unmistakable: p50, p95 and p99 land within a few percent of each
     * other on a round number — 8.33ms, 16.7ms, 33.3ms, 50ms. A game under load does not
     * produce a distribution that tight. This gate has already been fooled by exactly that
     * twice, once reporting a flat 30fps while the real figure was 120, and once failing a
     * build whose frames were all 33.3ms because the window had slipped behind a terminal.
     *
     * Capped frames cannot prove a budget either way, so say so and do not pass judgement.
     *
     * The floor below rejects a "near a refresh interval" match that isn't really one —
     * degenerate near-zero deltas (a duplicate rAF tick, an empty/broken frame) that could
     * otherwise coincidentally sit within the 4% tolerance of a listed interval. It has to
     * sit BELOW the fastest interval we actually detect (120Hz, 8.33ms) or it silently
     * disables detection of that interval, which is exactly what a stale "> 15" left over
     * from a 60/30/20Hz-only list did — it threw away every 120Hz reading before the check
     * ran. A true 120Hz cap (p50≈p95≈p99≈8.33ms) still passes this floor; a genuinely fast,
     * uncapped build (e.g. a real ~130fps with natural variance, p50≈7.7ms) is rejected by
     * the 4% tolerance and the spread check below, not by this floor.
     */
    const capSpread = (p99 - p50) / p50
    const nearRefresh = [1000/120, 1000/60, 1000/30, 1000/20]
      .some(r => Math.abs(p50 - r) / r < 0.04)
    const capped = capSpread < 0.15 && nearRefresh && p50 > 5

    const fpsOver = !capped && p95 > budget.p95
    const bootOver = bootSeconds > budget.boot
    const over = GATED.includes(tier) && (fpsOver || bootOver)

    results.push({ tier, quality, backend, bootSeconds, mean, p50, p95, p99, p95Spread,
                   fps: 1000 / mean, frames: frameCount, errors, over, fpsOver, bootOver })

    console.log(
      `${over ? '✗ FAIL' : capped ? '~ CAPPED' : '✓ pass'}  q=${String(quality).padEnd(6)} ` +
      `boot=${bootSeconds.toFixed(1).padStart(5)}s  ` +
      `fps=${(1000 / mean).toFixed(1).padStart(5)}  ` +
      `p50=${p50.toFixed(1).padStart(5)}ms  p95=${p95.toFixed(1).padStart(6)}ms ` +
      `(±${(p95Spread / 2).toFixed(1)}ms over ${REPS} samples)  ` +
      `p99=${p99.toFixed(1).padStart(6)}ms` +
      (bootOver ? `   ↳ boot ${bootSeconds.toFixed(1)}s over the ${budget.boot}s budget` : '') +
      (fpsOver ? `   ↳ over the ${budget.p95}ms budget (${budget.name})`
            : capped ? `   ↳ pinned to ${p50.toFixed(1)}ms with ${(capSpread*100).toFixed(0)}% spread — display or background throttle, not a bottleneck. Focus the window to measure.`
            : '')
    )
    if (errors.length) console.log(`        ${errors.length} page error(s): ${errors[0]}`)
  } catch (err) {
    console.log(`✗ CRASH q=${tier}  ${err.message.split('\n')[0].slice(0, 90)}`)
    results.push({ tier, crashed: err.message.slice(0, 200), over: true })
  }
  await page.close()
}

await browser.close()
server.close()

const failed = results.filter(r => r.over)
console.log()
if (failed.length) {
  console.error(`FPS GATE FAILED — ${failed.map(r => r.tier).join(', ')} over budget on "${SCENE}"`)
  console.error('Do NOT fix this by raising the budget. Cull lights, drop a post pass, or lower the pixel ratio.')
  process.exit(1)
}
console.log(`FPS GATE PASSED — ${results.length} tier(s) on "${SCENE}"`)
