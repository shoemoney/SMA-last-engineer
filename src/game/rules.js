/**
 * rules.js — the spec, as data.
 *
 * Every tunable number in ShoeINATOR lives here and nowhere else, so a reviewer can diff
 * this file against spec/ALL-CONSTANTS.md line by line and see the whole game's balance
 * in one place. Nothing here imports anything and nothing here computes anything: the
 * headless soak imports this in node in microseconds, and a typo cannot be masked by a
 * helper function.
 *
 * Provenance: every trailing comment names the Unreal C++ file the value came out of
 * (paths are relative to Source/Shoeinator/ in github.com/shoemoney/Shoeinator).
 * Anything the original never defined is marked `CHOSEN: not in original spec` — grep
 * that string to find every invention in the port in one pass.
 *
 * Units: 1 world unit = 1 cm, carried over from Unreal unchanged. Times are seconds,
 * angles are degrees unless a name says radians, and colours come in two flavours:
 * `*Hex` is sRGB for three.js Color.setHex, `*Linear` is an already-linear [r,g,b]
 * triple for Color.setRGB(..., LinearSRGBColorSpace).
 */

// ---------------------------------------------------------------------------
// UNITS — the conversion floor everything else stands on
// ---------------------------------------------------------------------------

export const UNITS = Object.freeze({
  cmPerUnit: 1.0, // SPEC.md — Unreal centimetres carried over 1:1
  metresPerUnit: 0.01, // derived; only needed where a library assumes metres
  gravityZ: -980.0, // ShoeCharacter.cpp — UE default world gravity, cm/s^2
})

// ---------------------------------------------------------------------------
// DAMAGE — hit zones, armor, and the two damage-over-time payloads
// ---------------------------------------------------------------------------

export const DAMAGE = Object.freeze({
  headMultiplier: 5.0, // ShoeinatorTypes.h FShoeDamageRules
  chestMultiplier: 3.0, // ShoeinatorTypes.h FShoeDamageRules
  bodyMultiplier: 1.0, // ShoeinatorTypes.h FShoeDamageRules

  armorAbsorption: 0.5, // ShoeinatorTypes.h FShoeDamageRules — read off the TARGET, not the weapon

  /** Bone-name sets the original matched against to pick a zone. Kept verbatim so a port
   *  that ever loads the real skeleton resolves zones identically. */
  headBones: Object.freeze(['head', 'neck_01', 'neck_02', 'Head', 'Neck']), // ShoeWeaponBase.cpp
  chestBones: Object.freeze([
    'spine_03',
    'spine_04',
    'spine_05',
    'clavicle_l',
    'clavicle_r',
    'Spine2',
    'Spine1',
    'Chest',
  ]), // ShoeWeaponBase.cpp

  zones: Object.freeze({ body: 'body', chest: 'chest', head: 'head' }), // ShoeinatorTypes.h EShoeHitZone

  /**
   * The original's hit zones depended on a physics asset that is not in the source, so the
   * port resolves zones geometrically instead: fractions of a zombie's capsule height,
   * measured from the feet, plus a head sphere the trace must actually intersect.
   */
  hitZoneGeometry: Object.freeze({
    headBottomFraction: 0.86, // CHOSEN: not in original spec
    headRadiusFraction: 0.13, // CHOSEN: not in original spec — of capsule half-height
    chestBottomFraction: 0.62, // CHOSEN: not in original spec
    chestTopFraction: 0.86, // CHOSEN: not in original spec
  }),

  incendiary: Object.freeze({
    ticks: 5, // ShoeinatorTypes.h FShoeDamageRules
    tickInterval: 1.0, // ShoeinatorTypes.h FShoeDamageRules — first tick lands one full interval after the hit
    tickMultiplier: 1.0, // ShoeinatorTypes.h FShoeDamageRules — multiple of BASE weapon damage, never zone-scaled
    minInterval: 0.01, // ShoeHealthComponent.h — lower clamp on a burn stack's interval
    ignoresArmor: true, // ShoeHealthComponent.cpp — burn always bypasses the armor pool
    maxStacksPerTarget: 6, // CHOSEN: not in original spec — the original stacked without limit, which made automatic incendiary fire compound past any balance
  }),

  /** An unsilenced shot that HIT something wakes every zombie inside this sphere around the
   *  trace origin (the camera, not the muzzle). No occlusion, no falloff. */
  hearingRadius: 3000.0, // ShoeWeaponBase.cpp — cm
})

// ---------------------------------------------------------------------------
// WEAPONS — three guns, four mods, one bitmask
// ---------------------------------------------------------------------------

export const WEAPONS = Object.freeze({
  /** Inherited by any weapon that does not override the field. The pistol matches these exactly. */
  DEFAULTS: Object.freeze({
    baseDamage: 20.0, // ShoeWeaponBase.h:57
    fireRate: 5.0, // ShoeWeaponBase.h:61 — shots per second
    magazineSize: 15, // ShoeWeaponBase.h:64
    reserveAmmo: 150, // ShoeWeaponBase.h:67
    reloadTime: 2.0, // ShoeWeaponBase.h:70 — never overridden by any weapon
    baseSpread: 1.5, // ShoeWeaponBase.h:74 — cone HALF-angle in degrees
    range: 10000.0, // ShoeWeaponBase.h:77 — hitscan ray length in cm, never overridden
    automatic: false, // ShoeWeaponBase.h:80
    pelletCount: 1, // ShoeWeaponBase.h:84
    fireSound: 'pistol_shot', // ShoeWeaponBase.h:91
  }),

  /** Cooldown when fireRate <= 0. No shipped weapon reaches it; kept so the port cannot divide by zero. */
  fireIntervalFallback: 0.2, // ShoeWeaponBase.cpp

  PISTOL: Object.freeze({
    id: 'pistol', // ShoeWeaponPistol.cpp
    displayName: 'PISTOL', // CHOSEN: not in original spec — the HUD needs a label
    baseDamage: 20.0, // ShoeWeaponPistol.cpp:13
    fireRate: 5.0, // ShoeWeaponPistol.cpp:14 — 0.2 s cooldown
    fireInterval: 0.2, // derived 1/5.0, spelled out so no module divides
    magazineSize: 15, // ShoeWeaponPistol.cpp:15
    reserveAmmo: 150, // ShoeWeaponPistol.cpp:16
    reloadTime: 2.0, // ShoeWeaponBase.h:70 — inherited
    baseSpread: 1.5, // ShoeWeaponPistol.cpp:17 — 0.525 deg with the laser sight
    range: 10000.0, // ShoeWeaponBase.h:77 — inherited
    automatic: false, // ShoeWeaponPistol.cpp:18
    pelletCount: 1, // ShoeWeaponPistol.cpp:19
    fireSound: 'pistol_shot', // ShoeWeaponBase.h:91 — inherited
    meshPath: '/Game/Weapons/SKM_Pistol', // ShoeWeaponPistol.cpp — asset is content, not source
  }),

  RIFLE: Object.freeze({
    id: 'rifle', // ShoeWeaponRifle.cpp
    displayName: 'RIFLE', // CHOSEN: not in original spec
    baseDamage: 15.0, // ShoeWeaponRifle.cpp:14
    fireRate: 10.0, // ShoeWeaponRifle.cpp:15 — 0.1 s cooldown
    fireInterval: 0.1, // derived 1/10.0
    magazineSize: 30, // ShoeWeaponRifle.cpp:16
    reserveAmmo: 240, // ShoeWeaponRifle.cpp:17
    reloadTime: 2.0, // ShoeWeaponBase.h:70 — inherited
    baseSpread: 2.5, // ShoeWeaponRifle.cpp:18 — 0.875 deg with the laser sight
    range: 10000.0, // ShoeWeaponBase.h:77 — inherited
    automatic: true, // ShoeWeaponRifle.cpp:19
    pelletCount: 1, // ShoeWeaponRifle.cpp:20
    fireSound: 'rifle_shot', // ShoeWeaponRifle.cpp:8
    meshPath: '/Game/Weapons/SKM_Rifle', // ShoeWeaponRifle.cpp
  }),

  SHOTGUN: Object.freeze({
    id: 'shotgun', // ShoeWeaponShotgun.cpp
    displayName: 'SHOTGUN', // CHOSEN: not in original spec
    baseDamage: 12.0, // ShoeWeaponShotgun.cpp:14 — PER PELLET; each pellet resolves independently
    fireRate: 1.2, // ShoeWeaponShotgun.cpp:16
    fireInterval: 0.8333333333333334, // derived 1/1.2
    magazineSize: 6, // ShoeWeaponShotgun.cpp:17
    reserveAmmo: 48, // ShoeWeaponShotgun.cpp:18
    reloadTime: 2.0, // ShoeWeaponBase.h:70 — inherited
    baseSpread: 8.0, // ShoeWeaponShotgun.cpp:19 — 2.8 deg with the laser sight
    range: 10000.0, // ShoeWeaponBase.h:77 — inherited
    automatic: false, // ShoeWeaponShotgun.cpp:20
    pelletCount: 8, // ShoeWeaponShotgun.cpp:15
    fireSound: 'shotgun_blast', // ShoeWeaponShotgun.cpp:8
    meshPath: '/Game/Weapons/SKM_GrenadeLauncher', // ShoeWeaponShotgun.cpp — the original deliberately reused a grenade-launcher mesh
  }),

  /** Draw/pickup order. Picking a weapon up destroys the previous one: there is no inventory. */
  ORDER: Object.freeze(['pistol', 'rifle', 'shotgun']), // ShoeCharacter.cpp giveWeapon

  DUAL_WIELD: Object.freeze({
    startsEnabled: false, // ShoeCharacter.h — player begins with one pistol
    fireLeftNext: false, // ShoeCharacter.h bFireLeftNext — the first trigger press fires the RIGHT pistol
    alternates: true, // ShoeCharacter.cpp — the flag flips on every press. It gates whether the LEFT pistol joins that press; the primary receives every press regardless, so a held automatic never loses its burst to the off hand.
    survivesWeaponSwap: true, // ShoeCharacter.cpp giveWeapon destroys only the primary, so the left pistol outlives a swap to a rifle
    leftHandSocket: 'hand_l_socket', // ShoeCharacter.h
    rightHandSocket: 'hand_r_socket', // ShoeCharacter.h
  }),

  /** Mods are a bitmask. The player can hold all five at once and can never lose one. */
  MOD_BITS: Object.freeze({
    silencer: 1, // ShoeinatorTypes.h EWeaponMod — bit 0
    armorPiercing: 2, // ShoeinatorTypes.h EWeaponMod — bit 1
    incendiary: 4, // ShoeinatorTypes.h EWeaponMod — bit 2
    laserSight: 16, // ShoeinatorTypes.h EWeaponMod — bit 4
  }),

  MODS: Object.freeze({
    silencer: Object.freeze({
      bit: 1, // ShoeinatorTypes.h EWeaponMod
      id: 'silencer', // ShoeinatorTypes.h
      label: 'SIL', // ShoeHUD.cpp mod badge row
      // The HUD banners `${name} ONLINE` on pickup and prints `label` on the persistent chip.
      // They are different strings on purpose: the banner is the one time the player is taught
      // what the mod IS, and it used to print the abbreviation too ("SIL ONLINE"), which
      // introduced the code with the code and taught nothing.
      name: 'SILENCER',
      alertsZombies: false, // ShoeWeaponBase.cpp — the only mod with a gameplay effect on aggro
      fireVolume: 0.28, // ShoeWeaponBase.cpp — vs 1.0 unsuppressed
      firePitch: 0.75, // ShoeWeaponBase.cpp — fixed, no randomisation
      cameraShakeScale: 0.4, // ShoeWeaponBase.cpp
    }),
    armorPiercing: Object.freeze({
      bit: 2, // ShoeinatorTypes.h EWeaponMod
      id: 'armorPiercing', // ShoeinatorTypes.h
      label: 'AP', // ShoeHUD.cpp
      name: 'ARMOR PIERCING',
      bypassesArmor: true, // ShoeWeaponBase.cpp — direct hit
    }),
    incendiary: Object.freeze({
      bit: 4, // ShoeinatorTypes.h EWeaponMod
      id: 'incendiary', // ShoeinatorTypes.h
      label: 'INC', // ShoeHUD.cpp
      name: 'INCENDIARY',
    }),
    laserSight: Object.freeze({
      bit: 16, // ShoeinatorTypes.h EWeaponMod
      id: 'laserSight', // ShoeinatorTypes.h
      label: 'LAS', // ShoeHUD.cpp
      name: 'LASER SIGHT',
      spreadFactor: 0.35, // ShoeWeaponBase.cpp — 65% tighter cone
    }),
  }),

  /** Badge draw order on the HUD, right to left. DUAL is not a mod bit; it rides along. */
  MOD_BADGE_ORDER: Object.freeze(['silencer', 'armorPiercing', 'incendiary', 'laserSight', 'dualWield']), // ShoeHUD.cpp
  dualWieldBadgeLabel: 'DUAL', // ShoeHUD.cpp

  FIRE_AUDIO: Object.freeze({
    normalVolume: 1.0, // ShoeWeaponBase.cpp
    normalPitchMin: 0.96, // ShoeWeaponBase.cpp — per-shot uniform random
    normalPitchMax: 1.04, // ShoeWeaponBase.cpp
    suppressedVolume: 0.28, // ShoeWeaponBase.cpp
    suppressedPitch: 1.0, // ShoeWeaponBase.cpp
    reloadVolume: 0.9, // ShoeWeaponBase.cpp — plays BEFORE the reload guard, so even a rejected reload clicks
    emptyChamberVolume: 0.8, // ShoeWeaponBase.cpp — unreachable in the original; the port makes it reachable
    explosionVolume: 1.0, // Generic environmental explosion volume
  }),

  /**
   * Pellet spread sampling. Unreal's FMath::VRandCone takes the polar angle modulo the cone
   * half-angle, which pushes samples toward the cone EDGE; a naive uniform-in-cap sampler
   * gives a visibly tighter, more central pattern than the original shotgun had.
   */
  SPREAD: Object.freeze({
    biasTowardEdge: true, // CHOSEN: not in original spec — reproduces the engine helper's edge bias
    edgeBiasExponent: 0.5, // CHOSEN: not in original spec — sqrt sampling of the radial term lands closest to the engine's distribution
  }),

  /** The original bound a switch key that only logged. The port cycles ORDER. */
  switchingEnabled: true, // CHOSEN: not in original spec — the handler in ShoeCharacter.cpp was a stub
  switchCooldown: 0.35, // CHOSEN: not in original spec
})

// ---------------------------------------------------------------------------
// ZOMBIES — five archetypes off one mesh, differentiated by stats and scale
// ---------------------------------------------------------------------------

/**
 * FIXED (was a bare 0.0): a zombie spawned with timeUntilNextAttack at 0 could fire its
 * first attack on the very frame it exists — zero reaction time, worst for the Spitter,
 * whose "attack" is a projectile the player has never seen coming. rules.js's own melee
 * ANIM.telegraphLeadSeconds analysis (below, ~line 590) puts this project's reactable bar
 * at a 146ms peak-to-hit window and treats a 6-frame/100ms window as already marginal.
 * 0.15s = 150ms = 9 frames @ 60fps: past the marginal floor, in the same ballpark as the
 * melee window this codebase already ships and calls reactable. REVIEW THIS NUMBER.
 */
const SPAWN_ATTACK_GRACE_SECONDS = 0.15

