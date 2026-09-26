import { defineConfig } from 'vite'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

/**
 * ShoeMoney: Last Engineer builds to a folder that has to work from ANY prefix.
 *
 * GitHub Pages serves this repo at /shoeinator-web/, `vite preview` serves it at /,
 * and a local check serves it from a made-up sub-path. `base: './'` is the only
 * setting that satisfies all three: every emitted URL comes out relative to the
 * document, so the same dist/ is correct at the root, under /shoeinator-web/, and
 * under /whatever/you/like/. Hard-coding `/shoeinator-web/` would 404 everywhere else,
 * including `npm run preview` and the frame gate.
 *
 * Runtime paths are the other half of the problem and they are already handled in
 * src/: rules.js states the audio root and the logo texture as site-absolute paths,
 * and the two places that consume them — src/audio/cues.js resolveUrl() and
 * src/world/materials.js loadLogoTexture() — strip the leading slash and re-resolve
 * against document.baseURI. index.html, src/main.js IMAGE_DIR and src/ui/hud.js
 * IMG_ROOT all use './game/...', which is document-relative already. subpathGuard()
 * below is what keeps it that way.
 */

const OUT_DIR = 'dist'

// Set SITE_URL to the deployed directory URL when building a public share preview.
function shareMetadata() {
  const site = process.env.SITE_URL || 'https://arcade.shoemoney.com/last-engineer/'
  let image = null
  if (site) {
    const base = new URL(site)
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
      throw new Error('SITE_URL must be an HTTP(S) deployment URL without credentials')
    }
    base.search = ''
    base.hash = ''
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    image = new URL('brand/last-engineer-og.jpg', base).href
  }
  return {
    name: 'shoe:share-metadata',
    transformIndexHtml(html) {
      if (!image) return html
      const escaped = image.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      return html.replaceAll('content="./brand/last-engineer-og.jpg"', `content="${escaped}"`)
    },
  }
}

// ---------------------------------------------------------------------------
// The renderer chip
// ---------------------------------------------------------------------------

/**
 * A visitor arriving from a link has no idea whether their browser brought WebGPU.
 * The engine already falls back to WebGL2 silently (src/core/engine.js: `forceWebGL:
 * !navigator.gpu`), and silent is exactly wrong here — on the fallback path the
 * lighting is noticeably cheaper, and someone in a browser one flag away from the
 * good version deserves to be told.
 *
 * This lives in the build rather than in index.html because the chip is a property of
 * the deployment, not of the game: it reports what the machine on the other end of the
 * link actually got. It reads the live backend the engine publishes on
 * globalThis.__SHOE_BACKEND__ rather than guessing from navigator.gpu alone, so it
 * cannot disagree with the renderer that is really on screen.
 */
const NOTE_CSS = `
.gpu-note{
  position:fixed;
  left:50%;
  bottom:max(16px, env(safe-area-inset-bottom, 0px));
  transform:translateX(-50%) translateY(6px);
  z-index:60;
  pointer-events:none;
  display:flex;
  align-items:center;
  gap:.6em;
  max-width:min(94vw, 940px);
  padding:.45em .95em .4em;
  font-family:'Barlow Condensed','Helvetica Neue',sans-serif;
  font-size:18px;
  font-weight:600;
  line-height:1;
  letter-spacing:.16em;
  text-transform:uppercase;
  white-space:nowrap;
  color:var(--bone,#e8ecf2);
  background:linear-gradient(180deg,rgba(12,17,25,.94),rgba(5,7,11,.94));
  border:1px solid rgba(255,180,58,.30);
  border-radius:2px;
  box-shadow:0 0 0 1px rgba(0,0,0,.6),0 12px 34px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
  opacity:0;
  transition:opacity .45s ease,transform .45s ease;
}
.gpu-note[data-show="1"]{opacity:1;transform:translateX(-50%) translateY(0)}
.gpu-note[hidden]{display:none}
.gpu-note__dot{
  width:.5em;height:.5em;flex:none;border-radius:50%;
  background:var(--steel,#8b96a4);
  box-shadow:0 0 9px currentColor;
  color:var(--steel,#8b96a4);
}
.gpu-note[data-backend="webgpu"] .gpu-note__dot{background:var(--cyan,#3ad7ff);color:var(--cyan,#3ad7ff)}
.gpu-note[data-backend="webgl2"] .gpu-note__dot{background:var(--amber,#ffb43a);color:var(--amber,#ffb43a)}
.gpu-note__label{color:var(--steel,#8b96a4);letter-spacing:.22em}
.gpu-note__value{color:var(--bone,#e8ecf2)}
.gpu-note[data-backend="webgpu"] .gpu-note__value{color:var(--cyan,#3ad7ff)}
.gpu-note[data-backend="webgl2"] .gpu-note__value{color:var(--amber,#ffb43a)}
.gpu-note__hint{
  overflow:hidden;text-overflow:ellipsis;
  color:var(--steel,#8b96a4);font-weight:500;letter-spacing:.1em;
  border-left:1px solid rgba(139,150,164,.32);padding-left:.7em;
}
.gpu-note__hint:empty{display:none}
@media (max-width:640px){
  /* Wrap, never hide. A phone without WebGPU is the visitor who most needs the
     explanation, and hiding it on the narrow breakpoint denied it to exactly them. */
  .gpu-note{white-space:normal;flex-wrap:wrap;justify-content:center;row-gap:.35em;text-align:center}
  .gpu-note__hint{flex-basis:100%;border-left:0;padding-left:0;overflow:visible;text-overflow:clip}
}
@media (prefers-reduced-motion:reduce){ .gpu-note{transition:none} }
`.trim()

