/**
 * projectile.js — the Spitter's bile round.
 *
 * Simulation is spec/zombies.md §4.3 verbatim: a 10 cm sphere at a constant 1800 cm/s with
 * gravityScale 0, a 6 s life (10 800 cm of travel), overlap-only collision that responds to
 * PAWNS ONLY. It passes straight through walls, columns and the train because the original's
 * collision profile ignored world geometry entirely — that is not a port shortcut, it is the
 * behaviour. It is consumed by the first pawn it touches that owns a health pool, including a
 * friendly zombie: the only exemption is the shooter itself.
 *
 * The original spawned no mesh, sprite, particle or trail for it, which meant the Spitter's
 * only attack was completely invisible. Everything visual below is marked CHOSEN in
 * rules.js (ZOMBIES.PROJECTILE.colorHex / emissiveIntensity / trailLength).
 *
 * Coordinate convention: Z is up, 1 unit = 1 cm, matching rules.js and the rest of the port.
 */

import * as THREE from 'three/webgpu'
import { ZOMBIES, UNITS, FX, WAVES } from '../game/rules.js'

const P = ZOMBIES.PROJECTILE

/**
 * Appearance only. The original spawned no mesh, sprite, particle or trail for the spit, so
 * there is nothing in rules.js to diff these against beyond colorHex / emissiveIntensity /
 * trailLength, which are already marked CHOSEN there. Everything here is a multiple of one of
 * those or of the 10 cm collision radius, so a designer retunes the spit from rules.js alone.
 */
const LOOK = Object.freeze({
  coreRoughness: 0.35,
  haloRadiusFactor: 2.6,
  haloOpacity: 0.32,
  trailRadiusFactor: 1.9,
  trailOpacity: 0.2,
  /** Fraction of an unsuppressed muzzle flash. A spit is a glowing gob, not a gunshot. */
  lightFractionOfMuzzle: 0.05,
  /** Share of FX.BUDGET.maxDynamicLights to take, leaving the rest for flash and impacts. */
  lightShareOfBudget: 0.25,
})

/** Local +Z is the direction of travel for both the core sphere and the trail cone. */
const FORWARD = new THREE.Vector3(0, 0, 1)

/** Scratch objects, module-scoped so a hundred rounds a second allocate nothing. */
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _step = new THREE.Vector3()
const _stepEnd = new THREE.Vector3()
const _axisA = new THREE.Vector3()
const _axisB = new THREE.Vector3()
const _d1 = new THREE.Vector3()
const _d2 = new THREE.Vector3()
const _r = new THREE.Vector3()
const _c1 = new THREE.Vector3()
const _c2 = new THREE.Vector3()

/**
 * Squared distance between segment (p1,q1) and segment (p2,q2).
 * Ericson, Real-Time Collision Detection §5.1.9. Used instead of a point test because a
 * 1800 cm/s round covers 30 cm per fixed step and a thin pawn could otherwise be tunnelled.
 */
function segmentDistanceSq(p1, q1, p2, q2) {
  _d1.subVectors(q1, p1)
  _d2.subVectors(q2, p2)
  _r.subVectors(p1, p2)
  const a = _d1.dot(_d1)
  const e = _d2.dot(_d2)
  const f = _d2.dot(_r)
  let s = 0
  let t = 0
  const EPS = 1e-8

  if (a <= EPS && e <= EPS) return _r.lengthSq()

  if (a <= EPS) {
    t = THREE.MathUtils.clamp(f / e, 0, 1)
  } else {
    const c = _d1.dot(_r)
    if (e <= EPS) {
      s = THREE.MathUtils.clamp(-c / a, 0, 1)
    } else {
      const b = _d1.dot(_d2)
      const denom = a * e - b * b
      s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0
      t = (b * s + f) / e
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1) }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1) }
    }
  }

  _c1.copy(p1).addScaledVector(_d1, s)
  _c2.copy(p2).addScaledVector(_d2, t)
  return _c1.distanceToSquared(_c2)
}

/**
 * One in-flight bile round. Plain simulation state — the pool owns every mesh, so a
 * projectile is cheap enough to allocate and keep forever.
 */
export class Projectile {
  constructor() {
    this.position = new THREE.Vector3()
    this.previous = new THREE.Vector3()
    this.velocity = new THREE.Vector3()
    this.damage = P.damage
    this.owner = null
    this.age = 0
    this.alive = false
    /** Set by the pool; the pool is what knows whether a struck pawn is the player. */
    this.onHit = null
  }

  /** @param {{position:THREE.Vector3, direction:THREE.Vector3, damage?:number, owner?:object}} opts */
  launch({ position, direction, damage = P.damage, owner = null }) {
    this.position.copy(position)
    this.previous.copy(position)
    this.velocity.copy(direction).normalize().multiplyScalar(P.speed)
    this.damage = damage
    this.owner = owner
    this.age = 0
    this.alive = true
  }