export const ZOMBIES = Object.freeze({
  /** Reset before the archetype switch runs, so anything an archetype does not name keeps these. */
  SHARED_DEFAULTS: Object.freeze({
    meleeDamage: 10.0, // ShoeZombieBase.h:68
    attackRange: 150.0, // ShoeZombieBase.h:69 / ShoeZombieBase.cpp:87
    attackCooldown: 1.2, // ShoeZombieBase.cpp:88
    desiredRange: 900.0, // ShoeZombieBase.cpp:89 — only the Spitter reads it
    projectileDamage: 12.0, // ShoeZombieBase.h
    timeUntilNextAttack: SPAWN_ATTACK_GRACE_SECONDS, // FIXED: was 0.0 (ShoeZombieBase.h had let a zombie attack on its first frame in range) — see SPAWN_ATTACK_GRACE_SECONDS above
    armor: 0.0, // ShoeZombieBase.cpp:78
    scale: 1.0, // ShoeZombieBase.cpp:82
  }),

  /** Index order matters: it is also the spawn-queue flatten order, so bosses always exit last. */
  ORDER: Object.freeze(['base', 'zerg', 'ranged', 'tank', 'boss']), // ShoeWaveDirector.cpp

  /**
   * SPECIES COLOUR, and why these three emissive hexes look far too dark for their intensities.
   *
   * Every archetype needs one colour a player can name mid-fight. Only the Spitter and the Boss
   * had one; Shambler, Crawler and Tank emitted at under luminance 7/255 — off, in practice — so
   * the sodium rig collapsed all three into the same beige as the brick behind them. Measured on
   * the captured frames: zombie-block mean luminance 52 against a wall at 40, a 1.27:1 silhouette.
   * A figure needs roughly 3:1 to register as a figure.
   *
   * The obvious fix — a bright hex at a low intensity, the way the Spitter is written — silently
   * does the opposite here. entities/zombie.js buildMaterials() splits this one colour across two
   * jobs and gates on the colour's own LINEAR luminance. At or under 0.02 it is read as skin
   * warmth and goes on the flesh; above 0.02 it is read as a lamp colour, the flesh emissive is
   * forced to ZERO, and only the small unlit glow parts get it. That gate is load-bearing — it is
   * the reason the Boss is a black silhouette with two red eyes instead of a glowing red man.
   * So 0x6bff8a @0.85 would have made the Shambler's body DARKER, not brighter.
   *
   * These values stay under the gate and put the brightness in the intensity instead, so the flesh
   * is lit from inside AND the eyes still blow out: the glow pass renormalises to the hue's peak
   * channel, so any intensity at or above 1.35 yields the same accent brightness the Boss gets.
   * All three are tuned to the same emitted luminance, ~0.151, so hue is the only variable:
   *   Shambler  swamp green  — the baseline grunt
   *   Crawler   hot amber    — small, fast, low to the ground
   *   Tank      furnace orange — the do-not-melee-this colour
   * Spitter and Boss keep their lamp colours; both sit ABOVE the gate and both are better for
   * it — see boss.emissiveHex, which documents why moving it under looks right and is not.
   *
   * THE GATE FLIPPED SIGN, SO RE-READ zombie.js BEFORE TRUSTING ANY OF THIS. When the paragraph
   * above was written, a skin-gated accent took the STRONGER rim mix (0.36) and a lamp colour a
   * bare trace (0.126), so staying under the gate was how an archetype got a coloured edge. That
   * is no longer true. zombie.js now splits them the other way — rimAccentMix 0.16 for grime
   * warmth, rimLampAccentMix 0.46 for a lamp colour — and `accentOnSkin` no longer zeroes flesh
   * emissive at all; selecting the mix is the only thing the gate still does. So the gate now
   * reads: under it is a background body, over it is a body entitled to its own edge.
   *
   * Measured through the live lerp against SURFACE.rimColdHex, that made two of the three
   * "background" archetypes unnameable, which is exactly the review finding:
   *
   *   base  0x0b2910  mix 0.16  ->  rim #97c2cc  hue 191deg  26% chroma   still reads
   *   zerg  0x2e2100  mix 0.16  ->  rim #b2b6c6  hue 228deg  10% chroma   amber rendering BLUE
   *   tank  0x3e1800  mix 0.16  ->  rim #b2abc6  hue 256deg  14% chroma   orange rendering VIOLET
   *
   * At 0.16 the cold wall wash simply outvotes a warm hue and inverts it. Green survives because
   * green is where the luminance is; amber and orange do not. The Crawler is therefore moved
   * over the gate (see zerg.emissiveHex) and the Tank is not (see tank.emissiveHex — it would
   * land on the Conductor's own rim hue). The Shambler stays under it deliberately: the commons
   * are meant to be the background the specials pop against.
   *
   * The intensities stay at 9.0 throughout. They are clamped to SURFACE.glowCeiling before use,
   * so every one of these hexes specifies a HUE and nothing else; the brightness of both the
   * glow and the rim has always been zombie.js's decision, not this file's.
   */
  ARCHETYPES: Object.freeze({
    base: Object.freeze({
      id: 'base', // ShoeinatorTypes.h EZombieArchetype
      displayName: 'SHAMBLER', // CHOSEN: not in original spec
      health: 100.0, // ShoeZombieBase.cpp:94
      armor: 0.0, // ShoeZombieBase.cpp:78 — not overridden in case Base
      speed: 140.0, // ShoeZombieBase.cpp:95 — cm/s
      meleeDamage: 10.0, // ShoeZombieBase.cpp:96
      projectileDamage: 0.0, // ShoeZombieBase.cpp — never spits
      attackRange: 150.0, // ShoeZombieBase.cpp:97
      attackCooldown: 1.2, // ShoeZombieBase.cpp:98
      desiredRange: 0.0, // ShoeZombieBase.cpp — melee archetypes close all the way
      scale: 1.0, // ShoeZombieBase.cpp:82
      capsuleRadius: 34.0, // CHOSEN: not in original spec — only the Zerg called SetCapsuleSize; this is UE's default ACharacter capsule
      capsuleHalfHeight: 88.0, // CHOSEN: not in original spec — the -90 cm mesh offset corroborates ~90
      turnRate: 360.0, // CHOSEN: not in original spec — deg/s; the original never set RotationRate
      tintHex: 0x5a6a52, // CHOSEN: not in original spec — sickly grey-green; the original gave all five the same material
      emissiveHex: 0x0b2910, // CHOSEN: not in original spec — swamp green, linear luminance 0.0169, under the 0.02 skin gate
      emissiveIntensity: 9.0, // CHOSEN: not in original spec — see the SPECIES COLOUR note above; emits ~0.151
    }),
    zerg: Object.freeze({
      id: 'zerg', // ShoeinatorTypes.h EZombieArchetype
      displayName: 'CRAWLER', // CHOSEN: not in original spec
      health: 45.0, // ShoeZombieBase.cpp:102
      armor: 0.0, // ShoeZombieBase.cpp:78
      speed: 520.0, // ShoeZombieBase.cpp:103 — cm/s, faster than the player's 600 walk once wave-scaled
      meleeDamage: 6.0, // ShoeZombieBase.cpp:104
      projectileDamage: 0.0, // ShoeZombieBase.cpp
      attackRange: 110.0, // ShoeZombieBase.cpp:105
      attackCooldown: 0.6, // ShoeZombieBase.cpp:106
      desiredRange: 0.0, // ShoeZombieBase.cpp
      scale: 0.55, // ShoeZombieBase.cpp:107 — also multiplies the collision capsule
      capsuleRadius: 20.0, // ShoeZombieBase.cpp:109 — BEFORE scale; effective 11.0 cm
      capsuleHalfHeight: 44.0, // ShoeZombieBase.cpp:110 — BEFORE scale; effective 24.2 cm
      turnRate: 720.0, // CHOSEN: not in original spec — deg/s; it must corner at 520 cm/s to stay threatening
      tintHex: 0xa89a7c, // CHOSEN: not in original spec — bleached bone; at 0.55 scale and knee height the Crawler is read as a pale BLUR against the wet slab, so it is the one archetype that wins by being lighter than its floor rather than darker. L 155 against the Shambler crowd's 101 — a clear step up without going back to the bleached-mannequin look this file already failed once at L 176.
      // ABOVE the 0.02 skin gate on purpose, and the only archetype moved across it this pass.
      // zombie.js reads that gate as "grime warmth or lamp colour" and gives the two buckets
      // rimAccentMix 0.16 and rimLampAccentMix 0.46. At 0.16 the station's cold wall wash simply
      // wins: 0x2e2100's amber came out of the lerp as #b2b6c6, hue 228deg — the Crawler's tell
      // was rendering BLUE, 10% chroma, which is why it was unnameable next to a Shambler. At
      // 0.46 it lands #d2c3a5, hue 40deg, 21% chroma: actual amber on the edge.
      //
      // 0xffd42c rather than a redder amber because of a hue collision. Every furnace-orange
      // candidate for this bucket lerps to within 6-17deg of the Conductor's own rose rim (see
      // the tank note) — a hot orange Crawler reads as a small Conductor, which is worse than
      // reading as nothing. Yellow-amber sits 61deg clear of the nearest other species rim
      // (ranged 153, base 191, boss 339) and is the widest gap left in the ladder.
      emissiveHex: 0xffd42c, // CHOSEN: not in original spec — hot amber, a LAMP colour so the edge is allowed to carry it
      emissiveIntensity: 9.0, // CHOSEN: not in original spec — see the SPECIES COLOUR note above; emits ~0.150
    }),
    ranged: Object.freeze({
      id: 'ranged', // ShoeinatorTypes.h EZombieArchetype
      displayName: 'SPITTER', // CHOSEN: not in original spec
      health: 80.0, // ShoeZombieBase.cpp (case Ranged)
      armor: 0.0, // ShoeZombieBase.cpp:78
      speed: 200.0, // ShoeZombieBase.cpp (case Ranged) — cm/s
      meleeDamage: 0.0, // ShoeZombieBase.cpp (case Ranged) — explicitly zero, it never melees
      projectileDamage: 12.0, // ShoeZombieBase.cpp (case Ranged)
      attackRange: 150.0, // ShoeZombieBase.cpp:87 — inherited default, set but never read on this branch
      attackCooldown: 2.0, // ShoeZombieBase.cpp (case Ranged)
      desiredRange: 900.0, // ShoeZombieBase.cpp (case Ranged) — stand-off distance in cm
      scale: 1.0, // ShoeZombieBase.cpp:82
      capsuleRadius: 34.0, // CHOSEN: not in original spec — see base
      capsuleHalfHeight: 88.0, // CHOSEN: not in original spec — see base
      turnRate: 300.0, // CHOSEN: not in original spec — deg/s
      tintHex: 0x4a6b3f, // CHOSEN: not in original spec — bile green, the only archetype that reads at 900 cm
      emissiveHex: 0x39ff6a, // CHOSEN: not in original spec — the glow is the tell that a spit is coming
      emissiveIntensity: 1.2, // CHOSEN: not in original spec
    }),
    tank: Object.freeze({
      id: 'tank', // ShoeinatorTypes.h EZombieArchetype
      displayName: 'TANK', // CHOSEN: not in original spec
      health: 900.0, // ShoeZombieBase.cpp (case Tank)
      armor: 200.0, // ShoeZombieBase.cpp (case Tank) — never wave-scaled; 1100 damage to kill without AP, 900 with
      speed: 90.0, // ShoeZombieBase.cpp (case Tank) — cm/s
      meleeDamage: 35.0, // ShoeZombieBase.cpp (case Tank)
      projectileDamage: 0.0, // ShoeZombieBase.cpp
      attackRange: 200.0, // ShoeZombieBase.cpp (case Tank)
      attackCooldown: 1.8, // ShoeZombieBase.cpp (case Tank)
      desiredRange: 0.0, // ShoeZombieBase.cpp
      scale: 1.45, // ShoeZombieBase.cpp (case Tank) — also multiplies the default capsule
      capsuleRadius: 34.0, // CHOSEN: not in original spec — pre-scale; effective 49.3 cm
      capsuleHalfHeight: 88.0, // CHOSEN: not in original spec — pre-scale; effective 127.6 cm
      turnRate: 180.0, // CHOSEN: not in original spec — deg/s; slow turn is what makes it kiteable
      // 0x39393d was R57 G57 B61 — 6% chroma, the flattest tint of the five, dropped into a
      // station whose own palette is grey-brown. A Tank costs 200 armour and has to be shot
      // differently, and it was landing within a few luminance steps of the wet floor behind it.
      // Going BRIGHTER would have merged it with the sodium instead, so it goes cold: blued gun
      // steel reads heavy, stays dark, and is the one hue nothing else on the platform owns.
      // It also buys the free contrast, because the three chest grate bars and two shoulder
      // vents at zombie.js:980-988 are furnace orange — cold hulk, hot vents.
      tintHex: 0x3c4450, // CHOSEN: not in original spec — blued steel, armour-plated
      // STAYS under the 0.02 gate, unlike the Crawler above, and the reason is hue crowding
      // rather than brightness. Moved across, the Tank takes rimLampAccentMix 0.46 like the
      // Conductor does, and every furnace orange tested (0xff5a14, 0xff6a1e, 0xff7a1e, 0xff8418)
      // lerps to a rim within 6-17deg of the Conductor's #d289a3. A 253 cm Tank wearing the
      // boss's own edge colour is a worse failure than a dull one, so the Tank buys its tell
      // somewhere else: a COLD body (see tintHex) against a warm station, and the three chest
      // grate bars and two shoulder vents at zombie.js:980-988, whose glow is peak-normalised to
      // 1.9 and is therefore genuinely over-unity — the only kind of surface POST.bloomThreshold
      // 1.05 still lets bloom. Cold hulk, hot vents, no red.
      emissiveHex: 0x3e1800, // CHOSEN: not in original spec — furnace orange, linear luminance 0.0168, under the 0.02 skin gate
      emissiveIntensity: 9.0, // CHOSEN: not in original spec — see the SPECIES COLOUR note above; emits ~0.151
    }),
    boss: Object.freeze({
      id: 'boss', // ShoeinatorTypes.h EZombieArchetype
      displayName: 'CONDUCTOR', // CHOSEN: not in original spec
      health: 4000.0, // ShoeZombieBase.cpp (case Boss)
      armor: 300.0, // ShoeZombieBase.cpp (case Boss) — sits at the hard cap, so it decays back to 200 over 40 s
      speed: 170.0, // ShoeZombieBase.cpp (case Boss) — cm/s
      meleeDamage: 60.0, // ShoeZombieBase.cpp (case Boss)
      projectileDamage: 0.0, // ShoeZombieBase.cpp
      attackRange: 280.0, // ShoeZombieBase.cpp (case Boss)
      attackCooldown: 2.0, // ShoeZombieBase.cpp (case Boss)
      desiredRange: 0.0, // ShoeZombieBase.cpp
      scale: 2.0, // ShoeZombieBase.cpp (case Boss) — also multiplies the default capsule
      capsuleRadius: 34.0, // CHOSEN: not in original spec — pre-scale; effective 68.0 cm
      capsuleHalfHeight: 88.0, // CHOSEN: not in original spec — pre-scale; effective 176.0 cm
      turnRate: 220.0, // CHOSEN: not in original spec — deg/s
      // The silhouette premise never fired. "Near-black against the sodium lamps" assumes bright
      // lamps BEHIND him, and at wave 10 the platform behind him is dark too, so he measured
      // #0c0807 (L 8.4) against a station wall at L 51.5 — the boss was six times darker than
      // what he stood in front of, with no internal value information at all. A 352 cm enemy
      // that a player cannot resolve into arms is not a silhouette, it is a hole.
      //
      // entities/zombie.js now floors every body surface's linear luminance, which rescues the
      // coat's VALUE on its own. It cannot rescue its COLOUR: the floor lerps toward neutral, so
      // a tint this dark arrives as a flat grey card — simulated through their floored(), the old
      // 0x1c1418 lands the coat at L 54 with 0% chroma and the face at L 43 with 2%. Raising the
      // tint means the floor has less lifting to do and the hue survives it: L 49 at 6% on the
      // coat, L 61 at 18% on the hands and face. Slightly DARKER than the floor alone produced,
      // and finally a coal-black wool garment instead of a hole. Still the darkest body on the
      // platform by a distance — the Shambler's flesh sits at L 101.
      tintHex: 0x473a3e, // CHOSEN: not in original spec — coal-black wool that still holds a highlight
      // LEAVE THIS ABOVE THE SKIN GATE. It looks like a near-white-hot red that wants toning
      // down, and moving it under zombie.js SURFACE.skinEmissiveMaxLuminance (0.02) is the
      // obvious-looking change. It is now the wrong one, and the reason is worth writing down
      // because the sign flipped mid-flight: that file used to give a skin-gated accent the
      // STRONGER rim mix (0.36) and a lamp colour a bare trace (0.126). It no longer does. It
      // now splits them into rimAccentMix 0.16 for grime warmth and rimLampAccentMix 0.46 for a
      // lamp colour, precisely so the Conductor's furnace red can reach his own edge and stop
      // him reading as a value-identical black mass against the wall.
      //
      // So at 0xff2008 (lum 0.223, a lamp colour) his rim mixes at 0.46 and lands #d289a3 — a
      // hot rose edge with 35% chroma running the shoulder line, the hat brim and both arms.
      // Dropped under the gate it would mix at 0.16 and land #b2a6c6, a washed lavender at 16%,
      // which is the "two arms read as unidentified dark blobs" finding coming straight back.
      // The silhouette is traced by this value being high. Check zombie.js before touching it.
      emissiveHex: 0xff2008, // CHOSEN: not in original spec — the only red-hot thing on the platform, and a LAMP colour by design
      emissiveIntensity: 2.4, // CHOSEN: not in original spec — clamped to zombie.js SURFACE.glowCeiling; this picks the hue, that picks the burn
    }),
  }),

  /** ConfigureForWave set only max walk speed; everything about HOW a zombie reaches it was engine default. */
  MOVEMENT: Object.freeze({
    maxAcceleration: 1800.0, // CHOSEN: not in original spec — cm/s^2
    brakingDeceleration: 1500.0, // CHOSEN: not in original spec — cm/s^2
    groundFriction: 8.0, // CHOSEN: not in original spec — matches the UE default the original inherited
    separationRadiusFactor: 2.2, // CHOSEN: not in original spec — multiple of capsule radius at which crowd members push apart
    separationStrength: 220.0, // CHOSEN: not in original spec — cm/s^2 of lateral push, so 60 zombies do not occupy one point
  }),

  AI: Object.freeze({
    /** CHOSEN: not in original spec — a crowd with no target mills instead of freezing.
     *  Slow enough to read as aimless, fast enough that the scene is obviously still alive. */
    idleWanderScale: 0.22,   // fraction of a full steering input — a shuffle, not a march
    idleWanderRate: 0.35,    // radians/s of heading drift
    repathInterval: 0.25, // ShoeZombieController.cpp — seconds between path re-requests while chasing
    rangedTolerance: 100.0, // ShoeZombieController.cpp — half-width of the Spitter's band around desiredRange (800-1000 cm)
    meleeAcceptanceFactor: 0.8, // ShoeZombieController.cpp — chase stops at attackRange * 0.8
    rangedAcceptanceRadius: 900.0, // ShoeZombieController.cpp — equal to desiredRange
    steerInputScale: 1.0, // ShoeZombieController.cpp — full-strength input when pathfinding is unavailable
  }),

  PROJECTILE: Object.freeze({
    damage: 12.0, // ShoeZombieProjectile.cpp — overwritten at spawn with 12 * damageScale
    radius: 10.0, // ShoeZombieProjectile.cpp — collision sphere, cm
    speed: 1800.0, // ShoeZombieProjectile.cpp — initial == max, so speed is constant, cm/s
    gravityScale: 0.0, // ShoeZombieProjectile.cpp — perfectly flat, no arc
    bounces: false, // ShoeZombieProjectile.cpp
    lifeSpan: 6.0, // ShoeZombieProjectile.cpp — 10800 cm of travel before it self-destructs
    socketName: 'Muzzle', // ShoeZombieBase.cpp — absent on the assigned mesh, so it falls back to the actor origin
    colorHex: 0x9dff4a, // CHOSEN: not in original spec — no projectile material exists in the source
    emissiveIntensity: 3.0, // CHOSEN: not in original spec
    trailLength: 120.0, // CHOSEN: not in original spec — cm; a 1800 cm/s dot is unreadable without one
  }),

  CORPSE: Object.freeze({
    lifeSpan: 8.0, // ShoeZombieBase.cpp — seconds a ragdoll remains
    fadeSeconds: 1.0, // CHOSEN: not in original spec — the original popped corpses out with no fade
  }),

  MESH: Object.freeze({
    zOffset: -90.0, // ShoeZombieBase.cpp — mesh origin is authored at the head
    yawOffset: -90.0, // ShoeZombieBase.cpp — degrees, so the model faces the capsule's forward axis
    sourcePath: '/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple', // ShoeZombieBase.cpp — all five archetypes shared it
  }),

  /** The original's aggro flag was written and never read. Kept so the port can act on it. */
  AGGRO: Object.freeze({
    hearingRadius: 3000.0, // ShoeZombieBase.cpp OnHeardShot — cm
  }),

  /** Spawn/death/melee cue gains live here because they are per-zombie, not per-cue. */
  SOUND: Object.freeze({
    growlVariantMin: 1, // ShoeZombieBase.cpp — zombie_growl_1..3
    growlVariantMax: 3, // ShoeZombieBase.cpp
    growlVolume: 0.7, // ShoeZombieBase.cpp
    growlPitchMin: 0.85, // ShoeZombieBase.cpp
    growlPitchMax: 1.15, // ShoeZombieBase.cpp
    swipeVolume: 0.8, // ShoeZombieBase.cpp
    swipePitchMin: 0.9, // ShoeZombieBase.cpp
    swipePitchMax: 1.1, // ShoeZombieBase.cpp
    deathVariantMin: 1, // ShoeZombieBase.cpp — zombie_death_1..2
    deathVariantMax: 2, // ShoeZombieBase.cpp
    deathVolume: 0.9, // ShoeZombieBase.cpp
    deathPitchMin: 0.9, // ShoeZombieBase.cpp
    deathPitchMax: 1.1, // ShoeZombieBase.cpp
    /** The original played the swipe ahead of the cooldown gate, so it retriggered every frame
     *  in range — roughly 60 overlapping plays a second per zombie. The port gates it. */
    swipeGatedByCooldown: true, // CHOSEN: not in original spec
  }),

  /**
   * The wind-up lead, and the one animation timing the simulation reads back.
   *
   * §4.1 damage is instant and stays instant — this does not move a hit by a frame. It moves
   * the CLIP, which used to be started BY the hit: the arm reached the top of its wind-up 117 ms
   * AFTER the damage had already landed, so the animation receipted the hit instead of
   * telegraphing it. Every frame a player could have read the swing from was a frame that came
   * after the health bar already moved.
   *
   * The number is read off the clip rather than picked. _poseAttack drives the lead arm by
   * (1.30 * wind - 2.55 * strike) radians: it cocks back over the first 0.32 of the swing, then
   * sweeps forward, and crosses back through its REST angle when 2.55 * strike == 1.30, at
   * attackT 0.32 + 0.68 * (1.30 / 2.55) = 2/3. On a 0.42 s clip that is 280 ms in. That crossing
   * is the visual instant of contact — the arm is at full speed, passing exactly where it
   * started — so landing damage there is the only choice that needs no fudge factor. It also
   * puts the cocked-arm peak (attackT 0.32, 134 ms) a clear 146 ms AHEAD of the hit, which is
   * the reaction window the old ordering did not have, and leaves 140 ms of follow-through after.
   *
   * Headroom is not tight: a clip started 280 ms early ends 140 ms after the hit, and the
   * shortest cooldown in the game is the Runner's 600 ms, so the arm is still idle for 180 ms
   * before the next swing begins. Any archetype whose cooldown exceeds the 0.42 s clip length
   * sustains this indefinitely, and all four melee archetypes do.
   *
   * It lives in rules.js and not beside ANIM in zombie.js because the melee tick now reads it,
   * and CONTRACT.md puts anything the simulation reads here.
   */
  ANIM: Object.freeze({
    telegraphLeadSeconds: 0.28, // CHOSEN: not in original spec — the swing's rest-angle crossing
  }),
})

