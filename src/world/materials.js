/**
 * materials.js — every surface in the subway station, and the procedural texture
 * sets behind them.
 *
 * The Unreal build shipped one flat Color parameter per geometry family and nothing
 * else: no roughness, no normal, no emissive. That is the whole reason it was
 * abandoned as "flat grey boxes". Every base colour below is still the spec's exact
 * linear value out of `STATION.COLORS` — the character comes from multiplying that
 * colour by a generated albedo/roughness/metalness/normal set, so a reviewer can
 * still diff the colours against the spec while the station stops looking like a
 * greybox.
 *
 * Textures are baked into 2D canvases at load time from a seeded RNG, never
 * `Math.random()`. That matters twice over: the headless frame gate compares real
 * pixels between runs, and a texture that changed every reload would make every
 * capture a false negative.
 *
 * UVs are baked in world space by the station builder (see station.js), so a texture
 * set tiles at a fixed number of centimetres regardless of how big the box it lands
 * on is. `TEXTURE_CM` is that number per family.
 */

import * as THREE from 'three/webgpu'
import { abs, attribute, dot, normalView, positionView, positionViewDirection, pow, smoothstep } from 'three/tsl'
import { Rng } from '../core/rng.js'
import { STATION } from '../game/rules.js'

const COLORS = STATION.COLORS
const SURFACE = STATION.MATERIALS
const PROPS = STATION.PROPS

/**
 * Presentation-only constants. None of these existed in the original C++ — it had no
 * texture pipeline at all — so they have no `rules.js` home the way a gameplay tunable
 * does. They live in one frozen block here so they are still findable in one place;
 * fold them into rules.js if rules.js ever grows a rendering section.
 */

/**
 * How hard a light shaft dims as its shell turns edge-on to the camera. A hollow cone
 * lit at a constant value shows a hard triangular silhouette, which is the single
 * thing that makes a cheap god-ray read as cardboard.
 */
const HAZE_EDGE_SOFTNESS = 1.35

/**
 * How close, in centimetres, a shaft may get to the eye before it fades out. The player
 * walks through these cones constantly; without this, standing inside one paints a white
 * wedge across half the screen. Fading near geometry is also what real haze does — there
 * is nothing to scatter in the metre in front of your face.
 */
const HAZE_NEAR_FADE_START = 90.0
const HAZE_NEAR_FADE_END = 560.0

/** Centimetres of world surface covered by one repeat of each texture set. */
export const TEXTURE_CM = Object.freeze({
  tile: 120.0, // 8 tiles across at 15 cm each
  concrete: 400.0,
  wetConcrete: 500.0,
  // Exactly the column height (LEVELS.wallTopZ - platformTopZ), so one repeat spans one
  // column and the base-grime gradient in bakePaintedSteel never wraps. At 240 the set
  // tiled twice up a 450 cm column and put a hard grime line across it at waist height.
  column: 450.0,
  rail: 120.0,
  sleeper: 90.0,
  furniture: 160.0,
  trashBin: 80.0,
  stripe: 220.0,
  portal: 400.0,
})

/** One seed per texture set, so adding a set never reshuffles the others. */
const SEEDS = Object.freeze({
  tile: 0x711e0a,
  concrete: 0xc04c1e,
  wetConcrete: 0x5104d1,
  column: 0xc01133,
  rail: 0x8a11ed,
  sleeper: 0x51eebb,
  furniture: 0xf02217,
  trashBin: 0xb12b04,
  stripe: 0x57819e,
  portal: 0x9aa7e0,
  signage: 0x519a9e,
})

/** Texture bake resolution. 512 is plenty: every set is tiled, none is a hero asset. */
const BAKE_SIZE = 512

/**
 * The glazed face of the wall tile, linear.
 *
 * Every other station surface multiplies its bake by `STATION.COLORS.structureLinear`
 * ([0.45, 0.45, 0.47]) because the original C++ shaded platform, walls, pit floors and
 * ceiling with one shared grey. Tile is the one place that colour is actively wrong.
 * bakeTile already paints a dirty white and then layers its own soot, iron staining,
 * chipped beds and water runoff on top, so multiplying it by 0.45 — and again by the
 * builder's per-vertex grime — lands the finished tile near 0.44 linear. A 0.44 grey
 * under sodium lamps is brown, which is why the platform walls read as mid-brown BRICK
 * with correct running-bond courses instead of as glazed tile. The base has to be the
 * glaze; the dirt is the bake's job and the bake is already doing it.
 *
 * Presentation-only, like the rest of this block: the original had no tile material at
 * all, so there is no rules.js entry to diff this against.
 */
const TILE_LINEAR = Object.freeze([0.88, 0.88, 0.85])

const warned = new Set()
function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

/** Value noise on a wrapped lattice, so every octave tiles seamlessly at u,v = 1. */
function tileableNoise(rng, cells) {
  const grid = new Float32Array(cells * cells)
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next()
  return (u, v) => {
    const x = u * cells
    const y = v * cells
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const cx0 = ((x0 % cells) + cells) % cells
    const cy0 = ((y0 % cells) + cells) % cells
    const cx1 = (cx0 + 1) % cells
    const cy1 = (cy0 + 1) % cells
    const a = grid[cy0 * cells + cx0]
    const b = grid[cy0 * cells + cx1]
    const c = grid[cy1 * cells + cx0]
    const d = grid[cy1 * cells + cx1]
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
  }
}

/** Fractal sum of the above. Returns values in [0,1]. */
function tileableFbm(rng, baseCells, octaves) {
  const layers = []
  let cells = baseCells
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    layers.push({ noise: tileableNoise(rng, cells), amp })
    total += amp
    cells *= 2
    amp *= 0.5
  }
  return (u, v) => {
    let sum = 0
    for (const layer of layers) sum += layer.noise(u, v) * layer.amp
    return sum / total
  }
}

