/**
 * Blood — spec/fx-feel.md §5.
 *
 * One square decal per connecting pellet, stamped only on things that have health
 * (there are no blood decals on hard surfaces anywhere in this game). Width and
 * height come from a SINGLE random draw, so splats are always square; the only
 * thing that keeps two hits from reading as the same rubber stamp is the random
 * roll about the projection axis.
 *
 * The original projected a real box decal 12-20 cm INTO the surface. A projector
 * that deep needs the receiving geometry, which the FX layer does not have, so
 * this is a quad standing just off the impact plane. The half-depth still drives
 * the standoff so a splat on a slightly uneven wall does not z-fight, and the
 * constant keeps its meaning if anyone later swaps in a real decal projector.
 *
 * The source's decal material was an admitted placeholder — a stock debug material
 * with four guessed parameter names set blindly on it. There is no blood texture,
 * mask or alpha shape anywhere in the project, so the splat shape here is
 * generated: an irregular blob with runs and speckle, low roughness so the station
 * lights catch it wet. That is a look decision, not a spec deviation.
 */
import * as THREE from 'three/webgpu'
import { FX } from '../game/rules.js'
import { Rng } from '../core/rng.js'

const B = FX.BLOOD_DECAL

/**
 * Appearance-only knobs. Not in rules.js because another agent owns that file and
 * it holds the Unreal spec as data; none of these existed in the original.
 */
const LOOK = Object.freeze({
  splatVariants: 4, // enough that a shotgun blast does not tile the same shape
  standoffFraction: 0.04, // of the decal's own half-depth — just enough to clear z-fighting
  textureSize: 256,
  blobsPerSplat: 9,
  speckPerSplat: 26,
  roughness: 0.22, // wet, so the platform lights streak across it
  polygonOffset: -4, // factor and units; pushes the quad in front of the wall it sits on
  mistPuffs: 12,
  mistPerSpray: 3,
  mistLifeSeconds: FX.IMPACT.shardFadeSeconds, // dies with the gobs it came off
  mistSpeed: 180, // cm/s
  mistSpeedJitterMin: 0.5,
  mistSizeFraction: 0.6, // of the decal half-size range midpoint
  mistSizeJitterMin: 0.6,
  mistSizeJitterMax: 1.2,
  mistNormalBias: 1.4, // how hard the spray leans away from the surface vs scattering
  mistOpacity: 0.7,
})

let splatTextures = null
let mistTexture = null