// ---------------------------------------------------------------------------
// WAVES — the director: counts, scaling, spawn pacing
// ---------------------------------------------------------------------------

export const WAVES = Object.freeze({
  firstWaveNumber: 1, // ShoeGameMode.cpp — startWave(1) on level begin-play
  initialWaveCounter: 0, // ShoeWaveDirector.h — before any wave starts
  maxLiveZombies: 60, // ShoeGameMode.h — the rest wait in a pending queue
  intermissionSeconds: 10, // ShoeGameMode.h:76
  countdownTickInterval: 1.0, // ShoeGameMode.cpp
  spawnBatchSize: 6, // ShoeWaveDirector.h — released per pulse, subject to the live cap
  spawnScatterRadius: 150.0, // ShoeWaveDirector.cpp — independent uniform jitter on X and on Y, cm; Z untouched
  archetypeSlotCount: 5, // ShoeWaveDirector.h ZombieClasses — out-of-range falls back to base

  /** Strict flatten order, never shuffled, so the boss is always last out of the doors. */
  spawnQueueOrder: Object.freeze(['base', 'zerg', 'ranged', 'tank', 'boss']), // ShoeWaveDirector.cpp

  /**
   * Every per-archetype count has the same shape:
   *   W >= firstWave ? base + perWave * floor((W - firstWave) / divisor) : 0
   * The boss is the exception and carries its own fields.
   */
  COUNT_FORMULAS: Object.freeze({
    base: Object.freeze({ firstWave: 1, base: 6, perWave: 2, divisor: 1 }), // ShoeWaveDirector.cpp — 6 + 2*(W-1)
    zerg: Object.freeze({ firstWave: 3, base: 2, perWave: 1, divisor: 1 }), // ShoeWaveDirector.cpp — W>=3 ? 2 + (W-3) : 0
    ranged: Object.freeze({ firstWave: 5, base: 1, perWave: 1, divisor: 2 }), // ShoeWaveDirector.cpp — W>=5 ? 1 + floor((W-5)/2) : 0
    tank: Object.freeze({ firstWave: 7, base: 1, perWave: 1, divisor: 3 }), // ShoeWaveDirector.cpp — W>=7 ? 1 + floor((W-7)/3) : 0
  }),

  BOSS_FORMULA: Object.freeze({
    everyNthWave: 5, // ShoeWaveDirector.cpp — (W % 5 == 0)
    base: 1, // ShoeWaveDirector.cpp
    extraPerWaves: 10, // ShoeWaveDirector.cpp — 1 + floor(W / 10): 1 boss on wave 5, 2 on 10 and 15, 3 on 20 and 25
  }),

  /** Applied at spawn. Armor, ranges, cooldown and body scale are NOT scaled. */
  SCALING: Object.freeze({
    health: Object.freeze({ base: 1.0, perWave: 0.12, cap: Infinity }), // ShoeWaveDirector.cpp — 1.0 + 0.12*(W-1), uncapped
    speed: Object.freeze({ base: 1.0, perWave: 0.04, cap: 2.0 }), // ShoeWaveDirector.cpp — the only clamped scale, hit at wave 26
    damage: Object.freeze({ base: 1.0, perWave: 0.08, cap: Infinity }), // ShoeWaveDirector.cpp — melee and projectile only; player weapons are never scaled
  }),

  /** Neutral values on a freshly constructed FWaveComposition, before any wave is computed. */
  COMPOSITION_DEFAULTS: Object.freeze({
    waveNumber: 1, // ShoeinatorTypes.h FWaveComposition
    healthScale: 1.0, // ShoeinatorTypes.h FWaveComposition
    speedScale: 1.0, // ShoeinatorTypes.h FWaveComposition
    damageScale: 1.0, // ShoeinatorTypes.h FWaveComposition
  }),

  /** The mod reward drop was fully implemented and never called. The port fires it on wave clear. */
  REWARD: Object.freeze({
    cycle: Object.freeze(['silencer', 'incendiary', 'laserSight', 'armorPiercing']),
    trigger: 'waveClear', // CHOSEN: not in original spec — DropRewardForWave had zero callers
    checksOccupancy: true, // CHOSEN: not in original spec — the original dropped onto a uniformly random point with no check
  }),

  /** A whole batch appeared in one frame in the original. Staggering them reads as a train unloading. */
  spawnStagger: 0.18, // CHOSEN: not in original spec — seconds between zombies inside one batch
  spawnDelayAfterArrival: 0.35, // CHOSEN: not in original spec — the original's gap was exactly zero

  /** The original never stopped spawning when the player died; enemies kept arriving under the menu. */
  haltOnPlayerDeath: true, // CHOSEN: not in original spec

  /** A failed spawn consumed its queue entry without decrementing the remaining count, stranding the wave forever. */
  failedSpawnDecrementsRemaining: true, // CHOSEN: not in original spec — the original had no recovery path

  /** Auto-screenshot debug harness. Tooling only, zero gameplay effect; kept for provenance. */
  DEBUG: Object.freeze({
    screenshotWidth: 1600, // ShoeGameMode.cpp -ShoeAutoShot
    screenshotHeight: 900, // ShoeGameMode.cpp
    shotDelay: 0.0, // ShoeGameMode.cpp — 0 or absent disables it
  }),
})

// ---------------------------------------------------------------------------
// PLAYER — capsule, movement, camera, input
// ---------------------------------------------------------------------------

export const PLAYER = Object.freeze({
  capsuleRadius: 42.0, // ShoeCharacter.cpp:23 — body is 84 cm wide
  capsuleHalfHeight: 96.0, // ShoeCharacter.cpp:23 — body is 192 cm tall

  MOVEMENT: Object.freeze({
    walkSpeed: 600.0, // ShoeCharacter.cpp:30 — cm/s
    sprintSpeed: 900.0, // ShoeCharacter.cpp:234
    sprintReleaseSpeed: 600.0, // ShoeCharacter.cpp:239 — a literal, not a restore: it clobbers crouch speed
    crouchSpeed: 300.0, // ShoeCharacter.cpp:31 — unreachable in the original, no crouch input was bound
    maxAcceleration: 2048.0, // UE default (CharacterMovementComponent) — never set in project C++
    brakingDecelerationWalking: 2048.0, // UE default — never set in project C++
    groundFriction: 8.0, // UE default — never set in project C++
    brakingFrictionFactor: 2.0, // UE default — effective braking friction 16.0
    brakingSubStepTime: 0.0303030303, // UE default — 1/33 s, clamped to [1/75, 1/20]
    airControl: 0.3, // ShoeCharacter.cpp — 0.3 * 2048 = 614.4 cm/s^2 airborne
    airControlBoostMultiplier: 2.0, // UE default — doubled (capped at 1.0) under the boost threshold
    airControlBoostVelocityThreshold: 25.0, // UE default — cm/s
    fallingLateralFriction: 0.0, // UE default — horizontal air speed is never bled off
    brakingDecelerationFalling: 0.0, // UE default
    jumpZVelocity: 420.0, // UE default — apex 90 cm, airtime 6/7 s
    jumpMaxCount: 1, // UE default — no double jump
    jumpMaxHoldTime: 0.0, // UE default — fixed jump height
    maxStepHeight: 45.0, // UE default — cm
    walkableFloorZ: 0.71, // UE default — max slope acos(0.71) = 44.765 deg
    crouchedHalfHeight: 40.0, // UE default — 80 cm total
    crouchedEyeHeight: 32.0, // UE default — crouchedHalfHeight * 0.8
    crouchEnabled: false, // ShoeCharacter.cpp — configured but no input action ever declared
  }),

  CAMERA: Object.freeze({
    eyeOffsetZ: 64.0, // UE APawn::BaseEyeHeight default, read by ShoeCharacter.cpp:38 — 160 cm above the feet
    fieldOfView: 90.0, // UE camera default — horizontal degrees, never set in project C++
    viewPitchMin: -89.9, // UE default
    viewPitchMax: 89.9, // UE default
    deathDropZ: -20.0, // ShoeCharacter.cpp:302 — instant drop along the camera's local up on death
    mesh1pRelativeZ: -160.0, // ShoeCharacter.cpp — puts the arms-mesh origin exactly at floor level
    nearPlane: 1.0, // CHOSEN: not in original spec — cm; the weapon sits inside the default near plane
    farPlane: 20000.0, // CHOSEN: not in original spec — cm, comfortably past the 10000 cm weapon range
  }),

  /** All seven actions were content-asset references the original never assigned. Every binding is new. */
  INPUT: Object.freeze({
    moveForward: Object.freeze(['KeyW', 'ArrowUp']), // CHOSEN: not in original spec
    moveBack: Object.freeze(['KeyS', 'ArrowDown']), // CHOSEN: not in original spec
    moveLeft: Object.freeze(['KeyA', 'ArrowLeft']), // CHOSEN: not in original spec
    moveRight: Object.freeze(['KeyD', 'ArrowRight']), // CHOSEN: not in original spec
    jump: Object.freeze(['Space']), // CHOSEN: not in original spec
    sprint: Object.freeze(['ShiftLeft', 'ShiftRight']), // CHOSEN: not in original spec
    reload: Object.freeze(['KeyR']), // CHOSEN: not in original spec
    switchWeapon: Object.freeze(['KeyQ', 'Tab']), // CHOSEN: not in original spec
    pause: Object.freeze(['Escape']), // CHOSEN: not in original spec
    fireMouseButton: 0, // CHOSEN: not in original spec
    lookSensitivity: 0.0022, // CHOSEN: not in original spec — radians of yaw per pixel of raw mouse delta
    invertY: false, // CHOSEN: not in original spec — the C++ added LookInput.Y to pitch with no negation
    mouseSmoothing: false, // ShoeCharacter.cpp / Config — explicitly disabled project-wide, feed raw deltas
    lookInputScale: 1.0, // UE default — degrees per input unit per frame, NOT delta-time scaled
  }),

  SPAWN: Object.freeze({
    x: 3100.0, // ShoeStationBuilder.cpp — 400 + (4 + 0.5) * 600, station-local cm
    y: 308.0, // ShoeStationBuilder.cpp — PlatformWidth * 0.22
    z: 92.0, // ShoeStationBuilder.cpp — 4 cm below the 96 cm half-height, so the player starts slightly in the floor
    yaw: 0.0, // ShoeStationBuilder.cpp — facing +X, down the platform
  }),

  SOCKETS: Object.freeze({
    leftHand: 'hand_l_socket', // ShoeCharacter.h — dual-wield second pistol
    rightHand: 'hand_r_socket', // ShoeCharacter.h — primary weapon
  }),

  START: Object.freeze({
    health: 100.0, // ShoeHealthComponent.h
    armor: 0.0, // ShoeHealthComponent.h — the player starts with no armor
    activeMods: 0, // ShoeCharacter.h — bitmask, no mods
    dualWield: false, // ShoeCharacter.h
    weapon: 'pistol', // ShoeCharacter.cpp
  }),

  /** The original defined nothing for a player who fell the 250 cm into a track pit. */
  PIT: Object.freeze({
    fallDamage: 0.0, // CHOSEN: not in original spec — a fall is punishment enough without a death spiral
    // CHOSEN: not in original spec. Was -240, one step above the -250 pit floor, on the
    // assumption that a player in the pit is a player falling. They are not: the rails,
    // sleepers and ballast bed all carry colliders and hold you well ABOVE -240, so a
    // player who dropped onto the track stood there forever with the rescue never firing.
    // Reported from real play: "i fell into the subway where the tracks are and cant get out".
    // -100 is below anything you can legitimately stand on — the platform is 0, the
    // mezzanine +250, the summit +980 — so being under it always means the trackway.
    rescueBelowZ: -100.0,
    rescueTeleportDelay: 1.2, // CHOSEN: not in original spec — long enough to feel like a fall, short enough not to feel stuck
  }),

  /** Nothing in the original ever restored health, cleared the dead flag, or restarted a wave. */
  respawnEnabled: false, // CHOSEN: not in original spec — death ends the run, matching the shipped behaviour

  zProbeInterval: 1.0, // ShoeCharacter.cpp — dev diagnostic log cadence, no gameplay effect
})

