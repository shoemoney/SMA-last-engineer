import {it,expect,vi,afterEach} from 'vitest'
import {initArcadeScore} from '../src/ui/arcadeScore.js'
afterEach(()=>vi.unstubAllGlobals())
it('hides names until qualification and refreshes board after native form submission',async()=>{
 const nodes=new Map(),handlers=new Map();for(const id of ['arcade-score-form','arcade-score-name','arcade-score-submit','arcade-score-status','arcade-leaderboard-status','arcade-leaderboard-retry'])nodes.set(id,{hidden:true,value:'',addEventListener:(event,fn)=>handlers.set(id+event,fn),removeEventListener(){}})
 const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:()=>'<b>Player</b>',setItem});vi.stubGlobal('BroadcastChannel',undefined)
 vi.stubGlobal('fetch',vi.fn(async(url)=>({ok:true,json:async()=>url.endsWith('/runs')?{runToken:'token'}:url.endsWith('/qualify')?{qualified:true,score:10100,scoreVersion:2,scores:[]}:url.includes('?')?{scores:[]}:{accepted:true,scoreVersion:2,score:{id:1,name:'<b>Player</b>',score:10100,createdAt:'2026-09-25T20:00:00Z'}}})))
 const client=initArcadeScore({document:{getElementById:id=>nodes.get(id),addEventListener(){},removeEventListener(){}}})
 client.begin();const done=client.finish({completedWaves:1,combatSeconds:60,waveReached:2,kills:1,headshots:0,duration:90})
 expect(nodes.get('arcade-score-form').hidden).toBe(true);await done;expect(nodes.get('arcade-score-form').hidden).toBe(false)
 const preventDefault=vi.fn();await handlers.get('arcade-score-formsubmit')({preventDefault});expect(preventDefault).toHaveBeenCalled();expect(setItem).toHaveBeenCalledWith('last-engineer.arcade.name.v1','<b>Player</b>');client.dispose()
})
