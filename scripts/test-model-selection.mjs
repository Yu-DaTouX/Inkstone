import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=await mkdtemp(join(tmpdir(),'inkstone-model-preferences-'))
try {
 const load=async(entry,name)=>{const file=join(root,name+'.mjs');await build({entryPoints:[entry],outfile:file,bundle:true,platform:'neutral',format:'esm',logLevel:'silent'});return import(pathToFileURL(file).href)}
 const {cleanModelChoice,cleanModelFavorites,modelKey}=await load('src/shared/model-selection.ts','preferences')
 const a={provider:'one',id:'same',name:'First'},b={provider:'two',id:'same'}
 assert.notEqual(modelKey(a),modelKey(b),'Same model id from different providers must remain distinct')
 assert.notEqual(modelKey({provider:'a/b',id:'c'}),modelKey({provider:'a',id:'b/c'}),'Keys do not collide across separators')
 assert.deepEqual(cleanModelFavorites([a,b,a,null,{provider:'unknown',id:'x'},{provider:'x',id:'bad\nvalue'}]),[a,b])
 assert.equal(cleanModelChoice({provider:'x',id:'unknown'}),undefined)
 assert.equal(cleanModelChoice({provider:'x',id:' '.repeat(2)}),undefined)
 assert.equal(cleanModelChoice({provider:'x',id:'x',name:'x'.repeat(300)}).name.length,256)
 assert.equal(cleanModelFavorites(Array.from({length:300},(_,i)=>({provider:'x',id:String(i)}))).length,256)
 const {applyRememberedModel}=await load('src/main/model-default.ts','default')
 let calls=[];const api={listModels:async()=>{calls.push('list');return[a,b]},setModel:async(provider,id)=>{calls.push({provider,id});return{ok:true}}}
 assert.deepEqual(await applyRememberedModel(api),{ok:true});assert.equal(calls.length,0,'No preference leaves native pi default untouched')
 assert.deepEqual(await applyRememberedModel(api,b),{ok:true});assert.deepEqual(calls,['list',{provider:'two',id:'same'}])
 calls=[];const missing=await applyRememberedModel(api,{provider:'missing',id:'same'})
 assert.equal(missing.ok,false);assert.deepEqual(calls,['list'],'Unavailable choice must not switch to another provider')
 api.setModel=async()=>({ok:false,error:'provider unavailable'})
 assert.deepEqual(await applyRememberedModel(api,a),{ok:false,error:'provider unavailable'})
 const {RunnerRegistry}=await load('src/main/runners.ts','runners')
 let applied=0,stopped=0,allowed=true
 const make=()=>({state:{sessionId:'fixture',isAgentRunning:false,isStreaming:false,cwd:'C:/fixture'},getState(){return this.state},getConn:()=>({state:'ready'}),hasRunningBash:()=>false,getPendingUiCount:()=>0,setRunnerGeneration(){},start:async()=>({ok:true}),stop:async()=>{stopped++},initializeContextBudgetV1Default:async()=>({ok:true}),async newSession(){this.state={...this.state,sessionFile:undefined};return{ok:true}},async switchSession(path){this.state={...this.state,sessionFile:path};return{ok:true}}})
 const registry=new RunnerRegistry({createAgent:make,prepareNewSession:async()=>{applied++;return allowed?{ok:true}:{ok:false,error:'remembered unavailable'}}})
 assert.equal((await registry.select({cwd:'C:/fixture'})).ok,true);assert.equal(applied,1,'Fresh instance applies remembered default')
 assert.equal((await registry.select({cwd:'C:/fixture'})).via,'reuse');assert.equal(applied,2,'Reused idle instance also applies default for new conversation')
 assert.equal((await registry.select({cwd:'C:/fixture',sessionFile:'C:/old.jsonl'})).ok,true);assert.equal(applied,2,'Restored history never takes the global model')
 assert.equal((await registry.select({cwd:'C:/fixture',sessionFile:'C:/old.jsonl'})).via,'hit');assert.equal(applied,2)
 allowed=false;assert.equal((await registry.select({cwd:'C:/fixture'})).ok,false)
 assert.equal(registry.active().getState().sessionFile,'C:/old.jsonl','Failed default restores reused conversation')
 const failing=new RunnerRegistry({createAgent:make,prepareNewSession:async()=>({ok:false,error:'unavailable'})})
 assert.equal((await failing.select({cwd:'C:/fixture'})).ok,false);assert.equal(failing.size,0);assert.equal(stopped,1,'A failed fresh setup is collected')
 console.log('PASS: model identity, bounded preference sanitation, exact default/no fallback, fresh/reused/restored runner model semantics')
}finally{await rm(root,{recursive:true,force:true})}