/** Anisotropic fbm — stretched along v, which is how water runs down a tiled wall. */
function streakFbm(rng, cells, octaves, stretch) {
  const f = tileableFbm(rng, cells, octaves)
  return (u, v) => f(u, v / stretch)
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const mix = (a, b, t) => a + (b - a) * t
function smooth01(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// canvas baking
// ---------------------------------------------------------------------------

function makeCanvas(size) {
  if (typeof document === 'undefined') {
    warnOnce(
      'no-document',
      '[materials] no DOM: procedural textures cannot be baked. Every station surface ' +
        'will fall back to the spec\'s flat colour, which is exactly the greybox look the ' +
        'port exists to replace.',
    )
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

function texture(canvas, colorSpace) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = colorSpace
  tex.anisotropy = 16 // 15 cm tiles on a 6000 cm wall moire badly at grazing angles
  tex.needsUpdate = true
  return tex
}

/**
 * Turn a height field into an OpenGL-convention tangent-space normal map.
 * Sampling wraps, so the normal map tiles as seamlessly as the height that made it.
 */
function heightToNormal(height, size, strength) {
  const canvas = makeCanvas(size)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      // Textures upload with flipY, so canvas +y is texture -v; the sign cancels out here.
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const inv = 1 / Math.hypot(-dx, dy, 1)
      const i = (y * size + x) * 4
      data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return texture(canvas, THREE.NoColorSpace)
}

/**
 * Bake one surface from a per-pixel shading function.
 *
 * `shade(u, v, out)` writes into a reused `out` object — 260k allocations per surface
 * is the difference between a 40 ms load and a 400 ms one.
 *
 * Roughness and metalness come back packed into a single glTF-style ORM texture
 * (G = roughness, B = metalness) rather than two. WebGPU guarantees only 16 sampled
 * textures per fragment stage, and this station spends a lot of them on shadow maps,
 * so every material that costs three bindings instead of four buys back a shadow.
 *
 * Both packed channels are normalised to their own maximum, because three MULTIPLIES
 * the map by `material.roughness` / `material.metalness`. That keeps the spec's values
 * in rules.js meaningful — each one is the roughest or most metallic that surface ever
 * gets, and the map only ever varies downward from it.
 */
function bakeSurface(shade, { normalStrength = 3.0, size = BAKE_SIZE } = {}) {
  const albedoCanvas = makeCanvas(size)
  if (!albedoCanvas) return {}
  const ormCanvas = makeCanvas(size)

  const albedoCtx = albedoCanvas.getContext('2d')
  const ormCtx = ormCanvas.getContext('2d')
  const albedo = albedoCtx.createImageData(size, size)
  const orm = ormCtx.createImageData(size, size)
  const height = new Float32Array(size * size)
  const roughRaw = new Float32Array(size * size)
  const metalRaw = new Float32Array(size * size)

  const out = { r: 0.5, g: 0.5, b: 0.5, rough: 0.8, metal: 0, height: 0.5 }
  let maxRough = 0
  let maxMetal = 0

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      out.r = out.g = out.b = 0.5
      out.rough = 0.8
      out.metal = 0
      out.height = 0.5
      shade(u, v, out)

      const p = y * size + x
      const i = p * 4
      albedo.data[i] = clamp01(out.r) * 255
      albedo.data[i + 1] = clamp01(out.g) * 255
      albedo.data[i + 2] = clamp01(out.b) * 255
      albedo.data[i + 3] = 255

      const rough = clamp01(out.rough)
      const metal = clamp01(out.metal)
      roughRaw[p] = rough
      metalRaw[p] = metal
      if (rough > maxRough) maxRough = rough
      if (metal > maxMetal) maxMetal = metal
      height[p] = out.height
    }
  }

  const roughScale = maxRough > 0 ? 255 / maxRough : 0
  const metalScale = maxMetal > 0 ? 255 / maxMetal : 0
  for (let p = 0; p < roughRaw.length; p++) {
    const i = p * 4
    orm.data[i] = 255 // R is the AO slot; nothing samples it, but leave it neutral
    orm.data[i + 1] = roughRaw[p] * roughScale
    orm.data[i + 2] = metalRaw[p] * metalScale
    orm.data[i + 3] = 255
  }

  albedoCtx.putImageData(albedo, 0, 0)
  ormCtx.putImageData(orm, 0, 0)

  return {
    map: texture(albedoCanvas, THREE.SRGBColorSpace),
    ormMap: texture(ormCanvas, THREE.NoColorSpace),
    // Strength is a height delta per TEXEL, so doubling the bake resolution would halve
    // the relief. Scaling by size keeps `normalStrength` meaning the same bump at any
    // resolution, which is what lets one set bake at 1024 without being re-tuned.
    normalMap: heightToNormal(height, size, normalStrength * (size / BAKE_SIZE)),
  }
}

// ---------------------------------------------------------------------------
// the surfaces
// ---------------------------------------------------------------------------

/** Dirty white running-bond subway tile with recessed grout, stains and water streaks. */
function bakeTile() {
  const rng = new Rng(SEEDS.tile)
  const cols = Math.round(TEXTURE_CM.tile / 15) // 15 cm tiles across
  const rows = Math.round(TEXTURE_CM.tile / 7.5) // 7.5 cm tiles down
  const shade = new Float32Array(cols * rows)
  const stain = new Float32Array(cols * rows)
  const chipped = new Uint8Array(cols * rows)
  for (let i = 0; i < shade.length; i++) {
    shade[i] = rng.range(0.74, 1.0) // a 12% spread made every course machine-identical
    stain[i] = rng.next()
    chipped[i] = rng.chance(0.045) ? 1 : 0
  }
  const grime = tileableFbm(rng, 4, 5)
  const drips = streakFbm(rng, 16, 4, 9)
  const speck = tileableFbm(rng, 48, 2)

  const groutU = 0.9 / 15 // 9 mm grout line, as a fraction of a tile
  const groutV = 0.9 / 7.5

  return bakeSurface(
    (u, v, out) => {
      const fv = v * rows
      const row = Math.floor(fv)
      const offset = (row & 1) * 0.5
      const fu = u * cols + offset
      const col = Math.floor(fu)
      const lu = fu - col
      const lv = fv - row
      const idx = (((row % rows) + rows) % rows) * cols + (((col % cols) + cols) % cols)

      // distance into the tile from its nearest grout line, in tile-fractions
      const edgeU = Math.min(lu, 1 - lu)
      const edgeV = Math.min(lv, 1 - lv)
      const inTile = Math.min(edgeU / groutU, edgeV / groutV)
      const groutMask = 1 - smooth01(0.25, 1.0, inTile)
      const bevel = smooth01(1.0, 2.6, inTile)

      const dirt = grime(u, v)
      const runoff = clamp01(drips(u, v) * 1.5 - 0.45)
      const grit = speck(u, v)

      let r = 0.99 * shade[idx]
      let g = 0.975 * shade[idx]
      let b = 0.93 * shade[idx]

      // some tiles have taken decades of iron-stained water
      // 1.6/-1.05 put some rust on a third of the tiles. That was invisible when the
      // whole wall was being multiplied to 0.44 grey; against the real glaze it turns the
      // wall tan, which is the same failure the base colour just fixed. Fewer tiles,
      // stained harder: ~19% of them, which is what a stained wall actually looks like.
      const rust = clamp01(stain[idx] * 2.4 - 1.95)
      r = mix(r, 0.44, rust)
      g = mix(g, 0.30, rust)
      b = mix(b, 0.21, rust)

      // a chipped tile shows the dark bed behind it
      if (chipped[idx]) {
        const chip = smooth01(0.3, 0.8, grit)
        r = mix(r, 0.22, chip)
        g = mix(g, 0.20, chip)
        b = mix(b, 0.18, chip)
      }

      let roughness = mix(0.42, 0.18, bevel)
      let heightValue = mix(0.25, 1.0, bevel)

      // grout: darker, rougher, recessed
      r = mix(r, 0.47, groutMask)
      g = mix(g, 0.455, groutMask)
      b = mix(b, 0.42, groutMask)
      roughness = mix(roughness, 0.95, groutMask)
      heightValue = mix(heightValue, 0.05, groutMask)

      // grime sits on top of everything and kills the gloss where it is thickest
      const soot = mix(0.82, 1.0, dirt)
      r *= soot
      g *= soot * 0.99
      b *= soot * 0.96
      roughness = clamp01(roughness + (1 - dirt) * 0.35)

      const wash = runoff * 0.55
      out.r = clamp01(mix(r, r * 0.55 + 0.08, wash))
      out.g = clamp01(mix(g, g * 0.55 + 0.07, wash))
      out.b = clamp01(mix(b, b * 0.52 + 0.06, wash))
      out.rough = clamp01(mix(roughness, 0.62, wash))
      out.metal = 0
      out.height = clamp01(heightValue + (grit - 0.5) * 0.04)
    },
    { normalStrength: 9.0 },
  )
}

/** Cast concrete: mottled, aggregate-flecked, hairline-cracked, form-tie pocked. */
function bakeConcrete() {
  const rng = new Rng(SEEDS.concrete)
  const broad = tileableFbm(rng, 3, 5)
  // 28 cells over TEXTURE_CM.concrete is a 14 cm dominant lump. At 10 it was 40 cm, and
  // a 40 cm lump with a centimetre of relief is sprayed stucco or cave rock, not a
  // ceiling that was poured against plywood.
  const mid = tileableFbm(rng, 28, 4)
  const aggregate = tileableFbm(rng, 96, 2)
  const crackField = tileableFbm(rng, 7, 4)
  // Ridged noise draws CONTOURS, and the contour of a smooth field is a closed loop, so
  // the raw crack mask tiles the ceiling with black jigsaw outlines — legible as a
  // pattern, never as damage. These two break it up the way a real slab fails: `patch`
  // decides WHERE the slab has cracked at all (most of it has not), `segment` chops the
  // surviving contours into runs with gaps, so a crack starts, wanders and stops.
  const crackPatch = tileableFbm(rng, 3, 3)
  const crackSegment = tileableFbm(rng, 9, 3)

  return bakeSurface(
    (u, v, out) => {
      const b = broad(u, v)
      const m = mid(u, v)
      const grit = aggregate(u, v)

      // ridged noise — the ridge line is where a crack runs
      const ridge = 1 - Math.abs(crackField(u, v) * 2 - 1)
      const crack =
        smooth01(0.986, 0.999, ridge) * // hairline; 0.958 was a 5 cm gouge
        smooth01(0.44, 0.70, crackPatch(u, v)) *
        smooth01(0.46, 0.66, crackSegment(u, v))

      const tone = mix(0.60, 0.94, b * 0.65 + m * 0.35)
      let r = tone * 1.02
      let g = tone * 0.995
      let b2 = tone * 0.95

      // Softer and wider than 0.62/0.86 at 1.22: with the mid lumps now at 14 cm the
      // aggregate was the loudest thing left in the frame and it resolved as static.
      const fleck = smooth01(0.58, 0.92, grit)
      r = mix(r, r * 1.12, fleck)
      g = mix(g, g * 1.11, fleck)
      b2 = mix(b2, b2 * 1.10, fleck)

      // A crack in concrete is a dark grey line with dust in it, not a black one. 0.12
      // is the value of a hole, and it is what made these read as gouges.
      r = mix(r, 0.34, crack)
      g = mix(g, 0.325, crack)
      b2 = mix(b2, 0.30, crack)

      out.r = clamp01(r)
      out.g = clamp01(g)
      out.b = clamp01(b2)
      out.rough = clamp01(mix(0.66, 0.94, m) + crack * 0.06)
      out.metal = 0
      // A 70% height drop at normal strength 4 made every crack a canyon and the mottle
      // something you could climb; together they read as a dried riverbed over cave rock.
      // 0.22 at strength 1.6 is a crack you have to walk up to, which is what hairline
      // means.
      // With the cracks and the lumps both pulled back, the 4 cm aggregate became the
      // loudest relief left, and on the mezzanine fascia — lit from below at a grazing
      // angle, which is the worst case for any normal map — it still read as sprayed
      // stucco. Exposed aggregate is a colour difference far more than a height one, so
      // it keeps its albedo fleck and gives up most of its bump.
      out.height = clamp01(0.5 + (b - 0.5) * 0.5 + (grit - 0.5) * 0.16 - crack * 0.22)

      // Form-board seams — the one feature that says CAST concrete rather than rock. The
      // multiplier is 3 and not 3.2 so the pattern closes at v = 1; a fractional period
      // leaves a mismatched joint at every texture wrap. 400 cm / 3 is a shutter joint
      // every 133 cm, which is a 4 ft board. It carries albedo as well as relief, because
      // a seam expressed only in roughness disappears wherever no lamp is on it, and most
      // of this vault is between lamps.
      const board = Math.abs(((v * 3) % 1) - 0.5)
      const seam = 1 - smooth01(0.0, 0.018, board)
      out.r *= mix(1.0, 0.88, seam)
      out.g *= mix(1.0, 0.88, seam)
      out.b *= mix(1.0, 0.89, seam)
      out.height = clamp01(out.height - seam * 0.12)
      out.rough = clamp01(out.rough + seam * 0.08)
    },
    { normalStrength: 1.6 },
  )
}

/**
 * The platform floor. Same concrete, plus standing water: broad puddles that flatten
 * the surface, darken the albedo and drop roughness far enough for the sodium strips
 * to streak across them. This is the single surface that decides whether the station
 * reads as wet or as a grey box.
 */
function bakeWetConcrete() {
  const rng = new Rng(SEEDS.wetConcrete)
  const broad = tileableFbm(rng, 3, 5)
  const mid = tileableFbm(rng, 11, 4)
  const aggregate = tileableFbm(rng, 96, 2)
  const puddleField = tileableFbm(rng, 15, 3)
  const scuff = streakFbm(rng, 20, 3, 4)

  return bakeSurface(
    (u, v, out) => {
      const b = broad(u, v)
      const m = mid(u, v)
      const grit = aggregate(u, v)
      const puddle = smooth01(0.44, 0.74, puddleField(u, v))
      const damp = smooth01(0.40, 0.58, puddleField(u, v))
      const traffic = smooth01(0.35, 0.8, scuff(u, v))

      const tone = mix(0.42, 0.70, b * 0.6 + m * 0.4)
      let r = tone
      let g = tone * 0.985
      let b2 = tone * 0.96

      const fleck = smooth01(0.66, 0.88, grit)
      r = mix(r, r * 1.25, fleck)
      g = mix(g, g * 1.22, fleck)
      b2 = mix(b2, b2 * 1.2, fleck)

      // walked-on lanes are polished lighter, standing water is near-black
      const polish = traffic * 0.18
      r += polish
      g += polish
      b2 += polish

      // Standing water is DARK, not merely glossy. Expressing a puddle almost entirely in
      // roughness — 0.86/0.87/0.90 is a 13% albedo nudge — means it exists only where a
      // lamp happens to be reflecting off it, and the rest of the slab, which is most of
      // it, is a blank gradient with grain on top. These numbers are the diffuse half of
      // wet, and they are what makes a puddle survive being in shadow.
      r = mix(r, r * 0.52, puddle)
      g = mix(g, g * 0.54, puddle)
      b2 = mix(b2, b2 * 0.60, puddle)

      // The damp rim outside the standing water. A puddle with no edge is a stain.
      const rim = smooth01(0.30, 0.46, puddleField(u, v)) * (1 - puddle)
      r = mix(r, r * 0.74, rim)
      g = mix(g, g * 0.75, rim)
      b2 = mix(b2, b2 * 0.78, rim)

      out.r = clamp01(r)
      out.g = clamp01(g)
      out.b = clamp01(b2)
      // 1.0 / 0.69 rather than 0.84 / 0.58 — the same ratio, moved up. The ORM pack
      // normalises roughness to the texture's own maximum, so the expansion joints below,
      // now the roughest thing on the slab, would otherwise rescale the whole floor
      // glossier by exactly the amount they add. Pinning the dry slab at the ceiling
      // keeps SURFACE.wetFloorRoughness meaning what it meant before.
      out.rough = clamp01(mix(mix(1.0, 0.69, damp + traffic * 0.4), 0.06, puddle))
      out.metal = puddle * 0.22
      out.height = clamp01(mix(0.5 + (b - 0.5) * 0.4 + (grit - 0.5) * 0.3, 0.42, puddle))

      // Expansion joints. A platform slab is poured in bays and saw-cut; with no grid it
      // is one infinite sheet of noise, which is why the floor read as a gradient with no
      // structure anywhere a highlight was not landing. 500 cm / 2 is a joint every
      // 250 cm, about 6 cm wide. A matte line cutting through a specular puddle is the
      // clearest "this is a floor and it has a size" cue available, and it is legible in
      // the dark because it is albedo and relief, not gloss.
      const jx = Math.abs(((u * 2.0) % 1) - 0.5)
      const jy = Math.abs(((v * 2.0) % 1) - 0.5)
      const joint = 1 - smooth01(0.0, 0.012, Math.min(jx, jy))
      out.height = clamp01(out.height - joint * 0.30)
      out.rough = clamp01(out.rough + joint * 0.45)
      out.r *= mix(1.0, 0.62, joint)
      out.g *= mix(1.0, 0.62, joint)
      out.b *= mix(1.0, 0.64, joint)
    },
    // 1.8 was the lowest of any station surface, so there was no micro-relief to break up
    // the diffuse either. 3.0 gives the aggregate, the rim and the joints something to
    // catch on.
    { normalStrength: 3.0 },
  )
}

/**
 * Painted-over steel: thick institutional paint, chipped down to rust at the edges.
 *
 * `chipCells` is per-call because the two sets that share this baker cover very
 * different amounts of world: TEXTURE_CM.column is 450 and TEXTURE_CM.furniture is 160,
 * so one cell count cannot give both the same chip SIZE in centimetres, and the chip's
 * size in centimetres is the whole finding. `grime` is per-call for a blunter reason:
 * the gradient below is keyed to v as height, which is true for the columns (a cylinder
 * side UVs straight off world Y) and meaningless for the furniture family, where the
 * same material also skins handrail bars whose v never leaves the first few percent.
 */
function bakePaintedSteel(seed, paint, rustAmount, { chipCells = 46, grime = 0, size = BAKE_SIZE } = {}) {
  const rng = new Rng(seed)
  const broad = tileableFbm(rng, 5, 4)
  const chips = tileableFbm(rng, chipCells, 4)
  const rustField = streakFbm(rng, 9, 4, 5)
  const grain = tileableFbm(rng, 70, 2)
  // Paint does not fail uniformly. A flat threshold over the chip field scatters chips at
  // an even density across the whole surface, which reads as confetti or camouflage — the
  // eye sees the DENSITY, not the individual chip. This large-scale field moves the
  // threshold instead of masking the result, so chips cluster where the paint has been
  // knocked about and keep their hard broken edge everywhere they do appear.
  const wear = tileableFbm(rng, 4, 3)

  return bakeSurface(
    (u, v, out) => {
      const b = broad(u, v)
      // A 0.14-wide mask on a coarse field gave a 4 cm feather on an 18 cm blob, which is
      // a cow spot. A 0.045-wide one gives the chip a hard broken edge, which is how paint
      // fails: it lets go in a flake, it does not fade out.
      const edge = mix(0.84, 0.685, smooth01(0.38, 0.70, wear(u, v)))
      const chipMask = smooth01(edge, edge + 0.045, chips(u, v))
      const chip = chipMask * rustAmount

      // The rust has to come OUT OF a chip. The bleed used to be an independent streak
      // field, so a stain landed wherever the noise put it and not one chip in any frame
      // had a tail under it. v runs DOWN the world here (see the grime note below), so
      // sampling the chip field at a smaller v finds the chip ABOVE this texel; two
      // offsets give the tail a length and a falloff instead of a hard stop.
      const source = Math.max(
        smooth01(edge, edge + 0.045, chips(u, v - 0.018)),
        smooth01(edge, edge + 0.045, chips(u, v - 0.045)) * 0.6,
      )
      // The 0.08 floor is deliberately almost nothing: a baseline of 0.25 still painted
      // rust over the whole column, which is the thing that made it look sprayed.
      const bleed = clamp01(rustField(u, v) * 1.7 - 0.62) * rustAmount * (0.08 + source * 1.5)
      const g = grain(u, v)

      let r = paint[0] * mix(0.86, 1.1, b)
      let gg = paint[1] * mix(0.86, 1.1, b)
      let bb = paint[2] * mix(0.86, 1.1, b)

      // rust bleeds downward out of every chip
      r = mix(r, 0.40, bleed * 0.6)
      gg = mix(gg, 0.21, bleed * 0.6)
      bb = mix(bb, 0.11, bleed * 0.6)

      r = mix(r, 0.46, chip)
      gg = mix(gg, 0.24, chip)
      bb = mix(bb, 0.12, chip)

      out.r = clamp01(r + (g - 0.5) * 0.03)
      out.g = clamp01(gg + (g - 0.5) * 0.03)
      out.b = clamp01(bb + (g - 0.5) * 0.03)
      // A strength-9 normal map over roughness 0.34 fireflied at close range: the
      // half-pixel normal jitter swung the specular lobe past the sodium lamps and
      // back, so at one metre a near column crawled with static instead of reading as
      // steel. The paint still has to look hard, so the floor only comes up to 0.46 —
      // enough that the highlight has width and stops resolving to single-pixel
      // sparks, not so far that the steel goes chalky.
      //
      // The triple below is 0.46 / 0.66 / 0.92 scaled so the ceiling lands at 1.0. Only
      // the RATIO ships — bakeSurface normalises the roughness channel to the texture's
      // own maximum — and the grime gradient at the end of this function adds roughness
      // at the column base, which would otherwise raise that maximum and quietly polish
      // the entire column by the same factor. Fixing the ceiling at 1.0 makes the
      // normalisation a no-op and leaves SURFACE.furnitureRoughness meaning what it said.
      out.rough = clamp01(mix(mix(0.56, 0.80, b), 1.0, Math.max(chip, bleed * 0.7)))

      // Those sparks were COLOURED, and that is the tell. A conductor tints its
      // specular with its own albedo; a dielectric reflects white. Shading intact
      // institutional paint at metalness 0.9 gave it a metal's tinted, diffuse-free
      // lobe, which is why the speckle came back white over paint and orange over the
      // rust bleed. Thick paint is a dielectric coat and rust is an oxide — neither
      // conducts. Only a chip worn through to clean steel is metal, and a chip sitting
      // in a rust streak has already gone back to oxide. Killing the false metalness
      // also hands the paint its diffuse term back, so the column finally answers the
      // lamps instead of sitting there as a dark mirror.
      //
      // Metalness normalises to the texture's own maximum, so it is the RATIO that
      // ships: bare chips land on SURFACE.furnitureMetalness and everything else falls
      // away from it. chipMask is used rather than chip so the bare-steel peak reaches
      // 1.0 for both the column and furniture sets despite their different rustAmount.
      const bare = clamp01(chipMask - bleed * 2)
      out.metal = clamp01(0.05 + bare * 0.95)
      out.height = clamp01(0.62 - chip * 0.45 + (g - 0.5) * 0.12)

      // Vertical grime. The columns had none: uniform cream from floor to ceiling, which
      // is the other half of why they read as camouflage rather than as painted steel in
      // a station where everything below hand height has been touched for fifty years.
      //
      // Direction: addCylinder gives the side quads v = worldY / TEXTURE_CM.column, and a
      // CanvasTexture uploads flipped, so bake v = 1 - worldY / 450. v -> 1 is the floor,
      // v -> 0 is the ceiling, and this gradient puts the dirt in the bottom ~200 cm.
      // TEXTURE_CM.column is set to exactly the column height so this never wraps; at any
      // other tiling the seam is a hard grime line across the middle of the column.
      if (grime > 0) {
        // Two terms, because grime is two things. The wide one starts 150 cm up and is
        // the general fall of dirt down a column; the narrow one is the hard line in the
        // last 45 cm where the mop stops and the floor grit starts. One smoothstep alone
        // gave a 200 cm soft ramp that reads as a shadow rather than as dirt.
        const base = clamp01(smooth01(0.66, 1.0, v) * 0.72 + smooth01(0.90, 1.0, v) * 0.5) * grime
        out.r *= mix(1.0, 0.58, base)
        out.g *= mix(1.0, 0.57, base)
        out.b *= mix(1.0, 0.56, base)
        out.rough = clamp01(out.rough + base * 0.18)
      }
    },
    { normalStrength: 5.0, size },
  )
}

/** Running rail: dark oxidised web, bright polished crown, oily ballast dust. */
function bakeRail() {
  const rng = new Rng(SEEDS.rail)
  const scratches = streakFbm(rng, 30, 3, 14)
  const pit = tileableFbm(rng, 40, 3)
  const rustField = tileableFbm(rng, 8, 4)

  return bakeSurface(
    (u, v, out) => {
      const scratch = scratches(u, v)
      const pits = pit(u, v)
      const rust = smooth01(0.48, 0.78, rustField(u, v))

      let r = mix(0.30, 0.52, scratch)
      let g = mix(0.29, 0.50, scratch)
      let b = mix(0.30, 0.52, scratch)

      r = mix(r, 0.42, rust)
      g = mix(g, 0.22, rust)
      b = mix(b, 0.12, rust)

      out.r = clamp01(r)
      out.g = clamp01(g)
      out.b = clamp01(b)
      out.rough = clamp01(mix(0.22, 0.78, rust) + (pits - 0.5) * 0.18)
      out.metal = mix(0.95, 0.35, rust)
      out.height = clamp01(0.6 + (pits - 0.5) * 0.5 - rust * 0.15)
    },
    { normalStrength: 6.0 },
  )
}

/** Creosoted timber sleeper: dark, split along the grain, ballast-dusted. */
function bakeSleeper() {
  const rng = new Rng(SEEDS.sleeper)
  const grain = streakFbm(rng, 34, 3, 12)
  const knots = tileableFbm(rng, 6, 3)
  const dust = tileableFbm(rng, 24, 3)

  return bakeSurface(
    (u, v, out) => {
      const g = grain(u, v)
      const knot = smooth01(0.72, 0.92, knots(u, v))
      const ballast = smooth01(0.55, 0.85, dust(u, v))

      let r = mix(0.16, 0.36, g)
      let gg = mix(0.12, 0.26, g)
      let b = mix(0.08, 0.17, g)

      r = mix(r, 0.09, knot)
      gg = mix(gg, 0.06, knot)
      b = mix(b, 0.04, knot)

      // grey ballast dust sits in the low grain
      r = mix(r, 0.42, ballast * 0.35)
      gg = mix(gg, 0.41, ballast * 0.35)
      b = mix(b, 0.39, ballast * 0.35)

      out.r = clamp01(r)
      out.g = clamp01(gg)
      out.b = clamp01(b)
      out.rough = clamp01(mix(0.82, 0.99, g))
      out.metal = 0
      out.height = clamp01(0.5 + (g - 0.5) * 0.8 - knot * 0.3)
    },
    { normalStrength: 8.0 },
  )
}

/** Worn yellow edge paint on gritty concrete, scuffed through by a million shoes. */
function bakeStripe() {
  const rng = new Rng(SEEDS.stripe)
  const wear = streakFbm(rng, 22, 4, 3)
  const grit = tileableFbm(rng, 80, 2)
  const scrape = tileableFbm(rng, 14, 4)

  return bakeSurface(
    (u, v, out) => {
      const worn = smooth01(0.42, 0.82, wear(u, v))
      const scraped = smooth01(0.66, 0.9, scrape(u, v))
      const g = grit(u, v)
      const loss = clamp01(worn * 0.55 + scraped * 0.8)

      // paint full-strength, then eaten back to the grey slab underneath
      let r = mix(1.0, 0.44, loss)
      let gg = mix(0.92, 0.42, loss)
      let b = mix(0.28, 0.40, loss)

      const dirt = mix(0.72, 1.0, g)
      out.r = clamp01(r * dirt)
      out.g = clamp01(gg * dirt)
      out.b = clamp01(b * dirt)
      out.rough = clamp01(mix(0.46, 0.93, loss) + (g - 0.5) * 0.1)
      out.metal = 0
      out.height = clamp01(0.7 - loss * 0.4 + (g - 0.5) * 0.2)
    },
    { normalStrength: 5.0 },
  )
}

/** Dented galvanised bin metal. */
function bakeBinMetal() {
  const rng = new Rng(SEEDS.trashBin)
  const dents = tileableFbm(rng, 9, 3)
  const grime = tileableFbm(rng, 18, 4)
  const brush = streakFbm(rng, 60, 2, 8)

  return bakeSurface(
    (u, v, out) => {
      const d = dents(u, v)
      const dirt = grime(u, v)
      const b = brush(u, v)
      const tone = mix(0.34, 0.62, d * 0.6 + b * 0.4) * mix(0.55, 1.0, dirt)
      out.r = clamp01(tone)
      out.g = clamp01(tone * 0.99)
      out.b = clamp01(tone * 1.02)
      out.rough = clamp01(mix(0.34, 0.8, dirt))
      out.metal = mix(0.85, 0.5, 1 - dirt)
      out.height = clamp01(0.5 + (d - 0.5) * 0.9)
    },
    { normalStrength: 7.0 },
  )
}

/** Tunnel darkness cap: not a colour, an absence. Faint soot structure only. */
function bakePortal() {
  const rng = new Rng(SEEDS.portal)
  const soot = tileableFbm(rng, 6, 4)
  return bakeSurface(
    (u, v, out) => {
      const s = soot(u, v)
      const tone = mix(0.02, 0.10, s)
      out.r = tone
      out.g = tone
      out.b = tone * 1.15
      out.rough = 1.0
      out.metal = 0
      out.height = 0.5
    },
    { normalStrength: 1.0 },
  )
}

// ---------------------------------------------------------------------------
// drawn signage (canvas 2D, not per-pixel — these are artwork, not surfaces)
// ---------------------------------------------------------------------------

export const SIGN_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'

/**
 * No webfont is loaded anywhere in this build (see index.html), so every condensed face
 * named in the CSS falls back to whatever the host has. Transit type is CONDENSED — that
 * proportion is most of what makes a sign read as a sign — so it is squeezed here on the
 * canvas transform instead of being wished for in a font stack that will not deliver it.
 */
export function stencil(ctx, text, x, y, size, opts = {}) {
  const { weight = 800, squeeze = 0.76, align = 'center', color = '#fff', track = 0, alpha = 1 } = opts
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.font = `${weight} ${Math.max(1, Math.round(size))}px ${SIGN_FONT}`
  if (track) {
    try {
      ctx.letterSpacing = `${track}px`
    } catch {
      // letterSpacing is Chrome 99+; tracking is a refinement, never a requirement
    }
  }
  ctx.translate(x, y)
  ctx.scale(squeeze, 1)
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

/** Width the same call to `stencil` will occupy, so rules and plates can be cut to fit. */
function stencilWidth(ctx, text, size, opts = {}) {
  const { weight = 800, squeeze = 0.76, track = 0 } = opts
  ctx.save()
  ctx.font = `${weight} ${Math.max(1, Math.round(size))}px ${SIGN_FONT}`
  if (track) {
    try {
      ctx.letterSpacing = `${track}px`
    } catch {
      /* see stencil() */
    }
  }
  const w = ctx.measureText(text).width * squeeze
  ctx.restore()
  return w
}

/**
 * One grime field, baked once and reused by every sign in the station.
 *
 * It used to be per-sign: two 512x512 per-pixel fbm loops, ~40 ms of the boot budget, for
 * two textures nobody could tell apart. Baking it once and stretching it is both cheaper
 * and more honest — the same tunnel deposits the same filth on everything in it.
 */
let grimeTile = null
function getGrimeTile() {
  if (grimeTile !== null) return grimeTile
  const size = 256
  const canvas = makeCanvas(size)
  if (!canvas) {
    grimeTile = false
    return grimeTile
  }
  const ctx = canvas.getContext('2d')
  const rng = new Rng(SEEDS.signage ^ 0x9e37)
  const broad = tileableFbm(rng, 5, 4)
  const runs = streakFbm(rng, 22, 3, 7)
  const image = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      // Soot pools in a broad mottle; rain runs pull it downward in vertical streaks.
      const n = clamp01(broad(u, v) * 0.72 + clamp01(runs(u, v) * 1.5 - 0.42) * 0.38)
      const i = (y * size + x) * 4
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.round(clamp01(n) * 255)
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  grimeTile = canvas
  return grimeTile
}

/**
 * Age one rectangle of artwork in place: soot multiply, a bleached top edge where the
 * light box has cooked the ink, a vignette, and a settled dust line along the bottom.
 * Brand new signage in a filthy station is the tell that kills a scene, so nothing
 * drawn in this file is allowed to leave without going through here.
 */
export function ageArt(ctx, x, y, w, h, strength = 0.4, seedShift = 0) {
  const tile = getGrimeTile()
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  if (tile) {
    // Offsetting per call keeps sixteen posters off the same smudge without a second bake.
    const ox = ((seedShift * 97) % 64) - 32
    const oy = ((seedShift * 53) % 64) - 32
    ctx.globalCompositeOperation = 'multiply'
    ctx.globalAlpha = strength
    ctx.drawImage(tile, x + ox, y + oy, w * 1.35, h * 1.35)
    ctx.globalAlpha = 1
  }

  ctx.globalCompositeOperation = 'source-over'
  const dust = ctx.createLinearGradient(0, y + h * 0.62, 0, y + h)
  dust.addColorStop(0, 'rgba(38,32,24,0)')
  dust.addColorStop(1, `rgba(28,23,16,${0.34 + strength * 0.4})`)
  ctx.fillStyle = dust
  ctx.fillRect(x, y + h * 0.62, w, h * 0.38)

  // A light box cooks its own poster from the top down; the ink up there goes chalky.
  const bleach = ctx.createLinearGradient(0, y, 0, y + h * 0.4)
  bleach.addColorStop(0, `rgba(226,222,208,${0.10 + strength * 0.12})`)
  bleach.addColorStop(1, 'rgba(226,222,208,0)')
  ctx.fillStyle = bleach
  ctx.fillRect(x, y, w, h * 0.4)

  const vignette = ctx.createRadialGradient(
    x + w / 2, y + h / 2, Math.min(w, h) * 0.22,
    x + w / 2, y + h / 2, Math.max(w, h) * 0.72,
  )
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, `rgba(4,4,6,${0.30 + strength * 0.34})`)
  ctx.fillStyle = vignette
  ctx.fillRect(x, y, w, h)
  ctx.restore()
}

/**
 * The house mark: a filled disc carrying a dollar sign. It is the route bullet on the
 * train, the logo on the platform signage and the full stop at the end of every poster —
 * one shape doing the branding everywhere, which is what stops it reading as a billboard.
 */
export function drawBullet(ctx, cx, cy, r, opts = {}) {
  const { fill = '#b3121c', ink = '#f6f2e6', ring = null } = opts
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  if (ring) {
    ctx.lineWidth = Math.max(1, r * 0.11)
    ctx.strokeStyle = ring
    ctx.stroke()
  }
  stencil(ctx, '$', cx, cy + r * 0.62, r * 1.72, { weight: 800, squeeze: 0.7, color: ink })
  ctx.restore()
}

/**
 * The station roundel: bar across a ring, the oldest wayfinding shape there is, and the
 * one that makes a tunnel read as a named place rather than a corridor.
 */
function drawRoundel(ctx, cx, cy, r, name, opts = {}) {
  const { ring = '#c8102e', bar = '#0b2a6b', ink = '#f4f6fb' } = opts
  ctx.save()
  ctx.lineWidth = r * 0.30
  ctx.strokeStyle = ring
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2)
  ctx.stroke()

  const barH = r * 0.52
  ctx.fillStyle = bar
  ctx.fillRect(cx - r * 1.28, cy - barH / 2, r * 2.56, barH)
  let size = barH * 0.74
  while (size > 4 && stencilWidth(ctx, name, size, { weight: 700, squeeze: 0.72 }) > r * 2.34) size -= 1
  stencil(ctx, name, cx, cy + barH * 0.26, size, { weight: 700, squeeze: 0.72, color: ink })
  ctx.restore()
}

