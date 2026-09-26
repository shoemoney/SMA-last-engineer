import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Merge static geometry so the renderer stops paying per-mesh cost on scenery that never
 * moves.
 *
 * Measured on this scene: frame-time p95 scales almost linearly with the number of VISIBLE
 * meshes, because three's WebGPU path does per-object uniform and bind-group work every
 * frame regardless of whether the object moved.
 *
 *   480 visible meshes → p95 199.4ms
 *   392               → p95  93.6ms
 *   289               → p95  40.7ms
 *   153               → p95  11.1ms
 *
 * The station was built as ~136 individual boxes because that is the readable way to write
 * a station. It is not the way to render one. Their world transforms are baked into the
 * vertices and everything sharing a material becomes a single mesh.
 *
 * WHAT IS DELIBERATELY NOT MERGED:
 *   - anything that moves (the train, pickups, zombies, the view model, FX)
 *   - anything a caller still needs to address by name
 *   - lights, cameras, and helpers
 * Merging is irreversible for the meshes it consumes, so the opt-in is explicit: only nodes
 * reachable from the roots you pass, and only those marked static.
 */

/** A mesh is safe to merge only if nothing will ever need to move or address it alone. */
function isMergeable(node, keepNames, skip) {
  if (!node.isMesh) return false             // InstancedMesh is already one call; leave it
  if (node.userData?.noMerge) return false
  // Anything that remembers its own open/shut positions moves, whatever it is called.
  if (node.userData && ('shutX' in node.userData || 'openX' in node.userData)) return false
  if (skip && skip(node)) return false
  if (keepNames.has(node.name)) return false
  if (!node.geometry || !node.material) return false
  if (node.geometry.morphAttributes && Object.keys(node.geometry.morphAttributes).length) return false
  if (node.isSkinnedMesh) return false
  return true
}

/**
 * @param {THREE.Object3D} root       subtree to flatten
 * @param {object}        [opts]
 * @param {Set<string>}   [opts.keepNames]  names that must survive as their own mesh
 * @param {number}        [opts.minBatch]   don't bother merging fewer than this many
 * @param {Function}      [opts.skip]       predicate: return true to leave a mesh alone
 * @returns {{before: number, after: number, batches: number}}
 */
export function mergeStatic(root, { keepNames = new Set(), minBatch = 2, skip = null } = {}) {
  root.updateMatrixWorld(true)

  // Bake relative to the ROOT, not the world. The train is merged while it sits at its
  // staging position and then drives down the platform; baking world matrices would weld
  // the carriage to wherever it happened to be standing when we flattened it.
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert()

  /** @type {Map<string, {material: THREE.Material, geometries: THREE.BufferGeometry[], meshes: THREE.Mesh[]}>} */
  const batches = new Map()
  let before = 0

  root.traverse(node => {
    if (node.isMesh) before++
    if (!isMergeable(node, keepNames, skip)) return

    // An array material means one geometry drawn with several materials — merging those
    // needs groups preserved per material, which is more surgery than it is worth here.
    if (Array.isArray(node.material)) return

    const key = `${node.material.uuid}|${node.castShadow ? 1 : 0}|${node.receiveShadow ? 1 : 0}`
    if (!batches.has(key)) batches.set(key, { material: node.material, geometries: [], meshes: [] })
    const batch = batches.get(key)

    // Bake the world transform in. The merged mesh sits at the root's origin, so every
    // vertex has to carry the placement its own node used to provide.
    const geo = node.geometry.clone()
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, node.matrixWorld))
    batch.geometries.push(geo)
    batch.meshes.push(node)
  })

  let merged = 0
  let batchCount = 0

  for (const { material, geometries, meshes } of batches.values()) {
    if (geometries.length < minBatch) { geometries.forEach(g => g.dispose()); continue }

    // mergeGeometries returns null when the inputs disagree on attributes — a real
    // possibility across hand-built geometry. Fail loudly and leave those meshes alone
    // rather than silently dropping scenery, which would read as a rendering bug later.
    const combined = mergeGeometries(geometries, false)
    geometries.forEach(g => g.dispose())
    if (!combined) {
      console.warn(`[optimize] ${meshes.length} meshes share a material but not an attribute ` +
                   `layout, so they stay separate: ${meshes.slice(0, 3).map(m => m.name || '(unnamed)').join(', ')}…`)
      continue
    }

    const sample = meshes[0]
    const mesh = new THREE.Mesh(combined, material)
    mesh.name = `merged:${sample.name || material.name || 'static'}×${meshes.length}`
    mesh.castShadow = sample.castShadow
    mesh.receiveShadow = sample.receiveShadow
    mesh.matrixAutoUpdate = false           // it can never move; stop recomputing its matrix
    mesh.updateMatrix()
    root.add(mesh)

    for (const old of meshes) {
      old.parent?.remove(old)
      old.geometry.dispose()
    }
    merged += meshes.length
    batchCount++
  }

  let after = 0
  root.traverse(node => { if (node.isMesh) after++ })
  console.info(`[optimize] merged ${merged} static meshes into ${batchCount} draws — ${before} → ${after} meshes`)
  return { before, after, batches: batchCount }
}