// ---------------------------------------------------------------------------
// HEALTH — one component, shared by the player and every zombie
// ---------------------------------------------------------------------------

export const HEALTH = Object.freeze({
  maxHealth: 100.0, // ShoeHealthComponent.h — soft cap; overheal above this decays back down
  overhealCap: 200.0, // ShoeHealthComponent.h — absolute ceiling
  maxArmor: 200.0, // ShoeHealthComponent.h — soft cap
  overArmorCap: 300.0, // ShoeHealthComponent.h — absolute ceiling; the Boss raises its own to 300

  decayPerTick: 0.25, // ShoeHealthComponent.h — points shed per tick while a pool sits above its soft cap
  decayInterval: 0.1, // ShoeHealthComponent.h — 2.5 points/second, so 200 -> 100 takes exactly 40 s
  decayEpsilon: 1e-4, // ShoeHealthComponent.cpp — UE_KINDA_SMALL_NUMBER, added before the floor-divide because 0.1 has no exact float representation and naive subtraction drops a tick a second

  armorAbsorption: 0.5, // ShoeHealthComponent.cpp — absorbed = min(armor, damage * 0.5)

  criticalThreshold: 0.25, // ShoeHealthComponent.h — health fraction strictly below which the portrait reads CRITICAL
  hurtThreshold: 0.5, // ShoeHealthComponent.h — strictly below which it reads HURT

  burnMinInterval: 0.01, // ShoeHealthComponent.h — hard floor on any burn stack's tick interval

  /** Portrait conditions, worst to best. Tints double as HUD accent colours. */
  CONDITIONS: Object.freeze({
    confident: Object.freeze({ id: 'confident', label: 'CONFIDENT', tintHex: 0x3ad65a, portrait: 'T_Jeremy_Confident' }), // ShoeHUD.cpp
    steady: Object.freeze({ id: 'steady', label: 'STEADY', tintHex: 0x2fd3e0, portrait: 'T_Jeremy_Steady' }), // ShoeHUD.cpp
    hurt: Object.freeze({ id: 'hurt', label: 'HURT', tintHex: 0xffb020, portrait: 'T_Jeremy_Hurt' }), // ShoeHUD.cpp
    critical: Object.freeze({ id: 'critical', label: 'CRITICAL', tintHex: 0xe03a3a, portrait: 'T_Jeremy_Critical' }), // ShoeHUD.cpp
    dead: Object.freeze({ id: 'dead', label: 'DEAD', tintHex: 0x303030, portrait: 'T_Jeremy_Dead' }), // ShoeHUD.cpp
  }),

  /** Values the HUD falls back to when no health component is bound. */
  FALLBACK: Object.freeze({
    health: 0.0, // ShoeHUD.cpp
    armor: 0.0, // ShoeHUD.cpp
    maxHealth: 100.0, // ShoeHUD.cpp
    overhealCap: 200.0, // ShoeHUD.cpp
    maxArmor: 200.0, // ShoeHUD.cpp
    overArmorCap: 300.0, // ShoeHUD.cpp
  }),

  /** The zombie health component's own defaults, before ConfigureForWave overwrites them. */
  ZOMBIE_DEFAULTS: Object.freeze({
    maxHealth: 100.0, // ShoeHealthComponent.h
    overhealCapAppliedAtBeginPlayOnly: true, // ShoeHealthComponent.cpp — BeginPlay runs before ConfigureForWave, so the 200 cap never clips a Boss's 4000
  }),
})

// ---------------------------------------------------------------------------
// STATION — 140 boxes, 28 lights, one logo quad
// ---------------------------------------------------------------------------

export const STATION = Object.freeze({
  DIMENSIONS: Object.freeze({
    length: 6000.0, // ShoeStationBuilder.h — X spans 0 to 6000
    platformWidth: 1400.0, // ShoeStationBuilder.h — centred on Y=0, so -700 to +700
    platformHalfWidth: 700.0, // derived
    platformThickness: 120.0, // ShoeStationBuilder.h — slab spans Z -120 to 0
    ceilingHeight: 700.0, // ShoeStationBuilder.h — measured above the TRACK PIT floor, not the platform
    columnSpacing: 600.0, // ShoeStationBuilder.h
    columnMargin: 400.0, // ShoeStationBuilder.h — first column/pilaster offset from the west end
    columnRadius: 45.0, // ShoeStationBuilder.cpp
    wallThickness: 40.0, // ShoeStationBuilder.cpp
    pilasterExtraDepth: 30.0, // ShoeStationBuilder.cpp — protrusion past the wall face on each side
    pilasterHalfWidth: 50.0, // ShoeStationBuilder.cpp — full width 100 cm
    trackBedWidth: 500.0, // ShoeStationBuilder.h — each of the two pits
    trackBedDropDepth: 250.0, // ShoeStationBuilder.h — pit floor surface at Z -250
    pitFloorThickness: 20.0, // ShoeStationBuilder.cpp — ballast slab spans Z -270 to -250
    ceilingSlabThickness: 60.0, // ShoeStationBuilder.cpp — spans Z 450 to 510
    ceilingSlabHalfWidth: 1240.0, // ShoeStationBuilder.cpp
    tunnelMouthDepth: 300.0, // ShoeStationBuilder.cpp — depth along X of each dark portal box
  }),

  /** Heights the builder computed once and reused everywhere. Spelled out so no module re-derives them. */
  LEVELS: Object.freeze({
    platformTopZ: 0.0, // ShoeStationBuilder.cpp
    platformBottomZ: -120.0, // derived — platformTopZ - platformThickness
    trackFloorZ: -250.0, // ShoeStationBuilder.cpp — pit floor surface
    pitFloorBottomZ: -270.0, // derived
    wallTopZ: 450.0, // ShoeStationBuilder.cpp — trackFloorZ + ceilingHeight
    ceilingTopZ: 510.0, // derived — wallTopZ + ceilingSlabThickness
    pitCentreY: 950.0, // derived — platformHalfWidth + trackBedWidth * 0.5; the designed train centreline
    wallInnerY: 1200.0, // derived — platformHalfWidth + trackBedWidth
    wallOuterY: 1240.0, // derived — wallInnerY + wallThickness
  }),

  COUNTS: Object.freeze({
    columns: 9, // ShoeStationBuilder.cpp — max(1, floor((6000 - 2*400)/600) + 1)
    pilastersPerWall: 9, // ShoeStationBuilder.cpp — 18 total
    lightStations: 7, // ShoeStationBuilder.cpp — max(1, floor(6000/800))
    benches: 4, // ShoeStationBuilder.cpp
    turnstiles: 6, // ShoeStationBuilder.cpp
    vendingMachines: 3, // ShoeStationBuilder.cpp
    trashBins: 6, // ShoeStationBuilder.cpp
    hangingSigns: 4, // ShoeStationBuilder.cpp
    sleepersPerSide: 30, // ShoeStationBuilder.cpp
    totalGeometryInstances: 140, // ShoeStationBuilder.cpp — boxes and cylinders
    totalLights: 28, // ShoeStationBuilder.cpp — 7 ceiling spots + 7 fills + 14 wall washes
  }),

  TRACK: Object.freeze({
    railGaugeHalf: 75.0, // ShoeStationBuilder.cpp — rails 150 cm apart centre-to-centre
    railHalfHeight: 10.0, // ShoeStationBuilder.cpp — 20 cm tall, Z -250 to -230
    railHalfWidth: 4.0, // ShoeStationBuilder.cpp — 8 cm wide
    sleeperSpacing: 200.0, // ShoeStationBuilder.cpp — first tie at X = 100
    sleeperFirstX: 100.0, // ShoeStationBuilder.cpp
    sleeperHalfThickness: 4.0, // ShoeStationBuilder.cpp — 8 cm along X
    sleeperHalfHeight: 4.0, // ShoeStationBuilder.cpp — centred at Z = -246
    sleeperCentreZ: -246.0, // ShoeStationBuilder.cpp
    sleeperWidthFactor: 0.4, // ShoeStationBuilder.cpp — half-extent = trackBedWidth * 0.4 = 200 cm
  }),

  STRIPE: Object.freeze({
    inset: 15.0, // ShoeStationBuilder.cpp — from the platform edge
    halfWidth: 12.5, // ShoeStationBuilder.cpp — 25 cm wide
    halfHeight: 1.5, // ShoeStationBuilder.cpp — 3 cm tall, Z 0 to 3
    centreY: 672.5, // derived — platformHalfWidth - inset - halfWidth
  }),

  LIGHTING: Object.freeze({
    spacing: 800.0, // ShoeStationBuilder.cpp — light stations at X = 400 + i*800
    firstX: 400.0, // ShoeStationBuilder.cpp

    ceilingSpot: Object.freeze({
      z: 440.0, // ShoeStationBuilder.cpp — wallTopZ - 10
      intensity: 26000.0, // ShoeStationBuilder.cpp — engine candelas; multiply by FX.LIGHT_INTENSITY_SCALE
      attenuationRadius: 1250.0, // ShoeStationBuilder.cpp — wallTopZ(450) + spacing(800)
      innerConeDeg: 25.0, // ShoeStationBuilder.cpp
      outerConeDeg: 62.0, // ShoeStationBuilder.cpp
      colorLinear: Object.freeze([1.0, 0.93, 0.8]), // ShoeStationBuilder.cpp — warm white
      colorHex: 0xfff7e7, // ShoeStationBuilder.cpp — sRGB equivalent
      castsShadow: true, // CHOSEN: not in original spec — every original light was explicitly shadowless, which is exactly why it looked flat
    }),

    ambientFill: Object.freeze({
      z: 180.0, // ShoeStationBuilder.cpp — head height
      intensity: 3200.0, // ShoeStationBuilder.cpp — engine candelas
      attenuationRadius: 1760.0, // ShoeStationBuilder.cpp — spacing * 2.2
      colorLinear: Object.freeze([0.72, 0.78, 0.95]), // ShoeStationBuilder.cpp — cool blue
      colorHex: 0xdde5f9, // ShoeStationBuilder.cpp
      castsShadow: false, // ShoeStationBuilder.cpp — shadowless in the original and it should stay that way, it is a fill
    }),

    wallWash: Object.freeze({
      y: 700.0, // ShoeStationBuilder.cpp — +/- platformWidth * 0.5, at the platform edge
      z: 370.0, // ShoeStationBuilder.cpp — wallTopZ - 80
      pitchDeg: -30.0, // ShoeStationBuilder.cpp — tilted down toward the far wall
      yawNorthDeg: 90.0, // ShoeStationBuilder.cpp
      yawSouthDeg: -90.0, // ShoeStationBuilder.cpp
      intensity: 14000.0, // ShoeStationBuilder.cpp — engine candelas
      attenuationRadius: 1200.0, // ShoeStationBuilder.cpp — trackBedWidth(500) + ceilingHeight(700)
      innerConeDeg: 30.0, // ShoeStationBuilder.cpp
      outerConeDeg: 70.0, // ShoeStationBuilder.cpp
      colorLinear: Object.freeze([0.8, 0.85, 1.0]), // ShoeStationBuilder.cpp — cool white
      colorHex: 0xe7edff, // ShoeStationBuilder.cpp
      castsShadow: false, // CHOSEN: not in original spec — 14 shadow-casting spots is not affordable; the ceiling spots carry the shadows
    }),

    lightStrip: Object.freeze({
      halfExtent: Object.freeze([60.0, 15.0, 2.0]), // ShoeStationBuilder.cpp — 120 x 30 x 4 cm
      z: 446.0, // ShoeStationBuilder.cpp — 6 cm below the ceiling line, directly above each spot
      colorLinear: Object.freeze([1.0, 0.92, 0.75]), // ShoeStationBuilder.cpp
      colorHex: 0xfff6e1, // ShoeStationBuilder.cpp
      emissiveIntensity: 6.0, // CHOSEN: not in original spec — the original coloured them but never declared them emissive, which is why nothing bloomed
    }),

    /** Two level-placed lights whose brightness was never authored anywhere in the C++. */
    skyAmbient: Object.freeze({
      position: Object.freeze([0.0, 0.0, 400.0]), // ShoeStationBuilder.cpp / level
      intensity: 0.18, // CHOSEN: not in original spec — three.js ambient units, kept low so the sodium lamps do the work
      colorHex: 0x2a3347, // CHOSEN: not in original spec — cold tunnel bounce
    }),
    directional: Object.freeze({
      position: Object.freeze([0.0, 0.0, 800.0]), // ShoeStationBuilder.cpp / level
      pitchDeg: -60.0, // ShoeStationBuilder.cpp / level
      scale: 2.5, // ShoeStationBuilder.cpp / level
      intensity: 0.55, // CHOSEN: not in original spec — a dim fill so surfaces the strips miss are not pure black; 0.35 was not enough to keep a body's shadow side off zero
      colorHex: 0x8fa6c8, // CHOSEN: not in original spec
      castsShadow: false, // CHOSEN: not in original spec
    }),
  }),

  PROPS: Object.freeze({
    bench: Object.freeze({
      count: 4, // ShoeStationBuilder.cpp
      firstX: 1200.0, // ShoeStationBuilder.cpp — X = 1200 + i*1200
      spacing: 1200.0, // ShoeStationBuilder.cpp
      yOffset: 300.0, // ShoeStationBuilder.cpp — +300 on even index, -300 on odd
      seatCentreZ: 22.0, // ShoeStationBuilder.cpp — top surface at Z = 44
      seatHalfExtent: Object.freeze([75.0, 30.0, 22.0]), // ShoeStationBuilder.cpp — 150 x 60 x 44 cm
      backrestCentreZ: 55.0, // ShoeStationBuilder.cpp — spans Z 25 to 85
      backrestHalfExtent: Object.freeze([75.0, 5.0, 30.0]), // ShoeStationBuilder.cpp — 150 x 10 x 60 cm
      backrestInsetY: 28.0, // ShoeStationBuilder.cpp — offset toward the centreline
    }),
    stairwell: Object.freeze({
      centre: Object.freeze([300.0, 0.0, 115.0]), // ShoeStationBuilder.cpp
      halfExtent: Object.freeze([220.0, 260.0, 115.0]), // ShoeStationBuilder.cpp — 440 x 520 x 230 cm
    }),
    mezzanine: Object.freeze({
      centre: Object.freeze([300.0, 0.0, 235.0]), // ShoeStationBuilder.cpp
      halfExtent: Object.freeze([260.0, 300.0, 15.0]), // ShoeStationBuilder.cpp — 520 x 600 x 30 cm, Z 220 to 250
    }),
    turnstile: Object.freeze({
      x: 5700.0, // ShoeStationBuilder.cpp — east end
      firstY: -375.0, // ShoeStationBuilder.cpp — Y = -375 + i*150
      spacingY: 150.0, // ShoeStationBuilder.cpp
      centreZ: 55.0, // ShoeStationBuilder.cpp
      halfExtent: Object.freeze([15.0, 15.0, 55.0]), // ShoeStationBuilder.cpp — 30 x 30 x 110 cm
    }),
    vending: Object.freeze({
      positions: Object.freeze([
        Object.freeze([600.0, 640.0, 90.0]),
        Object.freeze([680.0, 640.0, 90.0]),
        Object.freeze([5400.0, -640.0, 90.0]),
      ]), // ShoeStationBuilder.cpp — +/-640 = platformHalfWidth - 60
      halfExtent: Object.freeze([45.0, 30.0, 90.0]), // ShoeStationBuilder.cpp — 90 x 60 x 180 cm
    }),
    trashBin: Object.freeze({
      firstX: 900.0, // ShoeStationBuilder.cpp — X = 900 + i*900
      spacing: 900.0, // ShoeStationBuilder.cpp
      yOffset: 600.0, // ShoeStationBuilder.cpp — -600 on even i, +600 on odd
      radius: 20.0, // ShoeStationBuilder.cpp
      height: 50.0, // ShoeStationBuilder.cpp
      centreZ: 25.0, // ShoeStationBuilder.cpp
    }),
    hangingSign: Object.freeze({
      firstX: 800.0, // ShoeStationBuilder.cpp — X = 800 + i*1500
      spacing: 1500.0, // ShoeStationBuilder.cpp
      centreZ: 360.0, // ShoeStationBuilder.cpp — 90 cm below the ceiling line
      halfExtent: Object.freeze([5.0, 80.0, 30.0]), // ShoeStationBuilder.cpp — 10 x 160 x 60 cm
      emissiveIntensity: 3.0, // CHOSEN: not in original spec — transit signage is the one thing in a subway that glows
    }),
    wallBoard: Object.freeze({
      centre: Object.freeze([3000.0, 1212.0, 400.0]), // ShoeStationBuilder.cpp — north wall at station centre
      halfExtent: Object.freeze([220.0, 6.0, 130.0]), // ShoeStationBuilder.cpp — 440 x 12 x 260 cm
      boardZ: 400.0, // ShoeStationBuilder.cpp — (wallTopZ - trackFloorZ)*0.5 + 50
      emissiveIntensity: 2.0, // CHOSEN: not in original spec — it is described as backlit and was never made emissive
    }),
    logo: Object.freeze({
      anchor: Object.freeze([3000.0, 1205.0, 400.0]), // ShoeStationBuilder.cpp
      yawDeg: -90.0, // ShoeStationBuilder.cpp — facing the platform
      pitchDeg: 90.0, // ShoeStationBuilder.cpp — rotates the base quad vertical
      width: 400.0, // ShoeStationBuilder.cpp — 100 cm base quad scaled 4.0
      height: 240.0, // ShoeStationBuilder.cpp — scaled 2.4
      texturePath: '/game/img/T_ShoeMoneyLogo.png', // ShoeStationBuilder.cpp soft-load; re-rooted for the web build
      fallbackColorLinear: Object.freeze([0.4, 0.4, 0.4]), // ShoeStationBuilder.cpp — flat grey when the art is absent
      fallbackColorHex: 0xaaaaaa, // ShoeStationBuilder.cpp
      emissiveIntensity: 1.6, // CHOSEN: not in original spec
    }),
  }),

  /** Every surface in the original was one flat Color parameter on one shared material. */
  COLORS: Object.freeze({
    structureLinear: Object.freeze([0.45, 0.45, 0.47]), // ShoeStationBuilder.cpp — platform, pit floors, walls, pilasters, stairwell, mezzanine, ceiling
    structureHex: 0xb3b3b6, // ShoeStationBuilder.cpp
    safetyStripeLinear: Object.freeze([0.95, 0.82, 0.05]), // ShoeStationBuilder.cpp
    safetyStripeHex: 0xf9ea3f, // ShoeStationBuilder.cpp
    railLinear: Object.freeze([0.1, 0.1, 0.11]), // ShoeStationBuilder.cpp
    railHex: 0x59595d, // ShoeStationBuilder.cpp
    sleeperLinear: Object.freeze([0.22, 0.16, 0.1]), // ShoeStationBuilder.cpp
    sleeperHex: 0x816f59, // ShoeStationBuilder.cpp
    columnLinear: Object.freeze([0.35, 0.35, 0.37]), // ShoeStationBuilder.cpp
    columnHex: 0xa0a0a4, // ShoeStationBuilder.cpp
    tunnelPortalLinear: Object.freeze([0.02, 0.02, 0.025]), // ShoeStationBuilder.cpp — near-black darkness caps
    tunnelPortalHex: 0x27272c, // ShoeStationBuilder.cpp
    furnitureLinear: Object.freeze([0.3, 0.32, 0.4]), // ShoeStationBuilder.cpp — benches, turnstiles, vending machines
    furnitureHex: 0x9599aa, // ShoeStationBuilder.cpp
    trashBinLinear: Object.freeze([0.2, 0.2, 0.22]), // ShoeStationBuilder.cpp
    trashBinHex: 0x7c7c81, // ShoeStationBuilder.cpp
    signageLinear: Object.freeze([0.05, 0.25, 0.55]), // ShoeStationBuilder.cpp — transit blue
    signageHex: 0x3f89c4, // ShoeStationBuilder.cpp
    lightStripLinear: Object.freeze([1.0, 0.92, 0.75]), // ShoeStationBuilder.cpp
    lightStripHex: 0xfff6e1, // ShoeStationBuilder.cpp
    trainBodyHex: 0x6e737a, // CHOSEN: not in original spec — the train's material was never set
    trainAccentHex: 0xb3121c, // CHOSEN: not in original spec — the menu's blood red, so the train reads as the threat
  }),

  /**
   * The original had no roughness, metalness, normal or emissive value on any surface, which is
   * the single biggest reason the build was abandoned as "flat grey boxes". Wet concrete needs
   * a low-ish roughness so the sodium lamps streak across it.
   */
  MATERIALS: Object.freeze({
    concreteRoughness: 0.78, // CHOSEN: not in original spec
    concreteMetalness: 0.0, // CHOSEN: not in original spec
    wetFloorRoughness: 0.34, // CHOSEN: not in original spec — the platform reflects the strips
    wetFloorMetalness: 0.08, // CHOSEN: not in original spec
    railRoughness: 0.28, // CHOSEN: not in original spec — polished by use
    railMetalness: 0.9, // CHOSEN: not in original spec
    sleeperRoughness: 0.95, // CHOSEN: not in original spec — creosoted timber
    sleeperMetalness: 0.0, // CHOSEN: not in original spec
    furnitureRoughness: 0.55, // CHOSEN: not in original spec
    furnitureMetalness: 0.35, // CHOSEN: not in original spec
    signageRoughness: 0.4, // CHOSEN: not in original spec
    signageMetalness: 0.1, // CHOSEN: not in original spec
    grimeStrength: 0.45, // CHOSEN: not in original spec — vertex/AO darkening toward floor and corners
  }),

  /** No fog, exposure, bloom or grading existed for this level beyond a flag disabling auto-exposure. */
  ATMOSPHERE: Object.freeze({
    fogColorHex: 0x0b0d12, // CHOSEN: not in original spec
    fogNear: 900.0, // CHOSEN: not in original spec — cm; haze starts about a column away
    fogFar: 7000.0, // CHOSEN: not in original spec — cm; the far tunnel mouth dissolves
    fogDensity: 0.00018, // CHOSEN: not in original spec — for an exponential-squared fallback
    hazeIntensity: 0.35, // CHOSEN: not in original spec — volumetric shaft strength under each ceiling spot
    toneMappingExposure: 1.15, // CHOSEN: not in original spec — the original disabled auto-exposure and named no replacement
    backgroundHex: 0x05060a, // CHOSEN: not in original spec
  }),

  BOUNDS: Object.freeze({
    centre: Object.freeze([3000.0, 0.0, 130.0]), // ShoeStationBuilder.cpp — verified from the saved level file
    halfExtent: Object.freeze([3000.0, 1270.0, 400.0]), // ShoeStationBuilder.cpp
  }),

  NAV_BOUNDS: Object.freeze({
    centre: Object.freeze([0.0, 0.0, 0.0]), // level nav volume
    halfExtent: Object.freeze([8000.0, 3000.0, 1200.0]), // level nav volume — 200 cm base box scaled (80, 30, 12)
  }),

  /** The room-tone emitter's station-local position. */
  ambiencePosition: Object.freeze([3000.0, 0.0, 150.0]), // ShoeAudio.cpp — length * 0.5, centreline, 150 cm above the platform

  /**
   * Published by the station builder and read by absolutely nothing in the original. Kept because
   * they describe the level as DESIGNED — trains in the pits, zombies out of the tunnels — which
   * is a better game than the shipped behaviour of a train parked on the platform.
   */
  DESIGNED: Object.freeze({
    trainStopY: 950.0, // ShoeStationBuilder.cpp GetTrainStopLocation — +/-, centred in a track pit
    trainStopZ: -230.0, // ShoeStationBuilder.cpp — 20 cm above the pit floor
    trainStopX: 3000.0, // ShoeStationBuilder.cpp — station centre
    trainStagingNorth: Object.freeze([-1500.0, 950.0, -230.0]), // ShoeStationBuilder.cpp GetTrainStagingLocation
    trainStagingSouth: Object.freeze([7500.0, -950.0, -230.0]), // ShoeStationBuilder.cpp
    trainStagingDistance: 1500.0, // ShoeStationBuilder.h — past the station end
    tunnelSpawnWest: Object.freeze([-50.0, 950.0, -210.0]), // ShoeStationBuilder.cpp — +/- Y, yaw 0
    tunnelSpawnEast: Object.freeze([6050.0, 950.0, -210.0]), // ShoeStationBuilder.cpp — +/- Y, yaw 180
    doorSpawnXs: Object.freeze([2700.0, 2900.0, 3100.0, 3300.0]), // ShoeStationBuilder.cpp — startX = 3000 - 3*200*0.5
    doorSpawnY: 720.0, // ShoeStationBuilder.cpp — +/-; platformHalfWidth + 20
    doorSpawnZ: 0.0, // ShoeStationBuilder.cpp
    doorSpawnYawNorth: -90.0, // ShoeStationBuilder.cpp
    doorSpawnYawSouth: 90.0, // ShoeStationBuilder.cpp
    trainDoorCount: 4, // ShoeStationBuilder.h — the station's own copy
    trainDoorSpacing: 200.0, // ShoeStationBuilder.h — the station's own copy
  }),

  /** 18 pickup points: two per column, tucked fore and aft of it. */
  PICKUP_POINTS: Object.freeze({
    count: 18, // ShoeStationBuilder.cpp — 2 per column x 9 columns
    z: 10.0, // ShoeStationBuilder.cpp
    offsetX: 150.0, // ShoeStationBuilder.cpp — +/-, columnSpacing * 0.25
    offsetY: 385.0, // ShoeStationBuilder.cpp — +/-, platformHalfWidth * 0.55
    yaw: 0.0, // ShoeStationBuilder.cpp
  }),

  LEVEL_PATHS: Object.freeze({
    gameplay: '/Game/Maps/Lvl_Subway', // ShoeGameInstance.cpp:85 / DefaultEngine.ini:2
    menu: '/Game/Maps/Lvl_MainMenu', // ShoeGameInstance.cpp:90
  }),
})

