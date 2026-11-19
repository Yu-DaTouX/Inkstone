export const meta = { description: '小窗口会话栏开合时，长正文只按目标列宽换行一次，底部不丢失' }

export default async function run({ cdp, newSession, waitFor, sleep, check, shot, report }) {
  const ev = expression => cdp.evaluate(expression)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1370, height: 850, deviceScaleFactor: 1, mobile: false })
  await newSession()
  await ev(`window.__yanStore.getState().patchSettings({theme:'light',workspaceTiles:false,rightPanelOpen:false,reduceMotion:false,panelMotionMs:280})`)
  const para = '窗口变窄时应保留原来的阅读位置。已完成的长段落只按最终宽度换行，不能在会话栏移动时反复重排。'
  const text = Array.from({ length: 12 }, (_, i) => `- 第 ${i+1} 项：${para.repeat(3)}`).join('\n')
  await ev(`window.__yanStore.setState(s=>({messages:[{id:'reflow-user',role:'user',text:'检查小窗口排版',timestamp:Date.now()-15000},{id:'reflow-answer',role:'assistant',text:${JSON.stringify(text)},timestamp:Date.now()-10000}],session:{...s.session,isAgentRunning:false,isStreaming:false},historyLoading:false,switchLoading:false}))`)
  const selector = '[data-turn-id="reflow-answer"] .v3-prose'
  await waitFor(`!!document.querySelector('${selector} li:last-child')`, 8000)
  await sleep(800)
  for (const action of ['open', 'reverse', 'close']) {
    const open = action !== 'close'
    const stats = await ev(`(async()=>{
      const prose=document.querySelector('${selector}'), box=prose.closest('.v3-stream'), row=prose.querySelector('li:last-child'), frames=[]
      const toggle=document.querySelector('[data-testid="v3-head-sessionbar-toggle"]')
      let closingFrames=0, earlyExpansion=0, maxOverlap=0, reopened=false
      const take=()=>{
        const rect=prose.getBoundingClientRect(), bar=document.querySelector('.v3-sessionbar[data-closing]')
        if(bar){closingFrames++;if(rect.width>frames[0].w+1)earlyExpansion++;maxOverlap=Math.max(maxOverlap,rect.right-bar.getBoundingClientRect().left)}
        frames.push({w:Math.round(rect.width),h:Math.round(rect.height),gap:Math.round(box.scrollHeight-box.clientHeight-box.scrollTop),y:Math.round(row.getBoundingClientRect().bottom)})
      }
      take();toggle.click()
      const start=performance.now();while(performance.now()-start<750){await new Promise(requestAnimationFrame);take();if(${action === 'reverse'}&&!reopened&&closingFrames>=3){reopened=true;toggle.click()}}
      return {start:frames[0],end:frames.at(-1),closingFrames,earlyExpansion,maxOverlap,reopened,widths:new Set(frames.map(f=>f.w)).size, heights:new Set(frames.map(f=>f.h)).size, same:row===document.querySelector('${selector} li:last-child'), open:!!document.querySelector('.v3-sessionbar:not([data-closing])'), chat:document.querySelector('.v3-chat').clientWidth, toggle:document.querySelector('[data-testid="v3-head-sessionbar-toggle"]').getAttribute('aria-label')}
    })()`)
    report[action]=stats
    const changed = action==='reverse' ? stats.reopened && stats.widths===1 : Math.abs(stats.start.w-stats.end.w)>30
    check(`${action}：目标列宽、节点与贴底位置正确`,stats.open===open && stats.same && changed && stats.widths<=2 && stats.heights<=2 && Math.abs(stats.end.gap)<=2,stats)
    if(action!=='open') check(`${action}：会话栏退场期间正文不扩宽、不占用栏位`,stats.closingFrames>0 && stats.earlyExpansion===0 && stats.maxOverlap<=1,stats)
    if(action==='open') await shot('opened-light')
  }
}
