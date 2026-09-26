/**
 * pistol.js — the starting sidearm, and the gun the player is still holding in the left
 * hand once dual wield lands.
 *
 * 20 damage, 5 shots/s, 15 in the magazine, 150 in reserve, 1.5 deg cone. All of it comes
 * out of WEAPONS.PISTOL; nothing about the pistol's behaviour differs from the base weapon,
 * which is exactly how the original was written.
 *
 * PISTOL_VIEW is the first-person silhouette, built from primitives because the project
 * ships no weapon meshes — the original loaded /Game/Weapons/SKM_Pistol by path and the
 * asset is content, not source. Coordinates are centimetres in weapon space: +X right,
 * +Y up, and the barrel points down -Z.
 */
import { WEAPONS } from '../game/rules.js'
import { Weapon } from './weapon.js'

const GRIP_RAKE = 0.26 // radians; a pistol grip leans back off the frame

export const PISTOL_VIEW = Object.freeze({
  id: 'pistol',

  /** Where the whole gun sits relative to the eye. Bottom-right of the view, angled inward. */
  hold: Object.freeze({ pos: [17, -14.5, -27], rot: [0.03, -0.07, 0.02] }),

  /** Flash and fire sound spawn here, not at the camera — the trace starts at the eye. */
  muzzle: Object.freeze([0, 2.8, -14.6]),

  hands: Object.freeze({ right: [0, -3.4, 1.8], left: [-3.2, -5.0, 0.2] }),
  shoulders: Object.freeze({ right: [24, -42, 20], left: [-26, -40, 14] }),

  /** No recoil exists in the original — the shake is cosmetic and never touches aim. This
   *  kicks the MODEL only, for the same reason. CHOSEN: not in original spec. */
  recoil: Object.freeze({ back: 2.2, rise: 1.0, pitch: 0.085, roll: 0.04 }),

  reload: Object.freeze({ feed: 'magazine', magDrop: 8.0, slideTravel: 3.2, racks: 1 }),

  parts: Object.freeze([
    { shape: 'box', size: [4.4, 4.4, 20], pos: [0, 2.8, -3.5], mat: 'slide', tag: 'slide' },
    { shape: 'box', size: [1.7, 0.5, 18], pos: [0, 5.15, -3.5], mat: 'slide', tag: 'slide' },
    { shape: 'box', size: [0.9, 2.2, 6.5], pos: [2.1, 3.2, -1.5], mat: 'dark', tag: 'slide' },
    { shape: 'box', size: [4.6, 3.0, 0.45], pos: [0, 2.8, 4.2], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.6, 3.0, 0.45], pos: [0, 2.8, 5.2], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.6, 3.0, 0.45], pos: [0, 2.8, 6.2], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.6, 2.6, 0.45], pos: [0, 2.8, -10.4], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [4.6, 2.6, 0.45], pos: [0, 2.8, -9.4], mat: 'steel', tag: 'slide' },
    { shape: 'box', size: [1.3, 1.8, 0.9], pos: [0, 4.4, 6.8], rot: [-0.25, 0, 0], mat: 'steel' },

    { shape: 'box', size: [4.0, 2.4, 15], pos: [0, 0.3, -4.5], mat: 'steel' },
    { shape: 'box', size: [2.6, 1.0, 6.5], pos: [0, -1.1, -8], mat: 'steel' },
    { shape: 'box', size: [0.5, 1.0, 3.2], pos: [-2.3, 1.2, 0.6], mat: 'accent' },

    { shape: 'box', size: [3.6, 11.5, 4.8], pos: [0, -5.6, 3.0], rot: [GRIP_RAKE, 0, 0], mat: 'polymer' },
    { shape: 'box', size: [0.45, 9.0, 3.8], pos: [1.9, -5.6, 3.0], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'box', size: [0.45, 9.0, 3.8], pos: [-1.9, -5.6, 3.0], rot: [GRIP_RAKE, 0, 0], mat: 'rubber' },
    { shape: 'box', size: [1.0, 11.5, 1.0], pos: [0, -5.6, 5.5], rot: [GRIP_RAKE, 0, 0], mat: 'steel' },

    { shape: 'torus', size: [5.6, 5.6, 1.2], pos: [0, -1.9, -0.4], rot: [0, Math.PI / 2, 0], mat: 'steel' },
    { shape: 'box', size: [0.9, 2.6, 0.7], pos: [0, -1.6, 0.3], rot: [0.1, 0, 0], mat: 'accent' },

    { shape: 'box', size: [3.2, 1.8, 4.4], pos: [0, -10.7, 3.4], rot: [GRIP_RAKE, 0, 0], mat: 'polymer', tag: 'mag' },
    { shape: 'box', size: [3.6, 0.9, 5.2], pos: [0, -11.6, 3.6], rot: [GRIP_RAKE, 0, 0], mat: 'steel', tag: 'mag' },

    { shape: 'cyl', size: [2.2, 1.4, 2.2], pos: [0, 2.8, -13.2], rot: [Math.PI / 2, 0, 0], mat: 'accent' },
    { shape: 'cyl', size: [1.5, 0.8, 1.5], pos: [0, 2.8, -14.1], rot: [Math.PI / 2, 0, 0], mat: 'dark' },

    { shape: 'box', size: [0.6, 1.3, 0.9], pos: [0, 5.7, -12.0], mat: 'steel' },
    { shape: 'sphere', size: [0.5, 0.5, 0.5], pos: [0, 6.0, -12.0], mat: 'sightGreen' },
    { shape: 'box', size: [3.4, 1.1, 1.3], pos: [0, 5.7, 4.6], mat: 'steel' },
    { shape: 'box', size: [0.9, 1.3, 1.5], pos: [0, 5.9, 4.6], mat: 'dark' },
    { shape: 'sphere', size: [0.42, 0.42, 0.42], pos: [1.2, 5.9, 4.6], mat: 'sightGreen' },
    { shape: 'sphere', size: [0.42, 0.42, 0.42], pos: [-1.2, 5.9, 4.6], mat: 'sightGreen' },
  ]),
})

/**
 * A factory, not a subclass: weapon.js imports this module so WeaponSystem can build guns,
 * and `class Pistol extends Weapon` would evaluate `Weapon` while that module is still
 * initialising. Deferring the reference into a function body sidesteps the cycle, and there
 * was never any per-weapon behaviour to subclass in the first place.
 */
export function createPistol(deps) {
  return new Weapon(WEAPONS.PISTOL, deps)
}
