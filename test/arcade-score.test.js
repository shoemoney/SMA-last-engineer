import {it,expect,vi} from 'vitest'
import {createScoreClient} from '../src/arcade/scoreClient.js'
import {runScore as rankedScore} from '../src/game/runScore.js'
const summary=()=>({scoringVersion:2,completedWaves:1,combatSeconds:60,score:10100,waveReached:2,kills:12,headshots:4,duration:90})
const ok=body=>({ok:true,json:async()=>body})
const accepted=(name='Jeremy')=>({accepted:true,scoreVersion:2,score:{id:1,name,score:10100,createdAt:'2026-09-25T20:00:00Z'}})
const reject=status=>({ok:false,status,headers:{get:()=> '30'},json:async()=>({error:'Rejected'})})
function setup({qualifier,submitter,issuer}={}){
 const submits=[];let issues=0
 const request=vi.fn(async(url,options)=>{
  if(url.endsWith('/runs')){issues++;return issuer ? issuer(issues) : ok({runToken:'token',scoreVersion:2})}
  if(url.includes('?'))return ok({scores:[],scoreVersion:2})
  if(url.endsWith('/qualify'))return qualifier ? qualifier(JSON.parse(options.body)) : ok({qualified:true,score:10100,scoreVersion:2,scores:[]})
  submits.push(options.body);return submitter ? submitter(submits.length,JSON.parse(options.body)) : ok(accepted())
 })
 return {client:createScoreClient({request}),request,submits,issues:()=>issues}
}
it('derives bounded score from completed waves and simulated combat',()=>{
 expect(rankedScore(0,100)).toBe(0);expect(rankedScore(3,145.25)).toBe(30123);expect(rankedScore(1,0)).toBe(16000);expect(rankedScore(2,0)).toBe(29999)
})
it('qualifies before allowing names and submits only a frozen token and name',async()=>{
 let resolve;const wait=new Promise(r=>resolve=r)
 const a=setup({qualifier:()=>wait});a.client.begin();const finish=a.client.finish(summary())
 expect(a.client.state().status).toBe('qualifying');expect(await a.client.submit('Jeremy')).toBe(false)
 resolve(ok({qualified:true,score:10100,scoreVersion:2,scores:[]}));await finish
 expect(await a.client.submit('Jeremy')).toBe(true)
 expect(JSON.parse(a.submits[0])).toEqual({runToken:'token',scoreVersion:2,name:'Jeremy'})
 expect(await a.client.submit('Jeremy')).toBe(false)
})
it('does not offer a name for zero waves or below cutoff',async()=>{
 for(const reason of ['complete_wave','below_cutoff']){
  const a=setup({qualifier:()=>ok({qualified:false,score:10100,scoreVersion:2,reason,scores:[]})});a.client.begin();await a.client.finish(summary())
  expect(a.client.state().status).toBe('unqualified');expect(await a.client.submit('Jeremy')).toBe(false);expect(a.submits).toHaveLength(0)
 }
})
it('retries failed qualification without showing a name',async()=>{
 let attempts=0;const a=setup({qualifier:()=>++attempts===1?reject(503):ok({qualified:true,score:10100,scoreVersion:2,scores:[]})})
 a.client.begin();await a.client.finish(summary());expect(a.client.state().status).toBe('qualification-error')
 await a.client.qualify();expect(a.client.state().status).toBe('ready');expect(a.issues()).toBe(1)
})
it('locks ambiguous submission name and retries identical bytes',async()=>{
 const a=setup({submitter:n=>{if(n===1)throw Error('response lost');return ok(accepted('Alice Smith'))}})
 a.client.begin();await a.client.finish(summary());expect(await a.client.submit('Ａlice  Smith')).toBe(false)
 expect(a.client.state().nameLocked).toBe(true);expect(await a.client.submit('Other')).toBe(false)
 expect(await a.client.submit('Alice Smith')).toBe(true);expect(a.submits[0]).toBe(a.submits[1])
})
it.each([404,409,410])('closes terminal HTTP %s',async code=>{
 const a=setup({submitter:()=>reject(code)});a.client.begin();await a.client.finish(summary());await a.client.submit('Jeremy');expect(a.client.state().status).toBe('terminal')
})
it('allows correction after validation rejection and reports rate wait',async()=>{
 const a=setup({submitter:n=>n===1?reject(400):n===2?reject(429):ok(accepted('Corrected'))});a.client.begin();await a.client.finish(summary())
 await a.client.submit('Wrong');expect(a.client.state().nameLocked).toBe(false)
 await a.client.submit('Corrected');expect(a.client.state().message).toContain('Wait 30 seconds')
 expect(await a.client.submit('Corrected')).toBe(true)
})
it('handles a displaced qualified score without reporting save success',async()=>{
 const a=setup({submitter:()=>ok({accepted:false,qualified:false,reason:'board_changed',scores:[]})});a.client.begin();await a.client.finish(summary())
 expect(await a.client.submit('Jeremy')).toBe(false);expect(a.client.state().status).toBe('unqualified');expect(a.client.state().message).toContain('board changed')
})
it('rejects wrong confirmation and invalid normalized names',async()=>{
 const a=setup({submitter:()=>ok(accepted('Bob'))});a.client.begin();await a.client.finish(summary())
 for(const name of ['','ﬃ'.repeat(9),'bad\nname'])expect(await a.client.submit(name)).toBe(false)
 expect(a.submits).toHaveLength(0);expect(await a.client.submit('Alice')).toBe(false);expect(a.client.state().nameLocked).toBe(true)
})
it('ignores a previous run qualification response',async()=>{
 let resolve;const wait=new Promise(r=>resolve=r);const a=setup({qualifier:()=>wait})
 a.client.begin();const old=a.client.finish(summary());await vi.waitFor(()=>expect(a.request.mock.calls.some(([u])=>u.endsWith('/qualify'))).toBe(true))
 a.client.begin();resolve(ok({qualified:true,score:10100,scoreVersion:2,scores:[]}));await old
 expect(a.client.state().status).toBe('hidden');expect(a.client.state().summary).toBe(null)
})

it('loads and deduplicates the hero board before any run token exists',async()=>{
 let resolve;const result=new Promise(r=>resolve=r)
 const request=vi.fn(()=>result),client=createScoreClient({request})
 const first=client.refreshBoard(),second=client.refreshBoard()
 expect(request).toHaveBeenCalledTimes(1)
 expect(request.mock.calls[0][0]).toBe('/api/games/last-engineer/scores?scoreVersion=2')
 resolve(ok({scores:[{name:'Leader',score:12345}]}));await Promise.all([first,second])
 expect(client.state()).toMatchObject({status:'hidden',summary:null,boardStatus:'ready',scores:[{name:'Leader',score:12345}]})
 expect(request.mock.calls.every(([,options])=>options.method !== 'POST')).toBe(true)
})