// ---------------------------------------------------------------------------
// TRAIN — one greybox that slides in, unloads, and (in the original) never left
// ---------------------------------------------------------------------------

export const TRAIN = Object.freeze({
  bodyHalfExtent: Object.freeze([400.0, 80.0, 80.0]), // ShoeTrain.cpp — 800 x 160 x 160 cm, a 100 cm cube scaled 8.0 x 1.6 x 1.6
  bodySize: Object.freeze([800.0, 160.0, 160.0]), // derived

  platformStopLocation: Object.freeze([0.0, 0.0, 0.0]), // ShoeTrain.h — the default, and nothing ever overrode it
  stagingLocation: Object.freeze([-3000.0, 0.0, 0.0]), // ShoeTrain.h — off-screen, 3000 cm west
  placedPositions: Object.freeze([
    Object.freeze([0.0, -900.0, -250.0]),
    Object.freeze([0.0, 900.0, -250.0]),
  ]), // level — two trains placed correctly in the pits, then both teleported to staging at start-up

  arrivalTime: 4.0, // ShoeTrain.h — gates the first spawn of every wave
  departTime: 4.0, // ShoeTrain.h
  easeExponent: 2.0, // ShoeTrain.cpp:71 — quadratic ease-in-out: t<0.5 ? 2t^2 : 1 - 2(1-t)^2

  doorCount: 4, // ShoeTrain.h — one chosen uniformly at random per spawning zombie
  doorSpacing: 200.0, // ShoeTrain.h — door i local X = (i - 1.5) * 200
  doorLocalXs: Object.freeze([-300.0, -100.0, 100.0, 300.0]), // derived
  doorLateralOffset: 150.0, // ShoeTrain.h — local +Y, pushing spawns clear of the 160 cm body
  doorLocalZ: 0.0, // ShoeTrain.cpp

  arrivalSoundVolume: 1.0, // ShoeTrain.cpp — train_arriving, emitted at the train's position when the slide begins

  /**
   * In the original, startWave re-issued an arrival from the train's current position on the same
   * tick the departure started, so from wave 2 onward the train visually never left. The port lets
   * it leave, because a train that arrives is the whole framing device of the wave.
   */
  departsBetweenWaves: true, // CHOSEN: not in original spec
  doorOpenSeconds: 0.9, // CHOSEN: not in original spec — no door geometry or timing existed
  headlightIntensity: 40000.0, // CHOSEN: not in original spec — engine-candela scale; the approach needs to throw light down the tunnel
  headlightColorHex: 0xfff2d0, // CHOSEN: not in original spec
  headlightAttenuationRadius: 4000.0, // CHOSEN: not in original spec — cm
  windowEmissiveHex: 0xffd98a, // CHOSEN: not in original spec — the train had no windows at all
  windowEmissiveIntensity: 2.2, // CHOSEN: not in original spec
})

// ---------------------------------------------------------------------------
// PICKUPS — floating balls, colour-coded by what they grant
// ---------------------------------------------------------------------------

export const PICKUPS = Object.freeze({
  collisionRadius: 90.0, // ShoePickupBase.h — overlaps the player only, blocks nothing
  meshScale: 0.5, // ShoePickupBase.cpp — on a 100 cm sphere, so 50 cm across
  referenceSphereDiameter: 100.0, // engine BasicShapes/Sphere convention — corroborated by the explosion maths, never stated in project C++
  themeLightIntensity: 3000.0, // ShoePickupBase.h — engine candelas
  themeLightRadius: 300.0, // ShoePickupBase.h — cm
  rotationRate: 90.0, // ShoePickupBase.h — degrees/second of yaw
  bobAmplitude: 15.0, // ShoePickupBase.h — cm above/below the base position
  bobPeriod: 2.0, // ShoePickupBase.h — z = baseZ + sin(2*PI*t/2.0) * 15
  respawnTime: 30.0, // ShoePickupBase.h — base-class default
  sustainRespawnTime: null, // One health and armor pickup per wave; never timed respawns

  healPercent: 50.0, // ShoePickupHealth.h — percent of MAX health, so +50 at the default; refused (and left standing) at the overheal cap
  armorAmount: 50.0, // ShoePickupArmor.h — flat, capped at overArmorCap

  GLOW: Object.freeze({
    health: 0xff0000, // ShoePickupHealth.cpp — red
    armor: 0x00ffff, // ShoePickupArmor.cpp — cyan
    weapon: 0xffd966, // ShoePickupWeapon.cpp — RGB (1.0, 0.85, 0.4) gold
    silencer: 0x808080, // ShoePickupWeaponMod.cpp — RGB (0.5, 0.5, 0.5)
    armorPiercing: 0xffff00, // ShoePickupWeaponMod.cpp
    incendiary: 0xff6600, // ShoePickupWeaponMod.cpp — RGB (1.0, 0.4, 0.0)
    laserSight: 0x00ff00, // ShoePickupWeaponMod.cpp
  }),

  /** Seven permanent opening items; wave supplies are placed separately at random. */
  OPENING_LOADOUT: Object.freeze({
    sustainPairs: 0, // Wave supplies are dealt by PickupManager.beginWave
    modOrder: Object.freeze(['laserSight', 'silencer', 'armorPiercing', 'incendiary']), // Opening equipment points 0-3
    weaponOrder: Object.freeze(['pistol', 'rifle', 'shotgun']), // The pistol grants dual wield; opening points 4-6
    totalItems: 7, // Four mods and three weapons
  }),

  /** Equipment does not respawn; health and armor are replaced only at wave start. */
  modsRespawn: false, // ShoePickupPlacer.cpp
  weaponsRespawn: false, // ShoePickupPlacer.cpp
  summitRestock: Object.freeze(['rifle', 'shotgun', 'pistol']),

  respawnFlashSeconds: 0.4, // CHOSEN: not in original spec — a pickup simply blinked back into existence
  pulsePeriod: 1.6, // CHOSEN: not in original spec — seconds; the theme light breathes so it reads across the platform
  pulseDepth: 0.25, // CHOSEN: not in original spec — fraction of themeLightIntensity
})

// ---------------------------------------------------------------------------
// FX — the feel layer. Shake, flashes, shards, decals, numbers, post.
// ---------------------------------------------------------------------------