/**
 * Opt a light out of the scene light budget, permanently. The flag name lives here, with the
 * only code that reads it, so a caller cannot misspell it into silence.
 *
 * This is for a CAMERA-SPACE FIXTURE, and for nothing else. A light bolted to the camera and
 * sized for a 13-44 cm throw cannot be ranked against a room light by raw candela: the
 * station's spots run 122,880-1,594,320 cd because they have to fill a ten-metre hall, and
 * inverse-square over a 30x difference in working distance makes the comparison meaningless.
 * The viewmodel's rig measured 260-2150 cd and therefore sorted permanently last — 57x below
 * even the most generous tier's cut — so all three of its lights were deleted at boot at every
 * quality tier and the player's own weapon rendered unlit. See src/weapons/viewmodel.js.
 *
 * The answer is exclusion, not a brighter light: clearing the medium tier's cut would mean
 * driving a fill 13 cm from the slide to ~224,000 cd, which blows the gun to white.
 */
export function reserveFromLightBudget(light) {
  light.userData.excludeFromLightBudget = true
  return light
}

/**
 * Enforce a whole-SCENE light budget.
 *
 * lighting.js culls the rig it built, but station.js, summit.js and sky.js each add their
 * own lights afterwards — mezzanine downlights, stair washes, street lamps, the moon. The
 * rig cull never saw those, so a "culled" scene still carried 85 lights.
 *
 * That is a fillrate problem, not a CPU one. Measured at quality=low with shadows and the
 * post chain both OFF, frame time scaled with pixel count — 39.9ms at 1280x720, 21.8ms at
 * 640x360, 15.9ms at 320x180 — while the CPU sat 72% idle. Per-fragment lighting is the
 * only thing left that behaves that way.
 *
 * Three buckets, not two:
 *
 *   FREE      ambient and hemisphere. Effectively no per-fragment cost, and dropping them
 *             turns unlit surfaces black.
 *   RESERVED  camera-space fixtures marked by reserveFromLightBudget(). Never sorted, never
 *             dimmed, never re-parented away.
 *   COSTLY    everything else — the scene. Ranked brightest-first, because among lights that
 *             all illuminate the same ten-metre room a dim fill contributes least to the image
 *             per unit of cost. That reasoning is what scopes this function to scene lights:
 *             it only holds while every candidate shares roughly the same working distance,
 *             and the RESERVED bucket exists precisely because some do not. Intensity is still
 *             the wrong ranking for a spot with a tiny cone, but it is the one signal every
 *             light type shares, and projecting each light's screen coverage is more machinery
 *             than a quality tier deserves.
 *
 * `budget` counts COSTLY lights only. Reserved lights are four fixtures on the camera, fixed
 * for the life of the process — viewmodel.js's key/fill/rim (VIEW.key/fill/rim) and
 * lighting.js's characterKey (RIG.characterKey) — so they are a constant and not something a
 * tier negotiates. If a tier cannot afford the frame with them live, the answer is to shrink
 * the SCENE budget, never to un-reserve the rig.
 */