/** Corner torn off a pasted bill, showing the older bills underneath it. */
function drawTear(ctx, x, y, w, h, rng, corner) {
  const bite = Math.min(w, h) * rng.range(0.17, 0.30)
  const sx = corner & 1 ? x + w : x
  const sy = corner & 2 ? y + h : y
  const dx = corner & 1 ? -1 : 1
  const dy = corner & 2 ? -1 : 1
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(sx, sy + dy * bite)
  for (let i = 1; i <= 6; i++) {
    const t = i / 6
    ctx.lineTo(
      sx + dx * bite * t * rng.range(0.75, 1.3),
      sy + dy * bite * (1 - t) * rng.range(0.6, 1.25),
    )
  }
  ctx.closePath()
  // Three bills deep: the paste layer, the last poster, the steel behind them both.
  ctx.fillStyle = '#6d6455'
  ctx.fill()
  ctx.globalAlpha = 0.55
  ctx.fillStyle = '#3a342b'
  ctx.fill()
  ctx.restore()
}

/**
 * The four hanging platform signs. 160 x 60 cm boards, so the art lives in the middle
 * band of a square canvas and the rest is the dark edge of the housing.
 *
 * It said SHOEINATOR, which is the name on the box, not the name of the place. A station
 * sign names the STATION, carries the line bullet, and points at the way out — three jobs,
 * and the first two are where the branding actually belongs.
 */
