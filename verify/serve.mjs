import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { runScore } from '../src/game/runScore.js'
import { readFile, stat, readdir } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.webm': 'video/webm',
}

/** Graphics/control gates use an explicit empty-board fixture. Real persistence requires the SQLite integration gate. */
export function serve(root, port = 4173, { apiFixture = true } = {}) {
  const fixtureRuns = new Set()
  async function fixture(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Verification-Fixture':'empty-leaderboard' })
      res.end(JSON.stringify({ ...body, fixture:true }))
    }
    if (req.method === 'GET' && url.pathname === '/api/games/last-engineer/scores') {
      const version = url.searchParams.get('scoreVersion')
      send(version && version !== '2' ? 400 : 200, version && version !== '2'
        ? { error:'Fixture supports score version 2 only' } : { scores:[],scoreVersion:2,order:'highest' })
      return true
    }
    if (req.method !== 'POST' || !['/api/games/last-engineer/runs','/api/games/last-engineer/qualify'].includes(url.pathname)) return false
    let body
    try {
      const chunks = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new Error('Request too large'); chunks.push(chunk) }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { send(400,{error:'Invalid fixture JSON'}); return true }
    if (body?.scoreVersion !== 2) { send(400,{error:'Fixture supports score version 2 only'}); return true }
    if (url.pathname.endsWith('/runs')) {
      const runToken = randomBytes(32).toString('base64url')
      fixtureRuns.add(runToken)
      send(201,{runToken,scoreVersion:2})
      return true
    }
    if (!fixtureRuns.has(body.runToken)) { send(404,{error:'Fixture run not found'}); return true }
    if (!Number.isSafeInteger(body.completedWaves) || body.completedWaves < 0 || !Number.isFinite(body.combatSeconds) || body.combatSeconds < 0) {
      send(400,{error:'Invalid fixture metrics'}); return true
    }
    send(200,{qualified:false,score:runScore(body.completedWaves,body.combatSeconds),scoreVersion:2,reason:'verification_fixture',scores:[]})
    return true
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (apiFixture && await fixture(req, res)) return
      let p = decodeURIComponent(req.url.split('?')[0])
      if (p.endsWith('/')) p += 'index.html'
      const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''))
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise(resolve => server.listen(port, () => resolve(server)))
}

/**
 * Refuse to grade a bundle that is not the code.
 *
 * verify:frame, verify:fps and verify:e2e each run their script directly with no build step,
 * and all three serve dist/. Only the chained `npm run verify` builds first — so any gate run
 * on its own graded whatever bundle happened to be on disk.
 *
 * Measured 2026-09-25: dist held a bundle from 09:45:28 while the newest source was 09:46:16,
 * and rebuilding from the SAME source produced a different filename and a different md5
 * (index-BlApgmSE / 66acd7a2 -> index-7i4m4tYV / a365d49d). Every standalone gate run that week
 * therefore certified code that was not on disk — an instrument lying about all the other
 * instruments.
 *
 * Telling people to remember to build does not scale. This fails the gate instead.
 */

async function newestMtime(dir, exts, seen = { t: 0 }) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return seen.t }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await newestMtime(p, exts, seen)
    else if (exts.includes(extname(e.name))) {
      const s = await stat(p).catch(() => null)
      if (s && s.mtimeMs > seen.t) seen.t = s.mtimeMs
    }
  }
  return seen.t
}

/**
 * @param {string} distDir  the directory about to be served
 * @param {string} srcRoot  the project root whose sources must predate it
 * @throws if dist is missing or older than any source file
 */
export async function assertFreshBuild(distDir, srcRoot) {
  let bundle = 0
  try {
    for (const f of await readdir(join(distDir, 'assets'))) {
      if (extname(f) !== '.js') continue
      const s = await stat(join(distDir, 'assets', f))
      if (s.mtimeMs > bundle) bundle = s.mtimeMs
    }
  } catch {
    throw new Error(`no built bundle at ${distDir} — run \`npm run build\` first`)
  }
  if (!bundle) throw new Error(`no .js bundle under ${distDir}assets — run \`npm run build\` first`)

  const src = Math.max(
    await newestMtime(join(srcRoot, 'src'), ['.js', '.css']),
    await newestMtime(srcRoot, ['.html']),
  )

  if (src > bundle) {
    const age = ((src - bundle) / 1000).toFixed(0)
    throw new Error(
      `STALE BUNDLE — a source file is ${age}s newer than dist/.\n` +
      `  This gate would have graded code that is not on disk.\n` +
      `  Run \`npm run build\` and try again.`
    )
  }
}
