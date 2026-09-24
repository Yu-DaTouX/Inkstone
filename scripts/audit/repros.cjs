const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const esbuild=require('esbuild');
const out=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'inkstone-audit-repros-'));
async function main(){
 await esbuild.build({entryPoints:['src/main/runners.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(out,'runners.mjs')});
 const {RunnerRegistry}=await import(pathToFileURL(path.join(out,'runners.mjs')).href);
 const agents=[];
 const registry=new RunnerRegistry({createAgent:(id,cwd)=>{
  let state={sessionId:id,cwd};
  const a={cwd,running:true,getState:()=>state,getPendingUiCount:()=>0,start:async()=>({ok:true}),stop:async()=>{},newSession:async()=>{state={...state,sessionId:state.sessionId+'n'};return {ok:true};},switchSession:async()=>({ok:true})};agents.push(a);return a;
 }});
 await registry.select({cwd:'C:/audit/A'});
 const selected=await registry.select({cwd:'C:/audit/B'});
 const observations=[{id:'A01',case:'空闲 A 实例选择 B 工作目录',via:selected.via,registryCwd:registry.activeRunner().cwd,agentCwd:registry.active().getState().cwd,confirmed:selected.via==='reuse'&&registry.active().getState().cwd==='C:/audit/A'}];
 globalThis.__audit={gates:[],rpcOptions:[],cleanups:0};
 const mocks={
  './protocol':[
   "import {EventEmitter} from 'node:events';",
   'export class PiRpc extends EventEmitter { constructor(opts){super();globalThis.__audit.rpcOptions.push(opts);} get running(){return true;} spawn(){} async command(){return {success:true,data:{}};} async close(){} }'
  ].join('\n'),
  './subagent-isolation':[
   'export async function prepareWorkspace(cwd,id,isolation){await new Promise(r=>globalThis.__audit.gates.push(r));return {cwd,rootCwd:cwd,isolation,worktreePath:cwd};}',
   'export async function collectDiff(){return {summary:{files:1,additions:1,deletions:0,paths:["example.txt"],truncated:false,patchPath:"audit.patch"},patchPath:"audit.patch"};}',
   'export async function cleanupWorkspace(){globalThis.__audit.cleanups++;}',
   'export async function applyPatch(){return {ok:true};}'
  ].join('\n'),
  './paths':'export const YAN_DIR='+JSON.stringify(out)+';',
  './normalize':'export function normalizeMessage(x){return x;}'
 };
 await esbuild.build({entryPoints:['src/main/subagents.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(out,'subagents.mjs'),plugins:[{name:'audit-stubs',setup(build){build.onResolve({filter:/^\.\/(protocol|subagent-isolation|paths|normalize)$/},args=>({path:args.path,namespace:'audit'}));build.onLoad({filter:/.*/,namespace:'audit'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
 const {SubagentController}=await import(pathToFileURL(path.join(out,'subagents.mjs')).href);
 const controller=new SubagentController({cwd:'C:/audit/A',parentSessionId:'parent-A',parentRunId:'run-A',archiveDir:path.join(out,'mock-metadata'),onChange:()=>{}});
 const first=controller.start('first',undefined,'controlled-cwd');
 controller.setContext({cwd:'C:/audit/B',parentSessionId:'parent-B',parentRunId:'run-B'});
 const second=controller.start('second');
 const third=controller.start('third');
 for(const release of globalThis.__audit.gates)release();
 const result=await Promise.all([first,second,third]);
 observations.push({id:'A02',case:'只读模式启动参数',args:globalThis.__audit.rpcOptions[0].args,cwd:globalThis.__audit.rpcOptions[0].cwd,hasToolRestriction:globalThis.__audit.rpcOptions[0].args.includes('--tools'),confirmed:!globalThis.__audit.rpcOptions[0].args.includes('--tools')});
 observations.push({id:'A03',case:'工作区准备期间切换父会话',firstRunCwd:result[0].run.cwd,firstRunParent:result[0].run.parentSessionId,confirmed:result[0].run.cwd==='C:/audit/A'&&result[0].run.parentSessionId==='parent-B'});
 observations.push({id:'A04',case:'三个同时 start 在 await 前未预留并发槽',successfulStarts:result.filter(r=>r.ok).length,runningCount:controller.runningCount,documentedLimit:2,confirmed:controller.runningCount===3});
 const run=controller.runs.get(result[1].run.id);
 run.status='done';clearTimeout(run.timer);
 await controller.finalize(run,false);
 const before=globalThis.__audit.cleanups;
 await controller.finalize(run,true);
 observations.push({id:'A05',case:'完成后再退出的清理升级',review:run.review,additionalCleanup:globalThis.__audit.cleanups-before,confirmed:run.review==='pending'&&globalThis.__audit.cleanups===before});
 for(const item of controller.runs.values())clearTimeout(item.timer);
 await registry.stopAll();
 fs.writeFileSync(path.join(out,'targeted-repros.json'),JSON.stringify({boundary:'真实项目类 + 依赖桩；仅证明状态决策与参数，不证明真实模型或 OS 权限',observations},null,2));
 console.log(JSON.stringify(observations,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