function bakeHangingSign() {
  const size = 512
  const canvas = makeCanvas(size)
  if (!canvas) return {}
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#080b11'
  ctx.fillRect(0, 0, size, size)

  const top = Math.round(size * 0.31)
  const height = Math.round(size * 0.38)
  const mid = top + height / 2

  ctx.fillStyle = '#0d3f86'
  ctx.fillRect(0, top, size, height)
  const glow = ctx.createLinearGradient(0, top, 0, top + height)
  glow.addColorStop(0, 'rgba(226,240,255,0.26)')
  glow.addColorStop(0.45, 'rgba(226,240,255,0.03)')
  glow.addColorStop(1, 'rgba(0,0,0,0.34)')
  ctx.fillStyle = glow
  ctx.fillRect(0, top, size, height)

  ctx.strokeStyle = '#dce9ff'
  ctx.lineWidth = size * 0.009
  ctx.strokeRect(size * 0.025, top + height * 0.09, size * 0.95, height * 0.82)

  // Bullet hard left, station name filling the bar, exit arrow hard right.
  drawBullet(ctx, size * 0.115, mid, height * 0.30, { ring: 'rgba(255,255,255,0.5)' })
  stencil(ctx, 'SHOEMONEY SQ', size * 0.56, mid + height * 0.06, height * 0.36, {
    weight: 800, squeeze: 0.70, color: '#f2f7ff', track: 1,
  })
  stencil(ctx, 'PLATFORM 1  ·  ALL TRAINS  ·  WAY OUT', size * 0.56, mid + height * 0.34, height * 0.125, {
    weight: 600, squeeze: 0.80, color: '#9fc2ef', track: 2,
  })

  ctx.fillStyle = '#ffce3d'
  ctx.beginPath()
  const ax = size * 0.955
  const ah = height * 0.21
  ctx.moveTo(ax, mid)
  ctx.lineTo(ax - ah * 1.15, mid - ah)
  ctx.lineTo(ax - ah * 1.15, mid - ah * 0.42)
  ctx.lineTo(ax - ah * 2.6, mid - ah * 0.42)
  ctx.lineTo(ax - ah * 2.6, mid + ah * 0.42)
  ctx.lineTo(ax - ah * 1.15, mid + ah * 0.42)
  ctx.lineTo(ax - ah * 1.15, mid + ah)
  ctx.closePath()
  ctx.fill()

  ageArt(ctx, 0, top, size, height, 0.42, 3)

  const tex = texture(canvas, THREE.SRGBColorSpace)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return { map: tex }
}

