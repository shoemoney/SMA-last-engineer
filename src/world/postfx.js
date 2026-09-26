import { Color, PostProcessing, Vector2 } from 'three/webgpu'
import {
  luminance,
  mix,
  mrt,
  oneMinus,
  output,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  transformedNormalView,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { film } from 'three/addons/tsl/display/FilmNode.js'
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { FX, STATION } from '../game/rules.js'

const POST = FX.POST

/**
 * Look knobs with no home in rules.js. `FX.POST` names the passes the original never had;
 * it does not describe the shape of the grade or of a screen pulse, because neither existed
 * in the C++ to be extracted. These are grouped and named the way rules.js names things so
 * they can be lifted into `FX.POST` wholesale later. Everything the spec DOES pin down —
 * the damage-flash colour and decay, the explosion ramp and fade, the tunnel-portal albedo,
 * the sodium strip colour — is imported below rather than retyped here.
 */
const LOOK = Object.freeze({
  splitToneStrength: 0.22, // CHOSEN: how far shadows go cold and highlights go sodium
  highlightPivot: 0.55, // CHOSEN: luminance at which a pixel counts as lamp-lit rather than shadow
  vignetteInnerRadius: 0.32, // CHOSEN: fraction of the corner distance where the lens vignette starts
  hitEdgeInnerRadius: 0.12, // CHOSEN: the red crush starts closer to centre than the lens vignette
  hitLift: 0.06, // CHOSEN: faint full-screen red wash so a hit registers even when centred on a wall
  explosionPeak: 0.85, // CHOSEN: how much light the blowout adds at its peak
  explosionWarmth: 0.45, // CHOSEN: how far the blowout leans from white toward the fireball's own orange
  deathSeconds: 2.2, // CHOSEN: the death crush outlives the 0.9 s damage number and the 8 s corpse does not need it
  deathDesaturate: 0.8, // CHOSEN: how far the death frame collapses to a single tinted channel
  deathTintMix: 0.65, // CHOSEN: white-to-blood ratio of that tint
  deathDarken: 0.55, // CHOSEN: edge darkening on top of the desaturation
  maxPulseStep: 0.1, // CHOSEN: seconds; a backgrounded tab must not skip a whole pulse on the first frame back
  /**
   * ChromaticAberrationNode expresses strength in its own units: its per-channel UV offset at a
   * screen corner works out to roughly strength * scale * 0.02 * 0.707. Dividing the spec's UV
   * figure by that gain makes `POST.chromaticAberration` mean what it says — a fraction of screen
   * width at the corners — instead of an opaque multiplier.
   */
  caUvGainPerStrength: 0.0156,
  caScale: 1.1, // the node's own default, restated so the gain above stays derivable
})

/** Ramp-then-fall envelopes, each timed off the thing it is reacting to. */
const PULSE_SHAPES = Object.freeze({
  hit: Object.freeze({
    seconds: FX.DAMAGE_FLASH.fullDecaySeconds, // same 1/1.75 s the HUD vignette uses, so the two read as one event
    rampSeconds: 0,
  }),
  explosion: Object.freeze({
    seconds: FX.EXPLOSION.flashFadeSeconds,
    rampSeconds: FX.EXPLOSION.flashRampSeconds, // the flash light climbs before it falls; the screen should too
  }),
  death: Object.freeze({
    seconds: LOOK.deathSeconds,
    rampSeconds: 0,
  }),
})

const PULSE_KINDS = Object.keys(PULSE_SHAPES)

/** Strip the brightness out of a colour so tinting cannot also change exposure. */
function hueOnly(r, g, b) {
  const peak = Math.max(r, g, b, 1e-6)
  return [r / peak, g / peak, b / peak]
}

function linearHue(hex) {
  const c = new Color(hex)
  return hueOnly(c.r, c.g, c.b)
}

function envelope(shape, age) {
  if (age >= shape.seconds) return 0
  if (shape.rampSeconds > 0 && age < shape.rampSeconds) return age / shape.rampSeconds
  return 1 - (age - shape.rampSeconds) / (shape.seconds - shape.rampSeconds)
}

/**
 * The last line of defence. A post stack that cannot build must still draw the game, so every
 * failure path lands here rather than on a black canvas.
 */
function passthrough(renderer, scene, camera, reason, error) {
  console.warn(`[postfx] no post stack — ${reason}. The game will render flat.`, error ?? '')
  return {
    enabled: false,
    passes: [],
    render() {
      renderer.render(scene, camera)
    },
    resize() {},
    setIntensity() {},
    pulse() {},
  }
}

/**
 * Builds the full-screen look: AO to sit objects on the platform, bloom so the signage and the
 * muzzle flash bleed, a grade that rolls the tunnels down to black while the sodium lamps stay
 * hot, then grain, a whisper of aberration and a lens vignette over the tone-mapped image.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {import('three/webgpu').Scene} scene
 * @param {import('three/webgpu').Camera} camera
 * @returns {{ render: Function, resize: Function, setIntensity: Function, pulse: Function }}
 */
export function initPostFX(renderer, scene, camera) {
  if (!renderer || !scene || !camera) {
    throw new TypeError('initPostFX needs a renderer, a scene and a camera')
  }

  const backend = globalThis.__SHOE_BACKEND__ ?? 'unknown'
  const passes = []
  const uniforms = {
    /** Carries the aspect ratio already divided through, so a corner sits at radius 1.0 exactly. */
    aspect: uniform(new Vector2(1, 1)),
    split: uniform(LOOK.splitToneStrength),
    vignette: uniform(POST.vignetteStrength),
    grain: uniform(POST.filmGrain),
    aberration: uniform(POST.chromaticAberration / LOOK.caUvGainPerStrength),
    hit: uniform(0),
    explosion: uniform(0),
    death: uniform(0),
  }

  let post
  let bloomPass = null
  let aoPass = null

  try {
    /**
     * MSAA is off on purpose: FXAA runs after tone mapping anyway, and a multisampled target
     * that also has to carry MRT normals and a readable depth texture is the exact combination
     * that breaks on the WebGL2 backend.
     */
    const scenePass = pass(scene, camera, { samples: 0 })

    // The WebGL2 backend has no dependable MRT path here, so AO reconstructs normals from depth.
    const normalsFromMRT = backend === 'webgpu'
    if (normalsFromMRT) {
      scenePass.setMRT(mrt({ output, normal: transformedNormalView }))
    }

    const sceneColor = scenePass.getTextureNode('output')
    const sceneDepth = scenePass.getTextureNode('depth')
    const sceneNormal = normalsFromMRT ? scenePass.getTextureNode('normal') : null

    let lit = sceneColor
    if (POST.gtaoEnabled) {
      try {
        aoPass = ao(sceneDepth, sceneNormal, camera)
        aoPass.radius.value = POST.gtaoRadius
        aoPass.scale.value = POST.gtaoIntensity
        // RedFormat target: 1 is open air, 0 is fully occluded, so it multiplies straight in.
        lit = vec4(sceneColor.rgb.mul(aoPass.getTextureNode().r), sceneColor.a)
        passes.push(normalsFromMRT ? 'gtao' : 'gtao(depth-normals)')
      } catch (err) {
        aoPass = null
        lit = sceneColor
        console.warn('[postfx] GTAO could not be built; objects will float instead of sitting.', err)
      }
    }

    if (POST.dofEnabled) {
      try {
        lit = dof(lit, scenePass.getViewZNode(), POST.dofFocusDistance, POST.dofFocalLength, POST.dofBokehScale)
        passes.push('dof')
      } catch (err) {
        console.warn('[postfx] depth of field could not be built; the frame stays uniformly sharp.', err)
      }
    }

    /**
     * Grade, in linear HDR, before tone mapping.
     *
     * The toe is the whole reason the tunnels read as tunnels. ACES hands back a washed
     * charcoal where the spec wants darkness, so anything dimmer than the painted tunnel-portal
     * albedo is rolled off toward zero. It rides on luminance rather than on each channel so a
     * dim surface loses brightness without also losing its hue, and it is a smoothstep rather
     * than a subtract so shadow detail fades out instead of clipping off in a band.
     */
    const blackPoint = STATION.COLORS.tunnelPortalLinear[0]
    const crushed = lit.rgb.mul(smoothstep(0, blackPoint, luminance(lit.rgb)))

    const shadowTint = linearHue(STATION.ATMOSPHERE.fogColorHex)
    const lampTint = hueOnly(...STATION.COLORS.lightStripLinear)
    const warmth = smoothstep(0, LOOK.highlightPivot, luminance(crushed))
    const splitTint = mix(vec3(...shadowTint), vec3(...lampTint), warmth)
    const graded = mix(crushed, crushed.mul(splitTint), uniforms.split)

    let composite = vec4(graded, lit.a)

    try {
      // Thresholded against the raw scene, which is what POST.bloomThreshold was picked against.
      bloomPass = bloom(sceneColor, POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold)
      composite = composite.add(bloomPass)
      passes.push('bloom')
    } catch (err) {
      bloomPass = null
      console.warn('[postfx] bloom could not be built; emissive signage and muzzle flash will not bleed.', err)
    }

    // ACES and the sRGB conversion happen here so the passes below get display-referred pixels.
    let display = renderOutput(composite)
    passes.push('tonemap')

    if (POST.fxaaEnabled) {
      try {
        display = fxaa(display)
        passes.push('fxaa')
      } catch (err) {
        console.warn('[postfx] FXAA could not be built; edges will crawl.', err)
      }
    }

    if (POST.chromaticAberration > 0) {
      try {
        // The node's own factory documents a null centre as "screen centre" and then builds a
        // null node out of it, so the centre is always passed explicitly.
        display = chromaticAberration(display, uniforms.aberration, vec2(0.5, 0.5), LOOK.caScale)
        passes.push('chromatic-aberration')
      } catch (err) {
        console.warn('[postfx] chromatic aberration could not be built.', err)
      }
    }

    if (POST.filmGrain > 0) {
      try {
        display = film(display, uniforms.grain)
        passes.push('film-grain')
      } catch (err) {
        console.warn('[postfx] film grain could not be built; flat concrete will look like plastic.', err)
      }
    }

    // Distance from screen centre, 0 in the middle and 1 in a corner on any aspect ratio.
    const radius = screenUV.sub(0.5).mul(uniforms.aspect).length()
    const edge = smoothstep(LOOK.vignetteInnerRadius, 1, radius)
    const hurtEdge = smoothstep(LOOK.hitEdgeInnerRadius, 1, radius)

    const bloodTint = vec3(...hueOnly(...FX.DAMAGE_FLASH.vignetteColorLinear))
    const deathTint = mix(vec3(1), bloodTint, LOOK.deathTintMix)
    const boomTint = mix(vec3(1), vec3(...FX.EXPLOSION.flashColorLinear), LOOK.explosionWarmth)

    // Re-arming to the same peak as the HUD's own four-band flash keeps the two effects in step.
    const hurt = uniforms.hit.mul(FX.DAMAGE_FLASH.vignetteAlphaScale)

    let rgb = display.rgb.mul(oneMinus(edge.mul(uniforms.vignette)))
    rgb = mix(rgb, rgb.mul(bloodTint), hurt.mul(hurtEdge))
    rgb = rgb.add(bloodTint.mul(hurt.mul(LOOK.hitLift)))

    const drained = vec3(luminance(rgb)).mul(deathTint)
    rgb = mix(rgb, drained, uniforms.death.mul(LOOK.deathDesaturate))
    rgb = rgb.mul(oneMinus(uniforms.death.mul(LOOK.deathDarken).mul(hurtEdge)))

    rgb = rgb.add(boomTint.mul(uniforms.explosion.mul(LOOK.explosionPeak)))
    passes.push('vignette+pulse')

    post = new PostProcessing(renderer, vec4(rgb, 1))
    // The chain already tone-mapped and converted; letting PostProcessing do it again would
    // double-apply ACES and blow every highlight out to white.
    post.outputColorTransform = false
    post.needsUpdate = true
  } catch (err) {
    return passthrough(renderer, scene, camera, 'the chain failed to build', err)
  }

  console.info(`[postfx] backend=${backend} passes=${passes.join(', ')}`)

  const ages = { hit: Infinity, explosion: Infinity, death: Infinity }
  let lastSeconds = 0
  let fellBack = false

  function advance(deltaSeconds) {
    for (const kind of PULSE_KINDS) {
      if (ages[kind] === Infinity) continue
      ages[kind] += deltaSeconds
      const level = envelope(PULSE_SHAPES[kind], ages[kind])
      uniforms[kind].value = level
      if (level === 0) ages[kind] = Infinity
    }
  }

  function elapsed() {
    const now = (globalThis.performance?.now() ?? Date.now()) / 1000
    const delta = lastSeconds === 0 ? 0 : Math.min(now - lastSeconds, LOOK.maxPulseStep)
    lastSeconds = now
    return delta
  }

  return {
    enabled: true,
    passes,

    /**
     * @param {number} [deltaSeconds] - pass the simulation's own delta to keep the pulses
     *   reproducible under the verify harness; omit it and the wall clock is used.
     */
    render(deltaSeconds) {
      advance(Number.isFinite(deltaSeconds) ? deltaSeconds : elapsed())

      if (fellBack) {
        renderer.render(scene, camera)
        return
      }

      try {
        post.render()
      } catch (err) {
        fellBack = true
        console.error(
          '[postfx] the post chain threw mid-frame; dropping to a plain render for the rest of the session',
          err,
        )
        renderer.render(scene, camera)
      }
    },

    resize(width, height) {
      const size = renderer.getSize(new Vector2())
      const w = width || size.width || 1
      const h = height || size.height || 1
      const aspect = w / h
      const cornerDistance = Math.hypot(aspect * 0.5, 0.5)
      uniforms.aspect.value.set(aspect / cornerDistance, 1 / cornerDistance)
    },

    /** Master dial on how loud the look is. 0 leaves the grade and tone curve, nothing else. */
    setIntensity(n) {
      if (!Number.isFinite(n) || n < 0) {
        console.warn(`[postfx] setIntensity ignored a non-finite or negative value: ${n}`)
        return
      }
      uniforms.split.value = LOOK.splitToneStrength * n
      uniforms.vignette.value = POST.vignetteStrength * n
      uniforms.grain.value = POST.filmGrain * n
      uniforms.aberration.value = (POST.chromaticAberration / LOOK.caUvGainPerStrength) * n
      if (bloomPass !== null) bloomPass.strength.value = POST.bloomStrength * n
      if (aoPass !== null) aoPass.scale.value = POST.gtaoIntensity * n
    },

    /** @param {'hit'|'explosion'|'death'} kind */
    pulse(kind) {
      if (!Object.hasOwn(PULSE_SHAPES, kind)) {
        console.warn(`[postfx] pulse('${kind}') is not a known pulse; expected hit, explosion or death`)
        return
      }
      ages[kind] = 0
      uniforms[kind].value = envelope(PULSE_SHAPES[kind], 0)
    },
  }
}

export default initPostFX
