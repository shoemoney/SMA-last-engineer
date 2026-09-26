import { expect, it, vi } from 'vitest'
import { initRunControls } from '../src/ui/runControls.js'
function setup() {
  const nodes = new Map()
  const document = new EventTarget()
  document.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id,Object.assign(new EventTarget(),{hidden:false,focus:vi.fn()}))
    return nodes.get(id)
  }
  const actions = {onStartWave:vi.fn(),onResume:vi.fn(),onPause:vi.fn(),onSpeedChange:vi.fn()}
  const ui = initRunControls({document,...actions})
  const render = state => ui.render({playing:true,paused:false,speed:1,phase:'preparation',countdown:30,...state})
  const key = (code,target) => { const e = new Event('keydown',{cancelable:true}); Object.defineProperties(e,{code:{value:code},target:{value:target}}); document.dispatchEvent(e) }
  return {nodes,actions,ui,render,key}
}
it('starts ready waves by button and shortcut but never starts during combat', () => {
  const r=setup();r.render({paused:true});r.nodes.get('btn-start-wave').dispatchEvent(new Event('click'));r.key('KeyE')
  expect(r.actions.onStartWave).toHaveBeenCalledTimes(2)
  r.render({phase:'fighting'});r.nodes.get('btn-start-wave').dispatchEvent(new Event('click'));r.key('KeyE')
  expect(r.actions.onStartWave).toHaveBeenCalledTimes(2)
  expect(r.nodes.get('btn-start-wave').hidden).toBe(true)
})
it('keeps name typing from changing speed or starting a wave', () => {
  const r=setup();r.render({});for(const code of ['KeyE','BracketLeft','BracketRight'])r.key(code,{tagName:'INPUT'})
  expect(r.actions.onStartWave).not.toHaveBeenCalled();expect(r.actions.onSpeedChange).not.toHaveBeenCalled()
})
it('exposes bounded speed controls and renders countdown without exposing the paused panel while playing', () => {
  const r=setup();r.render({speed:.5,countdown:9.1,phase:'intermission'})
  expect(r.nodes.get('btn-slower').disabled).toBe(true);expect(r.nodes.get('run-controls').hidden).toBe(true)
  expect(r.nodes.get('run-controls-hint').textContent).toContain('10s')
  r.key('BracketRight');expect(r.actions.onSpeedChange).toHaveBeenLastCalledWith(1)
  r.render({paused:true,speed:2});expect(r.nodes.get('btn-faster').disabled).toBe(true);expect(r.nodes.get('run-controls').hidden).toBe(false)
})
it('keeps lock failure visible until resumed and removes shortcut handlers on destroy', () => {
  const r=setup();r.render({paused:true});r.ui.showError('Click Resume to retry');r.render({paused:true})
  expect(r.nodes.get('run-controls-status').textContent).toBe('Click Resume to retry')
  r.ui.destroy();r.key('KeyE');expect(r.actions.onStartWave).not.toHaveBeenCalled()
})
