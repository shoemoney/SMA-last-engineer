/**
 * Camera shake — spec/fx-feel.md §2.
 *
 * One pattern serves the whole game: 0.22 s of per-frame white noise under a
 * decay ramp times a blend-in/blend-out weight, scaled by a single multiplier at
 * the call site (1.0 shot, 0.4 suppressed, 1.5 explosion).
 *
 * Two behaviours from the original are load-bearing and easy to "improve" away:
 *
 *   1. The noise is RESAMPLED EVERY RENDERED FRAME. It is not coherent noise and
 *      it is not a baked curve. The harshness is the whole point, so `update()`
 *      belongs on the render tick with the render delta, not on the fixed
 *      simulation step.
 *   2. Shakes STACK. An explosive shot fires a 1.0 shake and a 1.5 shake on the
 *      same frame and both offsets sum. No cap, no priority, no dedupe — that is
 *      why explosions read as the screen coming apart.
 *
 * The shake is a pure post-effect. It never touches where the player is or where
 * a trace goes (rules.FX.SHAKE.affectsAim is false), so it is applied to the
 * camera immediately before rendering and reverted immediately after.
 */
import * as THREE from 'three/webgpu'
import { FX } from '../game/rules.js'
import { Rng } from '../core/rng.js'

const S = FX.SHAKE

/** Blend-out begins here; derived rather than stored so the two can never drift. */
const FADE_OUT_START = S.duration - S.blendOutSeconds

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The host's standard fade-in / fade-out weight. The real engine curve shape is
 * not in the original source (only the two durations are), so this is the linear
 * ramp the spec assumes.
 */
function blendWeight(elapsed) {
  if (elapsed < S.blendIn) return clamp01(elapsed / S.blendIn)
  if (elapsed > FADE_OUT_START) return clamp01((S.duration - elapsed) / S.blendOutSeconds)
  return 1
}

export function createCameraShake({ rng = new Rng() } = {}) {
  /** Live shakes as flat elapsed/scale pairs — a shotgun can start eight in one frame. */
  const elapsed = []
  const scales = []

  const position = new THREE.Vector3()
  const rotationDeg = new THREE.Vector3()

  const savedPosition = new THREE.Vector3()
  const savedQuaternion = new THREE.Quaternion()
  const localOffset = new THREE.Vector3()
  const jitterEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  const jitterQuat = new THREE.Quaternion()
  let applied = false

  const jitter = () => rng.range(S.jitterMin, S.jitterMax)

  return {
    /** Camera-local centimetres, summed across every live shake. Read-only for rig users. */
    position,
    /** (pitch, yaw, roll) in degrees, summed across every live shake. */
    rotationDeg,

    /** @param {number} scale 1.0 shot, 0.4 suppressed, 1.5 explosion. */
    add(scale = S.scaleNormalShot) {
      elapsed.push(0)
      scales.push(scale * S.dynamicScale)
    },

    get count() { return elapsed.length },

    /** Advance every live shake and redraw its noise. Call once per rendered frame. */
    update(dt) {
      position.set(0, 0, 0)
      rotationDeg.set(0, 0, 0)

      for (let i = elapsed.length - 1; i >= 0; i--) {
        const t = elapsed[i] + dt
        if (t >= S.duration) {
          elapsed.splice(i, 1)
          scales.splice(i, 1)
          continue
        }
        elapsed[i] = t

        const alpha = clamp01(1 - t / S.duration)
        const envelope = alpha * blendWeight(t) * scales[i]

        position.x += jitter() * S.locationAmplitude * envelope
        position.y += jitter() * S.locationAmplitude * envelope
        position.z += jitter() * S.locationAmplitude * envelope

        rotationDeg.x += jitter() * S.pitchAmplitude * envelope
        rotationDeg.y += jitter() * S.yawAmplitude * envelope
        rotationDeg.z += jitter() * S.rollAmplitude * envelope
      }
    },

    /**
     * Compose the current offset onto the camera in ITS OWN space, remembering the
     * untouched transform. Anything that reads camera.position between apply() and
     * revert() sees the shaken value, which is why the pair brackets the render call
     * and nothing else.
     */
    apply(camera) {
      if (applied || !camera) return
      savedPosition.copy(camera.position)
      savedQuaternion.copy(camera.quaternion)

      localOffset.copy(position).applyQuaternion(camera.quaternion)
      camera.position.add(localOffset)

      jitterEuler.set(
        THREE.MathUtils.degToRad(rotationDeg.x),
        THREE.MathUtils.degToRad(rotationDeg.y),
        THREE.MathUtils.degToRad(rotationDeg.z),
      )
      jitterQuat.setFromEuler(jitterEuler)
      camera.quaternion.multiply(jitterQuat)
      camera.updateMatrixWorld(true)

      applied = true
    },

    revert(camera) {
      if (!applied || !camera) return
      camera.position.copy(savedPosition)
      camera.quaternion.copy(savedQuaternion)
      camera.updateMatrixWorld(true)
      applied = false
    },

    reset() {
      elapsed.length = 0
      scales.length = 0
      position.set(0, 0, 0)
      rotationDeg.set(0, 0, 0)
      applied = false
    },
  }
}
