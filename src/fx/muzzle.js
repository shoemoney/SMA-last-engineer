/**
 * Muzzle flash — spec/fx-feel.md §3.3.
 *
 * In the original this was a bare point light and nothing else: no mesh, no smoke,
 * no tracer, no shell. The light's whole job is to strobe the tunnel walls for two
 * or three frames. A JS port that stops there reads as nothing at all, because a
 * 45 ms light change is below the threshold a player consciously registers — so a
 * single additive billboard rides along at exactly the light's own lifetime and
 * colour. Bloom picks it up; that flare IS the shot, the light is the room's
 * reaction to it.
 *
 * The suppressed variant is not just quieter. Per the source's own comment the
 * silencer must visibly change the shot: 6.4x dimmer, 2.1x shorter, 2.1x less
 * reach, and orange flips to blue-white.
 */
import * as THREE from 'three/webgpu'
import { FX } from '../game/rules.js'
import { Rng } from '../core/rng.js'

const M = FX.MUZZLE
const SCALE = FX.LIGHT_INTENSITY_SCALE

/**
 * Appearance-only knobs for the billboard the original never had. They are not in
 * rules.js because rules.js is the Unreal spec as data and another agent owns it;
 * if these ever want tuning they belong in rules.FX.MUZZLE.
 */
const LOOK = Object.freeze({
  flareCards: 4, // enough that a 900 RPM burst never reuses a card mid-life
  suppressedSizeFraction: 0.55, // the blue flash is a spark, not a fireball
  textureSize: 128,
  // The renderer tone-maps with ACES, which drags a 1.0 white down to a grey.
  // Driving the card's colour above 1.0 is what keeps the core clipped and puts
  // it over the bloom threshold in rules.FX.POST.
  hdrGain: 2.2,
  tailScale: 0.75, // the card shrinks to this as it dies, so no ghost is left at low alpha
})

let flareTexture = null

/** Four-spike star with a blown-out core — the shape reads as "flash" at 2 frames. */
function makeFlareTexture() {
  if (flareTexture) return flareTexture
  if (typeof document === 'undefined') {
    console.warn('[fx/muzzle] no DOM: muzzle flare billboard disabled, light-only flash')
    return null
  }
  const size = LOOK.textureSize
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const c = size / 2

  const core = ctx.createRadialGradient(c, c, 0, c, c, c)
  core.addColorStop(0, 'rgba(255,255,255,1)')
  core.addColorStop(0.18, 'rgba(255,238,200,0.95)')
  core.addColorStop(0.45, 'rgba(255,170,70,0.35)')
  core.addColorStop(1, 'rgba(255,120,20,0)')
  ctx.fillStyle = core
  ctx.fillRect(0, 0, size, size)

  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 4; i++) {
    ctx.save()
    ctx.translate(c, c)
    ctx.rotate((i * Math.PI) / 2 + Math.PI / 4)
    const spike = ctx.createLinearGradient(0, 0, c, 0)
    spike.addColorStop(0, 'rgba(255,255,255,0.9)')
    spike.addColorStop(0.35, 'rgba(255,200,120,0.28)')
    spike.addColorStop(1, 'rgba(255,150,50,0)')
    ctx.fillStyle = spike
    ctx.beginPath()
    ctx.moveTo(0, -size * 0.045)
    ctx.lineTo(c, 0)
    ctx.lineTo(0, size * 0.045)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  flareTexture = new THREE.CanvasTexture(canvas)
  flareTexture.colorSpace = THREE.SRGBColorSpace
  return flareTexture
}

/**
 * @param {object} deps
 * @param {THREE.Object3D} deps.scene
 * @param {object} deps.lights  light ring from fx/impacts.js createLightRing()
 */
