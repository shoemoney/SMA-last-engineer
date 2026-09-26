/**
 * summit.js — the level above the level.
 *
 * Until now the tallest thing in ShoeINATOR was a balcony 250 cm off the platform, and the
 * only thing above it was a painted rectangle of daylight glued to the underside of the
 * light well's blind cap. The ROOM went to Z 940. The GAME stopped at 250.
 *
 * This file keeps climbing. Three more pitches rise out of the mezzanine, up the inside of
 * the well the station already built, and out through a hole cut in the pavement onto a
 * city street at Z 980 — nine and a half metres over the platform, open to the night.
 *
 * ## Why the climb turns twice
 *
 * The shaft is 700 cm long and 520 wide (the ceiling opening: X 80..780, Y +/-260) and the
 * only surfaces it can be entered from are the mezzanine's own decks at Z 250. Everything
 * below is already walked on, and player.js refuses a step whose landing has no headroom
 * (`_headroomOver`), so every soffit this file hangs over an existing walking surface has to
 * clear a 192 cm pawn standing on it. That one rule dictates the whole plan:
 *
 * - **The first pitch cannot be on the north side.** Its soffit would roof the head of the
 *   station's own stair, and the blocked zone reaches 42 cm further than the flight does,
 *   because a step is refused the instant the capsule TOUCHES the tread above. Between that
 *   and the stairwell spine (solid to Z 362 at |Y| 55) the corridor off the old top tread
 *   closed to twenty-one centimetres and the original climb became a dead end. So pitch one
 *   takes the south band, where the only thing it roofs is the apron: a connector, not a place.
 * - **The first pitch is a ladder, and that is forced arithmetic.** Its landing stands over
 *   the top treads of the station's own north flight, so the landing's soffit must be at
 *   least 250 + 192 up — and the apron carries a guard rail at X 604..612 standing 112 cm
 *   proud of the deck, which is a COLLIDER, so the tread that passes over it has to be ABOVE
 *   Z 362 within the first 68 cm of run. 37 over 21. Nothing about it is taste.
 * - **The last two pitches are ordinary**, 20 over 32, because above Z 474 the shaft is empty
 *   and the arithmetic stops fighting.
 *
 * ## What it costs the floor below, and what is given back
 *
 * Pitch one roofs the mezzanine's apron, and the apron was the only way between the
 * balcony's two arms — so on its own it would leave the arm the climb starts on unreachable
 * and the whole summit decorative. It is paid back with a catwalk straight across the
 * balcony void at Z 362, landing on the caps of the balcony's own guard rails, which turns a
 * spur into a loop and is a better balcony than the one it replaces.
 *
 * ## The payoff
 *
 * The flights sit in two bands, Y +/-118..258, which leaves a 236 cm slot open down the
 * centre of the shaft from the pavement all the way to the mezzanine. That slot lines up
 * with the balcony void the original already cut, and the void opens onto the platform. So
 * from the lip at the top of the stairs a player looks back down through four storeys of
 * stair and sees warm sodium light on the platform slab, with a cold city night over their
 * shoulder. The contrast is the entire reason to climb.
 *
 * ## What is not built here
 *
 * sky.js owns the night — dome, moon, stars, cloud, rain — and lays a thin wet-asphalt plane
 * at Z 980.5 in a ring around the well, explicitly leaving the well's own footprint to
 * "whoever builds the roof". This file is that roof. Its pavement is also the COLLIDABLE
 * slab under that ring, because sky.js's planes are meshes and not colliders: until now the
 * street was a picture you fell through.
 *
 * Coordinates are the spec's Z-up frame, converted on the way into three exactly as
 * station.js converts: `three = (x, z, -y)`.
 */

import * as THREE from 'three/webgpu'
import { STATION, PLAYER, FX } from '../game/rules.js'

const LEVELS = STATION.LEVELS
const PROPS = STATION.PROPS
const LIGHTING = STATION.LIGHTING

const deg = Math.PI / 180

/** Unreal candelas assume metres; this world is centimetres. Same knob station.js uses. */
const candela = (unrealIntensity) => unrealIntensity * FX.LIGHT_INTENSITY_SCALE

/**
 * Numbers station.js and sky.js keep in their own local blocks, because rules.js has no
 * section for a building the extracted level never built. They are restated here for the
 * same reason those files restate them: this module owns neither, so it keeps one labelled
 * copy instead of reaching across and clobbering another agent's work. Every line names its
 * source so a reviewer can diff them.
 */
const ELSEWHERE = Object.freeze({
  throatMaxX: 780.0, // station.js WELL_MAX_X — east edge of the hole in the ceiling slab
  wellEastX: 820.0, // station.js wellEastX — outside face of the light well's east wall
  wellTopZ: 940.0, // station.js STAIRS.wellTopZ — the pavement line
  paveThickness: 40.0, // station.js STAIRS.wellCapThickness
  deckMaxX: 1120.0, // station.js DECK_MAX_X — east end of the balcony arms
  voidMinX: 660.0, // station.js DECK_VOID_MIN_X — west end of the balcony void
  voidHalfY: 110.0, // station.js STAIRS.voidHalfY
  oldStairMaxX: 520.0, // station.js STAIRS.maxX — the old stair's mouth and the deck's west edge

  railHeight: 112.0, // station.js STAIRS.railHeight, and the balcony's own rail idiom
  railKerb: 22.0,
  railThickness: 8.0,
  railTopDepth: 9.0,
  railCapOverhang: 2.5,
  postSpacing: 150.0,
  handrailHeight: 95.0,
  handrailRadius: 5.0,

  streetApron: 900.0, // sky.js NIGHT.street.apron — how far its wet asphalt reaches past the well
})

const MEZZ_Z = PROPS.mezzanine.centre[2] + PROPS.mezzanine.halfExtent[2] // 250
const SHAFT_MIN_X = PROPS.stairwell.centre[0] - PROPS.stairwell.halfExtent[0] // 80
const SHAFT_HALF_Y = PROPS.stairwell.halfExtent[1] // 260
const WELL_HALF_Y = PROPS.mezzanine.halfExtent[1] // 300
const WELL_MIN_X = PROPS.mezzanine.centre[0] - PROPS.mezzanine.halfExtent[0] // 40

/** Street level: the top face of the slab that replaces the well's blind cap. */
const STREET_Z = ELSEWHERE.wellTopZ + ELSEWHERE.paveThickness // 980
const PAVE_BOTTOM_Z = ELSEWHERE.wellTopZ // 940

/** How tall a pawn is, which is the number every soffit in this file is measured against. */
const STANDING = PLAYER.capsuleHalfHeight * 2 // 192

