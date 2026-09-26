/**
 * Impact bursts — spec/fx-feel.md §4 — plus the shared light ring and the FX facade.
 *
 * Every trace that hits anything at all spawns one of these: a cloud of tumbling
 * cube shards and a point light that is dark after 0.12 s. The shards are
 * hand-integrated against an INFINITE MATHEMATICAL PLANE through the impact point,
 * not against real geometry. That is not a shortcut to be fixed later — it is the
 * behaviour: a shard sprayed past the edge of a real wall is still stopped by the
 * invisible plane, and swapping in a physics query makes debris fall off ledges
 * instead of grinding along the surface, which reads completely differently.
 *
 * The bounce coefficients are worth decoding, because 1.35 and 0.6 look arbitrary.
 * A perfect mirror would use 2.0. With 1.35 and a 0.6 whole-vector damp the normal
 * component comes back at (1 - 1.35) * 0.6 = -0.21 of what went in, so debris takes
 * two or three low hops and then slides. Blood takes the other branch and stops
 * dead on first contact.
 *
 * Everything here is pooled. The original allocated fresh actors per hit with no
 * cap at all; a shotgun into a crowd is 8 bursts, 80 meshes and 8 lights in one
 * frame, and allocating that during a firefight stutters.
 *
 * ---------------------------------------------------------------------------
 * THE FACADE lives at the bottom of this file: `createFX({ scene, camera })`.
 * Gameplay calls fx.impact() / fx.shot() / fx.hit() and never reaches into the
 * individual fx modules. It is here rather than in an index.js because the light
 * ring it hands to every other module is defined here too.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three/webgpu'
import { FX, DAMAGE } from '../game/rules.js'
import { Rng } from '../core/rng.js'
import { createCameraShake } from './shake.js'
import { createMuzzleFX } from './muzzle.js'
import { createExplosionFX, explosionImpulse } from './explosions.js'
import { createDamageNumbers } from './damageNumbers.js'
import { createBloodFX } from './blood.js'

const I = FX.IMPACT
const BUDGET = FX.BUDGET
const SCALE = FX.LIGHT_INTENSITY_SCALE

/** The port is Y-up (see spec/player.md); the source's world +Z is our +Y. */
const UP = new THREE.Vector3(0, 1, 0)

/** All lights in this subsystem are inverse-square with a hard cutoff and cast nothing. */
const INVERSE_SQUARE = 2

const CONE_HALF_ANGLE = THREE.MathUtils.degToRad(I.coneHalfAngleDeg)

/**
 * Appearance and allocation knobs with no counterpart in the Unreal source. They
 * are not in rules.js because another agent owns that file and it holds the spec
 * as data — the original never distinguished concrete from metal at all, and had
 * no pooling of any kind. Promote them to rules.FX if a designer ever needs them.
 */
const LOOK = Object.freeze({
  muzzleLights: 2, // a 900 RPM burst overlaps its own 45 ms flash
  explosionLights: 2,
  bloodColorHex: 0x6e0c0c, // a gob in flight is darker than the light it throws
  bloodRoughness: 0.25,
  sparkColorHex: 0xffd39a,
  sparkHdrGain: 4.0, // ACES would otherwise turn a spark into a beige crumb
  dustColorHex: 0x9a958c,
  dustRoughness: 0.95,
  flashHdrGain: 1.15, // the spec's impact-light colours are dim as a sprite tint under ACES
  flashTextureSize: 64,
  puffTextureSize: 128,
  puffSizeFactor: 0.18, // of the impact light's radius
  puffGrowth: 2.8, // final size as a multiple of its start size
  puffOpacity: 0.38,
  puffStandoffFraction: 0.5, // of the puff's own size — dust hangs off the wall, not inside it
  flashSizeFactor: 0.12, // of the impact light's radius
  // The light source is the spark cloud standing off the surface, not a point buried
  // in the wall. Sitting it at the impact point makes inverse-square blow a flat white
  // disc across whatever was hit; holding it off gives the pool a falloff to read.
  lightStandoff: 0.35, // of the impact light's radius
  flashTailScale: 0.55, // a spark collapses as it dies; growing would read as a smoke puff
})

