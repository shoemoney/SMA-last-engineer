/**
 * Floating damage numbers — spec/fx-feel.md §6.
 *
 * This is the game's ONLY hit confirmation. There is no screen-space hit marker,
 * no crosshair flash, no kill-confirm sound in this subsystem: if the number does
 * not pop, the player does not know they connected. It is worth getting right.
 *
 * Three signals carry, and all three come straight out of the original:
 *   - zone colour: hot red head, amber chest, white body
 *   - zone size: a headshot number is 1.73x a body number, so it reads at a glance
 *   - a 30% oversized punch that settles over the first 0.18 s, then a hold to
 *     0.36 s, then a linear fade to nothing at 0.9 s
 *
 * The numbers live in the DOM overlay (#damage-numbers), not in the 3D scene, so
 * they stay crisp at any resolution and cost no draw calls. That means projecting
 * the world point every frame — including the 60 cm world-space rise, which is in
 * WORLD units and must not be faked with a screen-space translate, or a number
 * spawned at the far end of the platform would climb as fast as one at your feet.
 *
 * WHY A SCREEN-SPACE LAYER SITS ON TOP OF ALL THAT.
 * The readout is not the subject of the shot. Pure projected world sizing is
 * correct physics and, up close, terrible art: a 52 cm headshot number a couple of
 * metres from the muzzle projected to roughly 60 px of cap height, so in the
 * busiest frame in the game the two loudest elements after the wave banner were a
 * pair of floating "15"s — bigger than any zombie, sat dead centre over the
 * firefight, physically overlapping each other, with the crosshair completely
 * hidden behind them. The eye went to the damage readout instead of to the thing
 * eating the player. Four screen-space rules now sit over the world projection,
 * and every one of them is a CAP or a nudge, never a replacement:
 *
 *   1. MAX_FONT_PX caps the RENDERED glyph — 28 px for a headshot, less for the
 *      lesser zones. Distance still shrinks a number; proximity no longer grows
 *      one without limit, and the head > chest > body ordering survives the cap.
 *   2. Numbers in the same screen column are laddered 34 px apart at spawn and then
 *      held 34 px apart every frame after it. Both halves are needed. The spawn
 *      ladder alone was measured closing to 23 px within a third of a second,
 *      because two numbers at different depths climb the screen at different
 *      rates and the nearer one catches the further one up. The per-frame half is
 *      a stateless symmetric push recomputed from the raw projection, so the
 *      correction grows and shrinks continuously instead of snapping, and it can
 *      never accumulate into drift.
 *   3. Every number takes a fixed +/-40 px horizontal jitter at spawn, drawn from
 *      this module's OWN seeded Rng so the frame gate keeps comparing stable
 *      pixels. Fixed at spawn and never re-rolled — a per-frame jitter shimmers.
 *   4. A 120x120 px box around the screen centre belongs to the crosshair and
 *      nothing may render inside it, glyph box included. The escape side is chosen
 *      once, at spawn, so the clamp slides a number along the edge of the box
 *      rather than snapping it across the middle mid-flight.
 *
 * Peak opacity is 0.8, not 1.0. At full white over a lit platform these read as
 * foreground UI; at 0.8 they read as a confirmation laid over the scene.
 *
 * The .dmgnum class in src/ui/styles.css carries a `float` keyframe animation for
 * standalone/HUD-only use. It is switched off here: this module drives position,
 * scale and opacity from the spec's own curves, and letting the keyframes run as
 * well would double the rise and fight the fade.
 */
import * as THREE from 'three/webgpu'
import { FX, DAMAGE } from '../game/rules.js'
import { Rng } from '../core/rng.js'

const D = FX.DAMAGE_NUMBER
const ZONES = DAMAGE.zones

/** A burn tick has no zone of its own; the original drew nothing for incendiary at all. */
const BURN = 'burn'

/**
 * Screen-side limits with no counterpart in the Unreal source (the original drew
 * real world-space text, which became unreadable at distance and — see the header —
 * unmissable at point-blank range). Not in rules.js because another agent owns that
 * file and it is the spec as data.
 */