export function createMuzzleFX({ scene, lights, rng = new Rng() }) {
  if (!scene) throw new Error('[fx/muzzle] needs a scene')
  if (!lights) throw new Error('[fx/muzzle] needs a light ring (see createLightRing in fx/impacts.js)')

  const texture = makeFlareTexture()
  const cards = []
  const root = new THREE.Group()
  root.name = 'fx:muzzle'
  scene.add(root)

  for (let i = 0; i < LOOK.flareCards; i++) {
    const material = new THREE.SpriteNodeMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const sprite = new THREE.Sprite(material)
    sprite.visible = false
    sprite.frustumCulled = false
    root.add(sprite)
    cards.push({ sprite, material, elapsed: 0, life: 0, size: 0, active: false })
  }

  /** One live flash: a leased light plus the card that draws it. */
  const live = []
  const color = new THREE.Color()
  const at = new THREE.Vector3()
  const aim = new THREE.Vector3()

  function takeCard() {
    let card = cards.find((c) => !c.active)
    if (!card) card = cards.reduce((a, b) => (a.elapsed >= b.elapsed ? a : b))
    return card
  }

  return {
    /**
     * @param {THREE.Vector3} position weapon mesh origin (falls back to the firing origin)
     * @param {THREE.Vector3} [direction] aim direction; cosmetic only, a point light is symmetric
     * @param {boolean} [suppressed] true iff the silencer mod is fitted
     */
    flash(position, direction, suppressed = false) {
      const cfg = suppressed ? M.suppressed : M.normal
      color.setHex(cfg.colorHex, THREE.SRGBColorSpace)

      // Forward component only: the FX layer has no weapon basis to resolve a right or
      // up offset against, and the original's value is (0,0,0) regardless — flash and
      // fire sound both sat at the weapon mesh origin because there was no muzzle socket.
      at.copy(position)
      const forwardOffset = M.offsetFromWeaponOrigin[0]
      if (direction && forwardOffset !== 0) {
        at.addScaledVector(aim.copy(direction).normalize(), forwardOffset)
      }

      const lease = lights.acquire()
      if (lease) {
        lease.light.position.copy(at)
        lease.light.color.copy(color)
        lease.light.distance = cfg.attenuationRadius
        lease.light.intensity = cfg.intensity * SCALE
      }

      const card = takeCard()
      if (card.active && card.lease) lights.release(card.lease)
      const size = M.sizeHalfExtent * 2 * (suppressed ? LOOK.suppressedSizeFraction : 1)
      card.sprite.position.copy(at)
      card.sprite.scale.set(size, size, 1)
      card.material.color.copy(color).multiplyScalar(LOOK.hdrGain)
      card.material.opacity = 1
      card.material.rotation = rng.range(0, Math.PI * 2) // no two shots stamp the same star
      card.sprite.visible = true
      card.elapsed = 0
      card.life = Math.max(cfg.fadeSeconds, FX.LIGHT_PULSE.minFadeSeconds)
      card.size = size
      card.peak = cfg.intensity * SCALE
      card.lease = lease
      card.active = true
      if (!live.includes(card)) live.push(card)
    },

    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const card = live[i]
        card.elapsed += dt
        // Linear fall from peak, no ramp — a muzzle flash is at full brightness on frame 1.
        const a = Math.max(0, 1 - card.elapsed / card.life)

        if (card.lease && card.lease.valid) card.lease.light.intensity = card.peak * a
        card.material.opacity = a
        const s = card.size * (LOOK.tailScale + (1 - LOOK.tailScale) * a)
        card.sprite.scale.set(s, s, 1)

        if (card.elapsed >= card.life) {
          if (card.lease) lights.release(card.lease)
          card.lease = null
          card.sprite.visible = false
          card.active = false
          live.splice(i, 1)
        }
      }
    },

    reset() {
      for (const card of live) {
        if (card.lease) lights.release(card.lease)
        card.lease = null
        card.sprite.visible = false
        card.active = false
      }
      live.length = 0
    },

    dispose() {
      this.reset()
      for (const card of cards) card.material.dispose()
      scene.remove(root)
    },
  }
}
