/**
 * Explosion — spec/fx-feel.md §3.4 and §3.5.
 *
 * Fires only when the Explosive mod resolves an area hit. Three things happen at
 * the same instant and the timing between them is what sells it:
 *
 *   - the light RAMPS UP first (0.0525 s) instead of starting at peak like a muzzle
 *     flash, then falls for 0.2975 s. That rise is the difference between a bang
 *     and a strobe.
 *   - the fireball sphere eases out from a 1 cm speck to a ball whose RADIUS EQUALS
 *     THE BLAST RADIUS, by construction: rules' meshScaleDivisor is also the
 *     reference sphere's radius in cm, so scale = radius/50 on a 50 cm-radius sphere
 *     lands exactly on the kill zone. The fireball is a truthful readout of what
 *     just died. Keep that relationship.
 *   - a one-shot radial impulse, linear falloff, applied on this frame only.
 *
 * The shockwave ring and the smoke are additions. The original had neither (§9 is
 * explicit that no smoke or dust exists anywhere), but a fireball that appears and
 * vanishes with nothing left behind reads as a decal, not a detonation. Both are
 * tied to spec durations so they cannot drift out of sync with the flash.
 */
import * as THREE from 'three/webgpu'
import { abs, color, dot, mix, normalView, positionViewDirection, pow, uniform } from 'three/tsl'
import { FX } from '../game/rules.js'
import { Rng } from '../core/rng.js'

const E = FX.EXPLOSION
const P = FX.LIGHT_PULSE
const SCALE = FX.LIGHT_INTENSITY_SCALE

/**
 * Appearance-only knobs for the shockwave and smoke, which have no counterpart in
 * the Unreal source and therefore no home in rules.js (another agent owns that
 * file, and it is the spec-as-data). Promote them to rules.FX.EXPLOSION if they
 * ever need tuning by a designer rather than by eye.
 */
const LOOK = Object.freeze({
  concurrent: 3, // three overlapping blasts is already a pathological frame
  shockwaveRadiusFactor: 1.55, // the pressure front outruns the fireball
  shockwaveLifeFraction: 0.62, // of flashFadeSeconds — the ring is gone before the light is
  shockwaveThickness: 0.14, // of its own current radius
  shockwaveTextureSize: 256,
  smokePuffs: 5,
  smokeRiseSpeed: 110, // cm/s
  smokeSpreadFraction: 0.5, // of blast radius
  smokeColorHex: 0x2b2420, // cordite grey, lit only by whatever the station throws at it
  smokeSizeMin: 0.5, // of blast radius
  smokeSizeMax: 1.0,
  smokeOpacity: 0.5,
  smokeDelayFraction: 0.28, // of smokeSeconds — smoke over a live fireball punches black holes in it
  smokeTextureSize: 128,
  // ACES drags a 1.0 white down to grey. Driving the fireball and shock front above
  // 1.0 is what keeps them clipped and over the bloom threshold in rules.FX.POST.
  hdrGain: 2.6,
  fireballCoreHex: 0xfff0c8, // the middle of a fireball is white-hot, the rim is deep orange
  fireballCorePower: 3.0, // how tightly the white core is confined to the centre
  fireballEdgePower: 2.0, // how fast the shell thins out toward the silhouette
})

let smokeTexture = null
let shockTexture = null

/**
 * The shock front is a camera-facing sprite, not a flat ring lying in the world.
 * A real ring is correct for a blast on the floor and looks like a flying saucer
 * from every other angle; a billboard halo reads as a pressure front from all of
 * them, which is the only thing this effect is for.
 */
