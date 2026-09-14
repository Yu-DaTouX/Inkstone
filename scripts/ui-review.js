;(async()=>{
const store=window.__yanStore
const css=document.createElement('style');css.id='review-style'
css.textContent=`
:root {--w-stream:880px;--fs-xs:11px;--fs-sm:12px;--r-md:4px;--r-lg:4px}
.stream-inner,.composer-wrap{max-width:880px!important;width:100%;box-sizing:border-box}
.msg{margin-bottom:24px!important}.msg.user .bubble{border:0!important;background:#151515!important;border-radius:2px!important;padding:12px 16px!important;box-shadow:none!important}
.msg-label{font-size:12px!important;color:#a7afaf!important;margin-bottom:8px!important}
.prose{line-height:1.8!important;letter-spacing:0!important}
.reason-head,.tgroup-head{font-size:11px!important;color:#8a9494!important}
.turn{border:0!important;padding-left:0!important}.trow{border-left:2px solid #303636;padding:4px 8px;margin:12px 0!important;background:#101313}
.trow[data-state=running]{border-left-color:#53c9bc}.trow-head{min-height:32px!important}.trow-target{color:#c6d1cf!important}
.trow[data-state=ok] .trow-ico{color:#74bd93}.trow[data-state=error]{border-left-color:#df7373}
.trow-body{margin-top:8px}.term{box-shadow:none!important;border-radius:2px!important}
.composer{border:1px solid #303636!important;border-radius:4px!important;box-shadow:none!important;background:#151717!important}
.cborder,.cborder-status,.cborder-text,.cborder-spinner{color:#53c9bc!important;border-color:#53c9bc!important}
.srow{min-height:32px!important;border-radius:2px!important}.srow.active,.srow.sel,.srow.selected{background:#182120!important;box-shadow:inset 2px 0 #53c9bc!important}
.shead-proj{order:-1;background:none!important;border:0!important;color:#929c9b!important}.shead-title{font-size:13px!important}.shead-proj:after{content:'/';margin-left:12px;color:#56605e}
.rp-title{font-size:12px!important}.rp-context-summary{font-size:12px!important}.rp-context-summary strong{font-size:13px!important}.rp-meter{height:3px!important}
.rp-mode{display:none!important}.rp-slot{margin-bottom:16px!important}.rp-dim,.srow-time{color:#8b9492!important;font-size:11px!important}.rp-todo.active{background:#182120!important}.rp-state.doing{color:#53c9bc!important}
#review-controls{position:fixed;top:3px;left:110px;z-index:99999;display:flex;gap:8px;align-items:center;font:11px 'Maple Mono CN',monospace;color:#aab6b3;-webkit-app-region:no-drag}
#review-controls button{font:inherit;color:#b8ceca;background:#1b2422;border:1px solid #34423e;border-radius:2px;padding:3px 8px;cursor:pointer}#review-controls button:focus-visible{outline:1px solid #53c9bc}
`
document.head.append(css)
const controls=document.createElement('div');controls.id='review-controls';controls.innerHTML='<span>模拟 · 不执行命令</span><button id="review-pause">暂停</button><button id="review-replay">重播</button><button id="review-compare">查看原版</button><span id="review-phase"></span>';document.body.append(controls)
const initial=structuredClone(store.getState().messages)
let tick=0,paused=false
store.setState(s=>({settings:{...s.settings,railWidth:240,panelWidth:280,streamWidth:880,toolDetail:true},notices:[],todoHistory:[]}))
controls.querySelector('#review-pause').onclick=e=>{paused=!paused;e.target.textContent=paused?'继续':'暂停'}
controls.querySelector('#review-replay').onclick=()=>{tick=0;paused=false;controls.querySelector('#review-pause').textContent='暂停';render()}
controls.querySelector('#review-compare').onclick=e=>{css.disabled=!css.disabled;e.target.textContent=css.disabled?'查看优化版':'查看原版'}
const thinking='先核对组件层级与运行状态，再优化工具摘要。保留等宽字体与终端骨架，不改变 pi 的执行逻辑。'
const answer='界面调整已完成：工具默认显示紧凑摘要，完整输出按需展开。现在检查布局与交互。'
const lines=['$ npm run check','[模拟] 检查 TypeScript 类型…','[模拟] 检查样式规范…','[模拟] 校验工具展开交互…','[模拟] 校验布局宽度…','[模拟] 检查结束：0 errors · 0 warnings']
function render(){
const phase=tick<20?'思考':tick<40?'生成':tick<80?'执行':'完成'
const messages=structuredClone(initial);const last=messages.at(-1)
last.thinking=thinking.slice(0,Math.min(thinking.length,tick*4));last.thinkingLive=tick<20;last.thinkingMs=Math.min(tick*250,5000)
last.text=tick<20?'':answer.slice(0,(tick-20)*4)
last.toolCalls=tick<40?[]:[{id:'review-tool',name:'bash',args:{command:'npm run check'},status:tick<80?'running':'ok',startedAt:Date.now()-Math.max(0,tick-40)*250,...tick>=80?{endedAt:Date.now()}: {},output:lines.slice(0,Math.min(6,1+Math.floor((tick-40)/8))).join('\n')}]
store.setState(s=>({messages,session:{...s.session,isStreaming:tick<40,isAgentRunning:tick<80},todos:[{text:'核对终端风格与层级',done:tick>=20},{text:'优化工具摘要与输入区',done:tick>=40},{text:'检查布局与交互（模拟）',done:tick>=80}]}))
controls.querySelector('#review-phase').textContent=phase+' · '+Math.floor(tick/4)+'s'
// Use the existing React click handler, not CSS hiding that prevents expansion.
const row=document.querySelector('[data-tool="bash"] [data-testid="tool-row"]')
if(row&&!row.dataset.reviewInitialized){row.dataset.reviewInitialized='true';if(row.getAttribute('aria-expanded')==='true')row.click()}
}
render();setInterval(()=>{if(!paused){tick=Math.min(tick+1,96);render()}},250)
return 'review-ready'
})()