export const FX = Object.freeze({
  /**
   * Every intensity below is a raw Unreal candela. three.js with physical lights also uses
   * candela but assumes metres, and this world is in centimetres, so a single scale factor
   * reconciles the two. Tuned by eye against the ceiling spots; change this one number to
   * brighten or dim every light in the game at once.
   */
  LIGHT_INTENSITY_SCALE: 16.0, // CHOSEN: not in original spec — the source declared no JS mapping, only ratios

  SHAKE: Object.freeze({
    duration: 0.22, // ShoeFXLibrary.cpp — same for every shake in the game
    blendIn: 0.02, // ShoeFXLibrary.cpp
    blendOutFraction: 0.6, // ShoeFXLibrary.cpp
    blendOutSeconds: 0.132, // derived — duration * blendOutFraction; fade-out begins at t = 0.088
    locationAmplitude: 1.2, // ShoeFXLibrary.cpp — peak per-axis position jitter in cm, before envelope and scale
    pitchAmplitude: 1.4, // ShoeFXLibrary.cpp — degrees
    yawAmplitude: 1.4, // ShoeFXLibrary.cpp — degrees
    rollAmplitude: 1.0, // ShoeFXLibrary.cpp — degrees
    jitterMin: -1.0, // ShoeFXLibrary.cpp — redrawn every frame on every axis; per-frame white noise, not coherent
    jitterMax: 1.0, // ShoeFXLibrary.cpp
    scaleNormalShot: 1.0, // ShoeFXLibrary.cpp
    scaleSuppressedShot: 0.4, // ShoeFXLibrary.cpp
    scaleExplosion: 1.5, // ShoeFXLibrary.cpp — stacks on top of the shot's own shake
    dynamicScale: 1.0, // UE default — never set in project code
    affectsAim: false, // ShoeFXLibrary.cpp — purely visual; there is no recoil model anywhere in the game
  }),

  MUZZLE: Object.freeze({
    normal: Object.freeze({
      intensity: 9000.0, // ShoeFXLibrary.cpp — engine candelas
      colorHex: 0xff9128, // ShoeFXLibrary.cpp — sRGB (255, 145, 40), hot orange
      colorLinear: Object.freeze([1.0, 0.2831, 0.0212]), // ShoeFXLibrary.cpp — de-gammaed equivalent
      // RETUNED from the spec's 420: three.js maps this straight onto PointLight.distance,
      // which is a hard cutoff with an inverse-square window inside it, so 420 cm put the
      // brightest event in the game (9000 x FX.LIGHT_INTENSITY_SCALE = 144,000 cd) at zero
      // before it reached a horde standing at 3-8 m. The flash lit the shooter and nothing
      // else and read as a sticker on the lens. Reach is the fix; intensity and fadeSeconds
      // are correct and stay — it is still 45 ms, it just now throws that light across bodies.
      attenuationRadius: 1400.0, // RETUNED: spec said 420 cm — see above
      fadeSeconds: 0.045, // ShoeFXLibrary.cpp — linear falloff from peak to zero
      rampFraction: 0.0, // ShoeFXLibrary.cpp — muzzle flashes do not ramp, they start at peak
    }),
    suppressed: Object.freeze({
      intensity: 1400.0, // ShoeFXLibrary.cpp — 6.43x dimmer
      colorHex: 0x82afff, // ShoeFXLibrary.cpp — sRGB (130, 175, 255), cool blue-white
      colorLinear: Object.freeze([0.2232, 0.4287, 1.0]), // ShoeFXLibrary.cpp
      attenuationRadius: 700.0, // RETUNED: spec said 200 cm — scaled with normal to hold the source's 2.1x-less-reach ratio
      fadeSeconds: 0.02, // ShoeFXLibrary.cpp — 2.25x shorter
      rampFraction: 0.0, // ShoeFXLibrary.cpp
    }),
    /** The flash and fire sound sat at the weapon mesh's own origin; no muzzle socket existed. */
    offsetFromWeaponOrigin: Object.freeze([0.0, 0.0, 0.0]), // ShoeWeaponBase.cpp
    sizeHalfExtent: 14.0, // CHOSEN: not in original spec — cm; the flash card needs a size to bloom
  }),

  LIGHT_PULSE: Object.freeze({
    minFadeSeconds: 0.01, // ShoeFXLibrary.cpp — a pulse can never be shorter than this
    rampFraction: 0.15, // ShoeFXLibrary.cpp — when a pulse ramps, this much of its life is the ramp; the remaining 0.85 is the fade
    meshStartScale: 0.01, // ShoeFXLibrary.cpp — 1 cm on a 100 cm reference sphere
    meshTargetScale: 1.0, // ShoeFXLibrary.cpp — header/parameter default
    defaultPeakIntensity: 5000.0, // ShoeFXLibrary.cpp — header default, always overwritten by Configure()
    defaultFadeSeconds: 0.05, // ShoeFXLibrary.cpp — header default, always overwritten
  }),

  EXPLOSION: Object.freeze({
    blastRadius: 350.0, // ShoeFXLibrary.cpp — the default passed into spawnExplosion, cm
    flashIntensity: 60000.0, // ShoeFXLibrary.cpp — 6.667x the unsuppressed muzzle flash
    flashColorHex: 0xff9632, // ShoeFXLibrary.cpp — sRGB (255, 150, 50)
    flashColorLinear: Object.freeze([1.0, 0.3049, 0.0331]), // ShoeFXLibrary.cpp
    radiusToAttenuationMultiplier: 2.5, // ShoeFXLibrary.cpp — reach = max(radius * 2.5, 400)
    minAttenuationRadius: 400.0, // ShoeFXLibrary.cpp — cm
    flashFadeSeconds: 0.35, // ShoeFXLibrary.cpp
    flashRampSeconds: 0.0525, // derived — 0.35 * 0.15; brightness climbs to peak, then falls over the remaining 0.2975 s
    meshScaleDivisor: 50.0, // ShoeFXLibrary.cpp — scale = max(radius / 50, 1.0); 7.0 at radius 350 gives a fireball whose radius equals the blast
    meshMinScale: 1.0, // ShoeFXLibrary.cpp
    impulseStrength: 1200.0, // ShoeFXLibrary.cpp — direct velocity change in cm/s, mass-independent
    impulseFalloffLinear: true, // ShoeFXLibrary.cpp — 1200 * (1 - d/radius)
    impulseEmitterLifespan: 0.05, // ShoeFXLibrary.cpp — tick disabled, so it fires exactly once
    fireballColorHex: 0xff7a1a, // CHOSEN: not in original spec — the original set three guessed parameter names on a stock debug material
    fireballOpacity: 0.85, // CHOSEN: not in original spec
    smokeSeconds: 1.1, // CHOSEN: not in original spec — no explosion smoke existed anywhere
  }),

  IMPACT: Object.freeze({
    lifeSeconds: 1.5, // ShoeImpactFX.cpp — shards vanished abruptly at this time in the original, with no fade
    lightFadeSeconds: 0.12, // ShoeImpactFX.cpp — then the light sits dark for the remaining 1.38 s
    shardCountHeadshot: 10, // ShoeImpactFX.cpp — wins outright over the bloody test
    shardCountBloody: 8, // ShoeImpactFX.cpp
    shardCountHardSurface: 6, // ShoeImpactFX.cpp
    coneHalfAngleDeg: 55.0, // ShoeImpactFX.cpp — centred on the surface normal
    bloodSpeedMin: 250.0, // ShoeImpactFX.cpp — cm/s
    bloodSpeedMax: 550.0, // ShoeImpactFX.cpp
    debrisSpeedMin: 500.0, // ShoeImpactFX.cpp
    debrisSpeedMax: 950.0, // ShoeImpactFX.cpp
    bloodScaleMin: 0.02, // ShoeImpactFX.cpp — on a 100 cm reference cube, a 2.0 cm gob
    bloodScaleMax: 0.035, // ShoeImpactFX.cpp — 3.5 cm
    // These four are a MEASURED pair, not two independent knobs: segment count and stretch
    // trade against each other in the shard-silhouette gate, and the numbers come from
    // sweeping both against it. A lat-long sphere is NOT uniformly round — the pole is a
    // triangle fan, and when a pole lands on the silhouette it contributes a sharper corner
    // than the 360/width the equator suggests. 12x8 reads like it should turn 30 deg and in
    // fact peaked at 45 deg and failed 1.8% of orientations. Raising either stretch bound or
    // lowering either segment count re-opens that, so re-run the sweep before touching them.
    // Worst turn over 600 random orientations x 7 stretch combinations: 35.7 deg against a
    // 40 deg gate, worst circularity 0.974 against 0.93, zero failures.
    bloodSegmentsWidth: 14, // CHOSEN: not in original spec — 252 tris a gob, against 12 for the box it replaced
    bloodSegmentsHeight: 10, // CHOSEN: not in original spec — 18 deg pole to pole
    bloodStretchMin: 0.92, // CHOSEN: not in original spec — per-axis, applied inside the tumble, so a gob is an ellipsoid that rolls rather than a ball bearing
    bloodStretchMax: 1.10, // CHOSEN: not in original spec — worst aspect 1.196; an ellipse's curvature piles up at the ends, and past ~1.45 a round gob turns sharply enough to fail the gate on its own
    debrisScaleMin: 0.015, // ShoeImpactFX.cpp — 1.5 cm
    debrisScaleMax: 0.03, // ShoeImpactFX.cpp — 3.0 cm
    referenceCubeSize: 100.0, // engine BasicShapes/Cube convention — never stated in project C++
    spinMin: -720.0, // ShoeImpactFX.cpp — deg/s, drawn independently per axis
    spinMax: 720.0, // ShoeImpactFX.cpp
    gravityZ: -980.0, // ShoeImpactFX.cpp — cm/s^2 before the per-type scale
    bloodGravityScale: 1.6, // ShoeImpactFX.cpp — effective -1568 cm/s^2, so gobs arc harder and land sooner
    debrisGravityScale: 1.0, // ShoeImpactFX.cpp
    bounceReflectFactor: 1.35, // ShoeImpactFX.cpp — a perfect mirror would be 2.0
    bounceDamping: 0.6, // ShoeImpactFX.cpp — whole-velocity multiplier after each contact
    effectiveNormalRestitution: 0.21, // derived — (1 - 1.35) * 0.6
    lightIntensityHeadshot: 6000.0, // ShoeImpactFX.cpp
    lightIntensityFlesh: 3200.0, // ShoeImpactFX.cpp
    lightIntensityHardSurface: 2200.0, // ShoeImpactFX.cpp
    lightColorBloodLinear: Object.freeze([0.9, 0.05, 0.05]), // ShoeImpactFX.cpp — already linear, do not de-gamma
    lightColorBloodHex: 0xf63f3f, // ShoeImpactFX.cpp — sRGB equivalent
    lightColorHardLinear: Object.freeze([0.9, 0.85, 0.7]), // ShoeImpactFX.cpp — warm white spark, already linear
    lightColorHardHex: 0xf6efda, // ShoeImpactFX.cpp
    lightRadiusHeadshot: 260.0, // ShoeImpactFX.cpp — cm
    lightRadiusDefault: 160.0, // ShoeImpactFX.cpp — cm
    shardFadeSeconds: 0.35, // CHOSEN: not in original spec — the original popped shards out of existence
    disableLightAfterFade: true, // CHOSEN: not in original spec — the original kept updating a zero-intensity light for 1.38 s
  }),

  BLOOD_DECAL: Object.freeze({
    tintLinear: Object.freeze([0.3, 0.015, 0.015]), // ShoeFXLibrary.cpp — already linear
    tintHex: 0x972222, // ShoeFXLibrary.cpp — sRGB equivalent, dark red
    halfSizeMin: 18.0, // ShoeFXLibrary.cpp — one draw feeds both axes, so decals are always square; 36 cm per side minimum
    halfSizeMax: 34.0, // ShoeFXLibrary.cpp — 68 cm per side maximum
    halfDepthMin: 6.0, // ShoeFXLibrary.cpp — projection into the surface along the normal
    halfDepthMax: 10.0, // ShoeFXLibrary.cpp
    rollMinDeg: 0.0, // ShoeFXLibrary.cpp — so repeated splats never read as the same stamp
    rollMaxDeg: 360.0, // ShoeFXLibrary.cpp
    lifeSpan: 12.0, // ShoeFXLibrary.cpp
    fadeStartDelay: 9.0, // ShoeFXLibrary.cpp
    fadeDuration: 3.0, // ShoeFXLibrary.cpp — reaching zero at t = 12 s
    maxLive: 64, // CHOSEN: not in original spec — the original had no cap, pooling or culling of any kind
    edgeSoftness: 0.45, // CHOSEN: not in original spec — no blood texture, mask or alpha shape existed in the project
  }),

  DAMAGE_NUMBER: Object.freeze({
    lifeSeconds: 0.9, // ShoeDamageNumber.cpp
    riseDistance: 60.0, // ShoeDamageNumber.cpp — cm, on an ease-out quadratic: 1 - (1-t)^2
    colorHeadLinear: Object.freeze([1.0, 0.12, 0.08]), // ShoeDamageNumber.cpp — already linear
    colorHeadHex: 0xff6150, // ShoeDamageNumber.cpp
    sizeHead: 52.0, // ShoeDamageNumber.cpp — settled text height in cm, 1.73x the body size
    colorChestLinear: Object.freeze([1.0, 0.65, 0.05]), // ShoeDamageNumber.cpp
    colorChestHex: 0xffd33f, // ShoeDamageNumber.cpp
    sizeChest: 36.0, // ShoeDamageNumber.cpp
    colorBodyLinear: Object.freeze([1.0, 1.0, 1.0]), // ShoeDamageNumber.cpp
    colorBodyHex: 0xffffff, // ShoeDamageNumber.cpp
    sizeBody: 30.0, // ShoeDamageNumber.cpp
    defaultTargetSize: 32.0, // ShoeDamageNumber.h — header default, always overwritten by Init
    punchScaleFactor: 1.3, // ShoeDamageNumber.cpp — spawns 30% oversized; a headshot starts at 67.6 cm
    punchFraction: 0.2, // ShoeDamageNumber.cpp — 0.18 s to settle
    fadeStartFraction: 0.4, // ShoeDamageNumber.cpp — holds full opacity to 0.36 s
    fadeDurationFraction: 0.6, // ShoeDamageNumber.cpp — 0.54 s, reaching zero at 0.9 s
    minValue: 0, // ShoeDamageNumber.cpp — round(damage) floored at 0; no sign, decimals or separators
    billboard: true, // CHOSEN: not in original spec — the original aimed the actor's forward axis at the camera, which renders the glyphs mirrored
    maxLive: 48, // CHOSEN: not in original spec — a shotgun blast into a crowd spawned 8 at once with no budget
  }),

  DAMAGE_FLASH: Object.freeze({
    triggerValue: 1.0, // ShoeHUD.cpp — hard-SET on any negative health delta and on death; it does not accumulate
    decayRate: 1.75, // ShoeHUD.cpp — alpha units lost per second
    fullDecaySeconds: 0.5714285714, // derived — 1 / 1.75
    vignetteBandCount: 4, // ShoeHUD.cpp — nested edge bands approximating a vignette without a shader
    vignetteThicknessFraction: 0.06, // ShoeHUD.cpp — of min(viewportW, viewportH); 64.8 px at 1920x1080
    vignetteAlphaScale: 0.35, // ShoeHUD.cpp — band i alpha = flashAlpha * (1 - i/4) * 0.35
    vignetteColorLinear: Object.freeze([0.9, 0.05, 0.05]), // ShoeHUD.cpp — already linear
    vignetteColorHex: 0xf63f3f, // ShoeHUD.cpp
  }),

  CROSSHAIR: Object.freeze({
    gap: 8.0, // ShoeHUD.cpp:24 — px from screen centre to each arm
    length: 10.0, // ShoeHUD.cpp:25 — px per arm
    thickness: 2.0, // ShoeHUD.cpp — px
    colorRgba: Object.freeze([1.0, 1.0, 1.0, 0.8]), // ShoeHUD.cpp
    laserGapMultiplier: 0.5, // ShoeHUD.cpp — 8 -> 4 px
    laserLengthMultiplier: 0.7, // ShoeHUD.cpp — 10 -> 7 px
    laserThickness: 1.5, // ShoeHUD.cpp — px, thinner to read as more precise
    laserColorRgba: Object.freeze([0.1, 1.0, 0.2, 0.9]), // ShoeHUD.cpp
  }),

  /** The original computed 5 incendiary ticks and drew absolutely nothing for them. */
  BURN: Object.freeze({
    colorHex: 0xff7a18, // CHOSEN: not in original spec
    emissiveIntensity: 1.8, // CHOSEN: not in original spec
    pulseHz: 7.0, // CHOSEN: not in original spec
    emberCount: 14, // CHOSEN: not in original spec
    emberRiseSpeed: 90.0, // CHOSEN: not in original spec — cm/s
    lightIntensity: 2000.0, // CHOSEN: not in original spec — engine-candela scale
    lightRadius: 220.0, // CHOSEN: not in original spec — cm
  }),

  /** No tracer, shell ejection or muzzle smoke was defined anywhere in the original. */
  TRACER: Object.freeze({
    enabled: true, // CHOSEN: not in original spec
    lifeSeconds: 0.06, // CHOSEN: not in original spec
    thickness: 1.6, // CHOSEN: not in original spec — cm
    colorHex: 0xffcf7a, // CHOSEN: not in original spec
    emissiveIntensity: 4.0, // CHOSEN: not in original spec
    everyNthPellet: 3, // CHOSEN: not in original spec — 8 tracers per shotgun blast would be a laser show
  }),

  /** The floating damage number was the ONLY hit feedback in the original. */
  HIT_MARKER: Object.freeze({
    enabled: true, // CHOSEN: not in original spec
    lifeSeconds: 0.12, // CHOSEN: not in original spec
    spreadPx: 5.0, // CHOSEN: not in original spec — how far the crosshair arms kick out
    colorHex: 0xffffff, // CHOSEN: not in original spec
    killColorHex: 0xff3b30, // CHOSEN: not in original spec
    headshotColorHex: 0xffb020, // CHOSEN: not in original spec
  }),

  /** The original had no pooling, culling or LOD, and nobody ever measured the framerate under load. */
  BUDGET: Object.freeze({
    maxImpactBursts: 24, // CHOSEN: not in original spec
    maxDynamicLights: 12, // CHOSEN: not in original spec — beyond the 28 static station lights
    maxShardsTotal: 240, // CHOSEN: not in original spec
    cullEffectsBeyond: 4000.0, // CHOSEN: not in original spec — cm from the camera
  }),

  /**
   * Post stack. None of this existed in the original, which is most of why it looked flat.
   *
   * BLOOM, and why it is now a quarter of what it was. The threshold comment used to claim
   * "emissive signage and muzzle flash sit above it, lit concrete does not". That was simply
   * false. The threshold is applied to the PRE-TONEMAP LINEAR buffer, where a sodium lamp
   * landing on a pale concrete slab is comfortably over 0.78 — so the platform floor, the
   * mezzanine soffit and the whole vault ceiling were being treated as emitters and smeared
   * back over the frame. Measured on identical cameras with the look toggled at runtime:
   *
   *   platform  124.8 mean /  2.77% black  ->  72.5 mean / 23.16% black
   *   train      79.9        /  0.96%      ->  57.9       / 15.36%
   *   boss       46.7        /  8.68%      ->  36.1       / 20.02%
   *
   * A night subway was rendering at daylight-office luminance with the blacks filled in, the
   * stair mouth was a featureless white blob, and the pistol read as white instead of steel.
   * Nothing was wrong with the light rig underneath it — world/lighting.js is correct and must
   * not be re-tuned to compensate. The fix is to stop thresholding halfway down the diffuse
   * range: at 1.05 only genuine over-unity emitters bloom, which is what the old comment
   * believed was already happening. Strength and radius come down with it so the emitters that
   * DO qualify — signage, muzzle flash, the Spitter's gut, the Conductor's furnace — read as
   * hot rather than as fog.
   *
   * The menu is unaffected: swept across the whole range it scores 43.5 / 42.6 / 39.9 at x1.0 /
   * x0.35 / x0.2, so the strongest frame in the game pays essentially nothing for this.
   */
  POST: Object.freeze({
    bloomStrength: 0.25, // CHOSEN: not in original spec — was 0.62, which smeared lit concrete back over the blacks
    bloomRadius: 0.40, // CHOSEN: not in original spec — was 0.55; a tighter halo reads as a hot source, a wide one as haze
    bloomThreshold: 1.05, // CHOSEN: not in original spec — PRE-TONEMAP LINEAR, so only over-unity emitters qualify; at 0.78 lit concrete did
    gtaoRadius: 60.0, // CHOSEN: not in original spec — cm
    gtaoIntensity: 1.1, // CHOSEN: not in original spec
    gtaoEnabled: true, // CHOSEN: not in original spec — no baked AO data existed
    dofFocusDistance: 900.0, // CHOSEN: not in original spec — cm
    dofFocalLength: 28.0, // CHOSEN: not in original spec
    dofBokehScale: 1.6, // CHOSEN: not in original spec
    dofEnabled: false, // CHOSEN: not in original spec — off during a firefight, on for the menu and death cameras
    chromaticAberration: 0.0008, // CHOSEN: not in original spec — 0.0022 separated R from B by ~4 px at 1280 wide, which turned every tile course into rainbow moire; this is a fringe, not a band
    filmGrain: 0.09, // CHOSEN: not in original spec — sodium-lit concrete needs grain or it plasticises
    fxaaEnabled: true, // CHOSEN: not in original spec
    vignetteStrength: 0.42, // CHOSEN: not in original spec — the permanent lens vignette, distinct from the red damage flash
  }),
})