const SUMMIT = Object.freeze({
  /** Stair slab depth. Thin, because every centimetre of it is stolen from a soffit. */
  slab: 12.0,
  /** Clear air demanded over a pawn's head before a soffit is allowed to exist above it. */
  headroom: 20.0,

  /** The two bands the flights run in. Outside them is the slot that makes the vista. */
  innerY: 118.0, // just clear of the balcony's own void rail at Y 110..118
  outerY: 258.0, // 2 cm shy of the shaft wall, so no two faces are coplanar
  bandWall: 8.0, // thickness of the balustrade that walls each flight's open edge

  nosing: 4.0,
  nosingHeight: 1.5,

  /** The mouth in the pavement. Its east edge is the head of the climb; its west is solved. */
  mouthMaxX: 770.0,

  /** Street dressing. The pavement is sized to sky.js's apron so the two agree on the block. */
  paveMinX: WELL_MIN_X - 900.0,
  paveMaxX: 780.0 + 900.0,
  paveHalfY: 300.0 + 900.0,
  kerbDepth: 40.0,
  kerbRise: 14.0,
  roadDropZ: 18.0,

  /** Cheap dark boxes with lit windows. Parallax and scale, nothing more. */
  skylineCount: 16,
  skylineNear: 2400.0,
  skylineFar: 7400.0,

  /**
   * A ROW of lamp standards, because one lamp on a twenty-five metre plaza is not a street,
   * it is a torch in a field. The first street capture came back at mean luminance 24 with
   * 51% of the frame at pure black and the bollards standing in nothing — the void verdict,
   * arrived at from the dark end instead of the grey end. Four heads spaced 740 cm down the
   * kerb give the pavement the same thing the carriage's door strips give train.png: a
   * rhythm of lit and unlit that the eye reads as depth.
   *
   * They are inside paveMinX..paveMaxX so every post stands on pavement rather than on the
   * kerb strip that runs 400 cm further each way.
   */
  lampStandards: Object.freeze([-640.0, 100.0, 840.0, 1580.0]),

  /**
   * Each head's brightness stated as the irradiance it LANDS at the pavement, with the
   * candela figure derived from the throw — src/world/lighting.js's NIGHT_RIG idiom, so the
   * two rigs can be read line against line. The station floor sits at about 2.15 and
   * photographs at lum 100; a street pool at 1.0 is a little under half of that, which is
   * what a mercury head over wet paving is next to a hall lit by twenty-eight sodium spots.
   */
  lampIrradiance: 1.0,
  lampConeDeg: 62.0,

  /**
   * And a reach that CANNOT touch the building. The head hangs at Z 1560; at the old 2800
   * this lamp could put light at Z -1240, which is four metres under the platform slab.
   * lighting.js writes the rule down and checks it against its own night lights; this file
   * was never in that list, so it enforces it here. 1250 bottoms out at Z 310 — clear of
   * the mezzanine deck at 250 and of everything below it.
   */
  lampReach: 1250.0,

  /** Over POST.bloomThreshold's 1.05 pre-tonemap linear, so the lens itself is a hot source. */
  lampEmissive: 2.6,

  lampColorHex: 0xd7e4ff,
})

// ---------------------------------------------------------------------------
// the climb, as arithmetic that shows its work
// ---------------------------------------------------------------------------

/**
 * Pitch one's landing stands over the top treads of the station's own north flight, whose
 * walking surface is the mezzanine's level. So the landing's soffit is a pawn's height above
 * that, plus air, and the landing itself is one slab higher still. Every other height in
 * this file falls out of this one.
 */
const LANDING1_Z = MEZZ_Z + STANDING + SUMMIT.headroom + SUMMIT.slab // 474

/**
 * Pitch one, and both of its oddities were found by driving a pawn at it rather than by
 * arithmetic.
 *
 * IT IS ON THE SOUTH SIDE, over the mezzanine's apron, not the north. On the north band its
 * soffit roofs the head of the station's own stair — and `_headroomOver` evaluates a step
 * the instant the capsule touches it, one radius out, so the blocked zone reaches 42 cm
 * further than the flight does. Between that and the stairwell spine (solid to Z 362 at
 * |Y| 55) the corridor off the old top tread closed to twenty-one centimetres and the
 * original climb became a dead end. The south side is free because the apron below it is
 * only a connector, and the catwalk across the void replaces it.
 *
 * ITS FOOT IS AT X 680, not at the ceiling opening's own edge at 780. A pawn standing 42 cm
 * east of a tread at 780 is directly under the station's ceiling slab (X 780+, Z 450..510),
 * its head window reaches 477, and every step is refused: driven at it, the pawn stopped
 * dead at X 822.5 and stayed there. The mezzanine itself only clears that slab by 8 cm,
 * which is why nothing had ever noticed. 680 puts the first collision 58 cm clear of it.
 *
 * AND IT IS A LADDER, 37 over 21. The apron carries a guard rail at X 604..612 whose cap
 * tops out at Z 362, and a rail is a collider: the tread that passes over it has to be
 * ABOVE it, which is 124 cm of rise inside the 68 cm of run between the arm and the rail.
 * The riser is still under PLAYER.MOVEMENT.maxStepHeight, so it needs no jump.
 */
const PITCH1 = { footX: 680.0, headX: 554.0, treads: 6, band: -1 }

/**
 * Both landings are at least 120 cm deep, and that is a hard floor rather than a proportion: a pawn
 * is a cylinder 84 cm across, so a turn shallower than that wedges it between the rail behind
 * and the flight in front and the climb stops with no error anywhere.
 */
const LANDING1 = { minX: 424.0, maxX: PITCH1.headX, z: LANDING1_Z }
const PITCH2 = { footX: LANDING1.minX, headX: 200.0, treads: 7, band: 1 }
const LANDING2 = { minX: SHAFT_MIN_X, maxX: PITCH2.headX }
const PITCH3 = { footX: PITCH2.headX, headX: SUMMIT.mouthMaxX, treads: 18, band: -1 }

const RISER1 = (LANDING1_Z - MEZZ_Z) / PITCH1.treads // 37.3 — a ladder, and forced: see PITCH1
const RISER = (STREET_Z - LANDING1_Z) / (PITCH2.treads + PITCH3.treads) // 20.2
const LANDING2_Z = LANDING1_Z + PITCH2.treads * RISER

const TREAD1 = (PITCH1.footX - PITCH1.headX) / PITCH1.treads // 21
const TREAD2 = (PITCH2.footX - PITCH2.headX) / PITCH2.treads // 31.67
const TREAD3 = (PITCH3.headX - PITCH3.footX) / PITCH3.treads // 30
const PITCH3_SLOPE = RISER / TREAD3

for (const [name, rise] of [['one', RISER1], ['two and three', RISER]]) {
  if (rise > PLAYER.MOVEMENT.maxStepHeight) {
    console.error(
      `[summit] pitch ${name} has a ${rise.toFixed(1)} cm riser against a ` +
        `${PLAYER.MOVEMENT.maxStepHeight} cm step limit — that pitch cannot be walked up.`,
    )
  }
}

/**
 * Where the pavement has to stop being a pavement.
 *
 * The last pitch climbs out from under the slab, so the slab may only reach as far east as
 * the point where a climber's head would otherwise meet its underside. Solving that for X is
 * the only honest way to size the opening: chosen by eye it is either a slot the sky cannot
 * be seen through or a lid the player walks their head into.
 */
const MOUTH_MIN_X =
  PITCH3.footX +
  (PAVE_BOTTOM_Z - SUMMIT.headroom - STANDING - LANDING2_Z) / PITCH3_SLOPE -
  /**
   * And then two capsule radii further west, which is the correction a render could not have
   * found and a driven pawn did. A step is evaluated where the capsule TOUCHES the tread, one
   * radius short of it, and the capsule reaches one more radius behind that — so the slab has
   * to end 84 cm before the first tread that needs the sky, not at it. Without this the climb
   * stopped one tread under the street, at Z 737, with the pavement in its head window.
   */
  PLAYER.capsuleRadius * 2

/** Every pitch but the first climbs at the same, ordinary, 20-over-32 rake. */
const pitchRise = (pitch) => (pitch === PITCH1 ? RISER1 : RISER)
const pitchTreadDepth = (pitch) => (pitch === PITCH1 ? TREAD1 : pitch === PITCH2 ? TREAD2 : TREAD3)
const pitchFootZ = (pitch) => (pitch === PITCH1 ? MEZZ_Z : pitch === PITCH2 ? LANDING1_Z : LANDING2_Z)

/** Tread `k` of a pitch, counted up from its foot. */
function pitchTread(pitch, k) {
  const tread = pitchTreadDepth(pitch)
  const dir = Math.sign(pitch.headX - pitch.footX)
  const lead = pitch.footX + dir * k * tread
  const over = lead + dir * tread
  return {
    minX: Math.min(lead, over),
    maxX: Math.max(lead, over),
    topZ: pitchFootZ(pitch) + (k + 1) * pitchRise(pitch),
  }
}

const bandY = (band) => (band > 0 ? [SUMMIT.innerY, SUMMIT.outerY] : [-SUMMIT.outerY, -SUMMIT.innerY])