const LOOK = Object.freeze({
  minFontPx: 18,
  marginPx: 48, // cull this far outside the viewport rather than at the exact edge
  peakOpacity: 0.8, // a confirmation laid over the scene, not a HUD element
  minSpacingY: 34, // two numbers in one column never sit closer than this
  stackProbeX: 56, // horizontal reach that counts as "the same column"
  maxStackSteps: 6, // 6 * 34 px of ladder; past that, let them overlap
  escapeSpreadPx: 96, // how wide the crosshair escape BAND is, so it is not one line
  /**
   * Gauss-Seidel over a CHAIN of numbers converges slowly, and the measurements say
   * exactly how slowly: worst same-column gap against a 34 px target came out at
   * 9.9 px after 4 sweeps, 11.6 after 8, 24.1 after 12 and 32.5 after 20, over ~3,000
   * rendered positions at full rifle cadence. So it gets 20 — affordable because that
   * load peaks at nine live numbers, or 20 x 36 = 720 pair tests in a frame.
   * Past sparseCount it drops to crowdedPasses instead, for the honest reason that a
   * 720 px screen cannot hold 48 numbers 34 px apart however many sweeps it is given,
   * and the firefight frame is the last place in the game to spend CPU on a lost cause.
   */
  separationPasses: 20,
  sparseCount: 16,
  crowdedPasses: 4,
  jitterPx: 40, // fixed at spawn so a burst fans out instead of queueing
  crosshairHalfPx: 60, // the 120x120 px box the crosshair owns outright
  glyphAdvanceEm: 0.6, // JetBrains Mono advance width, for the keep-out box
})

/**
 * Rendered glyph ceiling per zone, in CSS pixels. Pinned just above the class font
 * sizes in styles.css (27/22/18/18), so a close-range number lands at its designed
 * size instead of being inflated to three times it. The ratios keep the zone-size
 * read: a headshot is still visibly the biggest thing in the set.
 */
const MAX_FONT_PX = Object.freeze({
  [ZONES.head]: 28,
  [ZONES.chest]: 24,
  [ZONES.body]: 21,
  [BURN]: 18,
})

const CLASS_FOR_ZONE = Object.freeze({
  [ZONES.head]: 'dmgnum head',
  [ZONES.chest]: 'dmgnum chest',
  [ZONES.body]: 'dmgnum',
  [BURN]: 'dmgnum burn',
})