// ---------------------------------------------------------------------------
// AUDIO — 41 clips, no buses, no attenuation assets, per-call gain only
// ---------------------------------------------------------------------------

export const AUDIO = Object.freeze({
  /** Original lookup was /Game/Audio/<Category>/<Name>. The web build re-roots it and ships mp3. */
  ROOT: '/game/audio', // public/game/audio — re-rooted from ShoeAudio.h SFX_LOOKUP_PATH_TEMPLATE
  CATEGORY_PATHS: Object.freeze({
    weapons: '/game/audio/sfx', // the original's Weapons/ category
    zombies: '/game/audio/sfx', // the original's Zombies/ category; flattened in the web build
    ambience: '/game/audio/ambience', // ShoeAudio.h
    vo: '/game/audio/vo', // ShoeVoiceDirector.cpp VO_PACKAGE_PATH
  }),
  fileExtension: '.mp3', // public/game/audio — the original shipped 44.1 kHz mono 16-bit WAV; the web build ships the mp3 twins

  FORMAT: Object.freeze({
    sampleRate: 44100, // every shipped WAV, no exceptions
    channels: 1, // every shipped WAV is mono
    bitDepth: 16, // every shipped WAV
    shippedClipCount: 53, // Ambience 4, VO 34, Weapons 8, Zombies 7
    orphanClipCount: 12, // shipped and imported with no code path that can ever play them
  }),

  DEFAULTS: Object.freeze({
    spatialVolume: 1.0, // ShoeAudio.cpp playAt
    spatialPitch: 1.0, // ShoeAudio.cpp playAt
    uiVolume: 1.0, // ShoeAudio.cpp play2D — every voice line uses it
    uiPitch: 1.0, // ShoeAudio.cpp play2D — no voice line is ever pitch-shifted
  }),

  /**
   * Cue sheet. `seconds` is the measured source duration, which matters because several cues
   * outlive the thing that spawned them (zombie_death_1 at 8.982 s outlives the 8.0 s corpse,
   * train_arriving at 20.195 s is still playing 16.195 s after the train docks).
   */
  CUES: Object.freeze({
    headshot_splat: Object.freeze({ category: 'weapons', seconds: 0.48 }),
    bullet_casing: Object.freeze({ category: 'weapons', seconds: 1.43 }),
    pistol_suppressed: Object.freeze({ category: 'weapons', seconds: 0.278 }),
    pistol_shot: Object.freeze({ category: 'weapons', seconds: 1.7 }), // RawAssets/Audio/Weapons
    rifle_shot: Object.freeze({ category: 'weapons', seconds: 1.74 }), // RawAssets/Audio/Weapons
    shotgun_blast: Object.freeze({ category: 'weapons', seconds: 2.02 }), // RawAssets/Audio/Weapons
    magazine_reload: Object.freeze({ category: 'weapons', seconds: 0.542 }), // RawAssets/Audio/Weapons — 3.69x shorter than the 2.0 s reload
    empty_chamber_click: Object.freeze({ category: 'weapons', seconds: 0.94 }), // RawAssets/Audio/Weapons — unreachable in the original
    explosion: Object.freeze({ category: 'weapons', seconds: 8.351 }), // RawAssets/Audio/Weapons
    zombie_growl_1: Object.freeze({ category: 'zombies', seconds: 3.1 }), // RawAssets/Audio/Zombies
    zombie_growl_2: Object.freeze({ category: 'zombies', seconds: 1.977 }), // RawAssets/Audio/Zombies
    zombie_growl_3: Object.freeze({ category: 'zombies', seconds: 2.157 }), // RawAssets/Audio/Zombies
    zombie_attack_swipe: Object.freeze({ category: 'zombies', seconds: 2.064 }), // RawAssets/Audio/Zombies
    zombie_death_1: Object.freeze({ category: 'zombies', seconds: 8.982 }), // RawAssets/Audio/Zombies
    zombie_death_2: Object.freeze({ category: 'zombies', seconds: 1.7 }), // RawAssets/Audio/Zombies
    zombie_scream: Object.freeze({ category: 'zombies', seconds: 12.756, orphan: true }), // RawAssets/Audio/Zombies — no call site in the original
    train_arriving: Object.freeze({ category: 'ambience', seconds: 20.195 }), // RawAssets/Audio/Ambience
    station_ambience_loop: Object.freeze({ category: 'ambience', seconds: 11.642 }), // RawAssets/Audio/Ambience
    train_doors_open: Object.freeze({ category: 'ambience', seconds: 2.541, orphan: true }), // RawAssets/Audio/Ambience
    alarm_siren: Object.freeze({ category: 'ambience', seconds: 22.749, orphan: true }), // RawAssets/Audio/Ambience
  }),

  VO_CLIPS: Object.freeze({
    vo_hurt_ouch: Object.freeze({ seconds: 0.4195 }),
    vo_hurt_ooh: Object.freeze({ seconds: 0.54 }),
    vo_hurt_ermph: Object.freeze({ seconds: 0.325 }),
    vo_hurt_argh: Object.freeze({ seconds: 0.33356 }),
    vo_headshot: Object.freeze({ seconds: 0.61 }),
    vo_killstreak: Object.freeze({ seconds: 1.09 }),
    vo_rampage: Object.freeze({ seconds: 0.7 }),
    vo_bloodbath: Object.freeze({ seconds: 1.06 }),
    vo_massacre: Object.freeze({ seconds: 0.61 }),
    vo_terminus: Object.freeze({ seconds: 0.57 }),
    vo_intro: Object.freeze({ seconds: 5.52 }), // JeremySay opening narration, measured MP3 duration
    vo_wave_start: Object.freeze({ seconds: 1.12 }), // RawAssets/Audio/VO
    vo_boss_incoming: Object.freeze({ seconds: 3.28 }), // RawAssets/Audio/VO
    vo_wave_clear: Object.freeze({ seconds: 2.24 }), // RawAssets/Audio/VO
    vo_game_over: Object.freeze({ seconds: 2.48 }), // RawAssets/Audio/VO
    vo_countdown_10: Object.freeze({ seconds: 1.28 }), // RawAssets/Audio/VO — the only countdown line that overruns its 1.0 s slot
    vo_countdown_9: Object.freeze({ seconds: 0.64 }), // RawAssets/Audio/VO
    vo_countdown_8: Object.freeze({ seconds: 0.56 }), // RawAssets/Audio/VO
    vo_countdown_7: Object.freeze({ seconds: 0.88 }), // RawAssets/Audio/VO
    vo_countdown_6: Object.freeze({ seconds: 0.96 }), // RawAssets/Audio/VO
    vo_countdown_5: Object.freeze({ seconds: 0.88 }), // RawAssets/Audio/VO
    vo_countdown_4: Object.freeze({ seconds: 0.88 }), // RawAssets/Audio/VO
    vo_countdown_3: Object.freeze({ seconds: 0.64 }), // RawAssets/Audio/VO
    vo_countdown_2: Object.freeze({ seconds: 0.72 }), // RawAssets/Audio/VO
    vo_countdown_1: Object.freeze({ seconds: 0.64 }), // RawAssets/Audio/VO
    vo_health_pickup: Object.freeze({ seconds: 2.24 }),
    vo_armor_pickup: Object.freeze({ seconds: 0.8 }), // RawAssets/Audio/VO
    vo_dual_wield: Object.freeze({ seconds: 2.4, orphan: true }), // RawAssets/Audio/VO
    vo_low_health: Object.freeze({ seconds: 2.64, orphan: true }), // RawAssets/Audio/VO
    vo_train_inbound: Object.freeze({ seconds: 2.56, orphan: true }), // RawAssets/Audio/VO
    vo_mod_armorpierce: Object.freeze({ seconds: 2.0, orphan: true }), // RawAssets/Audio/VO
    vo_mod_incendiary: Object.freeze({ seconds: 2.16, orphan: true }), // RawAssets/Audio/VO
    vo_mod_laser: Object.freeze({ seconds: 2.4, orphan: true }), // RawAssets/Audio/VO
    vo_mod_silencer: Object.freeze({ seconds: 2.88, orphan: true }), // RawAssets/Audio/VO
  }),

  COMBAT: Object.freeze({
    hurtCues: Object.freeze(['vo_hurt_ouch', 'vo_hurt_ooh', 'vo_hurt_ermph', 'vo_hurt_argh']),
    hurtCooldown: 1.4,
    pendingSeconds: 1.25,
    splatCooldown: 0.055,
    splatVolume: 0.85,
    casingVolume: 0.35,
    maxCasings: 12,
    casingDelay: Object.freeze({ pistol: 0.18, rifle: 0.2, shotgun: 0.45 }),
    milestones: Object.freeze([
      Object.freeze({ kills: 3, cue: 'vo_killstreak', text: 'KILLSTREAK!!' }),
      Object.freeze({ kills: 5, cue: 'vo_rampage', text: 'RAMPAGE!!' }),
      Object.freeze({ kills: 10, cue: 'vo_bloodbath', text: 'BLOODBATH!!' }),
      Object.freeze({ kills: 15, cue: 'vo_massacre', text: 'MASSACRE!!' }),
      Object.freeze({ kills: 20, cue: 'vo_terminus', text: 'TERMINUS!!' }),
    ]),
  }),

  VOICE: Object.freeze({
    countdownMinSpeakable: 1, // ShoeVoiceDirector.cpp — a request for 0 is silently ignored, so the countdown stops a second early
    countdownMaxSpeakable: 10, // ShoeVoiceDirector.cpp
    waveStartLine: 'vo_wave_start', // ShoeVoiceDirector.cpp — chosen when bossCount == 0
    bossIncomingLine: 'vo_boss_incoming', // ShoeVoiceDirector.cpp — chosen when bossCount > 0
    waveClearLine: 'vo_wave_clear', // ShoeVoiceDirector.cpp
    gameOverLine: 'vo_game_over', // ShoeVoiceDirector.cpp
    introLine: 'vo_intro', // ShoeVoiceDirector.cpp
    volume: 1.0, // ShoeVoiceDirector.cpp — play2D default
    /** The orphan lines had obvious homes the C++ never committed to. The port wires them. */
    lowHealthLine: 'vo_low_health', // CHOSEN: not in original spec — the clip shipped with no call site
    lowHealthThreshold: 0.3, // CHOSEN: not in original spec — fraction of max health; no threshold constant existed anywhere
    lowHealthCooldown: 25.0, // CHOSEN: not in original spec — seconds, so it does not nag
    healthPickupLine: 'vo_health_pickup',
    armorPickupLine: 'vo_armor_pickup', // CHOSEN: not in original spec
    dualWieldLine: 'vo_dual_wield', // CHOSEN: not in original spec
    trainInboundLine: 'vo_train_inbound', // CHOSEN: not in original spec
    modLines: Object.freeze({
      silencer: 'vo_mod_silencer', // CHOSEN: not in original spec
      armorPiercing: 'vo_mod_armorpierce', // CHOSEN: not in original spec
      incendiary: 'vo_mod_incendiary', // CHOSEN: not in original spec
      laserSight: 'vo_mod_laser', // CHOSEN: not in original spec
    }),
    ducksOtherChannels: true, // CHOSEN: not in original spec — the original had no ducking, so vo_intro talked over vo_wave_start at t=0
    duckAmount: 0.45, // CHOSEN: not in original spec — gain multiplier applied to non-VO channels while a line plays
    duckAttack: 0.08, // CHOSEN: not in original spec — seconds
    duckRelease: 0.35, // CHOSEN: not in original spec — seconds
  }),

  AMBIENCE: Object.freeze({
    cue: 'station_ambience_loop', // ShoeAudio.cpp
    volume: 0.35, // ShoeAudio.cpp — the quietest thing in the game
    position: Object.freeze([3000.0, 0.0, 150.0]), // ShoeAudio.cpp — station-local
    autoActivate: true, // ShoeAudio.cpp — started on creation and again explicitly; never stopped or faded
    isUiSound: false, // ShoeAudio.cpp — a world sound, so it spatialises if attenuation is ever added
    loop: true, // CHOSEN: not in original spec — the C++ never set a loop flag, so as wired the station fell silent after 11.642 s
    fadeInSeconds: 2.0, // CHOSEN: not in original spec — nothing in the original faded anything
  }),

  TRAIN: Object.freeze({
    arrivingCue: 'train_arriving', // ShoeTrain.cpp
    arrivingVolume: 1.0, // ShoeTrain.cpp
    arrivingPosition: Object.freeze([-3000.0, 0.0, 0.0]), // ShoeTrain.cpp — emitted at the staging point, 3000 cm from the dock
    departCue: null, // ShoeTrain.cpp — the departure has no sound cue at all in the original
    doorsOpenCue: 'train_doors_open', // CHOSEN: not in original spec — the clip shipped with no call site
  }),

  /**
   * No attenuation, concurrency, sound-class or submix asset existed anywhere, so spatial cues
   * played at constant gain regardless of distance. Every value here is new.
   */
  ATTENUATION: Object.freeze({
    distanceModel: 'inverse', // CHOSEN: not in original spec — WebAudio PannerNode distanceModel
    refDistance: 250.0, // CHOSEN: not in original spec — cm
    maxDistance: 6000.0, // CHOSEN: not in original spec — cm, the length of the station
    rolloffFactor: 1.1, // CHOSEN: not in original spec
    panningModel: 'HRTF', // CHOSEN: not in original spec
    coneInnerAngle: 360, // CHOSEN: not in original spec — omnidirectional, matching the original's lack of cones
  }),

  /** The only balance that existed was the per-call gains; these buses are new. */
  MIX: Object.freeze({
    master: 0.34, // Headroom for overlapping rifle tails and announcer playback.
    sfx: 1.0, // CHOSEN: not in original spec
    voice: 1.0, // CHOSEN: not in original spec
    ambience: 1.0, // CHOSEN: not in original spec — the 0.35 per-call gain already sets its level
    maxSimultaneousVoices: 32, // CHOSEN: not in original spec — no concurrency asset existed; 60 zombies could all swipe at once
    voiceStealing: 'oldest', // CHOSEN: not in original spec
  }),
})