  /**
   * @param {number} dt
   * @param {Array<{position:THREE.Vector3, radius:number, halfHeight:number, health?:object, isDead?:boolean}>} pawns
   * @returns {boolean} still alive
   */
  advance(dt, pawns) {
    if (!this.alive) return false

    this.age += dt
    if (this.age >= P.lifeSpan) {
      this.alive = false
      return false
    }

    // gravityScale is 0 in the source, but honouring the rule rather than assuming it means a
    // designer can give the spit an arc from rules.js alone.
    this.velocity.z += UNITS.gravityZ * P.gravityScale * dt

    this.previous.copy(this.position)
    this.position.addScaledVector(this.velocity, dt)

    // No world-geometry test and no bounce test exist on purpose: P.bounces is false and the
    // collision profile ignores everything that is not a pawn, so there is nothing to hit.
    for (let i = 0; i < pawns.length; i++) {
      const pawn = pawns[i]
      if (!pawn || pawn === this.owner || pawn.isDead) continue
      if (!this._touches(pawn)) continue

      // §4.3: a pawn without a health pool does not stop the round, it keeps flying.
      if (!pawn.health) continue

      const dealt = pawn.health.applyDamage(this.damage, false, this.owner)
      this.onHit?.(pawn, dealt, this.owner)
      this.alive = false
      return false
    }

    return true
  }

  _touches(pawn) {
    const r = pawn.radius
    const hh = pawn.halfHeight
    // A capsule's axis is the segment between its two cap centres, not its full height.
    const spine = Math.max(0, hh - r)
    _axisA.set(pawn.position.x, pawn.position.y, pawn.position.z - spine)
    _axisB.set(pawn.position.x, pawn.position.y, pawn.position.z + spine)
    const reach = r + P.radius
    return segmentDistanceSq(this.previous, this.position, _axisA, _axisB) <= reach * reach
  }
}

/**
 * Renders every live round in three draw calls regardless of how many are in flight: a solid
 * core, an additive halo and an additive tapered trail. A 10 cm dot crossing 900 cm in half a
 * second is unreadable without the trail, which is why ZOMBIES.PROJECTILE.trailLength exists.
 */