export function limitLights(scene, budget) {
  const lights = []
  scene.traverse(node => { if (node.isLight && node.visible) lights.push(node) })

  const free = lights.filter(l => l.isAmbientLight || l.isHemisphereLight)
  const rest = lights.filter(l => !l.isAmbientLight && !l.isHemisphereLight)
  const reserved = rest.filter(l => l.userData?.excludeFromLightBudget)
  const costly = rest.filter(l => !l.userData?.excludeFromLightBudget)

  if (costly.length <= budget) {
    console.info(`[optimize] ${costly.length} costly lights, budget ${budget} — nothing to cull ` +
                 `(${reserved.length} reserved, ${free.length} free)`)
    return { before: lights.length, after: lights.length, reserved: reserved.length, dropped: 0 }
  }

  costly.sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0))

  let dropped = 0
  for (const light of costly.slice(budget)) {
    light.visible = false
    light.intensity = 0
    light.castShadow = false
    light.parent?.remove(light)
    if (light.target?.parent) light.target.parent.remove(light.target)
    light.dispose?.()
    dropped++
  }
  console.info(`[optimize] light budget ${budget}: dropped ${dropped}, kept ${budget} costly + ` +
               `${reserved.length} reserved + ${free.length} free`)
  return { before: lights.length, after: lights.length - dropped, reserved: reserved.length, dropped }
}

/**
 * Share materials that are identical in every way that matters.
 *
 * Fifteen agents built this scene and each reasonably minted its own materials, so the
 * station carries 244 of them — 111 byte-for-byte redundant, including four separate groups
 * of sixteen identical ones. Each distinct material is a pipeline three compiles at boot and
 * a set of uniforms it pushes every frame, so the duplicates cost twice: once in the 12s
 * load, and again in every frame after it.
 *
 * The fingerprint covers everything that changes the compiled pipeline or its uniforms. Two
 * materials that differ only by uuid are the same material wearing two names.
 *
 * OPT OUT with `material.userData.noDedupe = true`. A material that was CLONED in order to
 * be mutated alone — the flickering tube's strip and haze — must keep its own identity, or
 * every tube in the station flickers together.
 */
export function dedupeMaterials(scene) {
  const fingerprint = m => JSON.stringify({
    t: m.type, c: m.color?.getHexString?.(), e: m.emissive?.getHexString?.(),
    ei: m.emissiveIntensity, r: m.roughness, mt: m.metalness, o: m.opacity,
    tr: m.transparent, bl: m.blending, side: m.side, dw: m.depthWrite, dt: m.depthTest,
    fog: m.fog, vc: m.vertexColors, aT: m.alphaTest, wf: m.wireframe,
    map: m.map?.uuid ?? null, nmap: m.normalMap?.uuid ?? null,
    rmap: m.roughnessMap?.uuid ?? null, emap: m.emissiveMap?.uuid ?? null,
    amap: m.aoMap?.uuid ?? null, mmap: m.metalnessMap?.uuid ?? null,
    almap: m.alphaMap?.uuid ?? null,
  })

  const canonical = new Map()
  const retired = new Set()
  let replaced = 0

  const pick = m => {
    if (!m || m.userData?.noDedupe) return m
    // A node material's graph is not captured by the fingerprint, so only share those when
    // they came from the same source object — anything with custom nodes keeps itself.
    if (m.isNodeMaterial && (m.colorNode || m.emissiveNode || m.positionNode || m.opacityNode)) return m
    const key = fingerprint(m)
    const existing = canonical.get(key)
    if (!existing) { canonical.set(key, m); return m }
    if (existing !== m) { retired.add(m); replaced++ }
    return existing
  }

  scene.traverse(node => {
    if (!node.isMesh && !node.isInstancedMesh && !node.isSprite && !node.isPoints) return
    if (Array.isArray(node.material)) node.material = node.material.map(pick)
    else node.material = pick(node.material)
  })

  // Only dispose what nothing points at any more. Disposing a material still in use would
  // show up as an untextured object several scenes later, which is a miserable bug to trace.
  const live = new Set()
  scene.traverse(node => {
    for (const m of (Array.isArray(node.material) ? node.material : [node.material])) if (m) live.add(m)
  })
  let disposed = 0
  for (const m of retired) if (!live.has(m)) { m.dispose?.(); disposed++ }

  console.info(`[optimize] materials: ${canonical.size} kept, ${replaced} references re-pointed, ${disposed} disposed`)
  return { kept: canonical.size, replaced, disposed }
}
