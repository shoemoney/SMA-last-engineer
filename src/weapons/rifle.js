/**
 * rifle.js — the only automatic weapon in the game.
 *
 * 15 damage, 10 shots/s, 30-round magazine, 240 in reserve, 2.5 deg cone. Holding the
 * trigger keeps the cooldown loop re-arming itself; every other weapon fires once per press.
 * At 150 body DPS sustained it is the highest damage-per-second in the game, and the fastest
 * way to build incendiary stacks, because every round pushes a brand-new 5-tick burn.
 *
 * RIFLE_VIEW is the first-person silhouette. The original loaded /Game/Weapons/SKM_Rifle by
 * path and the mesh is content, not source, so the shape below is built from primitives.
 * Centimetres in weapon space: +X right, +Y up, barrel down -Z.
 */
import { WEAPONS } from '../game/rules.js'
import { Weapon } from './weapon.js'

const GRIP_RAKE = 0.34
const MAG_RAKE = -0.06
const MAG_CURVE = -0.24 // the lower half of the magazine kicks forward, reading as a curve

export const RIFLE_VIEW = Object.freeze({
  id: 'rifle',

  /**
   * Same x/y framing the gun always had — only the distance changed. The stock runs to local
   * z +21.5, so at the old z of -24 the buttpad sat 2.5 cm from a 1 cm near plane, close
   * enough that a 5 cm part spans a 4 cm-wide frustum: not a gun in the corner, a wall.
   * At -40 the nearest geometry is 18.4 cm out.
   *
   * Distance, not height, is the fix. Measured by rasterising the silhouette of every part:
   * of the right-hand approach lane (x>=770) this gun covers 11.5% of the eye-level band and
   * 40.7% of the band below it, against 14.1% / 58.8% at z -24. Pulling it UP instead (a
   * hold of [13, -10.5, -38]) clears the lens but swings the barrel across the flankers:
   * 26.4% / 79.2%, worse than the wall it replaced. The muzzle still lands at (742, 429),
   * below-right of the crosshair, so the barrel reads as pointing where you aim.
   */
  hold: Object.freeze({ pos: [16, -15, -40], rot: [0.02, -0.05, 0.012] }),

  muzzle: Object.freeze([0, 4.2, -60]),

  hands: Object.freeze({ right: [0, -3.8, 1.6], left: [-0.8, 1.4, -28] }),

  /**
   * Shoulder anchors are eye-relative and only exist to aim the forearm cylinders. Parked at
   * y -42 / z +20 the whole right arm fell behind the lens and off the bottom of the frame —
   * the gun floated unheld. Pulled up and forward, the trigger hand and its fingers land on
   * screen above the HUD and the support hand sits under the handguard.
   */
  shoulders: Object.freeze({ right: [20, -28, 2], left: [-14, -26, 4] }),

  /** Light per shot because ten of them land every second. CHOSEN: not in original spec. */
  recoil: Object.freeze({ back: 1.4, rise: 0.55, pitch: 0.045, roll: 0.022 }),

  reload: Object.freeze({ feed: 'magazine', magDrop: 10.0, slideTravel: 3.6, racks: 1 }),

  parts: Object.freeze([
    { shape: 'box', size: [4.6, 5.0, 24], pos: [0, 0.8, -4], mat: 'steel' },
    { shape: 'box', size: [4.8, 4.2, 26], pos: [0, 4.4, -6], mat: 'slide', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.7, 24], pos: [0, 6.7, -6], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, 3.0], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, 0.4], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, -2.2], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, -4.8], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, -7.4], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, -10.0], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.0, 0.4, 0.6], pos: [0, 7.1, -12.6], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [0.8, 2.2, 6.5], pos: [2.5, 4.6, -1], mat: 'dark' },
    { shape: 'box', size: [0.5, 2.8, 7.4], pos: [2.7, 5.2, -1], mat: 'steel' },
    { shape: 'box', size: [5.8, 1.2, 1.4], pos: [0, 6.4, 7.4], mat: 'steel', tag: 'slide' },

    // The gun hangs to the right of the lens, so the camera only ever sees its LEFT flank.
    // Every warm-metal cue therefore lives on -x, where it actually catches the fill light.
    { shape: 'box', size: [0.9, 2.2, 3.4], pos: [-2.7, 6.2, 5.6], mat: 'brass', tag: 'slide' },
    { shape: 'box', size: [0.8, 1.7, 2.6], pos: [-2.6, 1.2, -5.5], mat: 'brass' },
    { shape: 'box', size: [0.6, 1.1, 9.0], pos: [-2.5, 3.4, -2], mat: 'slide', tag: 'slide' },

    { shape: 'box', size: [4.8, 4.8, 22], pos: [0, 4.0, -28], mat: 'accent' },
    { shape: 'box', size: [0.6, 3.0, 18], pos: [-2.5, 4.0, -28], mat: 'slide' },
    { shape: 'box', size: [3.0, 0.5, 1.0], pos: [0, 6.3, -21], mat: 'dark' },
    { shape: 'box', size: [3.0, 0.5, 1.0], pos: [0, 6.3, -24.5], mat: 'dark' },
    { shape: 'box', size: [3.0, 0.5, 1.0], pos: [0, 6.3, -28], mat: 'dark' },
    { shape: 'box', size: [3.0, 0.5, 1.0], pos: [0, 6.3, -31.5], mat: 'dark' },
    { shape: 'box', size: [3.0, 0.5, 1.0], pos: [0, 6.3, -35], mat: 'dark' },

    { shape: 'cyl', size: [2.2, 24, 2.2], pos: [0, 4.2, -45], rot: [Math.PI / 2, 0, 0], mat: 'steel' },
    { shape: 'box', size: [2.8, 3.0, 3.2], pos: [0, 6.4, -40], mat: 'steel' },
    { shape: 'box', size: [2.0, 2.8, 1.2], pos: [0, 8.6, -40], mat: 'steel' },
    { shape: 'cyl', size: [3.4, 5.0, 3.4], pos: [0, 4.2, -57], rot: [Math.PI / 2, 0, 0], mat: 'accent' },
    { shape: 'box', size: [3.6, 0.6, 0.7], pos: [0, 4.2, -55.5], mat: 'dark' },
    { shape: 'box', size: [3.6, 0.6, 0.7], pos: [0, 4.2, -57.0], mat: 'dark' },
    { shape: 'box', size: [3.6, 0.6, 0.7], pos: [0, 4.2, -58.5], mat: 'dark' },

    { shape: 'box', size: [3.0, 2.2, 6.0], pos: [0, 7.4, -6], mat: 'steel' },
    { shape: 'box', size: [4.2, 3.8, 10], pos: [0, 9.0, -6], mat: 'slide' },
    { shape: 'cyl', size: [3.2, 0.6, 3.2], pos: [0, 9.0, -11.2], rot: [Math.PI / 2, 0, 0], mat: 'lens' },
    { shape: 'sphere', size: [0.55, 0.55, 0.55], pos: [0, 9.0, -10.6], mat: 'sightRed' },
    { shape: 'cyl', size: [3.2, 0.6, 3.2], pos: [0, 9.0, -0.8], rot: [Math.PI / 2, 0, 0], mat: 'lens' },

    { shape: 'box', size: [3.4, 9.8, 4.4], pos: [0, -4.6, 2.6], rot: [GRIP_RAKE, 0, 0], mat: 'accent' },
    { shape: 'box', size: [3.6, 0.5, 4.0], pos: [0, -3.2, 2.2], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'box', size: [3.6, 0.5, 4.0], pos: [0, -5.0, 2.8], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'box', size: [3.6, 0.5, 4.0], pos: [0, -6.8, 3.4], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'torus', size: [5.4, 5.4, 1.2], pos: [0, -2.2, -0.6], rot: [0, Math.PI / 2, 0], mat: 'steel' },
    { shape: 'box', size: [0.9, 2.6, 0.7], pos: [0, -2.0, -0.2], mat: 'accent' },

    { shape: 'box', size: [3.4, 9.0, 5.0], pos: [0, -4.2, -8], rot: [MAG_RAKE, 0, 0], mat: 'accent', tag: 'mag' },
    { shape: 'box', size: [3.4, 5.5, 4.6], pos: [0, -11.6, -7.0], rot: [MAG_CURVE, 0, 0], mat: 'accent', tag: 'mag' },
    { shape: 'box', size: [3.7, 0.9, 4.9], pos: [0, -14.3, -6.4], rot: [MAG_CURVE, 0, 0], mat: 'steel', tag: 'mag' },
    // Round-counter window. Tagged 'mag' so it falls out of frame with the magazine on a
    // reload, and the only warm light source on the lower half of the gun until it does.
    { shape: 'box', size: [0.5, 2.4, 1.1], pos: [-1.8, -4.0, -8], rot: [MAG_RAKE, 0, 0], mat: 'sightAmber', tag: 'mag' },

    // STOCK. This is what fills the bottom-right corner of every gameplay frame, so it is
    // built to catch light rather than to be a black wedge: an earth-tone body, a polished
    // side plate and comb down the camera-facing flank, and brass at the toe.
    { shape: 'cyl', size: [3.6, 15, 3.6], pos: [0, 3.2, 12], rot: [Math.PI / 2, 0, 0], mat: 'steel' },
    { shape: 'box', size: [4.6, 7.0, 12], pos: [0, 2.4, 14], mat: 'accent' },
    { shape: 'box', size: [0.7, 5.2, 10.4], pos: [-2.4, 2.4, 14], mat: 'slide' },
    { shape: 'box', size: [3.4, 1.2, 9.0], pos: [0, 6.2, 13.0], mat: 'slide' },
    { shape: 'box', size: [5.2, 8.6, 0.5], pos: [0, 2.0, 19.4], mat: 'slide' },
    { shape: 'box', size: [5.0, 8.4, 1.5], pos: [0, 2.0, 20.4], mat: 'accent' },
    { shape: 'box', size: [4.2, 0.8, 0.5], pos: [0, 4.6, 21.3], mat: 'rubber' },
    { shape: 'box', size: [4.2, 0.8, 0.5], pos: [0, 2.0, 21.3], mat: 'rubber' },
    { shape: 'box', size: [4.2, 0.8, 0.5], pos: [0, -0.6, 21.3], mat: 'rubber' },
    // Charge segments. Emissive, so they do not depend on the viewmodel fill light — moving
    // the gun to arm's length cut the inverse-square fill on the stock by 40%, and this
    // corner of the frame is never allowed to go back to being a hole.
    { shape: 'box', size: [0.4, 0.9, 2.4], pos: [-2.8, 4.4, 11.5], mat: 'sightAmber' },
    { shape: 'box', size: [0.4, 0.9, 2.4], pos: [-2.8, 4.4, 14.6], mat: 'sightAmber' },
    { shape: 'torus', size: [3.0, 3.0, 0.8], pos: [-2.6, 1.0, 16], rot: [0, Math.PI / 2, 0], mat: 'brass' },
    { shape: 'cyl', size: [1.2, 0.6, 1.2], pos: [-2.8, 1.0, 18.2], rot: [0, 0, Math.PI / 2], mat: 'brass' },
  ]),
})

/** Factory rather than subclass — see the note in pistol.js. */
export function createRifle(deps) {
  return new Weapon(WEAPONS.RIFLE, deps)
}
