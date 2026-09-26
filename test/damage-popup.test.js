import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { Weapon } from '../src/weapons/weapon.js'
import { WEAPONS } from '../src/game/rules.js'
import { MOD } from '../src/game/damage.js'
import { HealthPool } from '../src/game/health.js'
const noop = () => {}
function shoot({ health = 100, armor = 0, mods = 0 }) {
  const pool = new HealthPool({ maxHealth: health, armor })
  const numbers = []
  const weapon = new Weapon(WEAPONS.PISTOL, {
    world: { trace: () => ({ actor: { health: pool }, point: new THREE.Vector3(), normal: new THREE.Vector3(0,1,0), zone: 'body' }), alert: noop },
    fx: { tracer: noop, impact: noop, bloodDecal: noop, damageNumber: event => numbers.push(event.value) },
    audio: { play: noop }, bus: { emit: noop },
  })
  weapon.applyMods(mods)
  weapon.fireSingleTrace(new THREE.Vector3(), new THREE.Vector3(1,0,0), 0, new THREE.Vector3())
  return { pool, numbers }
}
describe('impact numbers show health actually removed now', () => {
  it('does not promise burn on an enemy killed by the direct hit', () => {
    const { pool, numbers } = shoot({ health: 10, mods: MOD.INCENDIARY })
    expect(numbers).toEqual([10])
    expect(pool.dots.count).toBe(0)
  })
  it('keeps burn gameplay while separating it from the immediate number', () => {
    const { pool, numbers } = shoot({ health: 1000, mods: MOD.INCENDIARY })
    expect(numbers).toEqual([20])
    for (let n = 0; n < 600; n++) pool.tick(1 / 60)
    expect(pool.health).toBe(880)
  })
  it('reports health absorbed after armor and an ordinary unarmored hit', () => {
    expect(shoot({ armor: 100 }).numbers).toEqual([10])
    expect(shoot({}).numbers).toEqual([20])
  })
})