function makeSplatTextures(rng) {
  if (splatTextures) return splatTextures
  if (typeof document === 'undefined') {
    console.warn('[fx/blood] no DOM: blood decals fall back to untextured squares')
    return null
  }
  const size = LOOK.textureSize
  splatTextures = []

  for (let v = 0; v < LOOK.splatVariants; v++) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    const c = size / 2

    ctx.fillStyle = '#fff'
    for (let i = 0; i < LOOK.blobsPerSplat; i++) {
      // Blobs cluster near the centre and thin out, which is what makes a splat
      // read as one impact rather than a scatter of unrelated dots.
      const pull = rng.next() ** 1.6
      const angle = rng.range(0, Math.PI * 2)
      const dist = pull * c * 0.5
      const r = c * rng.range(0.2, 0.46) * (1 - pull * 0.45)
      ctx.beginPath()
      ctx.ellipse(
        c + Math.cos(angle) * dist,
        c + Math.sin(angle) * dist,
        r,
        r * rng.range(0.6, 1.4),
        rng.range(0, Math.PI),
        0,
        Math.PI * 2,
      )
      ctx.fill()
    }
    for (let i = 0; i < LOOK.speckPerSplat; i++) {
      const angle = rng.range(0, Math.PI * 2)
      const dist = rng.range(0.35, 0.96) * c
      const r = c * rng.range(0.012, 0.05)
      ctx.beginPath()
      ctx.arc(c + Math.cos(angle) * dist, c + Math.sin(angle) * dist, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // Feather the whole stamp so the square quad's edge never shows.
    const mask = ctx.createRadialGradient(c, c, c * (1 - B.edgeSoftness), c, c, c)
    mask.addColorStop(0, 'rgba(0,0,0,1)')
    mask.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = mask
    ctx.fillRect(0, 0, size, size)

    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    splatTextures.push(tex)
  }
  return splatTextures
}

function makeMistTexture() {
  if (mistTexture) return mistTexture
  if (typeof document === 'undefined') return null
  const size = LOOK.textureSize / 2
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const c = size / 2
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  g.addColorStop(0, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.3)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  mistTexture = new THREE.CanvasTexture(canvas)
  return mistTexture
}

export function createBloodFX({ scene, rng = new Rng() }) {
  if (!scene) throw new Error('[fx/blood] needs a scene')

  const root = new THREE.Group()
  root.name = 'fx:blood'
  scene.add(root)

  const textures = makeSplatTextures(rng)
  const tint = new THREE.Color().setRGB(...B.tintLinear, THREE.LinearSRGBColorSpace)
  const quad = new THREE.PlaneGeometry(1, 1)

  // Each decal keeps ONE splat variant for life. Swapping a map on a live material
  // rebuilds its shader, and a shotgun blast would do that eight times in one frame.
  const decals = []
  for (let i = 0; i < B.maxLive; i++) {
    const material = new THREE.MeshStandardNodeMaterial({
      map: textures ? textures[i % textures.length] : null,
      color: tint,
      roughness: LOOK.roughness,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: LOOK.polygonOffset,
      polygonOffsetUnits: LOOK.polygonOffset,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(quad, material)
    mesh.visible = false
    mesh.frustumCulled = true
    root.add(mesh)
    decals.push({ mesh, material, elapsed: 0, active: false })
  }

  const mistMap = makeMistTexture()
  const mist = []
  for (let i = 0; i < LOOK.mistPuffs; i++) {
    const material = new THREE.SpriteNodeMaterial({
      map: mistMap,
      color: tint,
      transparent: true,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.visible = false
    sprite.frustumCulled = false
    root.add(sprite)
    mist.push({ sprite, material, velocity: new THREE.Vector3(), elapsed: 0, size: 0, active: false })
  }

  const liveDecals = []
  const liveMist = []
  const orient = new THREE.Quaternion()
  const roll = new THREE.Quaternion()
  const forward = new THREE.Vector3(0, 0, 1)
  const axis = new THREE.Vector3()

  function takeDecal() {
    const free = decals.find((d) => !d.active)
    if (free) return free
    const oldest = liveDecals.reduce((a, b) => (a.elapsed >= b.elapsed ? a : b), liveDecals[0])
    const at = liveDecals.indexOf(oldest)
    if (at >= 0) liveDecals.splice(at, 1)
    return oldest
  }

  return {
    /**
     * @param {THREE.Vector3} position impact point
     * @param {THREE.Vector3} normal surface normal at the hit
     */
    decal(position, normal) {
      const slot = takeDecal()
      if (!slot) return

      axis.copy(normal).normalize()
      // One draw feeds both axes: the patch is always square, never rectangular.
      const half = rng.range(B.halfSizeMin, B.halfSizeMax)
      const halfDepth = rng.range(B.halfDepthMin, B.halfDepthMax)

      orient.setFromUnitVectors(forward, axis)
      roll.setFromAxisAngle(axis, THREE.MathUtils.degToRad(rng.range(B.rollMinDeg, B.rollMaxDeg)))
      slot.mesh.quaternion.copy(roll).multiply(orient)
      slot.mesh.position.copy(position).addScaledVector(axis, halfDepth * LOOK.standoffFraction)
      slot.mesh.scale.set(half * 2, half * 2, 1)
      slot.mesh.visible = true
      slot.material.opacity = 1
      slot.elapsed = 0
      slot.active = true
      liveDecals.push(slot)
    },

    /** Short-lived mist off a flesh hit. The gobs themselves are impact shards, not this. */
    spray(position, normal) {
      axis.copy(normal).normalize()
      const size = ((B.halfSizeMin + B.halfSizeMax) / 2) * LOOK.mistSizeFraction
      for (let i = 0; i < LOOK.mistPerSpray; i++) {
        const slot = mist.find((m) => !m.active)
        if (!slot) return
        slot.sprite.position.copy(position)
        slot.velocity
          .set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1))
          .normalize()
          .addScaledVector(axis, LOOK.mistNormalBias)
          .normalize()
          .multiplyScalar(LOOK.mistSpeed * rng.range(LOOK.mistSpeedJitterMin, 1))
        slot.size = size * rng.range(LOOK.mistSizeJitterMin, LOOK.mistSizeJitterMax)
        slot.sprite.scale.setScalar(slot.size)
        slot.material.opacity = LOOK.mistOpacity
        slot.sprite.visible = true
        slot.elapsed = 0
        slot.active = true
        liveMist.push(slot)
      }
    },

    update(dt) {
      for (let i = liveDecals.length - 1; i >= 0; i--) {
        const slot = liveDecals[i]
        slot.elapsed += dt
        if (slot.elapsed >= B.lifeSpan) {
          slot.mesh.visible = false
          slot.active = false
          liveDecals.splice(i, 1)
          continue
        }
        // Fully opaque for 9 s, then linear to nothing over the next 3.
        const fading = slot.elapsed - B.fadeStartDelay
        slot.material.opacity = fading <= 0 ? 1 : Math.max(0, 1 - fading / B.fadeDuration)
      }

      for (let i = liveMist.length - 1; i >= 0; i--) {
        const slot = liveMist[i]
        slot.elapsed += dt
        const t = slot.elapsed / LOOK.mistLifeSeconds
        if (t >= 1) {
          slot.sprite.visible = false
          slot.active = false
          liveMist.splice(i, 1)
          continue
        }
        slot.sprite.position.addScaledVector(slot.velocity, dt)
        slot.velocity.y += FX.IMPACT.gravityZ * FX.IMPACT.bloodGravityScale * dt
        slot.sprite.scale.setScalar(slot.size * (1 + t))
        slot.material.opacity = LOOK.mistOpacity * (1 - t)
      }
    },

    get decalCount() { return liveDecals.length },

    reset() {
      for (const slot of liveDecals) { slot.mesh.visible = false; slot.active = false }
      for (const slot of liveMist) { slot.sprite.visible = false; slot.active = false }
      liveDecals.length = 0
      liveMist.length = 0
    },

    dispose() {
      this.reset()
      for (const slot of decals) slot.material.dispose()
      for (const slot of mist) slot.material.dispose()
      quad.dispose()
      scene.remove(root)
    },
  }
}