/**
 * The backlit wall board at station centre, 440 x 260 cm — the biggest lit rectangle in
 * the room and the one the logo panel hangs in front of. It is the anchor ad, so it runs
 * the house livery at full size and lets the eight bay posters play variations on it.
 */
function bakeWallBoard() {
  const size = 512
  const canvas = makeCanvas(size)
  if (!canvas) return {}
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#0a0c11'
  ctx.fillRect(0, 0, size, size)

  const top = Math.round(size * 0.20)
  const height = Math.round(size * 0.60)
  const left = Math.round(size * 0.02)
  const width = size - left * 2

  const field = ctx.createLinearGradient(left, top, left + width, top + height)
  field.addColorStop(0, '#f6c21a')
  field.addColorStop(0.52, '#e2540d')
  field.addColorStop(1, '#7c0f1b')
  ctx.fillStyle = field
  ctx.fillRect(left, top, width, height)

  // A hard diagonal cut: the one piece of geometry that stops a gradient being wallpaper.
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(left, top + height * 0.52)
  ctx.lineTo(left + width, top + height * 0.34)
  ctx.lineTo(left + width, top + height)
  ctx.lineTo(left, top + height)
  ctx.closePath()
  ctx.fillStyle = 'rgba(8,9,14,0.90)'
  ctx.fill()
  ctx.restore()

  stencil(ctx, 'THE 6:15', left + width * 0.045, top + height * 0.30, height * 0.30, {
    weight: 800, squeeze: 0.70, align: 'left', color: '#150c04',
  })
  stencil(ctx, 'DOES NOT STOP', left + width * 0.045, top + height * 0.49, height * 0.19, {
    weight: 800, squeeze: 0.70, align: 'left', color: '#2a1405',
  })
  stencil(ctx, 'SHOEMONEY EXPRESS', left + width * 0.045, top + height * 0.74, height * 0.20, {
    weight: 800, squeeze: 0.70, align: 'left', color: '#ffd24a', track: 1,
  })
  stencil(ctx, 'RIDE IT OR BE RIDDEN.  SERVICE CHARGE APPLIES.', left + width * 0.045, top + height * 0.90, height * 0.072, {
    weight: 600, squeeze: 0.82, align: 'left', color: '#c9a25f', track: 2,
  })
  drawBullet(ctx, left + width * 0.90, top + height * 0.80, height * 0.13, { ring: 'rgba(255,220,140,0.65)' })

  ageArt(ctx, left, top, width, height, 0.30, 11)

  const tex = texture(canvas, THREE.SRGBColorSpace)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return { map: tex }
}

// ---------------------------------------------------------------------------
// branding — the platform advertising and wayfinding atlases
//
// The tunnel walls are 6000 cm of blank tile on both sides of the room, and blank tile is
// what makes a subway read as a corridor with a texture on it. Ads are the cheapest fix
// there is: they carry the brand, they are the only warm rectangles at eye level, and a
// lit panel every 600 cm is what gives the wall the pool-and-dark rhythm the flat-lighting
// critique was actually about.
//
// Everything below is drawn, never loaded. Two 1024 atlases — one of posters, one of
// wayfinding — so sixteen panels and two dozen signs cost four draw calls between them.
// The geometry that consumes these is built in train.js; see createPlatformBranding there.
// ---------------------------------------------------------------------------

/** Where a piece of art sits in its atlas, already flipped into texture space. */
function atlasRect(x, y, w, h, size) {
  return {
    u0: x / size,
    u1: (x + w) / size,
    // CanvasTexture uploads with flipY, so canvas row 0 is v = 1.
    v0: 1 - (y + h) / size,
    v1: 1 - y / size,
    px: { x, y, w, h },
  }
}

function atlasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  // Clamped, not repeated: a bay poster that wrapped would sample its neighbour.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 16
  tex.needsUpdate = true
  return tex
}

const ADS_SIZE = 1024
const AD_COLS = 2
const AD_W = ADS_SIZE / AD_COLS // 512
const AD_H = 256
/** World proportions of one bay poster, and the aspect every cell is drawn to. */
export const AD_PANEL = Object.freeze({ width: 340.0, height: 170.0 })

/**
 * Eight posters. Transit advertising has a shape — one field, one headline you can read
 * from across the tracks, one line of small print you cannot, and the mark bottom-right —
 * and the shape is what makes them read as ads rather than as decals. The copy is the
 * house's own history with the teeth left in.
 */
const AD_DESIGNS = Object.freeze([
  {
    field: ['#d8a516', '#b07c06'], ink: '#140c02', bar: '#0b0a07', mark: '#f0c552',
    head: ['MAKE MONEY', 'IN YOUR SLEEP'], kicker: 'THE SHOEMONEY SYSTEM',
    legal: 'RESULTS NOT TYPICAL. NEITHER ARE THE SIDE EFFECTS.',
  },
  {
    field: ['#17402c', '#0b241a'], ink: '#eef3e6', bar: '#eae4cf', mark: '#17402c',
    head: ['$132,994.97'], kicker: 'ONE MONTH. ONE MAILBOX.',
    legal: 'PAY TO THE ORDER OF — VOID AFTER DARK', invert: true,
  },
  {
    field: ['#6d1220', '#3a0910'], ink: '#f2e7d2', bar: '#120608', mark: '#d8a516',
    head: ['APPLY.', 'BE REFUSED.'], kicker: 'ELITE RETREAT — $10,000',
    legal: 'FULL REFUND AND AIRFARE HOME. NEVER ONCE CLAIMED.',
  },
  {
    field: ['#3b1d6b', '#170a2c'], ink: '#e8ddff', bar: '#0a0512', mark: '#ff5ea8',
    head: ['RINGTONES', 'FOR THE DEPARTED'], kicker: 'NEXTPIMP — 24 HOURS',
    legal: 'SIGNAL STRENGTH NOT GUARANTEED BELOW STREET LEVEL.',
  },
  {
    field: ['#0f5c66', '#062b31'], ink: '#dff5f7', bar: '#04171a', mark: '#f6c21a',
    head: ['BID ON', "WHAT'S LEFT"], kicker: 'AUCTIONADS — LOTS CLOSE NIGHTLY',
    legal: 'ALL SALES FINAL. SO IS EVERYTHING ELSE DOWN HERE.',
  },
  {
    field: ['#e5dfcb', '#c9c1a7'], ink: '#14130f', bar: '#14130f', mark: '#b3121c',
    head: ['IF YOU SEE', 'SOMETHING,', 'SHOOT IT'], kicker: 'CITY TRANSIT AUTHORITY',
    legal: 'NOTICE POSTED UNDER EMERGENCY ORDINANCE 6-15.', notice: true,
  },
  {
    field: ['#e8b400', '#c08c00'], ink: '#120d00', bar: '#120d00', mark: '#e8b400',
    head: ['HUNGER.', 'AGGRESSION.', 'NO PULSE.'], kicker: 'KNOW THE SYMPTOMS',
    legal: 'REPORT AFFECTED PASSENGERS TO PLATFORM STAFF.', hazard: true,
  },
  {
    field: ['#b3121c', '#5c060c'], ink: '#f6f0e2', bar: '#0d0405', mark: '#f6c21a',
    head: ['THE LAST TRAIN', 'RUNS ALL NIGHT'], kicker: 'SHOEMONEY EXPRESS',
    legal: 'NOW SERVING THE LOWER LEVELS. NO RETURN SERVICE.',
  },
])