const NOTE_MARKUP = `
  <span class="gpu-note__dot"></span>
  <span class="gpu-note__label">Renderer</span>
  <span class="gpu-note__value" id="gpu-note-value">detecting&hellip;</span>
  <span class="gpu-note__hint" id="gpu-note-hint"></span>
`.trim()

const NOTE_SCRIPT = `
(function(){
  try{
    var note=document.getElementById('gpu-note');
    if(!note) return;
    if(new URLSearchParams(location.search).get('debug')!=='1'){note.remove();return;}
    var value=document.getElementById('gpu-note-value');
    var hint=document.getElementById('gpu-note-hint');
    var hasGPU=typeof navigator!=='undefined'&&!!navigator.gpu;

    var COPY={
      webgpu:['WebGPU','Hardware path \\u2014 full lighting and post'],
      webgl2:['WebGL2 fallback','No WebGPU in this browser \\u2014 lighting runs cheaper'],
      pending:[hasGPU?'WebGPU':'WebGL2 fallback', hasGPU?'Booting the hardware path\\u2026':'No navigator.gpu here \\u2014 falling back']
    };

    function paint(key){
      var copy=COPY[key]||COPY.pending;
      note.setAttribute('data-backend',key==='pending'?(hasGPU?'webgpu':'webgl2'):key);
      value.textContent=copy[0];
      hint.textContent=copy[1];
      note.title=copy[0]+' \\u2014 '+copy[1];
    }
    paint('pending');

    var settled=false;
    function settle(){
      if(settled) return;
      var backend=globalThis.__SHOE_BACKEND__;
      if(backend!=='webgpu'&&backend!=='webgl2') return;
      settled=true;
      paint(backend);
    }

    // The engine publishes __SHOE_BACKEND__ after renderer.init() resolves, which is
    // async and can land either side of this script. Poll briefly, then stop: the
    // pre-boot text is already correct, so a missed poll costs nothing.
    var polls=0;
    var timer=setInterval(function(){
      settle();
      if(settled||++polls>120) clearInterval(timer);
    },250);

    function shown(id){
      var el=document.getElementById(id);
      return !!el && !el.hidden && getComputedStyle(el).display!=='none';
    }
    // If the overlays this keys off are ever renamed, the capability note must fail
    // VISIBLE. A visitor who is never told which renderer they got is the bug; a chip
    // that overstays its welcome is a blemish.
    function anyScreenExists(){
      return !!(document.getElementById('menu')||document.getElementById('loading'));
    }
    // Visible while someone is reading a screen; gone the moment they are shooting.
    // The fade is decoration; the hidden attribute is the guarantee. A CSS transition
    // only advances when the page repaints, and a firefight frame can block the main
    // thread long enough that a chip left on opacity:1 would sit over the gunfight.
    // display:none needs no repaint to be true.
    var hideTimer;
    function sync(){
      var on=!anyScreenExists()||shown('menu')||shown('loading');
      note.setAttribute('data-show',on?'1':'0');
      clearTimeout(hideTimer);
      if(on) note.hidden=false;
      else hideTimer=setTimeout(function(){ note.hidden=true; },520);
    }
    sync();

    // Only the three overlays, never #hud: hud.js writes CSS custom properties onto
    // #hud.style every frame, and observing that would re-run this sync (two
    // getComputedStyle calls, so a forced style recalc) sixty times a second during a
    // firefight. These three change on a state transition and nowhere else.
    var watched=['menu','loading','gameover'];
    if(typeof MutationObserver!=='undefined'){
      var obs=new MutationObserver(sync);
      for(var i=0;i<watched.length;i++){
        var el=document.getElementById(watched[i]);
        if(el) obs.observe(el,{attributes:true,attributeFilter:['hidden','class','style']});
      }
    }
    addEventListener('pointerlockchange',sync);
  }catch(err){
    // A decorative chip must never be the thing that breaks the page, and the frame
    // gate counts console.error, so this stays a warning.
    console.warn('[gpu-note] could not render the renderer chip',err);
  }
})();
`.trim()