/**
 * A guard run that spans a whole edge EXCEPT one pitch's lane — which is what makes a
 * landing a turn rather than a room with a hole in it. Derived from the pitch's own band so
 * a flight cannot be moved to the other side of the shaft and leave its exit walled up.
 */
const railSpanExcluding = (band) =>
  band > 0 ? [-SUMMIT.outerY, SUMMIT.innerY] : [-SUMMIT.innerY, SUMMIT.outerY]

// ---------------------------------------------------------------------------
// geometry accumulation — one buffer per material, same reason station.js does it
// ---------------------------------------------------------------------------

const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

class Batch {
  /** @param uvScale centimetres of world surface per texture repeat. */
  constructor(uvScale = 200) {
    this.uvScale = uvScale
    this.position = []
    this.normal = []
    this.uv = []
    this.color = []
    this.index = []
  }

  get empty() {
    return this.index.length === 0
  }

  vertex(p, n, u, v, c) {
    const i = this.position.length / 3
    this.position.push(p[0], p[1], p[2])
    this.normal.push(n[0], n[1], n[2])
    this.uv.push(u, v)
    this.color.push(c[0], c[1], c[2])
    return i
  }

  quad(corners, n, uvs, colors) {
    const a = this.vertex(corners[0], n, uvs[0][0], uvs[0][1], colors[0])
    const b = this.vertex(corners[1], n, uvs[1][0], uvs[1][1], colors[1])
    const c = this.vertex(corners[2], n, uvs[2][0], uvs[2][1], colors[2])
    const d = this.vertex(corners[3], n, uvs[3][0], uvs[3][1], colors[3])
    this.index.push(a, b, c, a, c, d)
  }

  /** A box given by its SPEC min/max spans, which is how a building is actually dimensioned. */
  box(xs, ys, zs, { color = [1, 1, 1], boxUv = false } = {}) {
    // spec (x, y, z) -> three (x, z, -y): the Y span flips and becomes three's Z.
    const centre = [(xs[0] + xs[1]) * 0.5, (zs[0] + zs[1]) * 0.5, -(ys[0] + ys[1]) * 0.5]
    const half = [(xs[1] - xs[0]) * 0.5, (zs[1] - zs[0]) * 0.5, (ys[1] - ys[0]) * 0.5]
    const scale = this.uvScale
    const cols = [color, color, color, color]

    for (const face of FACES) {
      const hn = Math.abs(dot3(face.n, half))
      const hu = Math.abs(dot3(face.u, half))
      const hv = Math.abs(dot3(face.v, half))
      const base = [
        centre[0] + face.n[0] * hn,
        centre[1] + face.n[1] * hn,
        centre[2] + face.n[2] * hn,
      ]
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([cu, cv]) => [
        base[0] + face.u[0] * cu * hu + face.v[0] * cv * hv,
        base[1] + face.u[1] * cu * hu + face.v[1] * cv * hv,
        base[2] + face.u[2] * cu * hu + face.v[2] * cv * hv,
      ])
      const uvs = boxUv
        ? [[0, 0], [1, 0], [1, 1], [0, 1]]
        : corners.map((p) => [dot3(p, face.u) / scale, dot3(p, face.v) / scale])
      this.quad(corners, face.n, uvs, cols)
    }
  }

  /**
   * A swept bar between two SPEC points, which is how every raked member in this file — the
   * balustrades, the handrails, the lamp's arm — gets to follow a flight instead of stepping
   * beside it. Same construction station.js's MeshBuilder.addBar uses.
   */
  bar(a, b, halfW, halfH, color = [1, 1, 1]) {
    const p0 = [a[0], a[2], -a[1]]
    const p1 = [b[0], b[2], -b[1]]
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    const length = Math.hypot(d[0], d[1], d[2])
    if (length < 1e-4) return
    d[0] /= length
    d[1] /= length
    d[2] /= length

    let s = [d[2], 0, -d[0]]
    let sl = Math.hypot(s[0], s[2])
    if (sl < 1e-4) {
      s = [1, 0, 0]
      sl = 1
    }
    s[0] /= sl
    s[2] /= sl
    const v = [
      s[1] * d[2] - s[2] * d[1],
      s[2] * d[0] - s[0] * d[2],
      s[0] * d[1] - s[1] * d[0],
    ]
    const corner = (p, su, sv) => [
      p[0] + s[0] * su * halfW + v[0] * sv * halfH,
      p[1] + s[1] * su * halfW + v[1] * sv * halfH,
      p[2] + s[2] * su * halfW + v[2] * sv * halfH,
    ]
    const ring = (p) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => corner(p, su, sv))
    const ringA = ring(p0)
    const ringB = ring(p1)
    const cols = [color, color, color, color]
    const scale = this.uvScale

    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      const quad = [ringA[i], ringB[i], ringB[j], ringA[j]]
      const e1 = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1], quad[1][2] - quad[0][2]]
      const e2 = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1], quad[3][2] - quad[0][2]]
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const nl = Math.hypot(n[0], n[1], n[2]) || 1
      this.quad(
        quad,
        [n[0] / nl, n[1] / nl, n[2] / nl],
        [[0, 0], [length / scale, 0], [length / scale, (halfW + halfH) / scale], [0, (halfW + halfH) / scale]],
        cols,
      )
    }
    for (const [ringP, dir] of [[ringA, -1], [ringB, 1]]) {
      const n = [d[0] * dir, d[1] * dir, d[2] * dir]
      const order = dir > 0 ? [0, 1, 2, 3] : [3, 2, 1, 0]
      this.quad(order.map((i) => ringP[i]), n, [[0, 0], [1, 0], [1, 1], [0, 1]], cols)
    }
  }

  /** A post, bollard or lamp column: axis along SPEC Z, pivot at the middle of its height. */
  cylinder(centre, radius, height, { radial = 14, color = [1, 1, 1] } = {}) {
    const c = [centre[0], centre[2], -centre[1]]
    const halfH = height * 0.5
    const twoPi = Math.PI * 2
    const scale = this.uvScale
    const cols = [color, color, color, color]

    for (let s = 0; s < radial; s++) {
      const a0 = (s / radial) * twoPi
      const a1 = ((s + 1) / radial) * twoPi
      const c0 = Math.cos(a0)
      const s0 = Math.sin(a0)
      const c1 = Math.cos(a1)
      const s1 = Math.sin(a1)
      const n = [(c0 + c1) * 0.5, 0, (s0 + s1) * 0.5]
      const inv = 1 / (Math.hypot(n[0], n[2]) || 1)
      n[0] *= inv
      n[2] *= inv
      const y0 = c[1] - halfH
      const y1 = c[1] + halfH
      this.quad(
        [
          [c[0] + c0 * radius, y0, c[2] + s0 * radius],
          [c[0] + c0 * radius, y1, c[2] + s0 * radius],
          [c[0] + c1 * radius, y1, c[2] + s1 * radius],
          [c[0] + c1 * radius, y0, c[2] + s1 * radius],
        ],
        n,
        [[(a0 * radius) / scale, y0 / scale], [(a0 * radius) / scale, y1 / scale], [(a1 * radius) / scale, y1 / scale], [(a1 * radius) / scale, y0 / scale]],
        cols,
      )
    }
    for (const dir of [1, -1]) {
      const y = c[1] + halfH * dir
      for (let s = 0; s < radial; s++) {
        const a0 = (s / radial) * twoPi
        const a1 = ((s + 1) / radial) * twoPi
        const p0 = [c[0] + Math.cos(a0) * radius, y, c[2] + Math.sin(a0) * radius]
        const p1 = [c[0] + Math.cos(a1) * radius, y, c[2] + Math.sin(a1) * radius]
        const cp = [c[0], y, c[2]]
        const order = dir > 0 ? [cp, p0, p1, p1] : [cp, p1, p0, p0]
        this.quad(order, [0, dir, 0], [[0, 0], [1, 0], [1, 1], [1, 1]], cols)
      }
    }
  }

  build() {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3))
    geometry.setIndex(this.index)
    geometry.computeBoundingSphere()
    return geometry
  }
}