// ---------------------------------------------------------------------------
// SCORE — entirely new. The original counted raw kills and nothing else.
// ---------------------------------------------------------------------------

export const SCORE = Object.freeze({
  /** No archetype was worth more than any other in the original; there was no points value at all. */
  perKill: Object.freeze({
    base: 10, // CHOSEN: not in original spec
    zerg: 15, // CHOSEN: not in original spec — harder to hit than it is to kill
    ranged: 25, // CHOSEN: not in original spec — killing it is the difference between taking chip damage and not
    tank: 100, // CHOSEN: not in original spec
    boss: 500, // CHOSEN: not in original spec
  }),

  headshotMultiplier: 2.0, // CHOSEN: not in original spec
  chestMultiplier: 1.25, // CHOSEN: not in original spec
  waveClearBonusPerWave: 100, // CHOSEN: not in original spec — bonus = waveNumber * this
  noDamageWaveBonus: 250, // CHOSEN: not in original spec

  comboWindow: 2.5, // CHOSEN: not in original spec — seconds since the last kill before the chain drops
  comboStep: 0.1, // CHOSEN: not in original spec — multiplier added per chained kill
  comboMax: 3.0, // CHOSEN: not in original spec

  /** The original banked headshots as a literal 0 with a comment saying they were not tracked. */
  trackHeadshots: true, // CHOSEN: not in original spec
})

// ---------------------------------------------------------------------------
// HUD — the canvas readout. Pixels, not centimetres.
// ---------------------------------------------------------------------------

export const HUD = Object.freeze({
  margin: 32.0, // ShoeHUD.cpp:16 — px
  portraitSize: 128.0, // ShoeHUD.cpp:17
  barWidth: 260.0, // ShoeHUD.cpp:18 — the soft-cap width of both stat bars
  healthBarHeight: 26.0, // ShoeHUD.cpp:19
  armorBarHeight: 20.0, // ShoeHUD.cpp:20
  barSpacing: 10.0, // ShoeHUD.cpp:21
  overfillFraction: 0.35, // ShoeHUD.cpp:22 — 260 * 0.35 = 91 px of headroom
  logoSize: 64.0, // ShoeHUD.cpp:23
  logoPosition: Object.freeze([16.0, 16.0]), // ShoeHUD.cpp — margin * 0.5 on both axes
  logoFallbackHeightScale: 0.4, // ShoeHUD.cpp — 64 * 0.4 = 25.6 px
  barPortraitGap: 20.0, // ShoeHUD.cpp:299

  barBackingRgba: Object.freeze([0.03, 0.03, 0.03, 0.85]), // ShoeHUD.cpp:232 — drawn 2 px outset, spanning the overfill headroom (355 px wide)
  barBorderRgba: Object.freeze([1.0, 1.0, 1.0, 0.18]), // ShoeHUD.cpp:233 — 2 px top and bottom
  healthColorHex: 0xe03a3a, // ShoeHUD.cpp:303
  healthOverfillColorHex: 0xff9a9a, // ShoeHUD.cpp:304 — the 100-200 range
  armorColorHex: 0x2fd3e0, // ShoeHUD.cpp:305
  armorOverfillColorHex: 0xc0faff, // ShoeHUD.cpp:306 — the 200-300 range
  healthLabelOffset: Object.freeze([6.0, 4.0]), // ShoeHUD.cpp — px from the bar's top-left
  armorLabelOffset: Object.freeze([6.0, 2.0]), // ShoeHUD.cpp

  portraitFallbackBackingInset: 3.0, // ShoeHUD.cpp:282 — a 134x134 rgba(0.05,0.05,0.05,0.9) plate
  burnPulseFrequency: 6.0, // ShoeHUD.cpp:294 — radians/second, period 1.0471975512 s
  burnOverlayRgb: Object.freeze([1.0, 0.45, 0.0]), // ShoeHUD.cpp:295
  burnOverlayAlphaBase: 0.2, // ShoeHUD.cpp:295 — alpha = 0.2 + 0.35 * pulse, so 0.20 to 0.55
  burnOverlayAlphaSwing: 0.35, // ShoeHUD.cpp:295
  burnTextRgba: Object.freeze([1.0, 0.55, 0.1, 1.0]), // ShoeHUD.cpp:296
  burnTextOffsetY: -20.0, // ShoeHUD.cpp — px above the portrait top

  modRowYOffset: -26.0, // ShoeHUD.cpp — px above the ammo text baseline
  modChipGap: 14.0, // ShoeHUD.cpp — row is laid out right to left
  modChipPadding: Object.freeze([-6.0, -3.0, 12.0, 6.0]), // ShoeHUD.cpp — x, y, width, height deltas
  modChipRgba: Object.freeze([0.05, 0.05, 0.05, 0.75]), // ShoeHUD.cpp
  modTextColorHex: 0xffb020, // ShoeHUD.cpp

  waveHeaderTopY: 24.0, // ShoeHUD.cpp — px from the top, centred horizontally
  countdownTextScale: 2.5, // ShoeHUD.cpp — font scale on the intermission number
  countdownColorHex: 0xffb020, // ShoeHUD.cpp
  countdownSubtitle: 'NEXT TRAIN INBOUND', // ShoeHUD.cpp
  countdownSubtitleGap: 4.0, // ShoeHUD.cpp — px below the number
  waveSubtitleGap: 2.0, // ShoeHUD.cpp — px below the WAVE n line
  zombiesRemainingColorHex: 0xe03a3a, // ShoeHUD.cpp — the live on-screen count, not the count left in the wave

  initialWaveNumber: 1, // ShoeHUD.cpp — before any wave event arrives
  initialZombiesRemaining: 0, // ShoeHUD.cpp
  initialCountdown: -1, // ShoeHUD.cpp — sentinel; the countdown draws only when this is >= 0

  /** The How To Play screen stated these numbers to the player; they must stay in step with DAMAGE. */
  HOW_TO_PLAY: Object.freeze({
    headMultiplierText: '5x', // ShoeMenuHUD.cpp
    chestMultiplierText: '3x', // ShoeMenuHUD.cpp
    bodyMultiplierText: '1x', // ShoeMenuHUD.cpp
    armorCapText: 'caps at 200', // ShoeMenuHUD.cpp — matches HEALTH.maxArmor
    healText: 'heals 50% of max health', // ShoeMenuHUD.cpp — matches PICKUPS.healPercent
  }),
})

// ---------------------------------------------------------------------------
// MENU — title and game-over front end
// ---------------------------------------------------------------------------

export const MENU = Object.freeze({
  PALETTE: Object.freeze({
    bloodRedHex: 0xb3121c, // ShoeMenuHUD.cpp:14
    offWhiteHex: 0xe8e4dc, // ShoeMenuHUD.cpp:15
    amberHex: 0xffb020, // ShoeMenuHUD.cpp:16
    backgroundRgb: Object.freeze([0.04, 0.04, 0.047]), // ShoeMenuHUD.cpp:102 — full-screen fill behind the sweep
  }),

  LIST: Object.freeze({
    startYFraction: 0.68, // ShoeMenuHUD.cpp:144 — of screen height
    itemSpacing: 46.0, // ShoeMenuHUD.cpp — px
    itemScale: 1.4, // ShoeMenuHUD.cpp
    hoverPadX: 40.0, // ShoeMenuHUD.cpp:159 — px of horizontal expansion on the measured text bounds
    hoverPadY: 8.0, // ShoeMenuHUD.cpp:160
    highlightAlpha: 0.16, // ShoeMenuHUD.cpp:186 — amber
    highlightOffset: Object.freeze([-34.0, -4.0]), // ShoeMenuHUD.cpp:187 — px
    highlightGrow: Object.freeze([68.0, 8.0]), // ShoeMenuHUD.cpp:188 — width+68, height+8
    caretLeftOffset: -26.0, // ShoeMenuHUD.cpp — the '>' marker, px
    caretRightOffset: 12.0, // ShoeMenuHUD.cpp — the '<' marker, px
    wraps: true, // ShoeMenuHUD.cpp — selection wraps in both directions; down is tested first
  }),

  TITLE_ITEMS: Object.freeze(['START RUN', 'HOW TO PLAY', 'QUIT']), // ShoeMenuHUD.cpp:284-304
  GAME_OVER_ITEMS: Object.freeze(['RETRY', 'MAIN MENU']), // ShoeMenuHUD.cpp:427-443

  KEYS: Object.freeze({
    down: Object.freeze(['KeyS', 'ArrowDown']), // ShoeMenuHUD.cpp:58-77
    up: Object.freeze(['KeyW', 'ArrowUp']), // ShoeMenuHUD.cpp:58-77
    confirm: Object.freeze(['Enter', 'Space']), // ShoeMenuHUD.cpp:134-141 — or left mouse button
    back: Object.freeze(['Escape', 'Backspace']), // ShoeMenuHUD.cpp:171-174
  }),

  SWEEP: Object.freeze({
    period: 9.0, // ShoeMenuHUD.cpp:105 — seconds for the blood-red band to drift top to bottom
    bandCount: 5, // ShoeMenuHUD.cpp
    bandSpacing: 40.0, // ShoeMenuHUD.cpp — offsetY = (i - 2) * 40
    bandHeight: 36.0, // ShoeMenuHUD.cpp — px
    bandAlphaPeak: 0.05, // ShoeMenuHUD.cpp — alpha = 0.05 * (1 - |i-2| / 2.5)
    bandAlphaFalloff: 2.5, // ShoeMenuHUD.cpp
    colorRgb: Object.freeze([0.35, 0.02, 0.03]), // ShoeMenuHUD.cpp
    travelPadding: 400.0, // ShoeMenuHUD.cpp — centreY = phase * (height + 400) - 200
    travelOffset: -200.0, // ShoeMenuHUD.cpp
  }),

  VIGNETTE: Object.freeze({
    pulseRate: 0.6, // ShoeMenuHUD.cpp:118 — pulse = 0.5 + 0.5*sin(time * 0.6)
    alphaBase: 0.35, // ShoeMenuHUD.cpp:119
    alphaSwing: 0.15, // ShoeMenuHUD.cpp:120
    thicknessFraction: 0.18, // ShoeMenuHUD.cpp:121 — of screen height, top and bottom
  }),

  TITLE_LAYOUT: Object.freeze({
    logoSize: 72.0, // ShoeMenuHUD.cpp:240-282 — px
    logoY: 36.0, // ShoeMenuHUD.cpp
    titleScale: 3.2, // ShoeMenuHUD.cpp — multiple of the large font
    portraitSize: 180.0, // ShoeMenuHUD.cpp — px
    portraitXFraction: 0.16, // ShoeMenuHUD.cpp — of screen width
    portraitYFraction: 0.55, // ShoeMenuHUD.cpp — of screen height
    statsPanelWidth: 260.0, // ShoeMenuHUD.cpp:212-228
    statsPanelHeight: 190.0, // ShoeMenuHUD.cpp
    statsPanelRightInset: 300.0, // ShoeMenuHUD.cpp — x = width - 300
    statsPanelYFraction: 0.4, // ShoeMenuHUD.cpp
    statsRowPitch: 28.0, // ShoeMenuHUD.cpp — px
    statsFirstRowOffset: 34.0, // ShoeMenuHUD.cpp — px below the header
    statsRows: Object.freeze(['BEST WAVE', 'TOTAL KILLS', 'HEADSHOTS', 'GAMES PLAYED']), // ShoeMenuHUD.cpp
  }),

  GAME_OVER_LAYOUT: Object.freeze({
    headline: 'YOU DIED', // ShoeMenuHUD.cpp:398-425
    headlineScale: 2.4, // ShoeMenuHUD.cpp — multiple of the large font
    headlineYFraction: 0.18, // ShoeMenuHUD.cpp — of screen height
    statRowGap: 10.0, // ShoeMenuHUD.cpp — px added to each row's own height
    bestWaveGap: 16.0, // ShoeMenuHUD.cpp — extra px before the best-wave line
    /** The original banked the run BEFORE reading the stored best, so this banner could never fire. */
    newBestUsesPreviousBest: true, // CHOSEN: not in original spec — snapshot the previous best so the banner works
  }),
})

// ---------------------------------------------------------------------------
// SAVE — one slot, six fields
// ---------------------------------------------------------------------------

export const SAVE = Object.freeze({
  slotName: 'ShoeinatorSave', // ShoeSaveGame.cpp:3
  userIndex: 0, // ShoeSaveGame.h:15 — single-player
  maxRecentScores: 10, // ShoeSaveGame.h:18 — oldest entries drop off the front

  DEFAULTS: Object.freeze({
    bestWave: 0, // ShoeSaveGame.h:21-36
    totalKills: 0, // ShoeSaveGame.h
    totalHeadshots: 0, // ShoeSaveGame.h
    totalPlayTime: 0.0, // ShoeSaveGame.h
    gamesPlayed: 0, // ShoeSaveGame.h
    recentWaveScores: Object.freeze([]), // ShoeSaveGame.h
  }),

  /** bestWave = max(bestWave, waveReached); the rest accumulate; recentWaveScores pushes then trims. */
  storageKey: 'SMA-last-engineer', // CHOSEN: not in original spec — localStorage key for the web port
})

// ---------------------------------------------------------------------------
// RUN — per-run counters and the states the machine moves between
// ---------------------------------------------------------------------------

export const RUN = Object.freeze({
  initialZombiesAlive: 0, // ShoeGameMode.h
  initialTotalKills: 0, // ShoeGameMode.h — cumulative, all archetypes, no weighting
  initialRunOver: false, // ShoeGameMode.h — latch so the run is banked exactly once
  initialRunStartTime: 0.0, // ShoeGameMode.h — captured on first player spawn, only if still exactly 0.0

  STATES: Object.freeze(['menu', 'howToPlay', 'intermission', 'fight', 'gameOver']), // ShoeGameMode.cpp / ShoeMenuHUD.cpp

  /** There is no win condition, no wave cap and no difficulty ceiling but the 2.0 speed clamp. */
  waveCap: Infinity, // ShoeWaveDirector.cpp — health and damage scale linearly and without bound forever
})

// ---------------------------------------------------------------------------
// Convenience roll-up. Import the named groups by preference; this exists so a
// test or the soak can dump the whole ruleset in one line.
// ---------------------------------------------------------------------------

export const RULES = Object.freeze({
  UNITS,
  DAMAGE,
  WEAPONS,
  ZOMBIES,
  WAVES,
  PLAYER,
  HEALTH,
  STATION,
  TRAIN,
  PICKUPS,
  FX,
  AUDIO,
  SCORE,
  HUD,
  MENU,
  SAVE,
  RUN,
})

export default RULES