function rendererChip() {
  return {
    name: 'shoe:renderer-chip',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          { tag: 'style', attrs: { 'data-shoe': 'gpu-note' }, children: NOTE_CSS, injectTo: 'head' },
          {
            tag: 'div',
            attrs: { id: 'gpu-note', class: 'gpu-note', 'data-backend': 'pending', 'data-show': '0' },
            children: NOTE_MARKUP,
            injectTo: 'body',
          },
          { tag: 'script', children: NOTE_SCRIPT, injectTo: 'body' },
        ]
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The sub-path guard
// ---------------------------------------------------------------------------

/**
 * The classic GitHub Pages failure is a dist/ full of `/assets/...` links that 404 under
 * /shoeinator-web/ and are invisible until a stranger opens the URL. One root-absolute
 * href is enough to serve a black page with a working title bar.
 *
 * So the build refuses to emit one. It reads the written dist/ rather than the rollup
 * bundle: index.html is emitted by a core plugin during generateBundle, so a plugin
 * inspecting the bundle object can and did run before the entry HTML existed — the
 * check passed a build whose every script tag was root-absolute. Disk is the only
 * place the whole artefact is definitely assembled, and it is what actually ships.
 *
 * `//host/path` and `https://...` are absolute on purpose (the Google Fonts import) and
 * are allowed through.
 */
const ABSOLUTE_URL_PATTERNS = [
  { ext: '.html', label: 'html src/href', re: /\s(?:src|href)\s*=\s*["']\/(?!\/)[^"']*/g },
  { ext: '.css', label: 'css url()', re: /url\(\s*["']?\/(?!\/)[^"')]*/g },
  { ext: '.js', label: 'module specifier', re: /(?:\bfrom\s*|\bimport\(\s*)["']\/(?!\/)[^"']*/g },
]

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

function subpathGuard() {
  return {
    name: 'shoe:subpath-guard',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const root = resolve(process.cwd(), OUT_DIR)
      const offences = []

      for (const file of await walk(root)) {
        const rule = ABSOLUTE_URL_PATTERNS.find(r => file.endsWith(r.ext))
        if (!rule) continue

        const hits = (await readFile(file, 'utf8')).match(rule.re)
        if (hits) {
          offences.push(
            `${relative(root, file)}: ${hits.length} root-absolute ${rule.label} — e.g. ${hits[0].trim().slice(0, 80)}`,
          )
        }
      }

      if (offences.length) {
        throw new Error(
          'Root-absolute URLs in dist/ — every one of these 404s when the site is served from a ' +
            "sub-path such as /shoeinator-web/, and the page goes black with no error a visitor can see. " +
            "Keep vite's `base` relative.\n  " +
            offences.join('\n  '),
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Pages housekeeping
// ---------------------------------------------------------------------------

/**
 * actions/deploy-pages serves the artefact directly and never runs Jekyll, but a branch
 * deploy of the same folder would, and Jekyll drops every path starting with an
 * underscore. One empty file makes dist/ correct under both.
 */
function nojekyll() {
  return {
    name: 'shoe:nojekyll',
    apply: 'build',
    async closeBundle() {
      await writeFile(resolve(process.cwd(), OUT_DIR, '.nojekyll'), '')
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [shareMetadata(), rendererChip(), nojekyll(), subpathGuard()],
  build: {
    outDir: OUT_DIR,
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