// ---------------------------------------------------------------------------
// the art this module bakes for itself
// ---------------------------------------------------------------------------

function canvasOf(w, h) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

function finish(canvas, { repeat = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/**
 * A shared facade with grouped office bays and dark service floors. It is the only texture the skyline gets, and it is deliberately the only one —
 * twenty-two buildings sharing one material is twenty-two boxes and one draw call, which is
 * the entire budget a background is allowed to cost.
 */
function bakeFacade(size = 256) {
  const canvas = canvasOf(size, size)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0a0b11'
  ctx.fillRect(0, 0, size, size)

  const cols = 12
  const rows = 12
  const cell = size / cols
  // A fixed integer hash, not Math.random: the skyline has to be the same building every
  // boot or two captures of the same frame stop being comparable.
  const lit = (i, j) => (((i * 73856093) ^ (j * 19349663)) >>> 0) % 100

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const roll = lit(i, j)
      const x = i * cell + cell * 0.28
      const y = j * cell + cell * 0.22
      const w = cell * (i % 4 === 0 ? 0.18 : 0.62)
      const h = cell * 0.5
      if (j % 5 !== 0 && i % 4 !== 0 && roll < 28) {
        const warm = roll % 3
        ctx.fillStyle = warm === 0 ? '#ffd9a0' : warm === 1 ? '#cfe2ff' : '#fff2cf'
        ctx.globalAlpha = 0.35 + (roll % 7) * 0.055
      } else {
        ctx.fillStyle = j % 5 === 0 ? '#131c27' : '#0e1520'
        ctx.globalAlpha = 1
      }
      ctx.fillRect(x, y, w, h)
    }
  }
  ctx.globalAlpha = 1
  return finish(canvas)
}

