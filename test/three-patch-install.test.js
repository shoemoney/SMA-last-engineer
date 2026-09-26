import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const temporary = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'three-patch-guard-'))
  temporary.push(root)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'node_modules/three/build'), { recursive: true })
  mkdirSync(join(root, 'node_modules/three/src/nodes/core'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'scripts/apply-three-patch.mjs'), readFileSync(new URL('../scripts/apply-three-patch.mjs', import.meta.url)))
  writeFileSync(join(root, 'node_modules/three/package.json'), JSON.stringify({ version, main: 'build/three.cjs' }))
  writeFileSync(join(root, 'node_modules/three/build/three.cjs'), '')
  writeFileSync(join(root, 'node_modules/three/build/three.webgpu.js'), 'unrecognized')
  writeFileSync(join(root, 'node_modules/three/src/nodes/core/NodeBuilder.js'), 'unrecognized')
  return root
}
describe('Three.js installation guard', () => {
  it('rejects unsupported versions before invoking patch tooling', () => {
    const root = fixture('0.183.0')
    const result = spawnSync(process.execPath, [join(root, 'scripts/apply-three-patch.mjs')], { cwd: tmpdir(), encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Expected three@0.182.0, found 0.183.0')
  })
  it('rejects unexpected source bytes even with the pinned package version', () => {
    const root = fixture('0.182.0')
    const result = spawnSync(process.execPath, [join(root, 'scripts/apply-three-patch.mjs')], { cwd: tmpdir(), encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unrecognized Three.js source')
    expect(readFileSync(join(root, 'node_modules/three/build/three.webgpu.js'), 'utf8')).toBe('unrecognized')
  })
  it('fails installation when patch-package rejects the patch', () => {
    const root = fixture('0.182.0')
    const require = createRequire(import.meta.url)
    const threeRoot = dirname(dirname(require.resolve('three')))
    for (const name of ['src/nodes/core/NodeBuilder.js', 'build/three.webgpu.js']) {
      writeFileSync(join(root, 'node_modules/three', name), readFileSync(join(threeRoot, name)))
    }
    symlinkSync(dirname(require.resolve('patch-package/package.json')), join(root, 'node_modules/patch-package'), 'dir')
    mkdirSync(join(root, 'patches'))
    writeFileSync(join(root, 'patches/three+0.182.0.patch'), [
      'diff --git a/node_modules/three/build/three.webgpu.js b/node_modules/three/build/three.webgpu.js',
      '--- a/node_modules/three/build/three.webgpu.js',
      '+++ b/node_modules/three/build/three.webgpu.js',
      '@@ -1 +1 @@',
      '-this source line does not exist in Three',
      '+this replacement line does not exist either',
      '',
    ].join('\n'))
    const result = spawnSync(process.execPath, [join(root, 'scripts/apply-three-patch.mjs')], { cwd: tmpdir(), encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Three.js patch failed')
  })

})