const SURFACES = Object.freeze({
  flesh: Object.freeze({ look: 'blood', bloody: true, puff: false }),
  concrete: Object.freeze({ look: 'dust', bloody: false, puff: true }),
  tile: Object.freeze({ look: 'dust', bloody: false, puff: true }),
  metal: Object.freeze({ look: 'spark', bloody: false, puff: false }),
  glass: Object.freeze({ look: 'spark', bloody: false, puff: false }),
})
const DEFAULT_SURFACE = 'concrete'

// ---------------------------------------------------------------------------
// Shared light ring
// ---------------------------------------------------------------------------

/**
 * A fixed ring of point lights handed out on lease. Most WebGL backends choke
 * well before the dozens of simultaneous lights this design implies, so when the
 * ring is empty the oldest lease is STOLEN and invalidated — its previous owner
 * sees `lease.valid === false` and stops writing to it. Effects that lose their
 * light still draw their billboard, so a hit is never invisible, only unlit.
 */
export function createLightRing({ scene, size }) {
  const slots = []
  for (let i = 0; i < size; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 1, INVERSE_SQUARE)
    light.castShadow = false
    // Stays visible for the life of the ring. A light's `visible` flag is part of the
    // program key every material in the scene is compiled against, so blinking one off
    // recompiles ALL of them against the station's hundred-odd lights. An automatic
    // weapon leases and releases a slot twice a round, which on the WebGL2 backend
    // meant a full recompile storm: the firefight frame stopped producing frames at
    // all and a 120-second screenshot timed out. An idle slot is silenced with
    // intensity 0 instead, which costs one dead uniform and never touches a shader.
    scene.add(light)
    slots.push({ light, lease: null, stamp: 0 })
  }
  let clock = 0

  return {
    size,

    acquire() {
      clock += 1
      let slot = slots.find((s) => s.lease === null)
      if (!slot) {
        slot = slots.reduce((a, b) => (a.stamp <= b.stamp ? a : b))
        slot.lease.valid = false
      }
      slot.stamp = clock
      slot.light.intensity = 0
      slot.lease = { light: slot.light, valid: true, slot }
      return slot.lease
    },

    release(lease) {
      if (!lease) return
      const slot = lease.slot
      lease.valid = false
      if (slot && slot.lease === lease) {
        slot.lease = null
        slot.light.intensity = 0
      }
    },

    reset() {
      for (const slot of slots) {
        if (slot.lease) slot.lease.valid = false
        slot.lease = null
        slot.light.intensity = 0
      }
    },

    dispose() {
      this.reset()
      for (const slot of slots) scene.remove(slot.light)
      slots.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

let flashTexture = null
let puffTexture = null
let texturesTried = false

function makeRadialTexture(size, stops) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const c = size / 2
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  for (const [at, color] of stops) g.addColorStop(at, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function impactTextures() {
  if (!texturesTried) {
    texturesTried = true
    flashTexture = makeRadialTexture(LOOK.flashTextureSize, [
      [0, 'rgba(255,255,255,1)'],
      [0.12, 'rgba(255,245,215,0.75)'],
      [0.32, 'rgba(255,215,150,0.22)'],
      [1, 'rgba(255,170,90,0)'],
    ])
    puffTexture = makeRadialTexture(LOOK.puffTextureSize, [
      [0, 'rgba(255,255,255,0.7)'],
      [0.45, 'rgba(255,255,255,0.25)'],
      [1, 'rgba(255,255,255,0)'],
    ])
    if (!flashTexture) console.warn('[fx/impacts] no DOM: impact flash and dust puff disabled, shards only')
  }
  return { flashTexture, puffTexture }
}

// ---------------------------------------------------------------------------
// randCone — spec §0, quirks included
// ---------------------------------------------------------------------------

const _axis = new THREE.Vector3()
const _side = new THREE.Vector3()

/**
 * Random unit vector inside a cone around `dir`. `phi` is taken MODULO the half
 * angle rather than clamped, which is not a uniform cone distribution: it wraps
 * and biases the spray. That bias is what the burst looks like, so the fmod stays.
 */
export function randCone(out, dir, halfAngleRad, rng) {
  _axis.copy(dir).normalize()
  if (halfAngleRad <= 0) return out.copy(_axis)

  const theta = 2 * Math.PI * rng.next()
  const phi = Math.acos(2 * rng.next() - 1) % halfAngleRad

  _side.copy(UP).cross(_axis)
  if (_side.lengthSq() < 1e-8) _side.set(0, 0, 1) // dir is parallel to up: any perpendicular will do
  _side.normalize()

  out.copy(_axis).applyAxisAngle(_side, phi).applyAxisAngle(_axis, theta)
  return out.normalize()
}

// ---------------------------------------------------------------------------
// Impact bursts
// ---------------------------------------------------------------------------

function createShardPool({ scene, geometry, material, capacity, name }) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  // Named so a probe can select one pool outright. Selecting it by sniffing the material
  // instead (`roughness < 0.3` picks blood today) breaks the moment the material changes,
  // and a gate that silently starts grading the wrong mesh is worse than no gate.
  if (name) mesh.name = name
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false // one burst can be anywhere; culling the whole batch would pop
  mesh.count = 0 // nothing live yet — see `liveCount` below
  scene.add(mesh)

  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  const free = []
  for (let i = capacity - 1; i >= 0; i--) {
    free.push(i)
    mesh.setMatrixAt(i, hidden)
  }
  mesh.instanceMatrix.needsUpdate = true
  let dirty = false

  // InstancedMesh draws instances [0, count), so shrinking count below a still-active
  // index would stop drawing that shard outright — hidden shards are scaled to 0, not
  // excluded from the draw. `take()` only ever grows the water mark to cover every
  // index it has handed out; it only resets to 0 once the pool is fully drained, which
  // is always safe because nothing is left to cut off. That is enough to fix the actual
  // cost here: this pool submitted its full capacity's worth of vertices every frame
  // even when nothing was live, which is real GPU work on an otherwise idle scene.
  let liveCount = 0

  const api = {
    mesh,
    material,
    take() {
      if (!free.length) return -1
      const index = free.pop()
      if (index + 1 > liveCount) liveCount = index + 1
      return index
    },
    release(index) {
      if (index < 0) return
      mesh.setMatrixAt(index, hidden)
      free.push(index)
      dirty = true
      if (free.length === capacity) liveCount = 0
    },
    write(index, matrix) {
      mesh.setMatrixAt(index, matrix)
      dirty = true
    },
    flush() {
      if (mesh.count !== liveCount) mesh.count = liveCount
      if (!dirty) return
      mesh.instanceMatrix.needsUpdate = true
      dirty = false
    },
    reset() {
      free.length = 0
      for (let i = capacity - 1; i >= 0; i--) {
        free.push(i)
        mesh.setMatrixAt(i, hidden)
      }
      liveCount = 0
      mesh.count = 0
      mesh.instanceMatrix.needsUpdate = true
      dirty = false
    },
    dispose() { scene.remove(mesh); material.dispose() },
  }

  // Reachable from a probe that can only select the MESH (by name, from the scene graph) and
  // has no way to see this closure. verify/frame.mjs stages nine gobs for the silhouette gate
  // and needs to reserve real slots rather than write matrices behind the pool's back: before
  // this, it wrote matrices directly and rendered only because the pool submitted its whole
  // capacity every frame regardless. When that waste was fixed the gate went blank, because a
  // matrix written into an unreserved slot is outside [0, count) and is never drawn.
  mesh.userData.pool = api
  return api
}

export function createImpactFX({ scene, lights, rng = new Rng() }) {
  if (!scene) throw new Error('[fx/impacts] needs a scene')
  if (!lights) throw new Error('[fx/impacts] needs a light ring')

  const root = new THREE.Group()
  root.name = 'fx:impacts'
  scene.add(root)

  // A 100 cm reference cube: shard scales of 0.015-0.035 are multipliers against it,
  // giving the 1.5-3.5 cm chips the spec describes.
  const cubeGeo = new THREE.BoxGeometry(I.referenceCubeSize, I.referenceCubeSize, I.referenceCubeSize)

  // Blood does not chip, it BEADS. A box gives every gob the same four countable corners,
  // which reads as brick rubble rather than fluid; verify/pixels.mjs measures the
  // silhouette and has the before/after numbers. Spark and dust keep the cube on purpose —
  // those are concrete and metal chips and a hard edge is right for them.
  const bloodGeo = new THREE.SphereGeometry(
    I.referenceCubeSize / 2, I.bloodSegmentsWidth, I.bloodSegmentsHeight,
  )

  // A per-instance colour jitter was tried here and REMOVED after measurement. Written at
  // spawn — which is after the pool's first draw — it never reached the shader: the frame
  // came back BYTE-IDENTICAL to no jitter at all, twice, the second time with explicit
  // updateRanges on the buffer. It was not needed either. Nine gobs holding rotation and
  // stretch constant, with no jitter, already span mean red 11.4 to 40.8 across the grid,
  // purely from which way each one faces the lights. Do not re-add it on the theory that
  // the gobs are otherwise one flat hex; they measurably are not.

  const pools = {
    blood: createShardPool({
      scene: root,
      name: 'fx:shards:blood',
      geometry: bloodGeo,
      capacity: BUDGET.maxShardsTotal,
      material: new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color().setHex(LOOK.bloodColorHex, THREE.SRGBColorSpace),
        roughness: LOOK.bloodRoughness,
        metalness: 0,
      }),
    }),
    spark: createShardPool({
      scene: root,
      name: 'fx:shards:spark',
      geometry: cubeGeo,
      capacity: BUDGET.maxShardsTotal,
      material: new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color().setHex(LOOK.sparkColorHex, THREE.SRGBColorSpace).multiplyScalar(LOOK.sparkHdrGain),
      }),
    }),
    dust: createShardPool({
      scene: root,
      name: 'fx:shards:dust',
      geometry: cubeGeo,
      capacity: BUDGET.maxShardsTotal,
      material: new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color().setHex(LOOK.dustColorHex, THREE.SRGBColorSpace),
        roughness: LOOK.dustRoughness,
        metalness: 0,
      }),
    }),
  }

  const { flashTexture: flashMap, puffTexture: puffMap } = impactTextures()

  const billboards = []
  for (let i = 0; i < BUDGET.maxImpactBursts; i++) {
    const flashMat = new THREE.SpriteNodeMaterial({
      map: flashMap,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const flash = new THREE.Sprite(flashMat)
    flash.visible = false
    flash.frustumCulled = false

    const puffMat = new THREE.SpriteNodeMaterial({
      map: puffMap,
      transparent: true,
      depthWrite: false,
      color: new THREE.Color().setHex(LOOK.dustColorHex, THREE.SRGBColorSpace),
    })
    const puff = new THREE.Sprite(puffMat)
    puff.visible = false
    puff.frustumCulled = false

    root.add(flash, puff)
    billboards.push({ flash, flashMat, puff, puffMat })
  }

  const bursts = []
  let liveShards = 0

  const _dir = new THREE.Vector3()
  const _next = new THREE.Vector3()
  const _matrix = new THREE.Matrix4()
  const _quat = new THREE.Quaternion()
  const _euler = new THREE.Euler()
  const _scale = new THREE.Vector3()
  // Chips are cubes on purpose and never stretch, so they all share one Vector3 instead
  // of each carrying an allocation that is always (1, 1, 1). Object.freeze is what makes
  // it actually shareable: `const` only fixes the binding, not the object, so a caller
  // that called a mutating method on it would silently corrupt every chip's stretch at
  // once. Nothing here does — the write loop below only reads `.x`/`.y`/`.z` off it, and
  // three.js tolerates that fine on a frozen Vector3 (verified: reads work, `.set()`
  // throws instead of silently no-op'ing) — but freezing turns a future mistake into an
  // immediate crash instead of quiet corruption.
  const UNIT_STRETCH = Object.freeze(new THREE.Vector3(1, 1, 1))
  const _color = new THREE.Color()
  // One randomized stretch vector per blood pool slot, indexed by the same `index` the
  // pool hands out. Reused via `.set()` on every new bloody shard instead of allocating
  // `new THREE.Vector3()` per shard — this file's own header above warns that allocating
  // per-hit is what made the original stutter during a firefight, and a shotgun blast of
  // headshots was doing exactly that here.
  const bloodStretch = Array.from({ length: BUDGET.maxShardsTotal }, () => new THREE.Vector3())

  function recycleBurst(burst) {
    for (const shard of burst.shards) burst.pool.release(shard.index)
    burst.shards.length = 0
    liveShards -= burst.shardCount
    if (liveShards < 0) liveShards = 0
    if (burst.lease) lights.release(burst.lease)
    burst.lease = null
    burst.billboard.flash.visible = false
    burst.billboard.puff.visible = false
    burst.free = true
  }

  function takeBurst() {
    const free = bursts.find((b) => b.free)
    if (free) return free
    if (bursts.length < BUDGET.maxImpactBursts) {
      const burst = { free: true, shards: [], billboard: billboards[bursts.length], index: bursts.length }
      bursts.push(burst)
      return burst
    }
    // Ring is full: the oldest burst is the least interesting thing on screen.
    const oldest = bursts.reduce((a, b) => (a.elapsed >= b.elapsed ? a : b))
    recycleBurst(oldest)
    return oldest
  }

  return {
    /**
     * @param {THREE.Vector3} point impact point
     * @param {THREE.Vector3} normal surface normal
     * @param {object} [opts]
     * @param {boolean} [opts.bloody] the thing hit has health
     * @param {boolean} [opts.headshot] hit zone is HEAD
     * @param {string} [opts.surface] 'flesh' | 'concrete' | 'tile' | 'metal' | 'glass'
     */
    burst(point, normal, { bloody = false, headshot = false, surface = DEFAULT_SURFACE } = {}) {
      const look = SURFACES[surface] ?? SURFACES[DEFAULT_SURFACE]
      const isBloody = bloody || look.bloody
      const pool = isBloody ? pools.blood : (pools[look.look] ?? pools.dust)

      // Headshot wins the count test outright, but still takes the bloody branch for
      // speed, scale and gravity — a head zone only ever comes off a body.
      const wanted = headshot ? I.shardCountHeadshot : isBloody ? I.shardCountBloody : I.shardCountHardSurface

      // takeBurst() must run BEFORE the shard budget is clamped below: when the burst
      // ring is full it evicts the oldest burst, releasing that burst's shards back to
      // the pool and reducing `liveShards`. Clamping against the pre-eviction value
      // would lock this impact to zero shards even though the eviction just freed the
      // room for it — a hit into a saturated crowd would land with no visible shards
      // at all, a real impact with no hit confirmation.
      const burst = takeBurst()
      const count = Math.max(0, Math.min(wanted, BUDGET.maxShardsTotal - liveShards))

      const speedMin = isBloody ? I.bloodSpeedMin : I.debrisSpeedMin
      const speedMax = isBloody ? I.bloodSpeedMax : I.debrisSpeedMax
      const scaleMin = isBloody ? I.bloodScaleMin : I.debrisScaleMin
      const scaleMax = isBloody ? I.bloodScaleMax : I.debrisScaleMax

      burst.free = false
      burst.elapsed = 0
      burst.pool = pool
      burst.bloody = isBloody
      burst.gravityScale = isBloody ? I.bloodGravityScale : I.debrisGravityScale
      burst.point = (burst.point || new THREE.Vector3()).copy(point)
      burst.normal = (burst.normal || new THREE.Vector3()).copy(normal).normalize()
      burst.shardCount = 0

      for (let i = 0; i < count; i++) {
        const index = pool.take()
        if (index < 0) break
        randCone(_dir, burst.normal, CONE_HALF_ANGLE, rng)
        burst.shards.push({
          index,
          position: point.clone(), // every shard starts at the same point
          velocity: _dir.clone().multiplyScalar(rng.range(speedMin, speedMax)),
          rotation: new THREE.Euler(rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2)),
          spin: new THREE.Vector3(
            THREE.MathUtils.degToRad(rng.range(I.spinMin, I.spinMax)),
            THREE.MathUtils.degToRad(rng.range(I.spinMin, I.spinMax)),
            THREE.MathUtils.degToRad(rng.range(I.spinMin, I.spinMax)),
          ),
          // A raw multiplier against the 100 cm reference cube the geometry already is,
          // so 0.015-0.035 lands on 1.5-3.5 cm chips. Do not scale by the reference size
          // again here — the geometry is the reference size.
          scale: rng.range(scaleMin, scaleMax),
          // An ellipsoid silhouette is an ellipse: still no corner anywhere on it, but no
          // two gobs the same. Applied inside the tumble, so the long axis rolls with the
          // shard instead of pointing a fixed way in world space.
          stretch: isBloody
            ? bloodStretch[index].set(
              rng.range(I.bloodStretchMin, I.bloodStretchMax),
              rng.range(I.bloodStretchMin, I.bloodStretchMax),
              rng.range(I.bloodStretchMin, I.bloodStretchMax),
            )
            : UNIT_STRETCH,
          settled: false,
        })
        burst.shardCount += 1
      }
      liveShards += burst.shardCount

      // Colour keys on bloody, radius keys on headshot — two independent tests, so a
      // headshot gets deep red AND the wide 260 cm reach.
      const intensity = headshot
        ? I.lightIntensityHeadshot
        : isBloody
          ? I.lightIntensityFlesh
          : I.lightIntensityHardSurface
      const radius = headshot ? I.lightRadiusHeadshot : I.lightRadiusDefault
      _color.setRGB(...(isBloody ? I.lightColorBloodLinear : I.lightColorHardLinear), THREE.LinearSRGBColorSpace)

      burst.peak = intensity * SCALE
      burst.lease = lights.acquire()
      if (burst.lease) {
        burst.lease.light.position.copy(point).addScaledVector(burst.normal, radius * LOOK.lightStandoff)
        burst.lease.light.color.copy(_color)
        burst.lease.light.distance = radius
        burst.lease.light.intensity = burst.peak
      }

      // The billboard draws whether or not a real light was free, so a hit in a busy
      // frame is unlit rather than invisible.
      const flashSize = radius * LOOK.flashSizeFactor
      burst.billboard.flash.position.copy(point)
      burst.billboard.flash.scale.setScalar(flashSize)
      burst.billboard.flashMat.color.copy(_color).multiplyScalar(LOOK.flashHdrGain)
      burst.billboard.flashMat.opacity = 1
      burst.billboard.flash.visible = true
      burst.flashSize = flashSize

      if (look.puff) {
        const size = radius * LOOK.puffSizeFactor
        burst.puffSize = size
        burst.billboard.puff.position.copy(point).addScaledVector(burst.normal, size * LOOK.puffStandoffFraction)
        burst.billboard.puff.scale.setScalar(size)
        burst.billboard.puffMat.opacity = LOOK.puffOpacity
        burst.billboard.puffMat.rotation = rng.range(0, Math.PI * 2)
        burst.billboard.puff.visible = true
      } else {
        burst.billboard.puff.visible = false
        burst.puffSize = 0
      }
    },

    update(dt) {
      for (const burst of bursts) {
        if (burst.free) continue
        burst.elapsed += dt

        if (burst.elapsed >= I.lifeSeconds) {
          recycleBurst(burst)
          continue
        }

        const gravity = I.gravityZ * burst.gravityScale
        // Shards are given a tail fade the original did not have; it popped them out
        // of existence mid-air, which reads as a rendering glitch rather than an effect.
        const remaining = I.lifeSeconds - burst.elapsed
        const fade = remaining < I.shardFadeSeconds ? remaining / I.shardFadeSeconds : 1

        for (const shard of burst.shards) {
          if (!shard.settled) {
            shard.velocity.y += gravity * dt // source gravity is on +Z; this port is Y-up
            _next.copy(shard.position).addScaledVector(shard.velocity, dt)

            // Half-space test against an INFINITE plane through the impact point. Not a
            // collision query: that is 10x slower and makes debris fall off ledges.
            const distAlongNormal = _next.sub(burst.point).dot(burst.normal)
            _next.add(burst.point)
            if (distAlongNormal < 0) {
              _next.addScaledVector(burst.normal, -distAlongNormal)
              if (burst.bloody) {
                shard.velocity.set(0, 0, 0)
                shard.settled = true // blood splats and never moves again
              } else {
                const vn = shard.velocity.dot(burst.normal)
                if (vn < 0) {
                  shard.velocity.addScaledVector(burst.normal, -I.bounceReflectFactor * vn)
                  shard.velocity.multiplyScalar(I.bounceDamping)
                }
              }
            }
            shard.position.copy(_next)

            shard.rotation.x += shard.spin.x * dt
            shard.rotation.y += shard.spin.y * dt
            shard.rotation.z += shard.spin.z * dt
          }

          _euler.set(shard.rotation.x, shard.rotation.y, shard.rotation.z)
          _quat.setFromEuler(_euler)
          const size = shard.scale * fade
          _scale.set(shard.stretch.x * size, shard.stretch.y * size, shard.stretch.z * size)
          _matrix.compose(shard.position, _quat, _scale)
          burst.pool.write(shard.index, _matrix)
        }

        const lightAlpha = Math.max(0, 1 - burst.elapsed / I.lightFadeSeconds)
        if (burst.lease && burst.lease.valid) {
          burst.lease.light.intensity = burst.peak * lightAlpha
          if (lightAlpha === 0 && I.disableLightAfterFade) {
            lights.release(burst.lease)
            burst.lease = null
          }
        }

        if (burst.billboard.flash.visible) {
          burst.billboard.flashMat.opacity = lightAlpha
          burst.billboard.flash.scale.setScalar(burst.flashSize * (LOOK.flashTailScale + (1 - LOOK.flashTailScale) * lightAlpha))
          if (lightAlpha === 0) burst.billboard.flash.visible = false
        }

        if (burst.billboard.puff.visible) {
          const pt = Math.min(1, burst.elapsed / I.shardFadeSeconds)
          burst.billboard.puff.scale.setScalar(burst.puffSize * (1 + (LOOK.puffGrowth - 1) * pt))
          burst.billboard.puffMat.opacity = LOOK.puffOpacity * (1 - pt)
          if (pt >= 1) burst.billboard.puff.visible = false
        }
      }

      for (const key of Object.keys(pools)) pools[key].flush()
    },

    get burstCount() { return bursts.reduce((n, b) => n + (b.free ? 0 : 1), 0) },
    get shardCount() { return liveShards },

    reset() {
      for (const burst of bursts) if (!burst.free) recycleBurst(burst)
      for (const key of Object.keys(pools)) pools[key].reset()
      liveShards = 0
    },

    dispose() {
      this.reset()
      for (const key of Object.keys(pools)) pools[key].dispose()
      for (const b of billboards) { b.flashMat.dispose(); b.puffMat.dispose() }
      cubeGeo.dispose()
      bloodGeo.dispose()
      scene.remove(root)
    },
  }
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

/**
 * The single surface gameplay talks to.
 *
 * ```js
 * const fx = createFX({ scene, camera })
 * fx.shot(muzzlePos, aimDir, suppressed)          // once per trigger pull
 * fx.hit(point, normal, { damage, zone, bloody }) // once per pellet that connects
 * fx.update(renderDelta)                          // once per RENDERED frame
 * fx.applyShake(camera); renderer.render(); fx.releaseShake(camera)
 * ```
 *
 * `update` takes the RENDER delta, not the fixed simulation step: the camera shake
 * is per-frame white noise by design, and every other effect here is wall-clock
 * timed rather than stepped.
 *
 * The RNG defaults to its own Rng instance rather than the shared `rng` singleton.
 * FX draws thousands of numbers per firefight, and pulling them from the gameplay
 * stream would make a rendered run diverge from the headless soak that replays the
 * same seed.
 */
export function createFX({ scene, camera, rng = new Rng(), container = null } = {}) {
  if (!scene) throw new Error('[fx] createFX needs a scene')
  if (!camera) throw new Error('[fx] createFX needs a camera')

  const impactLightCount = Math.max(1, BUDGET.maxDynamicLights - LOOK.muzzleLights - LOOK.explosionLights)
  const muzzleLights = createLightRing({ scene, size: LOOK.muzzleLights })
  const explosionLights = createLightRing({ scene, size: LOOK.explosionLights })
  const impactLights = createLightRing({ scene, size: impactLightCount })

  const shakes = createCameraShake({ rng })
  const muzzle = createMuzzleFX({ scene, lights: muzzleLights, rng })
  const explosions = createExplosionFX({ scene, lights: explosionLights, rng })
  const impacts = createImpactFX({ scene, lights: impactLights, rng })
  const bloodFX = createBloodFX({ scene, rng })
  const numbers = createDamageNumbers({ camera, container })

  const cullSq = BUDGET.cullEffectsBeyond * BUDGET.cullEffectsBeyond

  /**
   * Debris and gore far down the tunnel are never read, so they are skipped under
   * load. Damage numbers, muzzle flash and explosions are NEVER culled: the number
   * is the game's only hit confirmation, and a flash the player cannot see is a
   * shot they think did not fire.
   */
  const tooFar = (point) => camera.position.distanceToSquared(point) > cullSq

  const fx = {
    shakes, muzzle, explosions, impacts, blood: bloodFX, numbers,

    /** Every trigger pull: the flash and the per-shot shake, once per shot, not per pellet. */
    shot(position, direction, suppressed = false) {
      muzzle.flash(position, direction, suppressed)
      shakes.add(suppressed ? FX.SHAKE.scaleSuppressedShot : FX.SHAKE.scaleNormalShot)
    },

    /** @param {number} [scale] 1.0 shot, 0.4 suppressed, 1.5 explosion. Shakes STACK. */
    shake(scale) { shakes.add(scale) },

    /**
     * Every trace that hits anything at all.
     * @param {THREE.Vector3} point
     * @param {THREE.Vector3} normal
     * @param {string|object} [surface] surface name, or { surface, zone, bloody }
     */
    impact(point, normal, surface = DEFAULT_SURFACE) {
      const opts = typeof surface === 'string' ? { surface } : (surface ?? {})
      const zone = opts.zone ?? DAMAGE.zones.body
      const name = opts.surface ?? DEFAULT_SURFACE
      const bloody = opts.bloody ?? SURFACES[name]?.bloody ?? false
      if (tooFar(point)) return
      impacts.burst(point, normal, { bloody, headshot: zone === DAMAGE.zones.head, surface: name })
    },

    /** Flesh only: the decal and the mist off it. One per connecting pellet. */
    bloodHit(point, normal) {
      if (tooFar(point)) return
      bloodFX.decal(point, normal)
      bloodFX.spray(point, normal)
    },

    /** @param {string} [zone] 'head' | 'chest' | 'body' | 'burn' */
    damageNumber(point, damage, zone) { numbers.spawn(point, damage, zone) },

    /** Fireball, flash, shockwave, smoke and the 1.5 shake that stacks on the shot's own. */
    explosion(point, radius = FX.EXPLOSION.blastRadius) {
      explosions.explode(point, radius)
      shakes.add(FX.SHAKE.scaleExplosion)
    },

    /** The §3.5 radial push, as a velocity change in cm/s, or null outside the blast. */
    impulseAt: explosionImpulse,

    /**
     * One connecting pellet, in the exact order the original's firing code ran it:
     * hit marker, blood decal, impact burst, then explosion plus its shake.
     */
    hit(point, normal, { damage = 0, zone = DAMAGE.zones.body, bloody = false, surface, explosive = false, radius } = {}) {
      if (bloody) {
        fx.damageNumber(point, damage, zone)
        fx.bloodHit(point, normal)
      }
      fx.impact(point, normal, { surface: surface ?? (bloody ? 'flesh' : DEFAULT_SURFACE), zone, bloody })
      if (explosive) fx.explosion(point, radius)
    },

    /** Call once per RENDERED frame with the render delta. */
    update(dt) {
      shakes.update(dt)
      muzzle.update(dt)
      explosions.update(dt)
      impacts.update(dt)
      bloodFX.update(dt)
      numbers.update(dt)
    },

    applyShake(cam = camera) { shakes.apply(cam) },
    releaseShake(cam = camera) { shakes.revert(cam) },

    reset() {
      shakes.reset()
      muzzle.reset()
      explosions.reset()
      impacts.reset()
      bloodFX.reset()
      numbers.reset()
      muzzleLights.reset()
      explosionLights.reset()
      impactLights.reset()
    },

    dispose() {
      muzzle.dispose()
      explosions.dispose()
      impacts.dispose()
      bloodFX.dispose()
      numbers.dispose()
      muzzleLights.dispose()
      explosionLights.dispose()
      impactLights.dispose()
    },
  }

  return fx
}