/** The entrance sign: the one piece of type at the top of the climb that names the place. */
function bakeEntranceSign(w = 1024, h = 512) {
  const canvas = canvasOf(w, h)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  const font = '"Helvetica Neue", Helvetica, Arial, sans-serif'

  ctx.fillStyle = '#0d1520'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#e8eef7'
  ctx.lineWidth = h * 0.035
  ctx.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12)

  ctx.fillStyle = '#1c8f4d'
  ctx.beginPath()
  ctx.arc(w * 0.17, h * 0.5, h * 0.24, 0, Math.PI * 2)
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(h * 0.3)}px ${font}`
  ctx.fillText('S', w * 0.17, h * 0.52)

  ctx.save()
  ctx.translate(w * 0.62, h * 0.38)
  ctx.scale(0.82, 1)
  ctx.font = `700 ${Math.round(h * 0.24)}px ${font}`
  ctx.fillText('SHOEMONEY SQ', 0, 0)
  ctx.restore()

  ctx.save()
  ctx.translate(w * 0.62, h * 0.68)
  ctx.scale(0.82, 1)
  ctx.fillStyle = '#ffd35a'
  ctx.font = `700 ${Math.round(h * 0.15)}px ${font}`
  ctx.fillText('SUBWAY  ·  ALL TRAINS', 0, 0)
  ctx.restore()

  return finish(canvas, { repeat: false })
}

// ---------------------------------------------------------------------------
// the build
// ---------------------------------------------------------------------------

/**
 * Build the climb, the street it comes out on, and everything that makes the top of it a
 * place rather than a platform with a sky behind it.
 *
 * @param scene the three scene (unused directly — everything hangs off the station's group
 *              so one transform, one dispose and one removal still covers the whole level)
 * @param station `{ group, materials, colliders, geometries, disposables }` from station.js
 * @returns {{ colliders: Array, exitPoint: THREE.Vector3, vistaPoint: THREE.Vector3, bounds: THREE.Box3 }}
 */
export function buildSummit(scene, station) {
  const { group, materials } = station
  const geometries = station.geometries ?? []
  const disposables = station.disposables ?? []
  const colliders = []

  const toThree = (x, y, z) => new THREE.Vector3(x, z, -y)

  /**
   * The painted rectangle of daylight stuck to the underside of the well's cap.
   *
   * It is a good matte painting and it is in the way: it spans the whole well at Z 938, two
   * centimetres under the pavement the stair now comes up through, and the last pitch passes
   * straight through it. It is switched OFF rather than deleted so station.js still owns,
   * counts and disposes of it — this module has replaced the thing it was standing in for,
   * which is the only honest reason to hide another module's art.
   */
  const painted = group.getObjectByName('street-opening')
  if (painted) {
    painted.visible = false
    console.info(
      '[summit] station.js\'s "street-opening" plane is hidden: the well has a real sky over it now, ' +
        'and that plane spans the whole shaft 2 cm under the pavement the stair comes up through.',
    )
  } else {
    console.warn('[summit] no "street-opening" plane found — a painted sky may now be inside the stair pit')
  }

  const batches = {
    concrete: new Batch(200.0),
    /**
     * The pavement gets its own buffer on the same material for one reason: UV scale. The
     * station's concrete is authored at 400 cm per repeat for a wall two storeys high, and
     * on a plaza twenty-five metres across that puts two-metre cracks under the player's
     * feet. 90 reads as paving instead of as damage.
     */
    pave: new Batch(90.0),
    stripe: new Batch(220.0),
    furniture: new Batch(160.0),
    asphalt: new Batch(500.0),
    city: new Batch(760.0),
    /** The lamp lenses, on their own emissive material — see SUMMIT.lampEmissive. */
    lampGlow: new Batch(60.0),
  }

  /** Register a collider without geometry — for a rail whose art is a cap and six posts. */
  function blocker(name, xs, ys, zs) {
    const centre = toThree((xs[0] + xs[1]) * 0.5, (ys[0] + ys[1]) * 0.5, (zs[0] + zs[1]) * 0.5)
    const half = new THREE.Vector3((xs[1] - xs[0]) * 0.5, (zs[1] - zs[0]) * 0.5, (ys[1] - ys[0]) * 0.5)
    colliders.push({
      name,
      type: 'box',
      center: centre,
      halfExtent: half,
      box: new THREE.Box3(centre.clone().sub(half), centre.clone().add(half)),
    })
  }

  /** Geometry plus, unless told otherwise, the collider that makes it a thing you stand on. */
  function solid(family, name, xs, ys, zs, opts = {}) {
    batches[family].box(xs, ys, zs, opts)
    if (opts.solid !== false) blocker(name, xs, ys, zs)
  }

  // --- 1. the well is a room now, so give it walls that stop a body ---------
  /**
   * The light well's four tiled walls are drawn and have never been colliders, because until
   * now nothing could stand next to them. With three flights inside, they are the edge of
   * the world: without these a player leans on the tile at Z 700 and falls out of the level.
   * The geometry is station.js's; only the colliders are new.
   */
  const wellSpan = [LEVELS.wallTopZ, ELSEWHERE.wellTopZ]
  for (const side of [1, -1]) {
    const ys = side > 0 ? [SHAFT_HALF_Y, WELL_HALF_Y] : [-WELL_HALF_Y, -SHAFT_HALF_Y]
    blocker(`well-wall-${side > 0 ? 'n' : 's'}`, [WELL_MIN_X, ELSEWHERE.wellEastX], ys, wellSpan)
  }
  blocker('well-wall-w', [WELL_MIN_X, SHAFT_MIN_X], [-WELL_HALF_Y, WELL_HALF_Y], wellSpan)
  blocker('well-wall-e', [ELSEWHERE.throatMaxX, ELSEWHERE.wellEastX], [-WELL_HALF_Y, WELL_HALF_Y], wellSpan)

  // --- 2. the three pitches -------------------------------------------------
  /**
   * Each tread is a slab 12 cm deep with open air beneath it rather than a solid mass down
   * to the deck, and that is not a saving. Pitch one runs over the mezzanine's apron, where
   * station.js already publishes a zombie spawn at (580, -160, 250); poured solid, the wave
   * director would be dealing bodies into the middle of a concrete block.
   */
  function buildPitch(pitch, tag) {
    const [y0, y1] = bandY(pitch.band)
    const rise = pitchRise(pitch)
    const climbingEast = pitch.headX > pitch.footX

    for (let k = 0; k < pitch.treads; k++) {
      const t = pitchTread(pitch, k)
      solid('concrete', `summit-tread-${tag}-${k}`, [t.minX, t.maxX], [y0, y1], [t.topZ - SUMMIT.slab, t.topZ])
      // The nosing goes on the riser face the climber sees, which is the low end of the tread.
      const nose = climbingEast
        ? [t.minX - 0.6, t.minX + SUMMIT.nosing]
        : [t.maxX - SUMMIT.nosing, t.maxX + 0.6]
      batches.stripe.box(nose, [y0, y1], [t.topZ - SUMMIT.nosingHeight * 2, t.topZ + 0.6])
    }

    const footZ = pitchTread(pitch, 0).topZ - rise
    const headZ = pitchTread(pitch, pitch.treads - 1).topZ
    const [lowX, highX] = climbingEast ? [pitch.footX, pitch.headX] : [pitch.headX, pitch.footX]
    const lowZ = climbingEast ? footZ : headZ
    const highZ = climbingEast ? headZ : footZ

    for (const [edge, edgeY] of [y0, y1].entries()) {
      const inward = edge === 0 ? 1 : -1
      const wallY = [edgeY, edgeY + SUMMIT.bandWall * inward].sort((a, b) => a - b)
      const midY = (wallY[0] + wallY[1]) * 0.5
      const half = ELSEWHERE.railHeight * 0.5
      // The balustrade and its handrail, each one swept member the whole length — a raked
      // run is the one thing a box builder cannot do and a swept bar does for free.
      batches.concrete.bar([lowX, midY, lowZ + half], [highX, midY, highZ + half], SUMMIT.bandWall * 0.5, half)
      batches.furniture.bar(
        [lowX, midY, lowZ + ELSEWHERE.railHeight + 6],
        [highX, midY, highZ + ELSEWHERE.railHeight + 6],
        ELSEWHERE.handrailRadius,
        ELSEWHERE.handrailRadius,
      )
      /**
       * One collider per three treads: a raked wall cannot be an AABB, and a staircase you
       * can be nudged off the side of is the exact bug this whole file exists to avoid.
       */
      for (let k = 0; k < pitch.treads; k += 3) {
        const a = pitchTread(pitch, k)
        const b = pitchTread(pitch, Math.min(pitch.treads - 1, k + 2))
        blocker(
          `summit-balustrade-${tag}-${edge}-${k}`,
          [Math.min(a.minX, b.minX), Math.max(a.maxX, b.maxX)],
          wallY,
          [Math.min(a.topZ, b.topZ) - rise, Math.max(a.topZ, b.topZ) + ELSEWHERE.railHeight],
        )
      }
    }
  }

  buildPitch(PITCH1, 'a')
  buildPitch(PITCH2, 'b')
  buildPitch(PITCH3, 'c')

  // --- 3. the two turns -----------------------------------------------------
  // Full width, because a switchback landing that does not cross the shaft is a shelf.
  solid('concrete', 'summit-landing-a', [LANDING1.minX, LANDING1.maxX], [-SUMMIT.outerY, SUMMIT.outerY], [LANDING1.z - SUMMIT.slab, LANDING1.z])
  solid('concrete', 'summit-landing-b', [LANDING2.minX, LANDING2.maxX], [-SUMMIT.outerY, SUMMIT.outerY], [LANDING2_Z - SUMMIT.slab, LANDING2_Z])

  /** A run of guard rail: a plinth, a mid rail, a capping rail, posts, and ONE collider. */
  function railRun(name, xs, ys, z) {
    batches.concrete.box(xs, ys, [z, z + ELSEWHERE.railKerb], {})
    batches.furniture.box(xs, ys, [z + ELSEWHERE.railHeight * 0.5 - 3, z + ELSEWHERE.railHeight * 0.5 + 3], {})
    batches.furniture.box(
      [xs[0] - ELSEWHERE.railCapOverhang, xs[1] + ELSEWHERE.railCapOverhang],
      [ys[0] - ELSEWHERE.railCapOverhang, ys[1] + ELSEWHERE.railCapOverhang],
      [z + ELSEWHERE.railHeight - ELSEWHERE.railTopDepth, z + ELSEWHERE.railHeight],
      {},
    )
    const alongX = xs[1] - xs[0] >= ys[1] - ys[0]
    const span = alongX ? xs[1] - xs[0] : ys[1] - ys[0]
    const posts = Math.max(1, Math.round(span / ELSEWHERE.postSpacing))
    for (let i = 0; i <= posts; i++) {
      const at = (alongX ? xs[0] : ys[0]) + (i / posts) * span
      const half = ELSEWHERE.railThickness * 0.5
      batches.furniture.box(
        alongX ? [at - half, at + half] : xs,
        alongX ? ys : [at - half, at + half],
        [z + ELSEWHERE.railKerb, z + ELSEWHERE.railHeight - ELSEWHERE.railTopDepth],
        {},
      )
    }
    blocker(name, xs, ys, [z, z + ELSEWHERE.railHeight])
  }

  const rt = ELSEWHERE.railThickness
  // Landing A is railed on its west face and across the slot on the flank each flight is
  // NOT on, so the only two ways off it are the two pitches that meet there.
  railRun('summit-landing-a-rail-w', [LANDING1.minX - rt, LANDING1.minX], railSpanExcluding(PITCH2.band), LANDING1.z)
  railRun('summit-landing-a-rail-e', [LANDING1.maxX, LANDING1.maxX + rt], railSpanExcluding(PITCH1.band), LANDING1.z)
  // Landing B: only its east face is open, and both flights leave from either side of the slot.
  railRun('summit-landing-b-rail-e', [LANDING2.maxX, LANDING2.maxX + rt], [-SUMMIT.innerY, SUMMIT.innerY], LANDING2_Z)

  // --- 4. the crossing that keeps the balcony a loop ----------------------
  /**
   * Pitch one roofs the mezzanine's apron, and the apron was the only way between the
   * balcony's two arms — so without this the arm the climb starts on cannot be reached and
   * the whole summit is decoration. This is the replacement: a catwalk straight across the
   * balcony void.
   *
   * It is at Z 362 rather than at deck level, and that height is not a style choice either.
   * The void is ringed by the balcony's own guard rails, which are 112 cm colliders standing
   * on the deck at |Y| 110..118 for the arms' whole length; a bridge at 250 is a bridge
   * behind a wall. 362 is exactly those rails' cap, so the crossing lands ON them and the
   * rail becomes the last eight centimetres of the walkway instead of the thing in the way.
   *
   * It sits at X 690..760 because that is the only stretch of the void with open sky over
   * it — east of X 780 the station's ceiling slab is at Z 450 and a pawn standing at 362
   * puts its head straight through it — and because the sightline from the top of the climb
   * down through the void to the platform passes over it at Z 427, so the vista survives.
   */
  const CATWALK = { minX: 690.0, maxX: 760.0, deckZ: MEZZ_Z + ELSEWHERE.railHeight }
  const catwalkX = [CATWALK.minX, CATWALK.maxX]
  const catwalkRisers = 3
  const catwalkRise = (CATWALK.deckZ - MEZZ_Z) / catwalkRisers // 37.3, under the step limit

  solid('concrete', 'summit-catwalk', catwalkX, [-ELSEWHERE.voidHalfY, ELSEWHERE.voidHalfY], [CATWALK.deckZ - SUMMIT.slab, CATWALK.deckZ])
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'n' : 's'
    /**
     * The steps up to it are 40 cm deep in total, and that is the tightest constraint in
     * this file. The balcony arm is 182 cm wide between its own two rails; a pawn is 84
     * across and is pushed off anything within 42 of it, so a stair 40 deep leaves a 98 cm
     * lane to walk PAST it — and at 60 deep the lane closes to 38 and the arm is severed by
     * the very thing that was meant to reconnect it. Driven at a deeper version, the pawn
     * wedged between the step and the outer rail and stopped.
     */
    const step = 40.0 / catwalkRisers
    for (let k = 0; k < catwalkRisers; k++) {
      // Counted DOWN from the deck, so the run nearest the void is the top one.
      const inner = (ELSEWHERE.voidHalfY + 8 + k * step) * side
      const outer = inner + step * side
      solid(
        'concrete',
        `summit-catwalk-step-${tag}-${k}`,
        catwalkX,
        [Math.min(inner, outer), Math.max(inner, outer)],
        [MEZZ_Z, CATWALK.deckZ - k * catwalkRise],
      )
    }
    // A handrail down each side of the crossing, geometry only — a collider on a walkway
    // this narrow is a walkway the pawn cannot use.
    const railY = ELSEWHERE.voidHalfY * side
    batches.furniture.bar(
      [CATWALK.minX, railY, CATWALK.deckZ + ELSEWHERE.handrailHeight],
      [CATWALK.maxX, railY, CATWALK.deckZ + ELSEWHERE.handrailHeight],
      ELSEWHERE.handrailRadius,
      ELSEWHERE.handrailRadius,
    )
  }

  // --- 5. the pavement, with the stair coming up through it -----------------
  /**
   * Four pieces around the mouth, and they are COLLIDERS — sky.js lays wet asphalt over this
   * footprint as plain meshes so its rain has something to break on, which means until now
   * the street was a picture you fell through.
   */
  const paveSpan = [PAVE_BOTTOM_Z, STREET_Z]
  const mouthY = [-SHAFT_HALF_Y, SHAFT_HALF_Y]
  const paveY = [-SUMMIT.paveHalfY, SUMMIT.paveHalfY]
  // Tinted well down: this is a wet pavement at midnight under one lamp, and the station's
  // concrete is authored for a hall lit by twenty-eight of them.
  const flags = { color: [0.5, 0.52, 0.58] }
  solid('pave', 'street-pave-w', [SUMMIT.paveMinX, MOUTH_MIN_X], paveY, paveSpan, flags)
  solid('pave', 'street-pave-e', [SUMMIT.mouthMaxX, SUMMIT.paveMaxX], paveY, paveSpan, flags)
  solid('pave', 'street-pave-s', [MOUTH_MIN_X, SUMMIT.mouthMaxX], [paveY[0], mouthY[0]], paveSpan, flags)
  solid('pave', 'street-pave-n', [MOUTH_MIN_X, SUMMIT.mouthMaxX], [mouthY[1], paveY[1]], paveSpan, flags)

  /**
   * And then the FLAGS on top of them, as geometry with no colliders of their own.
   *
   * Four boxes spanning twenty-five metres is a slab, and a slab is what the first street
   * capture photographed: mean luminance 24, half the frame at pure black, five bollards
   * standing in nothing. A raking light needs something to rake. A real pavement is not one
   * surface, it is four hundred slightly different ones, and that variation is the whole
   * reason a street lamp reads as a street lamp instead of as a stain.
   *
   * Each flag stands 1.2 cm proud of the walking datum and carries NO collider — the four
   * slabs underneath already own the physics, and 1.2 cm is a twentieth of a step. They are
   * laid from a fixed integer hash, not Math.random, for the same reason the skyline is:
   * the frame gate compares pixels between runs and a pavement that reshuffles every boot
   * is a pavement no capture can be diffed against.
   *
   * One flag in nine is pulled well down. A puddle is not a shape, it is a patch of paving
   * that throws the lamp back at you instead of scattering it, and with the whole surface
   * on the wet material a dark flag under a head is exactly that.
   */
  let flagSeed = 0x9a71ce
  const flagRand = () => {
    flagSeed = (flagSeed * 1664525 + 1013904223) >>> 0
    return flagSeed / 4294967296
  }
  const FLAG = 130.0
  for (let fx = SUMMIT.paveMinX; fx < SUMMIT.paveMaxX; fx += FLAG) {
    for (let fy = -SUMMIT.paveHalfY; fy < SUMMIT.paveHalfY; fy += FLAG) {
      const x1 = Math.min(fx + FLAG - 1.5, SUMMIT.paveMaxX)
      const y1 = Math.min(fy + FLAG - 1.5, SUMMIT.paveHalfY)
      // The mouth is a hole in the pavement, so it gets no flags over it.
      if (x1 > MOUTH_MIN_X - 8 && fx < SUMMIT.mouthMaxX + 8 && y1 > mouthY[0] - 8 && fy < mouthY[1] + 8) continue
      const roll = flagRand()
      const tone = roll < 0.11 ? 0.20 + roll * 1.1 : 0.44 + roll * 0.44
      batches.pave.box([fx + 1.5, x1], [fy + 1.5, y1], [STREET_Z - 1.0, STREET_Z + 1.2], {
        color: [tone, tone * 1.02, tone * 1.13],
      })
    }
  }

  /**
   * The nosing round the lip, and it is the one piece of yellow up here: from the pavement
   * the mouth is a black rectangle, and a black rectangle at your feet in the dark is a hole
   * nobody sees until they are in it.
   */
  for (const side of [1, -1]) {
    const y = SHAFT_HALF_Y * side
    batches.stripe.box([MOUTH_MIN_X - 6, SUMMIT.mouthMaxX + 6], [y - 6, y + 6], [STREET_Z, STREET_Z + 4])
  }
  batches.stripe.box([MOUTH_MIN_X - 6, MOUTH_MIN_X + 6], mouthY, [STREET_Z, STREET_Z + 4])

  /**
   * Railings on all four sides but one gap, and the gap is the whole point: it is exactly
   * the last pitch's lane, so the only way through the rail is the way you came up.
   */
  railRun('street-mouth-rail-n', [MOUTH_MIN_X, SUMMIT.mouthMaxX], [mouthY[1], mouthY[1] + rt], STREET_Z)
  railRun('street-mouth-rail-s', [MOUTH_MIN_X, SUMMIT.mouthMaxX], [mouthY[0] - rt, mouthY[0]], STREET_Z)
  railRun('street-mouth-rail-w', [MOUTH_MIN_X - rt, MOUTH_MIN_X], mouthY, STREET_Z)
  const exitGap = bandY(PITCH3.band)
  railRun('street-mouth-rail-e', [SUMMIT.mouthMaxX, SUMMIT.mouthMaxX + rt], [exitGap[1] - 6, mouthY[1]], STREET_Z)
  if (exitGap[0] > mouthY[0] + 12) {
    railRun('street-mouth-rail-e-far', [SUMMIT.mouthMaxX, SUMMIT.mouthMaxX + rt], [mouthY[0], exitGap[0] + 6], STREET_Z)
  }

  // --- 6. kerb, carriageway, and the block the entrance is set into ---------
  const kerbTop = STREET_Z + SUMMIT.kerbRise
  const kerbY = [-SUMMIT.paveHalfY - SUMMIT.kerbDepth, -SUMMIT.paveHalfY]
  solid('pave', 'street-kerb', [SUMMIT.paveMinX - 400, SUMMIT.paveMaxX + 400], kerbY, [PAVE_BOTTOM_Z, kerbTop], { color: [0.72, 0.73, 0.78] })

  const roadTop = kerbTop - SUMMIT.roadDropZ
  solid('asphalt', 'street-road', [-3400, 4600], [-3600, kerbY[0]], [roadTop - 60, roadTop], { color: [0.62, 0.64, 0.7] })
  // Lane markings: the cheapest thing that says ROAD rather than "a dark slab", and the only
  // bright thing for the wet asphalt to smear a reflection of.
  for (let i = 0; i < 14; i++) {
    const x = -2000 + i * 460
    batches.stripe.box([x, x + 230], [-2360, -2300], [roadTop, roadTop + 2])
  }

  /**
   * The building the entrance is set into. It closes the block on the north side so a player
   * who turns round at the top is looking at a facade rather than at nothing, and it gives
   * sky.js's painted horizon a hard near edge to be read against. game.js hangs its secret
   * on this wall and finds it off the bounds published below, so the two cannot drift.
   */
  solid('city', 'street-facade', [SUMMIT.paveMinX - 300, SUMMIT.paveMaxX + 300], [SUMMIT.paveHalfY, SUMMIT.paveHalfY + 500], [PAVE_BOTTOM_Z, STREET_Z + 2900], { color: [0.88, 0.88, 0.94] })

  // --- 7. the skyline -------------------------------------------------------
  /**
   * Sixteen stepped silhouettes on one material, laid out by a fixed integer sequence so the city is
   * the same city every boot. They are parallax and nothing else: no light reaches them, no
   * light comes off them but the windows already in their texture, and they are tinted down
   * with distance in the vertex colours so the far ones sit behind the near ones without a
   * single extra draw. sky.js bakes a skyline ON its horizon; these stand in front of it and
   * move against it, which is the one thing a painted horizon cannot do.
   */
  let seed = 0x5eed1e
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < SUMMIT.skylineCount; i++) {
    const far = SUMMIT.skylineNear + rand() * (SUMMIT.skylineFar - SUMMIT.skylineNear)
    const side = i % 4 === 0 ? 1 : -1
    const y = far * side
    const x = -4600 + rand() * 10500
    const w = 520 + rand() * 1250
    const d = 520 + rand() * 1050
    const h = 900 + rand() * 4000 * (far / SUMMIT.skylineFar + 0.4)
    const distance = far / SUMMIT.skylineFar
    const fade = 0.78 - 0.42 * distance
    const color = [fade * 0.85, fade * 0.96, fade * 1.12]
    const roof = PAVE_BOTTOM_Z + h
    const y0 = Math.min(y, y + d * side)
    const y1 = Math.max(y, y + d * side)
    const box = (x0, x1, a, b, z0, z1) => batches.city.box([x0, x1], [a, b], [z0, z1], { color })
    box(x, x + w, y0, y1, PAVE_BOTTOM_Z - 300, roof)
    // Roof setbacks establish distinct silhouettes without another material or draw.
    if (i % 3 === 0) {
      box(x + w * .15, x + w * .85, y0 + d * .15, y1 - d * .15, roof, roof + h * .15)
      box(x + w * .32, x + w * .68, y0 + d * .32, y1 - d * .32, roof + h * .15, roof + h * .24)
    } else if (i % 3 === 1) {
      box(x + w * .58, x + w * .86, y0 + d * .25, y1 - d * .25, roof, roof + h * .2)
    }

  }

  // --- 8. street dressing ---------------------------------------------------
  /**
   * The standards. One column, one swan-neck arm, one canopy — and under the canopy a
   * separate little box on an EMISSIVE material, because a lamp whose fixture is as dark as
   * the pole it stands on is a pool of light with no cause. The lens is the cause, it is
   * over the bloom threshold, and it is the only thing in this file allowed to be.
   */
  const lampY = kerbY[1] + 60
  const lampTopZ = STREET_Z + 560
  for (const [i, lampX] of SUMMIT.lampStandards.entries()) {
    batches.furniture.cylinder([lampX, lampY, (STREET_Z + lampTopZ) * 0.5], 9, lampTopZ - STREET_Z, { radial: 12 })
    batches.furniture.bar([lampX, lampY, lampTopZ], [lampX, lampY + 200, lampTopZ + 26], 7, 7)
    batches.furniture.box([lampX - 27, lampX + 27], [lampY + 178, lampY + 242], [lampTopZ + 26, lampTopZ + 36], {})
    batches.lampGlow.box([lampX - 22, lampX + 22], [lampY + 183, lampY + 237], [lampTopZ + 13, lampTopZ + 26], {})
    blocker(`street-lamp-post-${i}`, [lampX - 14, lampX + 14], [lampY - 14, lampY + 14], [STREET_Z, lampTopZ])
  }

  // Bollards the length of the kerb rather than one clump of five in the middle of it: the
  // row is what gives the near ground a measurable scale as it recedes.
  for (let i = 0; i < 9; i++) {
    const x = -700 + i * 280
    batches.furniture.cylinder([x, kerbY[1] + 90, STREET_Z + 45], 11, 90, { radial: 10 })
    // A reflective band, at knee height, on the one material up here that is already yellow.
    batches.stripe.box([x - 12, x + 12], [kerbY[1] + 78, kerbY[1] + 102], [STREET_Z + 58, STREET_Z + 70])
    blocker(`street-bollard-${i}`, [x - 11, x + 11], [kerbY[1] + 79, kerbY[1] + 101], [STREET_Z, STREET_Z + 90])
  }

  // One piece of litter-scale furniture is what turns a slab with a lamp on it into a
  // pavement somebody uses.
  const newsX = [1320, 1390]
  const newsY = [kerbY[1] + 70, kerbY[1] + 130]
  solid('furniture', 'street-news-box', newsX, newsY, [STREET_Z, STREET_Z + 112])
  batches.stripe.box([newsX[0] + 2, newsX[1] - 2], [newsY[0] - 2, newsY[0]], [STREET_Z + 40, STREET_Z + 104])

  // The sign's posts; its lit face is hung below, after the batches close.
  const signX = SUMMIT.mouthMaxX + 90
  const signMidY = ((SUMMIT.innerY + SUMMIT.outerY) * 0.5) * Math.sign(PITCH3.band)
  for (const side of [1, -1]) {
    batches.furniture.cylinder([signX, signMidY + side * 86, STREET_Z + 150], 7, 300, { radial: 10 })
  }

  // --- 9. assemble ----------------------------------------------------------
  const asphalt = materials.wetConcrete.clone()
  asphalt.color = new THREE.Color().setRGB(0.05, 0.051, 0.058, THREE.LinearSRGBColorSpace)
  asphalt.roughness = 0.2
  asphalt.metalness = 0.12
  disposables.push(asphalt)

  /**
   * The pavement is WET, and that is one clone rather than a new bake.
   *
   * `roughness` and `metalness` on a MeshStandardMaterial are MULTIPLIERS over the baked ORM
   * pack, so dropping them keeps every hairline crack, every form-tie pocket and every
   * aggregate fleck the concrete baker put there and simply rains on all of it. 0.30 against
   * the dry concrete's 0.78 is a shade tighter than the platform's own wet floor at 0.34,
   * which is right: the slab downstairs is under a roof and this is not. It is also what
   * makes scene.environment worth the 0.70 it is already set to up here — under four heads
   * the flags streak instead of sitting flat, which is the single effect that separates
   * train.png's floor from a grey rectangle.
   */
  const wetPave = materials.concrete.clone()
  wetPave.roughness = 0.30
  wetPave.metalness = 0.10
  disposables.push(wetPave)

  /** The lamp lenses. Emissive only — it lights nothing, the spot below it does that. */
  const lampGlowMaterial = new THREE.MeshStandardMaterial({
    color: 0x0c0f16,
    emissive: new THREE.Color(SUMMIT.lampColorHex),
    emissiveIntensity: SUMMIT.lampEmissive,
    roughness: 0.42,
    metalness: 0.0,
  })
  disposables.push(lampGlowMaterial)

  const facadeTexture = bakeFacade()
  const cityMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    map: facadeTexture ?? null,
    fog: false, // the skyline IS the distance; fogging it just deletes it
    toneMapped: true,
  })
  if (!facadeTexture) cityMaterial.color = new THREE.Color(0x11141d)
  disposables.push(cityMaterial)
  if (facadeTexture) disposables.push(facadeTexture)

  const plan = [
    { key: 'concrete', material: materials.concrete, receive: true, cast: true },
    { key: 'pave', material: wetPave, receive: true },
    { key: 'stripe', material: materials.safetyStripe, receive: true },
    { key: 'furniture', material: materials.furniture, receive: true, cast: true },
    { key: 'asphalt', material: asphalt, receive: true },
    { key: 'city', material: cityMaterial },
    { key: 'lampGlow', material: lampGlowMaterial },
  ]
  for (const entry of plan) {
    const batch = batches[entry.key]
    if (batch.empty) continue
    const geometry = batch.build()
    const mesh = new THREE.Mesh(geometry, entry.material)
    mesh.name = `summit-${entry.key}`
    mesh.castShadow = Boolean(entry.cast)
    mesh.receiveShadow = Boolean(entry.receive)
    group.add(mesh)
    geometries.push(geometry)
  }

  // --- 10. the sign at the top of the climb ---------------------------------
  const signTexture = bakeEntranceSign()
  if (signTexture) {
    /**
     * NO U-FLIP. The comment that used to live here reasoned correctly about a DOUBLE-SIDED
     * plane, where the back face genuinely does show the texture mirrored — but this builds
     * TWO separate PlaneGeometry panels, each FrontSide, each rotated to present its own front
     * to its own viewer. Neither is ever seen from behind, so the flip was not correcting a
     * mirror, it was creating one: captured head-on, the face the street is approached from
     * read "SHOEMONE" backwards with "YAWBUS" beneath it.
     */
    const signGeometry = new THREE.PlaneGeometry(260, 130)
    geometries.push(signGeometry)
    for (const yaw of [Math.PI / 2, -Math.PI / 2]) {
      const map = signTexture
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        emissive: 0xffffff,
        emissiveMap: map,
        emissiveIntensity: PROPS.hangingSign.emissiveIntensity * 1.15,
        roughness: 0.3,
        metalness: 0.0,
      })
      const panel = new THREE.Mesh(signGeometry, material)
      panel.name = `street-entrance-sign-${yaw > 0 ? 'w' : 'e'}`
      panel.position.copy(toThree(signX + (yaw > 0 ? -4 : 4), signMidY, STREET_Z + 232))
      panel.rotation.y = yaw
      group.add(panel)
      disposables.push(material)
    }
    disposables.push(signTexture)
  }

  // --- 11. the rig ----------------------------------------------------------
  /**
   * The street is COLD and the hole in it is WARM, and that one sentence is the whole rig.
   *
   * Everything up here used to be cold including the mouth, on the reasoning that the
   * station below is lit by twenty-eight sodium sources and the contrast is the payoff for
   * the climb. The reasoning was right and the wiring was backwards: the light coming OUT of
   * a subway entrance IS the station's light, so the one warm thing on a mercury-lit street
   * should be the stair head. Get that the right way round and the hole reads as somewhere
   * from fifty metres off, with no sign needed. None of these casts.
   */
  const lampThrow = lampTopZ + 20 - STREET_Z
  for (const [i, lampX] of SUMMIT.lampStandards.entries()) {
    const lamp = new THREE.SpotLight(
      new THREE.Color(SUMMIT.lampColorHex),
      SUMMIT.lampIrradiance * lampThrow * lampThrow, // decay 2: irradiance = I / d^2
      SUMMIT.lampReach,
      SUMMIT.lampConeDeg * deg,
      0.5,
      2,
    )
    lamp.name = `street-lamp-${i}`
    lamp.position.copy(toThree(lampX, lampY + 210, lampTopZ + 20))
    /**
     * Aimed just SHORT of the kerb rather than at the middle of the pavement. The cone is
     * 1090 cm across at this throw, so an aim at the kerb line puts the far half of it over
     * the carriageway — and the carriageway is the wet asphalt, which is the only surface up
     * here that can streak a lamp back. Aimed at the pavement's middle instead, the road
     * behind the kerb stays a black band across the frame and the whole block stops at the
     * kerb line.
     */
    lamp.target.position.copy(toThree(lampX - 40, lampY + 90, STREET_Z))
    lamp.castShadow = false
    group.add(lamp, lamp.target)
  }

  /**
   * The lip, and it is sodium. Without it the mouth is the darkest thing on a dark street,
   * which is the exact opposite of what a lit stair head looks like from a pavement — and in
   * the station's own colour it is also the only warm object in a cold frame, which is what
   * makes it the thing the eye goes to.
   */
  const lip = new THREE.PointLight(new THREE.Color(LIGHTING.ceilingSpot.colorHex), candela(LIGHTING.ambientFill.intensity * 1.8), 1600, 2)
  lip.name = 'street-mouth-lip'
  lip.position.copy(toThree((MOUTH_MIN_X + SUMMIT.mouthMaxX) * 0.5, 0, STREET_Z + 140))
  group.add(lip)

  // The covered pocket over landing B, which the pavement has just put a lid on.
  const pocket = new THREE.PointLight(new THREE.Color(SUMMIT.lampColorHex), candela(LIGHTING.ambientFill.intensity * 1.2), 1000, 2)
  pocket.name = 'summit-landing-fill'
  pocket.position.copy(toThree(LANDING2.maxX + 40, 0, LANDING2_Z + 210))
  group.add(pocket)

  /**
   * And one WARM light aimed back down the old stair. Landing A is a new ceiling over the
   * top of the station's north flight, and a soffit where there used to be 450 cm of open
   * shaft takes light away from the one climb the platform camera is already pointed at.
   * This gives it back, in the sodium the rest of the station is lit in.
   */
  const under = new THREE.SpotLight(new THREE.Color(LIGHTING.ceilingSpot.colorHex), candela(LIGHTING.ceilingSpot.intensity * 0.45), 1100, 68 * deg, 0.6, 2)
  under.name = 'summit-landing-underlight'
  under.position.copy(toThree(LANDING1.minX + 30, 0, LANDING1.z - SUMMIT.slab - 8))
  under.target.position.copy(toThree(240, 0, MEZZ_Z * 0.5))
  under.castShadow = false
  group.add(under, under.target)

  // --- what the rest of the game needs out of the summit --------------------
  /** Where the stair arrives on the pavement, and where to stand to look back down it. */
  const exitPoint = toThree(SUMMIT.mouthMaxX + 90, signMidY, STREET_Z)
  const vistaPoint = toThree(MOUTH_MIN_X - 60, 0, STREET_Z)

  const lo = toThree(SUMMIT.paveMinX, kerbY[0], PAVE_BOTTOM_Z)
  const hi = toThree(SUMMIT.paveMaxX, SUMMIT.paveHalfY, STREET_Z + 300)
  const bounds = new THREE.Box3(
    new THREE.Vector3(Math.min(lo.x, hi.x), Math.min(lo.y, hi.y), Math.min(lo.z, hi.z)),
    new THREE.Vector3(Math.max(lo.x, hi.x), Math.max(lo.y, hi.y), Math.max(lo.z, hi.z)),
  )

  if (Array.isArray(station.colliders)) station.colliders.push(...colliders)

  console.info(
    `[summit] street at Z ${STREET_Z} — ${PITCH1.treads + PITCH2.treads + PITCH3.treads} treads in three ` +
      `pitches, ${colliders.length} colliders, mouth opens at X ${MOUTH_MIN_X.toFixed(0)}`,
  )

  return { colliders, exitPoint, vistaPoint, bounds }
}

/** The climb, published so a test can assert against the numbers instead of guessing them. */
export const SUMMIT_PLAN = Object.freeze({
  mezzanineZ: MEZZ_Z,
  streetZ: STREET_Z,
  landingZ: Object.freeze([LANDING1_Z, LANDING2_Z]),
  footX: PITCH1.footX,
  footY: ((SUMMIT.innerY + SUMMIT.outerY) * 0.5) * PITCH1.band,
  mouth: Object.freeze({ minX: MOUTH_MIN_X, maxX: SUMMIT.mouthMaxX, halfY: SHAFT_HALF_Y }),
})
