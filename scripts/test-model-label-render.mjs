import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

await mkdir('.tmp/model-label-render',{recursive:true})
const dir = await mkdtemp(resolve('.tmp/model-label-render/run-'))
let checks = 0
const check = (condition, label) => { assert.ok(condition,label); checks++ }
try {
  const outfile = join(dir,'components.mjs')
  const modules = {
    state: `export let state={};export const setState=value=>{state=value};export const useStore=selector=>selector(state);useStore.getState=()=>state;`,
    i18n: `export const useT=()=>((key,vars)=>key);`,
    confirm: `export const useConfirm=()=>async()=>true;`,
    ui: `const h=globalThis.__inkstoneLabelRender;export const Button=({children,variant,size,active,trailingIcon,...props})=>h('button',props,children);export const Badge=({children})=>h('span',null,children);export const IconButton=({label})=>h('button',{'aria-label':label});`,
    reasoning: `export const ReasoningCapsule=()=>null;`,
    tool: `export const ToolGroup=()=>null;`,
    progress: `export const runPhaseText=()=>'';export const useRunProgress=()=>({});`,
    scrollAnchor: `export const withScrollAnchor=(element,action)=>{action();};`,
    icon: `const h=globalThis.__inkstoneLabelRender;export const Icon=({name,size,className})=>h('span',{className});`,
    turn: `export const TurnView=()=>null;`,
    markdown: `const h=globalThis.__inkstoneLabelRender;export const Markdown=({text,children})=>h('span',null,text ?? children);`
  }
  globalThis.__inkstoneLabelRender = createElement
  globalThis.React = { createElement, Fragment }
  await build({stdin:{contents:`export {SubagentGroup} from './src/renderer/src/components/chat/SubagentCards';export {TurnMeta} from './src/renderer/src/components/chat/TurnProcess';export {AgentMessageStream} from './src/renderer/src/components/chat/AgentMessageStream';export {SubagentPlan} from './src/renderer/src/components/workbench/SubagentPlan';export {groupIntoTurns} from './src/shared/turns';export {normalizeMessage} from './src/main/normalize';export {setState} from 'inkstone-test-state';`,resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'label-adjacencies',setup(b){
    const fixtures = [ [/^(inkstone-test-state)$|state\/store$/,'state'], [/(^|\/)i18n$/,'i18n'], [/ui\/confirm$/,'confirm'], [/ui$/,'ui'], [/Reasoning$/,'reasoning'], [/ToolRow$/,'tool'], [/scrollAnchor$/,'scrollAnchor'], [/icons\/Icon$/,'icon'], [/run-status$/,'progress'], [/TurnView$/,'turn'], [/MessageParts$/,'markdown'] ]
      for (const [filter,name] of fixtures) b.onResolve({filter},()=>({path:name,namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js'}))
  }}]})
  const mod = await import(pathToFileURL(outfile).href)
  const models = [ {provider:'commandcode',id:'deepseek/deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}, {provider:'openai-codex',id:'gpt-6.1-sol',name:'GPT-6.1 Sol'} ]
  const state = { models,settings:{modelFavorites:[]},session:{model:models[1]},stopSubagent:async()=>{},mergeSubagent:async()=>{},discardSubagent:async()=>{} }
  mod.setState(state)
  const run = {id:'labels',task:'Inspect model labels',model:'commandcode/deepseek/deepseek-v4.1-flash',status:'running',review:'none',isolation:'shared-cwd',startedAt:Date.now(),thinkingLevel:'medium',transcript:[],cwd:process.cwd()}
  const render = (label,component,props)=>{try{return renderToStaticMarkup(createElement(component,props))}catch(error){console.error('render failed:',label,'|',error.message);throw error}}
  const text = (html,id)=>html.match(new RegExp(`<span[^>]*data-testid="${id}"[^>]*>([^<]*)</span>`))?.[1]
  const card = render('SubagentGroup',mod.SubagentGroup,{runs:[run]})
  check(text(card,'subagent-note-model-labels') === 'DeepSeek V4.1 Flash · commandcode','collapsed chat card displays menu name and supplier')
  check(card.includes('title="commandcode/deepseek/deepseek-v4.1-flash"'),'card retains complete identity in tooltip')
  const plan = render('SubagentPlan',mod.SubagentPlan,{runs:[run],mainModel:'openai-codex/gpt-6.1-sol',onOpen:()=>{}})
  check(plan.includes('DeepSeek V4.1 Flash · commandcode'),'child workspace list displays supplier without details')
  check(plan.includes('GPT-6.1 Sol · openai-codex'),'workspace main-model summary uses catalog name')
  const stream = render('AgentMessageStream',mod.AgentMessageStream,{run})
  check(text(stream,'subagent-stream-model') === 'DeepSeek V4.1 Flash · commandcode','child transcript header displays source supplier')
  const message = mod.normalizeMessage({role:'assistant',provider:'openai-codex',model:'gpt-6.1-sol',content:[{type:'text',text:'hello'}],timestamp:1},0)
  const turn = mod.groupIntoTurns([message])[0]
  const footer = render('TurnMeta',mod.TurnMeta,{turn})
  check(text(footer,'turn-model') === 'GPT-6.1 Sol','footer uses exact menu capitalization from native provider/model')
  check(footer.includes('(openai-codex/gpt-6.1-sol)'),'footer keeps complete recorded identity for accessibility')
  const legacy = render('TurnMeta-legacy',mod.TurnMeta,{turn:{...turn,model:'gpt-6.1-sol'}})
  check(text(legacy,'turn-model') === 'GPT-6.1 Sol','old bare-ID footer resolves unambiguous menu name')
  mod.setState({...state,models:[],settings:{modelFavorites:models}})
  check(text(render('TurnMeta',mod.TurnMeta,{turn}),'turn-model') === 'GPT-6.1 Sol','unavailable catalog uses same saved name as menu')
  mod.setState({...state,models:[...models,{provider:'other',id:'gpt-6.1-sol',name:'Different Model'}]})
  check(text(render('TurnMeta-legacy',mod.TurnMeta,{turn:{...turn,model:'gpt-6.1-sol'}}),'turn-model') === 'gpt-6.1-sol','ambiguous legacy identity is not attributed to current selected provider')
  check(text(render('SubagentGroup-unknown',mod.SubagentGroup,{runs:[{...run,model:undefined}]}),'subagent-note-model-labels') === '—','missing child model remains unknown')
  console.log(`model-label-render: ${checks} component rendering checks passed`)
} finally {
  if(process.env.KEEP_LABEL_RENDER) console.log('kept',dir)
  else await rm(dir,{recursive:true,force:true})
}