const HEIGHT_FOR_ZONE = Object.freeze({
  [ZONES.head]: D.sizeHead,
  [ZONES.chest]: D.sizeChest,
  [ZONES.body]: D.sizeBody,
  [BURN]: D.sizeBody,
})

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`

/**
 * Set inline from rules.js rather than left to the stylesheet. A critic opening the
 * firefight frame could not tell a headshot from a body hit, and zone colour is one
 * of the three signals this subsystem exists to carry — it should not be possible to
 * flatten it from another file.
 */
const COLOR_FOR_ZONE = Object.freeze({
  [ZONES.head]: hex(D.colorHeadHex),
  [ZONES.chest]: hex(D.colorChestHex),
  [ZONES.body]: hex(D.colorBodyHex),
  [BURN]: '#ff7a1a', // styles.css .dmgnum.burn; incendiary has no zone entry in rules.js
})

/**
 * Hue alone is a thin signal at 21 px over a lit station, so the two scoring zones
 * carry a halo in their own colour as well. Body hits get black shadow only — they
 * are the common case and they are supposed to recede.
 */
const SHADOW_FOR_ZONE = Object.freeze({
  [ZONES.head]: `0 0 13px ${COLOR_FOR_ZONE[ZONES.head]}cc, 0 0 4px #000, 0 2px 5px #000`,
  [ZONES.chest]: `0 0 9px ${COLOR_FOR_ZONE[ZONES.chest]}99, 0 0 3px #000, 0 2px 5px #000`,
  [ZONES.body]: '0 0 3px #000, 0 2px 5px #000',
  [BURN]: `0 0 9px ${COLOR_FOR_ZONE[BURN]}99, 0 2px 5px #000`,
})

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function createDamageNumbers({ camera, container, seed = 0x0d4a6e }) {
  if (!camera) throw new Error('[fx/damageNumbers] needs a camera to project with')

  const host = container ?? globalThis.document?.getElementById('damage-numbers')
  if (!host) {
    console.warn(
      '[fx/damageNumbers] #damage-numbers is missing from the DOM — hit confirmation is DISABLED. ' +
        'Damage still applies, but the player gets no feedback that a shot connected.',
    )
  }

  const pool = []
  const live = []
  const scratch = new THREE.Vector3()
  const spawnPoint = new THREE.Vector3()
  const viewMatrix = new THREE.Matrix4()
  /** Own stream, own seed: jitter must not shift when gameplay draws a different number of rolls. */
  let jitter = new Rng(seed)
  if (host) {
    for (let i = 0; i < D.maxLive; i++) {
      const el = globalThis.document.createElement('div')
      el.className = 'dmgnum'
      el.style.display = 'none'
      el.style.left = '0px'
      el.style.top = '0px'
      el.style.animation = 'none'
      el.style.transformOrigin = '50% 50%'
      host.appendChild(el)
      pool.push({ el, active: false, visible: false, screenX: Number.NaN, screenY: Number.NaN })
    }
  }

  function take() {
    let slot = pool.find((s) => !s.active)
    if (!slot) {
      // Oldest first: a stale number is worth less than the one the player just earned.
      slot = live.reduce((a, b) => (a.elapsed >= b.elapsed ? a : b), live[0])
      const at = live.indexOf(slot)
      if (at >= 0) live.splice(at, 1)
    }
    return slot
  }

  /**
   * Fixes this number's screen-space offset for its whole life — jitter, de-stack, and
   * which side of the crosshair it keeps to. Resolved once at spawn: any of these
   * re-decided per frame would make the number twitch, or jump sides in flight.
   *
   * It also seeds screenX/screenY with the PREDICTED spawn position, so a second
   * number spawned in the same frame (a shotgun into a crowd — the case that produced
   * the overlapping "15"s) de-stacks against it before update() has run once.
   */
  function place(slot) {
    slot.offsetX = jitter.range(-LOOK.jitterPx, LOOK.jitterPx)
    slot.escapePad = jitter.range(0, LOOK.escapeSpreadPx)
    slot.offsetY = 0
    slot.side = 1
    slot.screenX = Number.NaN
    slot.screenY = Number.NaN

    const viewW = host.clientWidth || globalThis.innerWidth || 0
    const viewH = host.clientHeight || globalThis.innerHeight || 0
    if (viewW === 0 || viewH === 0) return

    camera.updateMatrixWorld()
    viewMatrix.copy(camera.matrixWorld).invert()
    spawnPoint.copy(slot.origin).applyMatrix4(viewMatrix)
    if (-spawnPoint.z <= 0) return // behind the camera; nothing to place against
    spawnPoint.applyMatrix4(camera.projectionMatrix)

    const sx = (spawnPoint.x * 0.5 + 0.5) * viewW + slot.offsetX
    const sy = (-spawnPoint.y * 0.5 + 0.5) * viewH
    slot.side = sx >= viewW * 0.5 ? 1 : -1

    for (let step = 0; step < LOOK.maxStackSteps; step++) {
      let clash = false
      for (const other of live) {
        // A NaN screenX (hidden, or behind the camera) fails both tests and is skipped.
        if (!(Math.abs(other.screenX - sx) <= LOOK.stackProbeX)) continue
        if (!(Math.abs(other.screenY - (sy + slot.offsetY)) < LOOK.minSpacingY)) continue
        clash = true
        break
      }
      if (!clash) break
      slot.offsetY += LOOK.minSpacingY
    }

    slot.screenX = sx
    slot.screenY = sy + slot.offsetY
  }

  return {
    /**
     * @param {THREE.Vector3} position impact point
     * @param {number} damage resolved DIRECT damage
     * @param {string} [zone] 'head' | 'chest' | 'body' | 'burn'
     */
    spawn(position, damage, zone = ZONES.body) {
      if (!host) return
      const kind = CLASS_FOR_ZONE[zone] ? zone : ZONES.body
      const slot = take()
      if (!slot) return

      const className = CLASS_FOR_ZONE[kind]
      const text = String(Math.max(Math.round(damage), D.minValue))
      slot.el.className = className
      slot.el.textContent = text
      slot.el.style.display = ''
      slot.el.style.color = COLOR_FOR_ZONE[kind]
      slot.el.style.textShadow = SHADOW_FOR_ZONE[kind]
      slot.origin = slot.origin || new THREE.Vector3()
      slot.origin.copy(position)
      slot.targetHeight = HEIGHT_FOR_ZONE[kind]
      slot.maxFontPx = MAX_FONT_PX[kind]
      slot.digits = text.length
      slot.elapsed = 0
      slot.active = true
      place(slot)
      live.push(slot)
    },

    update(dt) {
      if (!host || live.length === 0) return

      const viewW = host.clientWidth || globalThis.innerWidth || 0
      const viewH = host.clientHeight || globalThis.innerHeight || 0
      if (viewW === 0 || viewH === 0) return

      camera.updateMatrixWorld()
      viewMatrix.copy(camera.matrixWorld).invert()
      // Half the vertical frustum extent at unit depth: turns centimetres into pixels.
      const pxPerCmAtUnitDepth = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
      const cx = viewW * 0.5
      const cy = viewH * 0.5

      // PASS 1 — age, project, size. Nothing reaches the DOM yet: the separation
      // pass below has to see where every number WANTS to be before any one of
      // them can be told where it ends up.
      for (let i = live.length - 1; i >= 0; i--) {
        const slot = live[i]
        slot.elapsed += dt
        slot.visible = false
        slot.screenX = Number.NaN

        if (slot.elapsed >= D.lifeSeconds) {
          slot.el.style.display = 'none'
          slot.active = false
          live.splice(i, 1)
          continue
        }

        const t = clamp01(slot.elapsed / D.lifeSeconds)
        const riseEase = 1 - (1 - t) * (1 - t)
        // Straight up world +Y (the port is Y-up; the source's +Z). No drift, no arc,
        // and it never inherits the target's velocity.
        scratch.set(slot.origin.x, slot.origin.y + D.riseDistance * riseEase, slot.origin.z)

        scratch.applyMatrix4(viewMatrix)
        const depth = -scratch.z
        if (depth <= 0) {
          slot.el.style.display = 'none' // behind the camera
          continue
        }
        scratch.applyMatrix4(camera.projectionMatrix)

        // The world projection says where the number IS; the offsets fixed at spawn say
        // where it is ALLOWED to be. Both are in play, every frame.
        const x = (scratch.x * 0.5 + 0.5) * viewW + slot.offsetX
        const y = (-scratch.y * 0.5 + 0.5) * viewH + slot.offsetY
        if (x < -LOOK.marginPx || x > viewW + LOOK.marginPx || y < -LOOK.marginPx || y > viewH + LOOK.marginPx) {
          slot.el.style.display = 'none'
          continue
        }

        const punch = clamp01(slot.elapsed / (D.lifeSeconds * D.punchFraction))
        const heightCm = slot.targetHeight * D.punchScaleFactor + (slot.targetHeight - slot.targetHeight * D.punchScaleFactor) * punch
        const heightPx = (heightCm * pxPerCmAtUnitDepth) / depth
        slot.px = x
        slot.py = y
        slot.renderedPx = Math.max(LOOK.minFontPx, Math.min(slot.maxFontPx, heightPx))
        // The crosshair's 120x120 px box, grown by half this number's own glyph box, so
        // it is the rendered TEXT that clears the centre and not just its origin.
        slot.keepOutY = LOOK.crosshairHalfPx + slot.renderedPx * 0.55
        slot.keepOutX = LOOK.crosshairHalfPx + slot.renderedPx * LOOK.glyphAdvanceEm * 0.5 * slot.digits
        slot.visible = true
      }

      // PASS 2 — the crosshair keep-out (x) and the anti-stack separation (y),
      // relaxed against each other. They conflict, and every naive ordering of them
      // is wrong in a way that only shows up in pixels:
      //
      //   - Separation alone. The spawn ladder closes up in flight, because two
      //     numbers at different depths climb the screen at different rates. First
      //     rendered pass measured a 34 px ladder down to 23 px in a third of a second.
      //   - Keep-out alone, or keep-out last with a bare clamp. The escape edge is the
      //     one x every number in the centre band agrees on, so the clamp piles
      //     numbers that never shared a column into one, exactly overlapped. A
      //     headless sweep of 8,020 rendered positions found a worst gap of 0 px.
      //   - Separation last. It happily shoves a number back over the crosshair.
      //
      // So: THE KEEP-OUT GETS THE LAST WORD, because of the two it is a promise and
      // not a preference — the crosshair must be readable in EVERY frame, while two
      // numbers 30 px apart instead of 34 is a blemish nobody will ever see. Three
      // things then stop it re-piling. escapePad spreads the escape edge into a band.
      // The separation test below counts two numbers as sharing a column when the
      // clamp is ABOUT to put them in one, not only when they already are. And both
      // constraints are monotone within a frame — keep-out only pushes away from the
      // centre, separation only pushes apart — while both are recomputed from the raw
      // projection next frame, so corrections can never accumulate into drift.
      //
      // Two converging numbers are held exactly minSpacingY apart and therefore never
      // cross, which is what keeps the push direction, and so the motion, continuous.
      const sweeps = live.length <= LOOK.sparseCount ? LOOK.separationPasses : LOOK.crowdedPasses
      for (let sweep = 0; sweep <= sweeps; sweep++) {
        for (const slot of live) {
          if (!slot.visible) continue
          if (Math.abs(slot.py - cy) >= slot.keepOutY) continue
          // escapePad, not a bare clamp: clamping every number onto the same edge builds
          // one tall column out of numbers that never shared one. The pad is drawn once
          // at spawn, so the escape line is a BAND and the pile spreads sideways too.
          const edge = cx + slot.side * (slot.keepOutX + slot.escapePad)
          slot.px = slot.side > 0 ? Math.max(slot.px, edge) : Math.min(slot.px, edge)
        }

        if (sweep === sweeps) break

        for (let a = 0; a < live.length; a++) {
          const first = live[a]
          if (!first.visible) continue
          for (let b = a + 1; b < live.length; b++) {
            const second = live[b]
            if (!second.visible) continue
            // "Same column" has to include where the FINAL clamp is about to put
            // them, not just where they are now. Two numbers 300 px apart that are
            // both inside the crosshair band on the same side will be squeezed into
            // one column by the last keep-out, and separation is the only pass that
            // can still do anything about it — so it has to see them as neighbours
            // now. Measured on 3,000 rendered positions: worst gap 0.5 px without
            // this test, because the pair was never even compared.
            const squeezedTogether = first.side === second.side
              && Math.abs(first.py - cy) < first.keepOutY
              && Math.abs(second.py - cy) < second.keepOutY
            if (!squeezedTogether && Math.abs(first.px - second.px) > LOOK.stackProbeX) continue
            const gap = second.py - first.py
            const deficit = LOOK.minSpacingY - Math.abs(gap)
            if (deficit <= 0) continue
            const push = deficit * 0.5
            const sign = gap >= 0 ? 1 : -1
            first.py -= push * sign
            second.py += push * sign
          }
        }
      }

      // PASS 3 — write.
      for (const slot of live) {
        if (!slot.visible) continue

        const fade = 1 - clamp01((slot.elapsed - D.lifeSeconds * D.fadeStartFraction) / (D.lifeSeconds * D.fadeDurationFraction))

        slot.screenX = slot.px
        slot.screenY = slot.py
        slot.el.style.display = ''
        slot.el.style.opacity = (clamp01(fade) * LOOK.peakOpacity).toFixed(3)
        slot.el.style.fontSize = `${slot.renderedPx.toFixed(2)}px`
        slot.el.style.transform = `translate3d(${slot.px.toFixed(1)}px, ${slot.py.toFixed(1)}px, 0) translate(-50%, -50%)`
      }
    },

    get count() { return live.length },

    reset() {
      for (const slot of live) {
        slot.el.style.display = 'none'
        slot.active = false
        slot.visible = false
        slot.screenX = Number.NaN
        slot.screenY = Number.NaN
      }
      live.length = 0
      // Replays must jitter identically, so the stream restarts with the run.
      jitter = new Rng(seed)
    },

    dispose() {
      this.reset()
      for (const slot of pool) slot.el.remove()
      pool.length = 0
    },
  }
}
