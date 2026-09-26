/**
 * shotgun.js — eight independent bullets per trigger pull.
 *
 * 12 damage PER PELLET, 1.2 shots/s, 6 shells, 48 in reserve, 8 deg cone. Every pellet runs
 * the whole pipeline on its own: its own cone-random direction, its own zone lookup, its own
 * damage resolution, its own alert call — and its own damage result.
 *
 * SHOTGUN_VIEW is the first-person silhouette. The original pointed the shotgun class at
 * /Game/Weapons/SKM_GrenadeLauncher, deliberately reusing a grenade-launcher mesh; with no
 * meshes to reuse here it is modelled as what the stats describe — a pump gun.
 * Centimetres in weapon space: +X right, +Y up, barrel down -Z.
 */
import { WEAPONS } from '../game/rules.js'
import { Weapon } from './weapon.js'

const GRIP_RAKE = 0.3
const STOCK_DROP = -0.05

export const SHOTGUN_VIEW = Object.freeze({
  id: 'shotgun',

  hold: Object.freeze({ pos: [17, -15.5, -24], rot: [0.02, -0.055, 0.015] }),

  muzzle: Object.freeze([0, 4.6, -54]),

  hands: Object.freeze({ right: [0, -3.2, 1.4], left: [-0.4, -1.6, -24] }),
  shoulders: Object.freeze({ right: [24, -42, 20], left: [-28, -34, -8] }),

  /** The heaviest kick in the game, to match 96 damage arriving at once. CHOSEN: not in original spec. */
  recoil: Object.freeze({ back: 3.6, rise: 1.8, pitch: 0.145, roll: 0.06 }),

  /** Tube-fed, so the reload is the forend working shells in rather than a magazine swap. */
  reload: Object.freeze({ feed: 'tube', magDrop: 0, slideTravel: 6.5, racks: 4 }),

  parts: Object.freeze([
    { shape: 'box', size: [5.6, 6.6, 20], pos: [0, 2.4, -3], mat: 'slide' },
    { shape: 'box', size: [1.4, 0.6, 18], pos: [0, 5.9, -3], mat: 'steel' },
    { shape: 'box', size: [0.8, 3.0, 7.0], pos: [2.9, 2.0, -1], mat: 'dark' },
    { shape: 'box', size: [0.8, 2.6, 6.0], pos: [-2.9, 0.6, 0], mat: 'dark' },

    { shape: 'cyl', size: [3.8, 42, 3.8], pos: [0, 4.6, -32], rot: [Math.PI / 2, 0, 0], mat: 'steel' },
    { shape: 'box', size: [1.2, 0.5, 40], pos: [0, 6.6, -32], mat: 'steel' },
    { shape: 'sphere', size: [0.8, 0.8, 0.8], pos: [0, 7.1, -51], mat: 'sightAmber' },

    { shape: 'cyl', size: [3.0, 36, 3.0], pos: [0, 0.9, -28], rot: [Math.PI / 2, 0, 0], mat: 'steel' },
    { shape: 'cyl', size: [3.4, 1.8, 3.4], pos: [0, 0.9, -46.5], rot: [Math.PI / 2, 0, 0], mat: 'accent' },

    { shape: 'box', size: [5.8, 5.2, 14], pos: [0, 0.9, -24], mat: 'polymer', tag: 'slide' },
    { shape: 'box', size: [6.0, 0.5, 1.0], pos: [0, 0.9, -29.5], mat: 'rubber', tag: 'slide' },
    { shape: 'box', size: [6.0, 0.5, 1.0], pos: [0, 0.9, -27.3], mat: 'rubber', tag: 'slide' },
    { shape: 'box', size: [6.0, 0.5, 1.0], pos: [0, 0.9, -25.1], mat: 'rubber', tag: 'slide' },
    { shape: 'box', size: [6.0, 0.5, 1.0], pos: [0, 0.9, -22.9], mat: 'rubber', tag: 'slide' },
    { shape: 'box', size: [6.0, 0.5, 1.0], pos: [0, 0.9, -20.7], mat: 'rubber', tag: 'slide' },
    { shape: 'box', size: [6.0, 0.5, 1.0], pos: [0, 0.9, -18.5], mat: 'rubber', tag: 'slide' },

    { shape: 'box', size: [3.8, 10.2, 5.0], pos: [0, -3.6, 2.4], rot: [GRIP_RAKE, 0, 0], mat: 'polymer' },
    { shape: 'box', size: [4.0, 0.5, 4.4], pos: [0, -2.2, 2.0], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'box', size: [4.0, 0.5, 4.4], pos: [0, -4.0, 2.6], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'box', size: [4.0, 0.5, 4.4], pos: [0, -5.8, 3.2], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'torus', size: [6.0, 6.0, 1.4], pos: [0, -1.4, -0.4], rot: [0, Math.PI / 2, 0], mat: 'steel' },
    { shape: 'box', size: [1.0, 2.8, 0.8], pos: [0, -1.2, 0], mat: 'accent' },

    { shape: 'box', size: [4.8, 7.6, 15], pos: [0, 1.2, 12], rot: [STOCK_DROP, 0, 0], mat: 'polymer' },
    { shape: 'box', size: [3.2, 1.4, 12], pos: [0, 5.2, 12], rot: [STOCK_DROP, 0, 0], mat: 'polymer' },
    { shape: 'box', size: [5.2, 9.0, 2.2], pos: [0, 0.4, 20], rot: [STOCK_DROP, 0, 0], mat: 'rubber' },

    { shape: 'box', size: [0.6, 7.5, 6.5], pos: [-3.1, 3.0, 4], mat: 'steel' },
    { shape: 'cyl', size: [2.0, 5.2, 2.0], pos: [-3.6, 5.2, 4], rot: [Math.PI / 2, 0, 0], mat: 'brass' },
    { shape: 'cyl', size: [2.0, 5.2, 2.0], pos: [-3.6, 3.0, 4], rot: [Math.PI / 2, 0, 0], mat: 'brass' },
    { shape: 'cyl', size: [2.0, 5.2, 2.0], pos: [-3.6, 0.8, 4], rot: [Math.PI / 2, 0, 0], mat: 'brass' },
  ]),
})

/** Factory rather than subclass — see the note in pistol.js. */
export function createShotgun(deps) {
  return new Weapon(WEAPONS.SHOTGUN, deps)
}