function makeShockTexture() {
  if (shockTexture) return shockTexture
  if (typeof document === 'undefined') return null
  const size = LOOK.shockwaveTextureSize
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const c = size / 2
  const inner = 1 - LOOK.shockwaveThickness
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(Math.max(0, inner - 0.12), 'rgba(255,255,255,0)')
  g.addColorStop(inner, 'rgba(255,255,255,0.55)')
  g.addColorStop(inner + LOOK.shockwaveThickness * 0.45, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  shockTexture = new THREE.CanvasTexture(canvas)
  shockTexture.colorSpace = THREE.SRGBColorSpace
  return shockTexture
}

function makeSmokeTexture() {
  if (smokeTexture) return smokeTexture
  if (typeof document === 'undefined') {
    console.warn('[fx/explosions] no DOM: explosion smoke disabled, fireball only')
    return null
  }
  const size = LOOK.smokeTextureSize
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const c = size / 2
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  g.addColorStop(0, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.32)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  smokeTexture = new THREE.CanvasTexture(canvas)
  return smokeTexture
}

/**
 * The radial push from §3.5, as plain math so game code can apply it without
 * importing three. Returns the velocity CHANGE in cm/s — mass is ignored, this is
 * a velocity change, not a force — or null when the body is outside the blast.
 *
 * Applied exactly once, on the frame the explosion is created.
 */
export function explosionImpulse(bodyPos, blastPos, radius = E.blastRadius, strength = E.impulseStrength) {
  const dx = bodyPos.x - blastPos.x
  const dy = bodyPos.y - blastPos.y
  const dz = bodyPos.z - blastPos.z
  const d = Math.hypot(dx, dy, dz)
  if (d >= radius) return null
  if (d === 0) return { x: 0, y: strength, z: 0 } // dead centre: straight up beats a NaN
  const push = (strength * (1 - d / radius)) / d
  return { x: dx * push, y: dy * push, z: dz * push }
}

/**
 * @param {object} deps
 * @param {THREE.Object3D} deps.scene
 * @param {object} deps.lights light ring from fx/impacts.js createLightRing()
 */
export function createExplosionFX({ scene, lights, rng = new Rng() }) {
  if (!scene) throw new Error('[fx/explosions] needs a scene')
  if (!lights) throw new Error('[fx/explosions] needs a light ring (see createLightRing in fx/impacts.js)')

  const root = new THREE.Group()
  root.name = 'fx:explosions'
  scene.add(root)

  const smokeMap = makeSmokeTexture()

  // A 100 cm reference sphere: meshScaleDivisor IS its radius in cm, which is the
  // only reason scale = radius/50 lands the fireball on the blast radius.
  const sphereGeo = new THREE.SphereGeometry(E.meshScaleDivisor, 48, 32)
  const shockMap = makeShockTexture()

  const slots = []
  for (let i = 0; i < LOOK.concurrent; i++) {
    // A flat additive sphere reads as a matte orange ball, which is the single worst
    // thing this effect can look like. Fading the shell toward its own silhouette and
    // running white-hot in the middle is what turns it back into a fireball.
    const fireFade = uniform(E.fireballOpacity)
    const facing = abs(dot(normalView, positionViewDirection))
    const fireMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    fireMat.colorNode = mix(
      color(new THREE.Color().setHex(E.fireballColorHex, THREE.SRGBColorSpace)),
      color(new THREE.Color().setHex(LOOK.fireballCoreHex, THREE.SRGBColorSpace)),
      pow(facing, LOOK.fireballCorePower),
    ).mul(LOOK.hdrGain)
    fireMat.opacityNode = pow(facing, LOOK.fireballEdgePower).mul(fireFade)
    const fireball = new THREE.Mesh(sphereGeo, fireMat)
    fireball.visible = false
    fireball.frustumCulled = false

    const ringMat = new THREE.SpriteNodeMaterial({
      map: shockMap,
      color: new THREE.Color()
        .setHex(E.flashColorHex, THREE.SRGBColorSpace)
        .multiplyScalar(LOOK.hdrGain),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const shockwave = new THREE.Sprite(ringMat)
    shockwave.visible = false
    shockwave.frustumCulled = false

    const puffs = []
    for (let p = 0; p < LOOK.smokePuffs; p++) {
      const mat = new THREE.SpriteNodeMaterial({
        map: smokeMap,
        transparent: true,
        depthWrite: false,
        color: LOOK.smokeColorHex,
      })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      sprite.frustumCulled = false
      root.add(sprite)
      puffs.push({ sprite, mat, drift: new THREE.Vector3(), size: 0 })
    }

    root.add(fireball, shockwave)
    slots.push({ fireball, fireMat, fireFade, shockwave, ringMat, puffs, active: false, elapsed: 0, lease: null })
  }

  const live = []

  function takeSlot() {
    let slot = slots.find((s) => !s.active)
    if (!slot) slot = slots.reduce((a, b) => (a.elapsed >= b.elapsed ? a : b))
    if (slot.lease) lights.release(slot.lease)
    slot.lease = null
    return slot
  }

  return {
    /**
     * @param {THREE.Vector3} position impact point
     * @param {number} [radius] blast radius in cm; 350 with default tuning
     */
    explode(position, radius = E.blastRadius) {
      const slot = takeSlot()
      slot.active = true
      slot.elapsed = 0
      slot.radius = radius
      slot.origin = slot.origin || new THREE.Vector3()
      slot.origin.copy(position)

      slot.fireballScale = Math.max(radius / E.meshScaleDivisor, E.meshMinScale)
      slot.fireball.position.copy(position)
      slot.fireball.scale.setScalar(P.meshStartScale)
      slot.fireball.visible = true
      slot.fireFade.value = E.fireballOpacity

      slot.shockwave.position.copy(position)
      slot.shockwave.scale.setScalar(P.meshStartScale)
      slot.shockwave.material.rotation = rng.range(0, Math.PI * 2)
      slot.shockwave.visible = true
      slot.ringMat.opacity = 1

      for (const puff of slot.puffs) {
        puff.sprite.position.copy(position)
        puff.drift.set(
          rng.range(-1, 1) * radius * LOOK.smokeSpreadFraction,
          LOOK.smokeRiseSpeed,
          rng.range(-1, 1) * radius * LOOK.smokeSpreadFraction,
        )
        puff.size = radius * rng.range(LOOK.smokeSizeMin, LOOK.smokeSizeMax)
        puff.sprite.scale.setScalar(puff.size * P.meshStartScale)
        puff.mat.opacity = 0
        puff.mat.rotation = rng.range(0, Math.PI * 2)
        puff.sprite.visible = true
      }

      const lease = lights.acquire()
      if (lease) {
        lease.light.position.copy(position)
        lease.light.color.setHex(E.flashColorHex, THREE.SRGBColorSpace)
        lease.light.distance = Math.max(radius * E.radiusToAttenuationMultiplier, E.minAttenuationRadius)
        lease.light.intensity = 0 // it ramps; starting at peak would read as a muzzle flash
      }
      slot.lease = lease

      if (!live.includes(slot)) live.push(slot)
    },

    update(dt) {
      const life = Math.max(E.flashFadeSeconds, P.minFadeSeconds)
      const ring = life * LOOK.shockwaveLifeFraction

      for (let i = live.length - 1; i >= 0; i--) {
        const slot = live[i]
        slot.elapsed += dt
        const t = slot.elapsed

        // Brightness: linear rise across the ramp, then linear fall over the rest.
        let intensity
        if (E.flashRampSeconds > 0 && t < E.flashRampSeconds) {
          intensity = E.flashIntensity * (t / E.flashRampSeconds)
        } else {
          const a = Math.max(0, Math.min(1, 1 - (t - E.flashRampSeconds) / (life - E.flashRampSeconds)))
          intensity = E.flashIntensity * a
        }
        if (slot.lease && slot.lease.valid) slot.lease.light.intensity = intensity * SCALE

        // Fireball: ease-out quadratic from a 1 cm speck to the blast radius.
        const g = Math.min(1, t / life)
        const eased = 1 - (1 - g) * (1 - g)
        slot.fireball.scale.setScalar(P.meshStartScale + (slot.fireballScale - P.meshStartScale) * eased)
        slot.fireFade.value = E.fireballOpacity * (1 - g)

        // Shockwave: outruns the fireball and is gone before the light is.
        if (t < ring) {
          const rt = t / ring
          const r = slot.radius * LOOK.shockwaveRadiusFactor * (1 - (1 - rt) * (1 - rt))
          slot.shockwave.scale.setScalar(r * 2) // a sprite's scale is its full width, not a radius
          slot.ringMat.opacity = (1 - rt) * (1 - rt)
          slot.shockwave.visible = r > 0
        } else if (slot.shockwave.visible) {
          slot.shockwave.visible = false
        }

        // Smoke lingers past the flash, which is the only thing that leaves a beat behind.
        const st = Math.min(1, t / E.smokeSeconds)
        const sm = Math.max(0, (st - LOOK.smokeDelayFraction) / (1 - LOOK.smokeDelayFraction))
        for (const puff of slot.puffs) {
          puff.sprite.position.set(
            slot.origin.x + puff.drift.x * st,
            slot.origin.y + puff.drift.y * st,
            slot.origin.z + puff.drift.z * st,
          )
          puff.sprite.scale.setScalar(puff.size * (P.meshStartScale + st))
          // Rise in, then fall away, and only once the fireball is past its peak.
          puff.mat.opacity = Math.sin(Math.PI * sm) * LOOK.smokeOpacity
        }

        const done = t >= Math.max(life, E.smokeSeconds)
        if (done) {
          if (slot.lease) lights.release(slot.lease)
          slot.lease = null
          slot.fireball.visible = false
          slot.shockwave.visible = false
          for (const puff of slot.puffs) puff.sprite.visible = false
          slot.active = false
          live.splice(i, 1)
        } else if (t >= life && slot.fireball.visible) {
          slot.fireball.visible = false
        }
      }
    },

    reset() {
      for (const slot of slots) {
        if (slot.lease) lights.release(slot.lease)
        slot.lease = null
        slot.fireball.visible = false
        slot.shockwave.visible = false
        for (const puff of slot.puffs) puff.sprite.visible = false
        slot.active = false
        slot.elapsed = 0
      }
      live.length = 0
    },

    dispose() {
      this.reset()
      for (const slot of slots) {
        slot.fireMat.dispose()
        slot.ringMat.dispose()
        for (const puff of slot.puffs) puff.mat.dispose()
      }
      sphereGeo.dispose()
      scene.remove(root)
    },
  }
}
