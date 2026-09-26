import { describe, expect, it } from 'vitest'
import { NodeBuilder as BundledBuilder } from 'three/webgpu'
import SourceBuilder from 'three/src/nodes/core/NodeBuilder.js'

for (const [name, Builder] of [['active WebGPU bundle', BundledBuilder], ['source module', SourceBuilder]]) {
  describe(`NodeBuilder membership: ${name}`, () => {
    it('deduplicates by identity while retaining insertion and sequential order', () => {
      const builder = new Builder(null, null, null)
      const calls = []
      const a = { getHash: () => { calls.push('a'); return 'a' } }
      const b = { getHash: () => { calls.push('b'); return 'b' } }
      for (const node of [a, b, a]) builder.addNode(node)
      for (const node of [b, a, b]) builder.addSequentialNode(node)
      expect(builder.nodes).toEqual([a, b])
      expect(builder.sequentialNodes).toEqual([b, a])
      expect(calls).toEqual(['a', 'b'])
      expect(builder.includes(a)).toBe(true)
      expect(builder.includes({})).toBe(false)
    })

    it('keeps distinct nodes with colliding hashes and registers the latest hash', () => {
      const builder = new Builder(null, null, null)
      const a = { getHash: () => 'same' }, b = { getHash: () => 'same' }
      builder.addNode(a); builder.addNode(b)
      expect(builder.nodes).toEqual([a, b])
      expect(builder.hashNodes.same).toBe(b)
    })

    it('publishes membership before reentrant hash calculation', () => {
      const builder = new Builder(null, null, null)
      let calls = 0
      const node = { getHash(current) {
        calls++
        expect(current.includes(this)).toBe(true)
        current.addNode(this)
        return 'recursive'
      } }
      builder.addNode(node)
      expect(calls).toBe(1)
      expect(builder.nodes).toEqual([node])
    })

    it('retains original membership semantics when hashing throws', () => {
      const builder = new Builder(null, null, null)
      let calls = 0
      const node = { getHash() { calls++; throw new Error('hash failed') } }
      expect(() => builder.addNode(node)).toThrow('hash failed')
      expect(() => builder.addNode(node)).not.toThrow()
      expect(calls).toBe(1)
      expect(builder.includes(node)).toBe(true)
      expect(builder.nodes).toEqual([node])
    })

    it('keeps membership local to each builder', () => {
      const a = new Builder(null, null, null), b = new Builder(null, null, null)
      const node = { getHash: () => 'shared' }
      a.addNode(node)
      expect(b.includes(node)).toBe(false)
      b.addNode(node)
      expect(b.nodes).toEqual([node])
    })

    it('preserves frame and render update order', () => {
      const builder = new Builder(null, null, null)
      const make = hash => ({ getHash: () => hash, getUpdateType: () => 'frame', getUpdateBeforeType: () => 'render', getUpdateAfterType: () => 'none' })
      const child = make('child'), parent = make('parent')
      for (const node of [child, parent, child]) { builder.addNode(node); builder.addSequentialNode(node) }
      builder.buildUpdateNodes()
      expect(builder.updateNodes).toEqual([child, parent])
      expect(builder.updateBeforeNodes).toEqual([child, parent])
      expect(builder.updateAfterNodes).toEqual([])
    })
  })
}
