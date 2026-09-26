import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const threeRoot = dirname(dirname(require.resolve('three')))
const version = JSON.parse(readFileSync(join(threeRoot, 'package.json'), 'utf8')).version
if (version !== '0.182.0') throw new Error(`Expected three@0.182.0, found ${version}`)
const expected = {
  "src/nodes/core/NodeBuilder.js": {
    "pristine": "8bc21bbda6d3304efd78d9385f73ec0ea4115f9dbad308b8e88adcb9d604da37",
    "patched": "148edba009f1d86d4d5daada38d9366ec81625f8fe248cda17daae3e9f8877cb"
  },
  "build/three.webgpu.js": {
    "pristine": "7c563f76bb2a95a2d15bda8c8a70181974715973667b24ae53adf166ab143384",
    "patched": "5aae03a2ebbfff49e33c153d2a5bb226b586dd45a7c492ff7d2873c283d4ec30"
  }
}
const digest = name => createHash('sha256').update(readFileSync(join(threeRoot, name))).digest('hex')
for (const [name, hashes] of Object.entries(expected)) {
  const actual = digest(name)
  if (actual !== hashes.pristine && actual !== hashes.patched) {
    throw new Error(`Unrecognized Three.js source: ${name}; refusing to patch`)
  }
}
const patchPackageRoot = dirname(require.resolve('patch-package/package.json'))
const result = spawnSync(process.execPath, [join(patchPackageRoot, 'index.js'), '--error-on-fail'], {
  cwd: projectRoot, stdio: 'inherit', env: process.env,
})
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Three.js patch failed: ${result.signal ?? result.status}`)
for (const [name, hashes] of Object.entries(expected)) {
  if (digest(name) !== hashes.patched) throw new Error(`Three.js patch verification failed: ${name}`)
}
