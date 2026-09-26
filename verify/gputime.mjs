/**
 * GPU time, measured rather than inferred.
 *
 * Every conclusion about the GPU in this project so far came from elimination — the CPU
 * profile showed 72% idle, frame time scaled with pixel count, therefore fillrate. That
 * reasoning was right, but it was reasoning. Chrome's DevTools protocol does not expose
 * GPU timing at all, so the only standard way to get real numbers headlessly is WebGPU's
 * own timestamp-query feature, and three exposes it as renderer.info.render.timestamp.
 */
import { chromium } from 'playwright'
import { serve } from './serve.mjs'
const server = await serve(new URL('../dist/', import.meta.url).pathname, 0)
const b = await chromium.launch({ headless: false, args: [
  '--use-angle=metal','--enable-unsafe-webgpu','--mute-audio',
  // Without this Chrome quantises timestamps to 100us, which is coarse enough to hide a pass.
  '--enable-webgpu-developer-features',
]})
for (const q of ['low','medium','high']) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } })
  try {
    await p.goto(`http://localhost:${server.address().port}/?renderer=webgpu&verify=1&seed=1337&q=${q}&gputime=1`, { waitUntil: 'load' })
    await p.waitForFunction('globalThis.__SHOE__ && globalThis.__SHOE__.ready === true', null, { timeout: 200000 })
    await p.evaluate(() => globalThis.__SHOE__.scenario('firefight'))
    await p.waitForTimeout(3000)
    const r = await p.evaluate(() => new Promise(resolve => {
      const S = globalThis.__SHOE__
      // three r182 populates renderer.info.render.timestamp (ms of GPU time) when the
      // adapter supports timestamp-query. It reads back a frame or two late, which is fine
      // for a steady-state average.
      // autoReset MUST stay on. Turning it off makes info.render.timestamp accumulate
      // across frames, which reported 132ms of GPU time inside an 8.4ms frame — a number
      // whose own impossibility is the only reason it got caught.
      const gpu = [], cpu = []
      let last = performance.now(); const start = last
      const tick = now => {
        cpu.push(now - last); last = now
        S.renderer.resolveTimestampsAsync?.().catch(() => {})
        const t = S.renderer.info.render?.timestamp
        if (typeof t === 'number' && t > 0) gpu.push(t)
        if (now - start < 4000) requestAnimationFrame(tick)
        else resolve({ gpu, cpu, calls: S.renderer.info.render.calls, tris: S.renderer.info.render.triangles })
      }
      requestAnimationFrame(tick)
    }))
        /**
     * KNOWN LIMITATION: with the post chain on, info.render.timestamp sums every pass in
     * the chain rather than reporting the frame, so medium and high report more GPU time
     * than wall clock — 143ms inside an 8.4ms frame. Trust the number only where the post
     * chain is off (q=low); elsewhere treat it as a relative cost of the chain, not a frame
     * time. An impossible number is at least an obvious one.
     */
    const med = a => a.length ? [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)] : null
    const g = med(r.gpu), c = med(r.cpu)
    console.log(`q=${q.padEnd(7)} frame=${c.toFixed(1).padStart(5)}ms  GPU=${g === null ? '  n/a' : g.toFixed(2).padStart(6)+'ms'}` +
                (g === null ? '  (timestamp-query unavailable)'
                 : g > c * 1.5 ? `  (sums ${'' + (g/c).toFixed(0)} post passes — not a frame time; see the note above)`
                 : `  → ${((g/c)*100).toFixed(0)}% of the frame is GPU`))
  } catch(e){ console.log(`q=${q} FAILED ${e.message.slice(0,70)}`) }
  await p.close()
}
await b.close(); server.close()