function drawPoster(ctx, r, design, seed) {
  const rng = new Rng(SEEDS.signage ^ (0x1000 + seed * 0x9e3))
  const { x, y, w, h } = r

  const field = ctx.createLinearGradient(x, y, x + w, y + h)
  field.addColorStop(0, design.field[0])
  field.addColorStop(1, design.field[1])
  ctx.fillStyle = field
  ctx.fillRect(x, y, w, h)

  if (design.hazard) {
    // Diagonal hazard chevrons down the left edge — instantly legible as a warning bill.
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w * 0.11, h)
    ctx.clip()
    ctx.fillStyle = '#120d00'
    for (let i = -6; i < 20; i++) {
      ctx.beginPath()
      ctx.moveTo(x + i * h * 0.16, y)
      ctx.lineTo(x + i * h * 0.16 + h * 0.08, y)
      ctx.lineTo(x + i * h * 0.16 + h * 0.08 - h, y + h)
      ctx.lineTo(x + i * h * 0.16 - h, y + h)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  if (design.notice) {
    ctx.strokeStyle = design.ink
    ctx.lineWidth = h * 0.022
    ctx.strokeRect(x + w * 0.035, y + h * 0.07, w * 0.93, h * 0.86)
  }

  const padLeft = x + w * (design.hazard ? 0.16 : 0.07)
  const barH = h * 0.19
  const barY = y + h - barH

  // Headline: as large as the widest line allows, so every poster fills its own field.
  //
  // The vertical fit is solved from the BOTTOM, not the top. Sizing off the line count
  // alone put a one-line poster's kicker 50 px below the artwork and a three-line
  // poster's kicker inside the legal bar — "$132,994.97" shipped with no "ONE MONTH.
  // ONE MAILBOX." under it at all. The block now has to end above the space the kicker
  // needs, and the kicker is clamped off the bar regardless.
  const lines = design.head
  const maxW = w - (padLeft - x) - w * 0.08
  const kickerSize = h * 0.078
  const lineGap = 1.02
  const blockTop = y + h * 0.10
  const blockBottom = barY - h * 0.05 - kickerSize
  let size = (blockBottom - blockTop) / (lines.length * lineGap)
  for (const line of lines) {
    while (size > 6 && stencilWidth(ctx, line, size, { weight: 800, squeeze: 0.70 }) > maxW) size -= 1
  }
  lines.forEach((line, i) => {
    stencil(ctx, line, padLeft, blockTop + size * (0.80 + i * lineGap), size, {
      weight: 800, squeeze: 0.70, align: 'left', color: design.ink,
    })
  })

  const lastBaseline = blockTop + size * (0.80 + (lines.length - 1) * lineGap)
  stencil(
    ctx,
    design.kicker,
    padLeft,
    Math.min(lastBaseline + kickerSize * 2.0, barY - h * 0.045),
    kickerSize,
    { weight: 700, squeeze: 0.76, align: 'left', color: design.ink, alpha: 0.82, track: 3 },
  )

  ctx.fillStyle = design.bar
  ctx.fillRect(x, barY, w, barH)
  stencil(ctx, design.legal, padLeft, barY + barH * 0.66, barH * 0.40, {
    weight: 600, squeeze: 0.80, align: 'left',
    color: design.invert ? '#2a2417' : '#b9b09a', track: 2,
  })
  drawBullet(ctx, x + w * 0.935, barY + barH * 0.5, barH * 0.34, {
    fill: design.mark, ink: design.invert ? '#eae4cf' : '#0c0a06',
  })

  // Paste-up damage: one torn corner and a bleached scrape, different on every bill.
  drawTear(ctx, x, y, w, h, rng, Math.floor(rng.next() * 4))

  // Two bills in eight have been tagged. It is the cheapest character in the set and the
  // one thing on a poster that could only have got there after it was pasted up.
  if (rng.chance(0.28)) {
    ctx.save()
    ctx.globalAlpha = rng.range(0.55, 0.85)
    ctx.strokeStyle = rng.chance(0.5) ? '#27d17a' : '#f24c8a'
    ctx.lineWidth = h * rng.range(0.035, 0.06)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let px = x + w * rng.range(0.10, 0.28)
    let py = y + h * rng.range(0.35, 0.72)
    ctx.moveTo(px, py)
    for (let i = 0; i < 7; i++) {
      px += w * rng.range(0.05, 0.13)
      py = y + h * rng.range(0.24, 0.80)
      ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.restore()
  }
  if (rng.chance(0.5)) {
    ctx.save()
    ctx.globalAlpha = rng.range(0.10, 0.22)
    ctx.fillStyle = '#d9d2bd'
    ctx.beginPath()
    ctx.ellipse(
      x + w * rng.range(0.2, 0.8), y + h * rng.range(0.25, 0.75),
      w * rng.range(0.06, 0.16), h * rng.range(0.08, 0.2),
      rng.range(-0.6, 0.6), 0, Math.PI * 2,
    )
    ctx.fill()
    ctx.restore()
  }

  ageArt(ctx, x, y, w, h, rng.range(0.30, 0.52), seed * 7 + 1)
}

function bakeAdAtlas() {
  const canvas = makeCanvas(ADS_SIZE)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#05060a' // gutters: a mip that bleeds should bleed into the bezel
  ctx.fillRect(0, 0, ADS_SIZE, ADS_SIZE)

  const cells = []
  const gutter = 6
  AD_DESIGNS.forEach((design, i) => {
    const cx = (i % AD_COLS) * AD_W
    const cy = Math.floor(i / AD_COLS) * AD_H
    const r = { x: cx + gutter, y: cy + gutter, w: AD_W - gutter * 2, h: AD_H - gutter * 2 }
    drawPoster(ctx, r, design, i)
    cells.push(atlasRect(r.x, r.y, r.w, r.h, ADS_SIZE))
  })

  return { texture: atlasTexture(canvas), cells }
}

const SIGNS_SIZE = 1024
const STRIP_W = 512
const STRIP_H = 128
/** World proportions of one wayfinding strip, matching the 4:1 atlas cell. */
export const SIGN_STRIP = Object.freeze({ width: 340.0, height: 85.0 })

/** The line diagram. Six stops, a fat rule, and you are the one ringed in red. */
function drawLineDiagram(ctx, r, stops, here) {
  const { x, y, w, h } = r
  ctx.fillStyle = '#0a0e17'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#b3121c'
  ctx.fillRect(x, y, w, h * 0.055)

  const cy = y + h * 0.50
  const x0 = x + w * 0.075
  const x1 = x + w * 0.955
  ctx.strokeStyle = '#e8eef8'
  ctx.lineWidth = h * 0.085
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x0, cy)
  ctx.lineTo(x1, cy)
  ctx.stroke()

  stops.forEach((name, i) => {
    const t = stops.length > 1 ? i / (stops.length - 1) : 0.5
    const px = x0 + (x1 - x0) * t
    ctx.beginPath()
    ctx.arc(px, cy, h * (i === here ? 0.145 : 0.095), 0, Math.PI * 2)
    ctx.fillStyle = i === here ? '#b3121c' : '#0a0e17'
    ctx.fill()
    ctx.lineWidth = h * 0.05
    ctx.strokeStyle = i === here ? '#ffd24a' : '#e8eef8'
    ctx.stroke()
    // Alternating above and below, which is how a real diagram keeps its labels apart.
    const above = i % 2 === 0
    stencil(ctx, name, px, above ? cy - h * 0.24 : cy + h * 0.40, h * 0.145, {
      weight: 700, squeeze: 0.74, color: i === here ? '#ffd24a' : '#9fb2cc', track: 1,
    })
  })
}

/** A lit wayfinding plate: dark ground, one accent rule, one line you can read at 12 m. */
function drawStrip(ctx, r, spec, seed) {
  const { x, y, w, h } = r
  ctx.fillStyle = spec.ground ?? '#0a0e17'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = spec.rule ?? '#0d3f86'
  ctx.fillRect(x, y, w, h * 0.07)
  ctx.fillRect(x, y + h * 0.93, w, h * 0.07)

  let cursor = x + w * 0.045
  if (spec.roundel) {
    // Centred at 0.145, not 0.085: the bar runs 1.28 radii either side of centre, and at
    // 0.085 it hung 19 px off the left edge of the cell and into its neighbour's artwork.
    drawRoundel(ctx, x + w * 0.145, y + h * 0.5, h * 0.40, 'SHOEMONEY')
    cursor = x + w * 0.29
  } else if (spec.bullet) {
    drawBullet(ctx, x + w * 0.075, y + h * 0.5, h * 0.29, { ring: 'rgba(255,255,255,0.45)' })
    cursor = x + w * 0.155
  }

  if (spec.arrow) {
    const dir = spec.arrow > 0 ? 1 : -1
    const ax = dir > 0 ? x + w * 0.94 : x + w * 0.06
    const ah = h * 0.20
    ctx.fillStyle = '#ffce3d'
    ctx.beginPath()
    ctx.moveTo(ax, y + h * 0.5)
    ctx.lineTo(ax - dir * ah * 1.1, y + h * 0.5 - ah)
    ctx.lineTo(ax - dir * ah * 1.1, y + h * 0.5 - ah * 0.40)
    ctx.lineTo(ax - dir * ah * 2.5, y + h * 0.5 - ah * 0.40)
    ctx.lineTo(ax - dir * ah * 2.5, y + h * 0.5 + ah * 0.40)
    ctx.lineTo(ax - dir * ah * 1.1, y + h * 0.5 + ah * 0.40)
    ctx.lineTo(ax - dir * ah * 1.1, y + h * 0.5 + ah)
    ctx.closePath()
    ctx.fill()
  }

  const right = spec.arrow > 0 ? x + w * 0.80 : x + w * 0.96
  const room = right - cursor
  let size = h * 0.42
  while (size > 6 && stencilWidth(ctx, spec.head, size, { weight: 800, squeeze: 0.72 }) > room) size -= 1
  stencil(ctx, spec.head, cursor, y + h * (spec.sub ? 0.50 : 0.64), size, {
    weight: 800, squeeze: 0.72, align: 'left', color: spec.ink ?? '#f2f7ff', track: 1,
  })
  if (spec.sub) {
    stencil(ctx, spec.sub, cursor, y + h * 0.80, h * 0.155, {
      weight: 600, squeeze: 0.80, align: 'left', color: spec.subInk ?? '#8fa9cc', track: 2,
    })
  }
  ageArt(ctx, x, y, w, h, 0.40, seed * 13 + 5)
}

const STRIP_SPECS = Object.freeze([
  { roundel: true, head: 'SHOEMONEY SQ', sub: 'PLATFORM 1 · LOWER LEVEL' },
  { arrow: -1, head: 'WAY OUT', sub: 'STREET LEVEL · TAXIS · TRANSFER', rule: '#1f7a2e' },
  { diagram: ['HOLLIS', 'PAR', 'SHOEMONEY SQ', 'AUCTION', 'HUDSON', 'TERMINUS'], here: 2 },
  { arrow: 1, head: 'DOWNTOWN EXPRESS', sub: 'DOES NOT STOP · DO NOT BOARD', rule: '#b3121c' },
  { bullet: true, head: 'MIND THE GAP', sub: 'STAND CLEAR OF THE CLOSING DOORS', rule: '#d8a516' },
  { head: 'NO EXIT', sub: 'AUTHORISED PERSONNEL BEYOND THIS POINT', rule: '#b3121c', ink: '#ffb9b9' },
  { diagram: ['TERMINUS', 'HUDSON', 'AUCTION', 'SHOEMONEY SQ', 'PAR', 'HOLLIS'], here: 3 },
  { bullet: true, head: 'EXPRESS SERVICE', sub: 'ALL NIGHT · EVERY NIGHT · NO RETURN', rule: '#0d3f86' },
])

function bakeSignAtlas() {
  const canvas = makeCanvas(SIGNS_SIZE)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  // Transparent ground, because the platform stencils are paint on concrete, not a decal
  // on a black rectangle. Every opaque sign fills its own cell before it draws.
  ctx.clearRect(0, 0, SIGNS_SIZE, SIGNS_SIZE)

  const gutter = 4
  const strips = []
  STRIP_SPECS.forEach((spec, i) => {
    const cx = (i % 2) * STRIP_W
    const cy = Math.floor(i / 2) * STRIP_H
    const r = { x: cx + gutter, y: cy + gutter, w: STRIP_W - gutter * 2, h: STRIP_H - gutter * 2 }
    if (spec.diagram) {
      drawLineDiagram(ctx, r, spec.diagram, spec.here)
      ageArt(ctx, r.x, r.y, r.w, r.h, 0.34, i * 29 + 3)
    } else {
      drawStrip(ctx, r, spec, i)
    }
    strips.push(atlasRect(r.x, r.y, r.w, r.h, SIGNS_SIZE))
  })

  // --- MIND THE GAP: worn paint, transparent ground, so it lies ON the platform --------
  const gapPx = { x: 4, y: 516, w: 744, h: 120 } // 6.2:1 — BRAND.stencil* matches this
  ctx.save()
  ctx.beginPath()
  ctx.rect(gapPx.x, gapPx.y, gapPx.w, gapPx.h)
  ctx.clip()
  const gapRng = new Rng(SEEDS.stripe ^ 0x31d)
  stencil(ctx, 'MIND THE GAP', gapPx.x + gapPx.w * 0.5, gapPx.y + gapPx.h * 0.80, gapPx.h * 0.94, {
    weight: 800, squeeze: 0.68, color: '#f2d24a', track: 6,
  })
  // Scrubbed back to the slab by a million shoes: knock holes in the paint, do not tint it.
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = gapRng.range(0.25, 0.95)
    ctx.beginPath()
    ctx.ellipse(
      gapPx.x + gapRng.next() * gapPx.w, gapPx.y + gapRng.next() * gapPx.h,
      gapRng.range(3, 26), gapRng.range(2, 13), gapRng.range(0, Math.PI), 0, Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.restore()

  // --- the enamel plate that goes on every column --------------------------------------
  const tabletPx = { x: 772, y: 516, w: 248, h: 120 } // 2.067:1
  ctx.fillStyle = '#0d3f86'
  ctx.fillRect(tabletPx.x, tabletPx.y, tabletPx.w, tabletPx.h)
  ctx.strokeStyle = '#e4edfb'
  ctx.lineWidth = 4
  ctx.strokeRect(tabletPx.x + 8, tabletPx.y + 8, tabletPx.w - 16, tabletPx.h - 16)
  stencil(ctx, 'SHOEMONEY', tabletPx.x + tabletPx.w * 0.5, tabletPx.y + tabletPx.h * 0.52, 40, {
    weight: 800, squeeze: 0.70, color: '#f2f7ff', track: 1,
  })
  stencil(ctx, 'SQUARE', tabletPx.x + tabletPx.w * 0.5, tabletPx.y + tabletPx.h * 0.80, 30, {
    weight: 700, squeeze: 0.72, color: '#9fc2ef', track: 5,
  })
  ageArt(ctx, tabletPx.x, tabletPx.y, tabletPx.w, tabletPx.h, 0.46, 41)

  // --- the two hanging exit signs ------------------------------------------------------
  const exits = [
    { px: { x: 4, y: 644, w: 504, h: 248 }, head: 'WAY OUT', sub: 'STREET LEVEL', up: true, ground: '#0f5c2a' },
    { px: { x: 516, y: 644, w: 504, h: 248 }, head: 'TO TRAINS', sub: 'PLATFORM 1 · ALL SERVICES', up: false, ground: '#0d3f86' },
  ]
  exits.forEach((exit, i) => {
    const { x, y, w, h } = exit.px
    ctx.fillStyle = exit.ground
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(240,248,255,0.8)'
    ctx.lineWidth = 5
    ctx.strokeRect(x + 12, y + 12, w - 24, h - 24)

    // A big arrow is the whole sign; the words are the caption.
    const ax = x + w * 0.20
    const ay = y + h * 0.48
    const a = h * 0.17
    ctx.fillStyle = '#ffce3d'
    ctx.beginPath()
    if (exit.up) {
      ctx.moveTo(ax, ay - a * 1.5)
      ctx.lineTo(ax + a, ay - a * 0.3)
      ctx.lineTo(ax + a * 0.42, ay - a * 0.3)
      ctx.lineTo(ax + a * 0.42, ay + a * 1.4)
      ctx.lineTo(ax - a * 0.42, ay + a * 1.4)
      ctx.lineTo(ax - a * 0.42, ay - a * 0.3)
      ctx.lineTo(ax - a, ay - a * 0.3)
    } else {
      ctx.moveTo(ax - a * 1.5, ay)
      ctx.lineTo(ax - a * 0.3, ay - a)
      ctx.lineTo(ax - a * 0.3, ay - a * 0.42)
      ctx.lineTo(ax + a * 1.4, ay - a * 0.42)
      ctx.lineTo(ax + a * 1.4, ay + a * 0.42)
      ctx.lineTo(ax - a * 0.3, ay + a * 0.42)
      ctx.lineTo(ax - a * 0.3, ay + a)
    }
    ctx.closePath()
    ctx.fill()

    stencil(ctx, exit.head, x + w * 0.40, y + h * 0.52, h * 0.30, {
      weight: 800, squeeze: 0.70, align: 'left', color: '#f4f9ff', track: 2,
    })
    stencil(ctx, exit.sub, x + w * 0.40, y + h * 0.74, h * 0.10, {
      weight: 600, squeeze: 0.80, align: 'left', color: '#cbdcf2', track: 3,
    })
    ageArt(ctx, x, y, w, h, 0.36, 61 + i * 17)
  })

  return {
    texture: atlasTexture(canvas),
    strips,
    gap: atlasRect(gapPx.x, gapPx.y, gapPx.w, gapPx.h, SIGNS_SIZE),
    tablet: atlasRect(tabletPx.x, tabletPx.y, tabletPx.w, tabletPx.h, SIGNS_SIZE),
    exits: exits.map((e) => atlasRect(e.px.x, e.px.y, e.px.w, e.px.h, SIGNS_SIZE)),
  }
}

/**
 * A soft disc, used additively on the wall around every lit panel.
 *
 * Sixteen real point lights would be the honest way to pool light around sixteen light
 * boxes, and it would also be sixteen more lights on top of the station's twenty-eight.
 * This is the lie that buys the same read for one draw call: the wall behind each panel
 * gets the falloff a box would throw, and the bloom pass does the rest.
 */
function bakeHalo() {
  const size = 256
  const canvas = makeCanvas(size)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, size, size)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0.0, 'rgba(255,238,205,1)')
  g.addColorStop(0.26, 'rgba(255,224,172,0.52)')
  g.addColorStop(0.58, 'rgba(206,150,74,0.15)')
  g.addColorStop(1.0, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return atlasTexture(canvas)
}

/**
 * Bake the whole branding set. Called once, by whoever builds the platform dressing.
 *
 * Cost is two 1024 canvases of vector drawing plus one 256 noise field — about 60 ms
 * against the station's own 1.2 s bake, because none of it is a per-pixel shader loop.
 */
export function createBrandingTextures() {
  const clock = typeof performance !== 'undefined' ? performance : null
  const started = clock ? clock.now() : 0

  const ads = bakeAdAtlas()
  const signs = bakeSignAtlas()
  const halo = bakeHalo()

  if (!ads || !signs) {
    warnOnce(
      'no-branding',
      '[materials] no DOM: the platform advertising and wayfinding cannot be drawn, so the ' +
        'tunnel walls stay blank tile — the corridor look the branding pass exists to kill.',
    )
  }

  const textures = [ads?.texture, signs?.texture, halo].filter(Boolean)
  if (clock && textures.length) {
    console.info(`[materials] baked ${textures.length} branding atlases in ${Math.round(clock.now() - started)} ms`)
  }

  return {
    ads,
    signs,
    halo,
    textures,
    dispose() {
      for (const tex of textures) tex.dispose()
    },
  }
}

/**
 * A tiny equirectangular environment: black tunnel below, cold grey at the horizon,
 * a warm band overhead where the strips are. Without it, every low-roughness surface
 * in the station reflects nothing and reads as black plastic rather than wet stone.
 */
export function createEnvironmentTexture() {
  const width = 128
  const height = 64
  if (typeof document === 'undefined') {
    warnOnce('no-env', '[materials] no DOM: skipping the procedural environment map; wet surfaces will lose their reflections.')
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0.0, '#4a4438')
  gradient.addColorStop(0.28, '#2a2a30')
  gradient.addColorStop(0.5, '#161a22')
  gradient.addColorStop(0.72, '#0b0d13')
  gradient.addColorStop(1.0, '#040508')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  // the seven strip lights, smeared into a band of warm highlights to catch in puddles
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < STATION.COUNTS.lightStations; i++) {
    const x = ((i + 0.5) / STATION.COUNTS.lightStations) * width
    const blob = ctx.createRadialGradient(x, height * 0.18, 0, x, height * 0.18, width * 0.09)
    blob.addColorStop(0, 'rgba(255,238,200,0.85)')
    blob.addColorStop(1, 'rgba(255,238,200,0)')
    ctx.fillStyle = blob
    ctx.fillRect(0, 0, width, height)
  }
  ctx.globalCompositeOperation = 'source-over'

  const tex = new THREE.CanvasTexture(canvas)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// material assembly
// ---------------------------------------------------------------------------

const linear = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace)

