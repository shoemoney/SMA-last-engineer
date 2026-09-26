import * as THREE from 'three/webgpu'

/**
 * WebGPU first, WebGL2 when the browser or the harness says otherwise.
 *
 * `?renderer=webgl` forces the fallback path. The headless verifier uses it so a
 * capture never depends on WebGPU being available inside a CI-grade Chromium,
 * while the real game still opens on WebGPU wherever it exists.
 */
export async function createEngine(canvas) {
  const params = new URLSearchParams(globalThis.location?.search ?? '')
  const forced = params.get('renderer')
  const wantsWebGL = forced === 'webgl' || !navigator.gpu

  /**
   * ?gputime=1 turns on WebGPU timestamp queries so GPU time per frame can be MEASURED
   * rather than inferred. Chrome's DevTools protocol exposes no GPU timing at all, so every
   * GPU conclusion in this project so far came from elimination — a CPU profile showing 72%
   * idle plus frame time scaling with pixel count. Sound reasoning, but not a measurement.
   * Off by default: the queries themselves cost a little, and a profiling aid should never
   * be in a player's frame.
   */
  const trackTimestamp = params.get('gputime') === '1'

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    trackTimestamp,
    forceWebGL: wantsWebGL,
    powerPreference: 'high-performance',
  })

  /**
   * Quality tiers. Default is 'medium', NOT the full look.
   *
   * The full look — 44 lights, a 7-pass post chain with screen-space AO, at devicePixelRatio
   * 2 — was built by agents that were each told to push the art and none of which were given
   * a frame budget. On a Retina display pixelRatio 2 renders four times the pixels, and GTAO
   * pays for every one of them. It locked up a M4 Max.
   *
   *   ?q=low     1.0x pixels, no post chain at all      — for anything struggling
   *   ?q=medium  1.25x pixels, cheap post only          — DEFAULT
   *   ?q=high    2.0x pixels, the whole chain           — for a screenshot, or a spare GPU
   */
  // high was 2.0 and measured 0.1fps. This scene is fillrate-bound and the post chain's
  // screen-space AO scales with pixel count, so 2.0 is four times low's cost before a
  // single light is lit. 1.5 is the most the full look can afford.
  const QUALITY = { low: 1.0, medium: 1.25, high: 1.5 }
  const tier = params.get('q') ?? 'medium'
  const ratio = QUALITY[tier] ?? QUALITY.medium
  globalThis.__SHOE_QUALITY__ = QUALITY[tier] ? tier : 'medium'
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, ratio))
  console.info(`[engine] quality=${globalThis.__SHOE_QUALITY__} pixelRatio=${renderer.getPixelRatio().toFixed(2)}`)
  renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.shadowMap.enabled = globalThis.__SHOE_QUALITY__ !== 'low'
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  await renderer.init()

  const backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2'
  console.info(`[engine] backend=${backend}`)
  globalThis.__SHOE_BACKEND__ = backend

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x05070b)
  scene.fog = new THREE.FogExp2(0x0a0f18, 0.0022)

  const camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 6000)

  const resize = () => {
    const w = globalThis.innerWidth
    const h = globalThis.innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  globalThis.addEventListener?.('resize', resize)
  resize()

  return { THREE, renderer, scene, camera, backend, resize }
}
