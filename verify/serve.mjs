import http from 'node:http'
import { readFile, stat, readdir } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
}

export function serve(root, port = 4173) {
  const server = http.createServer(async (req, res) => {
    try {
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