function standard(baseColorLinear, maps, extra = {}) {
  const material = new THREE.MeshStandardMaterial({
    color: linear(baseColorLinear),
    vertexColors: true, // the builder bakes grime/AO per vertex; see station.js
    ...extra,
  })
  if (maps.map) material.map = maps.map
  if (maps.ormMap) {
    // Same texture object in both slots: three reads .g for roughness and .b for
    // metalness, so this is one binding doing two jobs.
    material.roughnessMap = maps.ormMap
    material.metalnessMap = maps.ormMap
  }
  if (maps.normalMap) {
    material.normalMap = maps.normalMap
    material.normalScale = new THREE.Vector2(1, 1)
  }
  return material
}

/**
 * Build every station material. Call once; the station holds the result and disposes it.
 *
 * Baking runs ~2.5 M shader-function evaluations, which is 60-150 ms of main thread on a
 * laptop. It happens during level build, before the first frame, so it costs load time
 * and never frame time.
 */
export function createStationMaterials() {
  const clock = typeof performance !== 'undefined' ? performance : null
  const started = clock ? clock.now() : 0

  const tileMaps = bakeTile()
  const concreteMaps = bakeConcrete()
  const wetMaps = bakeWetConcrete()
  // 450 cm of column over 90 cells is a 5 cm chip, and at 1024 that chip is 11 px across
  // — enough for it to have an inside and a broken edge rather than being a soft dot.
  // This is the only set baked above 512: it is the surface a player stands next to.
  const columnMaps = bakePaintedSteel(SEEDS.column, [0.86, 0.87, 0.82], 0.55, {
    chipCells: 90,
    grime: 1.0,
    size: 1024,
  })
  // 160 cm of furniture over 32 cells is the same 5 cm chip at 512.
  const furnitureMaps = bakePaintedSteel(SEEDS.furniture, [0.82, 0.86, 0.96], 0.35, {
    chipCells: 32,
  })
  const railMaps = bakeRail()
  const sleeperMaps = bakeSleeper()
  const stripeMaps = bakeStripe()
  const binMaps = bakeBinMetal()
  const portalMaps = bakePortal()
  const hangingSignMaps = bakeHangingSign()
  const wallBoardMaps = bakeWallBoard()

  const concrete = standard(COLORS.structureLinear, concreteMaps, {
    roughness: SURFACE.concreteRoughness,
    metalness: SURFACE.concreteMetalness,
  })

  const wetConcrete = standard(COLORS.structureLinear, wetMaps, {
    roughness: SURFACE.wetFloorRoughness,
    metalness: SURFACE.wetFloorMetalness,
  })

  const tile = standard(TILE_LINEAR, tileMaps, {
    roughness: SURFACE.concreteRoughness,
    metalness: SURFACE.concreteMetalness,
  })

  const column = standard(COLORS.columnLinear, columnMaps, {
    roughness: SURFACE.furnitureRoughness,
    metalness: SURFACE.furnitureMetalness,
  })

  const rail = standard(COLORS.railLinear, railMaps, {
    roughness: SURFACE.railRoughness,
    metalness: SURFACE.railMetalness,
  })

  const sleeper = standard(COLORS.sleeperLinear, sleeperMaps, {
    roughness: SURFACE.sleeperRoughness,
    metalness: SURFACE.sleeperMetalness,
  })

  const safetyStripe = standard(COLORS.safetyStripeLinear, stripeMaps, {
    roughness: SURFACE.signageRoughness,
    metalness: 0.0,
  })

  const furniture = standard(COLORS.furnitureLinear, furnitureMaps, {
    roughness: SURFACE.furnitureRoughness,
    metalness: SURFACE.furnitureMetalness,
  })

  const trashBin = standard(COLORS.trashBinLinear, binMaps, {
    roughness: SURFACE.furnitureRoughness,
    metalness: SURFACE.furnitureMetalness,
  })

  // A darkness cap must not respond to the 28 lights or it stops being darkness.
  const tunnelPortal = new THREE.MeshBasicMaterial({
    color: linear(COLORS.tunnelPortalLinear),
    vertexColors: true,
    fog: true,
  })
  if (portalMaps.map) tunnelPortal.map = portalMaps.map

  const hangingSign = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: hangingSignMaps.map ?? null,
    emissive: 0xffffff,
    emissiveMap: hangingSignMaps.map ?? null,
    emissiveIntensity: PROPS.hangingSign.emissiveIntensity,
    roughness: SURFACE.signageRoughness,
    metalness: SURFACE.signageMetalness,
  })
  if (!hangingSignMaps.map) {
    hangingSign.color = linear(COLORS.signageLinear)
    hangingSign.emissive = linear(COLORS.signageLinear)
  }

  const wallBoard = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: wallBoardMaps.map ?? null,
    emissive: 0xffffff,
    emissiveMap: wallBoardMaps.map ?? null,
    emissiveIntensity: PROPS.wallBoard.emissiveIntensity,
    roughness: SURFACE.signageRoughness,
    metalness: SURFACE.signageMetalness,
  })
  if (!wallBoardMaps.map) {
    wallBoard.color = linear(COLORS.signageLinear)
    wallBoard.emissive = linear(COLORS.signageLinear)
  }

  // Starts on the documented flat-grey fallback; loadLogoTexture upgrades it in place.
  const logo = new THREE.MeshStandardMaterial({
    color: linear(PROPS.logo.fallbackColorLinear),
    emissive: linear(PROPS.logo.fallbackColorLinear),
    emissiveIntensity: PROPS.logo.emissiveIntensity * 0.25,
    roughness: SURFACE.signageRoughness,
    metalness: 0.0,
    side: THREE.DoubleSide,
    transparent: true,
  })

  const lightStrip = new THREE.MeshStandardMaterial({
    color: linear(COLORS.lightStripLinear),
    emissive: linear(COLORS.lightStripLinear),
    emissiveIntensity: STATION.LIGHTING.lightStrip.emissiveIntensity,
    roughness: 0.25,
    metalness: 0.0,
    toneMapped: true,
  })

  // Built without vertexColors: the fixtures come from lighting.js as plain instanced
  // boxes, which carry no baked grime attribute.
  const lightHousing = new THREE.MeshStandardMaterial({
    color: linear(COLORS.trashBinLinear),
    map: binMaps.map ?? null,
    roughnessMap: binMaps.ormMap ?? null,
    metalnessMap: binMaps.ormMap ?? null,
    normalMap: binMaps.normalMap ?? null,
    roughness: 0.45,
    metalness: 0.65,
  })

  const haze = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // BackSide, not DoubleSide: an additive cone you can walk inside must not add twice,
    // and seeing only the far wall of the cone is what reads as depth rather than card.
    side: THREE.BackSide,
    fog: false,
    toneMapped: true,
  })
  // The vertical gradient is baked into the cone's vertex colours by lighting.js; this
  // multiplies it by how squarely the shell faces the viewer, which is both what a real
  // shaft does (more air to look through down the axis) and what dissolves the silhouette.
  haze.colorNode = attribute('color', 'vec3')
    .mul(pow(abs(dot(normalView, positionViewDirection)), HAZE_EDGE_SOFTNESS))
    .mul(smoothstep(HAZE_NEAR_FADE_START, HAZE_NEAR_FADE_END, positionView.z.negate()))

  const materials = {
    concrete,
    wetConcrete,
    tile,
    column,
    rail,
    sleeper,
    safetyStripe,
    furniture,
    trashBin,
    tunnelPortal,
    hangingSign,
    wallBoard,
    logo,
    lightStrip,
    lightHousing,
    haze,
  }

  const textures = [
    tileMaps,
    concreteMaps,
    wetMaps,
    columnMaps,
    furnitureMaps,
    railMaps,
    sleeperMaps,
    stripeMaps,
    binMaps,
    portalMaps,
    hangingSignMaps,
    wallBoardMaps,
  ].flatMap((set) => Object.values(set).filter(Boolean))

  if (clock) {
    console.info(`[materials] baked ${textures.length} procedural textures in ${Math.round(clock.now() - started)} ms`)
  }

  return {
    ...materials,
    textures,
    dispose() {
      for (const tex of textures) tex.dispose()
      for (const material of Object.values(materials)) material.dispose()
    },
  }
}

/**
 * Swap the real logo art onto the logo panel once it arrives over the network.
 * On failure the panel keeps the spec's flat grey and says so loudly — a silently
 * blank board is exactly the kind of missing asset that hides for a week.
 */
export function loadLogoTexture(material) {
  if (typeof document === 'undefined') return Promise.resolve(false)
  const relative = PROPS.logo.texturePath.replace(/^\//, '')
  // vite is configured with `base: './'`, so a root-absolute path would 404 on any
  // sub-path deploy; resolve against the document base instead.
  const url = new URL(relative, document.baseURI).href

  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 8
        material.map = tex
        material.emissiveMap = tex
        material.color = new THREE.Color(0xffffff)
        material.emissive = new THREE.Color(0xffffff)
        material.emissiveIntensity = PROPS.logo.emissiveIntensity
        material.needsUpdate = true
        resolve(true)
      },
      undefined,
      (err) => {
        console.warn(
          `[materials] logo art failed to load from ${url} — the wall panel stays flat grey ` +
            `(${PROPS.logo.fallbackColorHex.toString(16)}).`,
          err,
        )
        resolve(false)
      },
    )
  })
}