export class ProjectilePool {
  /**
   * @param {THREE.Object3D} parent scene or group the meshes are added to
   * @param {{capacity?:number, lights?:number}} [opts]
   */
  constructor(parent, opts = {}) {
    if (!parent) throw new Error('[projectile] ProjectilePool needs a parent Object3D to render into')

    this.parent = parent
    this.live = []
    this._free = []
    this._warnedOverBudget = false
    /**
     * `(pawn, damageDealt, shooter) => void`, invoked when a round is consumed by a pawn that
     * owns a health pool. The pool sets it on every round it hands out; projectile.js itself
     * has no idea which pawn is the player and does not guess.
     */
    this.onHit = null

    // One round in flight per living zombie is already far past anything the wave table can
    // produce; past that something is wrong and the console should say so.
    this.softBudget = WAVES.maxLiveZombies
    this.capacity = Math.max(8, opts.capacity ?? WAVES.maxLiveZombies)

    // The spit light sweeping across wet concrete is most of what sells it, but the dynamic
    // light budget is shared with muzzle flash, impacts and explosions.
    this.lightCount = opts.lights ?? Math.floor(FX.BUDGET.maxDynamicLights * LOOK.lightShareOfBudget)

    const glow = new THREE.Color().setHex(P.colorHex).multiplyScalar(P.emissiveIntensity)

    this.group = new THREE.Group()
    this.group.name = 'spit-projectiles'
    parent.add(this.group)

    const coreGeo = new THREE.SphereGeometry(1, 10, 8)
    const coreMat = new THREE.MeshStandardNodeMaterial({
      color: P.colorHex,
      emissive: new THREE.Color().setHex(P.colorHex),
      emissiveIntensity: P.emissiveIntensity,
      roughness: LOOK.coreRoughness,
      metalness: 0.0,
    })

    const haloGeo = new THREE.SphereGeometry(1, 10, 8)
    const haloMat = new THREE.MeshBasicNodeMaterial({
      color: glow,
      transparent: true,
      opacity: LOOK.haloOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    // Apex at the origin, base one unit behind, so the instance matrix alone aims and stretches it.
    const trailGeo = new THREE.ConeGeometry(1, 1, 8, 1, true)
    trailGeo.rotateX(Math.PI / 2)
    trailGeo.translate(0, 0, -0.5)
    const trailMat = new THREE.MeshBasicNodeMaterial({
      color: glow,
      transparent: true,
      opacity: LOOK.trailOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    this.core = this._makeInstanced(coreGeo, coreMat, 'spit-core')
    this.halo = this._makeInstanced(haloGeo, haloMat, 'spit-halo')
    this.trail = this._makeInstanced(trailGeo, trailMat, 'spit-trail')
    this.halo.renderOrder = 2
    this.trail.renderOrder = 2

    this.lights = []
    for (let i = 0; i < this.lightCount; i++) {
      // Intensity, never visibility — see the note on createLightRing in fx/impacts.js.
      const light = new THREE.PointLight(P.colorHex, 0, FX.IMPACT.lightRadiusDefault)
      this.group.add(light)
      this.lights.push(light)
    }
  }

  _makeInstanced(geometry, material, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, this.capacity)
    mesh.name = name
    mesh.count = 0
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Instances travel the whole 6000 cm platform; the source geometry's bounds say nothing
    // useful about where they are, so culling them per-mesh would pop them out of existence.
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    this.group.add(mesh)
    return mesh
  }

  /** @param {{position:THREE.Vector3, direction:THREE.Vector3, damage?:number, owner?:object}} opts */
  spawn(opts) {
    const p = this._free.pop() ?? new Projectile()
    p.launch(opts)
    p.onHit = this.onHit
    this.live.push(p)

    if (this.live.length > this.softBudget && !this._warnedOverBudget) {
      this._warnedOverBudget = true
      console.warn(
        `[projectile] ${this.live.length} spits in flight, past the ${this.softBudget} budget — ` +
        'a Spitter is probably firing without its cooldown being consumed.'
      )
    }
    if (this.live.length > this.capacity) this._grow(this.live.length * 2)
    return p
  }

  _grow(next) {
    console.info(`[projectile] growing instance capacity ${this.capacity} -> ${next}`)
    this.capacity = next
    for (const key of ['core', 'halo', 'trail']) {
      const old = this[key]
      const grown = this._makeInstanced(old.geometry, old.material, old.name)
      grown.renderOrder = old.renderOrder
      this.group.remove(old)
      old.dispose()
      this[key] = grown
    }
  }

  /**
   * @param {number} dt
   * @param {Array<{position:THREE.Vector3, radius:number, halfHeight:number, health?:object, isDead?:boolean}>} pawns
   *        every body a spit can hit: the player and every living zombie. There is no
   *        friendly-fire exemption beyond the shooter itself (§4.3).
   */
  update(dt, pawns = []) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]
      if (!p.advance(dt, pawns)) {
        this.live.splice(i, 1)
        p.owner = null
        this._free.push(p)
      }
    }
    this._sync()
  }

  _sync() {
    const n = this.live.length
    const haloRadius = P.radius * LOOK.haloRadiusFactor

    for (let i = 0; i < n; i++) {
      const p = this.live[i]
      _q.setFromUnitVectors(FORWARD, _step.copy(p.velocity).normalize())

      _scale.setScalar(P.radius)
      _m.compose(p.position, _q, _scale)
      this.core.setMatrixAt(i, _m)

      _scale.setScalar(haloRadius)
      _m.compose(p.position, _q, _scale)
      this.halo.setMatrixAt(i, _m)

      // The trail is clipped to how far the round has actually flown, so a freshly spawned
      // spit does not appear with 120 cm of history behind it.
      const flown = Math.min(P.trailLength, P.speed * p.age)
      const trailRadius = P.radius * LOOK.trailRadiusFactor
      _scale.set(trailRadius, trailRadius, flown)
      _stepEnd.copy(p.position).addScaledVector(_step, P.radius * 0.5)
      _m.compose(_stepEnd, _q, _scale)
      this.trail.setMatrixAt(i, _m)
    }

    this.core.count = n
    this.halo.count = n
    this.trail.count = n
    this.core.instanceMatrix.needsUpdate = true
    this.halo.instanceMatrix.needsUpdate = true
    this.trail.instanceMatrix.needsUpdate = true

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]
      const p = this.live[i]
      if (!p) { light.intensity = 0; continue }
      light.position.copy(p.position)
      light.intensity = FX.MUZZLE.normal.intensity * LOOK.lightFractionOfMuzzle * FX.LIGHT_INTENSITY_SCALE
    }
  }

  /** Drop every round without playing out its life — used on wave reset and on death. */
  clear() {
    for (const p of this.live) { p.alive = false; p.owner = null; this._free.push(p) }
    this.live.length = 0
    this._sync()
  }

  dispose() {
    this.clear()
    for (const key of ['core', 'halo', 'trail']) {
      this[key].geometry.dispose()
      this[key].material.dispose()
      this[key].dispose()
    }
    for (const light of this.lights) light.dispose?.()
    this.group.removeFromParent()
  }
}

export default ProjectilePool
