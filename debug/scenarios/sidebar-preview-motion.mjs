import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { demo: true, description: '消息内文件链接打开右栏：宽度、贴底、阅读位置与展开收起动画回归' }

export default async function run({ cdp, waitFor, check, log, sleep, shot, fake, runDir }) {
  const ev = expression => cdp.evaluate(expression)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({lang:'zh-CN',theme:'dark',reduceMotion:false,workspaceTiles:true})`)
  await waitFor(`!!document.querySelector('a[data-link-kind="file"]') && !s.switchLoading`)
  await ev(`document.fonts.ready`)
  await sleep(1000)
  await ev(`window.__previewOriginal=window.__yanStore.getState().messages`)
  const close = async () => {
    await ev(`window.__yanRightPanel.getState().closeAll()`)
    await sleep(700)
  }
  const start = async (closing = false) => {
    await ev(`(() => {const stream=document.querySelector('.v3-stream'),link=[...stream.querySelectorAll('a[data-link-kind="file"]')].find(x=>{const r=x.getBoundingClientRect(),s=stream.getBoundingClientRect();return r.top>=s.top&&r.bottom<=s.bottom});window.__previewTrace=[];window.__previewPaintTrace=[];window.__previewLink=link;window.__previewMotionDone=false;const begin=performance.now();const tick=()=>{const p=document.querySelector('[data-testid="rp"]'),r=link?.getBoundingClientRect();window.__previewTrace.push({t:performance.now()-begin,win:innerWidth,chat:document.querySelector('.v3-chat')?.clientWidth,root:document.querySelector('.v3-root')?.clientWidth,w:stream.clientWidth,top:stream.scrollTop,size:stream.scrollHeight,h:stream.clientHeight,y:r?.top,panel:p?.getBoundingClientRect().width,clip:p?getComputedStyle(p).clipPath:null});setTimeout(()=>{const a=window.__previewReading;window.__previewPaintTrace.push({t:performance.now()-begin,w:stream.clientWidth,anchor:a?.isConnected?a.getBoundingClientRect().top:null})},0);if(performance.now()-begin<1000)requestAnimationFrame(tick);else window.__previewMotionDone=true};requestAnimationFrame(tick)})()`)
    if (closing) await ev(`window.__yanRightPanel.getState().setOpen(false)`)
    else {
      const point=await ev(`(() => {const r=window.__previewLink?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
      if (!point) throw Error('当前视口缺少文件链接')
      await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point})
      await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point})
    }
    await waitFor('window.__previewMotionDone')
    const trace=await ev('window.__previewTrace')
    writeFileSync(join(runDir,'preview-trace-'+Date.now()+'.json'),JSON.stringify(trace,null,2))
    const widths=[...new Set(trace.map(x=>x.w))]
    const last=trace.at(-1)
    const summary={widths,bottom:Math.max(0,last.size-last.top-last.h),yChanges:trace.slice(1).filter((x,i)=>Math.abs(x.y-trace[i].y)>.5).length,animated:trace.some(x=>x.clip&&x.clip!=='inset(0px)'&&x.clip!=='none'),present:!!last.panel}
    log(closing?'收起采样':'展开采样',summary)
    const painted=await ev('window.__previewPaintTrace')
    writeFileSync(join(runDir,'preview-painted-'+Date.now()+'.json'),JSON.stringify(painted,null,2))
    return {trace,summary,painted}
  }
  await close()
  const short=await start()
  check('短会话打开预览只调整一次消息宽度',short.summary.widths.length<=2,short.summary)
  check('右栏保留独立展开动画',short.summary.animated)
  check('打开后文件预览可见',await ev(`!!document.querySelector('[data-testid="rp"]') && !!window.__yanRightPanel.getState().byKey[window.__yanRightPanel.getState().key]?.open`))
  const repeated=await start()
  check('重复点击已打开文件不改变消息宽度和位置',repeated.summary.widths.length===1&&repeated.summary.yChanges===0,repeated.summary)
  const closed=await start(true)
  check('收起只调整一次消息宽度且最终移除面板',closed.summary.widths.length<=2&&!closed.summary.present,closed.summary)
  for (const [name,count] of [['普通长会话',12],['虚拟长会话',110]]) {
    await close()
    await ev(`(() => {const last=window.__previewOriginal.filter(x=>x.role==='assistant').at(-1),now=Date.now();window.__yanStore.setState(s=>({messages:Array.from({length:${count}},(_,i)=>[{id:'preview-user-'+i,role:'user',text:'第 '+i+' 轮复核',timestamp:now+i*2},{...last,id:'preview-answer-'+i,timestamp:now+i*2+1}]).flat(),session:{...s.session,isStreaming:false,isAgentRunning:false},historyLoading:false,switchLoading:false}))})()`)
    await sleep(1400)
    const bottom=await ev(`(() => {const b=document.querySelector('.v3-stream');b.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));b.scrollTop=b.scrollHeight;return b.scrollHeight-b.clientHeight})()`)
    await sleep(1100)
    check(name+'样本确实可滚动',bottom>500)
    const result=await start()
    check(name+'文件链接点击后保持贴底',result.summary.bottom<=2,result.summary)
    check(name+'展开期间消息宽度不逐帧变化',result.summary.widths.length<=2,result.summary)
    await close()
    const point=await ev(`(() => {const b=document.querySelector('.v3-stream'),r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',deltaX:0,deltaY:-1800,...point})
    await sleep(1300)
    const anchor=await ev(`(() => {const b=document.querySelector('.v3-stream'),base=b.getBoundingClientRect().top;const row=[...b.querySelectorAll('.v3-msg[data-turn-id]')].find(x=>x.getBoundingClientRect().top>=base&&x.getBoundingClientRect().bottom<base+b.clientHeight);window.__previewReading=row;return row?{id:row.dataset.turnId,y:row.getBoundingClientRect().top}:null})()`)
    if (!anchor) throw Error(name+'缺少可视阅读锚点')
    const reading=await start()
    const position=await ev(`({y:window.__previewReading?.getBoundingClientRect().top,jump:!!document.querySelector('[data-testid="v3-jump"]')})`)
    const deviation=Math.max(...reading.painted.filter(x=>x.anchor!==null).map(x=>Math.abs(x.anchor-anchor.y)))
    check(name+'预览后保留阅读位置',Math.abs(position.y-anchor.y)<=3&&position.jump,{before:anchor,after:position})
    check(name+'展开期间阅读锚点不来回跳动',deviation<=3,{maxShift:deviation})
    await shot(name==='普通长会话'?'preview-reading-dom':'preview-reading-virtual')
    await close()
  }
  await ev(`window.__yanStore.setState({messages:window.__previewOriginal});window.__yanStore.getState().patchSettings({reduceMotion:true})`)
  await sleep(1300)
  const reduced=await start()
  check('减少动效设置下宽度一次调整',reduced.summary.widths.length<=2)
  check('回归未调用模型',!fake?.requests.length)
}
