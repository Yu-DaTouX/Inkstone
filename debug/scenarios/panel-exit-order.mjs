export const meta = { description: '检查面板退场的鼠标隔离、键盘焦点、标签可见性和正文占位' }

export default async function run({ cdp, newSession, waitFor, sleep, check, shot, box, report }) {
  const ev = expr => cdp.evaluate(expr)
  const dims = width => cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false })
  const patch = settings => ev(`window.__yanStore.getState().patchSettings(${JSON.stringify(settings)})`)
  await dims(1600)
  await newSession(box.project)
  await patch({ theme: 'light', workspaceTiles: false, reduceMotion: false })
  await ev(`window.__yanStore.setState({messages:[{id:'wrap',role:'assistant',text:'这段文字用于核对面板开合时的换行。'.repeat(240),timestamp:Date.now()-12000}]})`)
  report.exits = []
  for (const [ms, reduced] of [[300,false],[600,false],[0,false],[600,true]]) {
    await patch({panelMotionMs:ms,reduceMotion:reduced})
    await ev(`window.__yanRightPanel.getState().open({id:'files',kind:'files'})`)
    await waitFor(`!!document.querySelector('.t3-rp--docked .rp-surface:not([hidden])')`,6000)
    await sleep(700)
    await ev(`(()=>{
      const host=document.querySelector('.t3-rp--docked'), surface=host.querySelector('[data-rp-surface]'), tab=host.querySelector('.rp-surface:not([hidden])'), prose=document.querySelector('.v3-prose'), t=performance.now(), frames=window.__exitFrames=[]
      function take(){const r=surface.getBoundingClientRect();frames.push({t:Math.round(performance.now()-t),connected:host.isConnected,visible:Math.round(Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))),content:tab.getBoundingClientRect().height>0,inert:host.inert,width:Math.round(prose.getBoundingClientRect().width)})}
      take();document.querySelector('[data-testid="v3-head-panel-toggle"]').click();function tick(){take();if(host.isConnected&&performance.now()-t<1500)requestAnimationFrame(tick)}requestAnimationFrame(tick)
    })()`)
    if (ms===600 && !reduced) { await sleep(95); await shot('right-panel-leaving') }
    await waitFor(`window.__exitFrames.at(-1)?.connected===false`,2500)
    const s=await ev(`(()=>{const f=window.__exitFrames, live=f.filter(x=>x.connected);return {elapsed:f.at(-1).t,first:f[0],last:live.at(-1),end:f.at(-1),widths:new Set(f.map(x=>x.width)).size,early:live.some(x=>x.width!==f[0].width),blank:live.some(x=>x.visible>10&&!x.content),inactive:live.some(x=>x.inert)}})()`)
    report.exits.push(s)
    const animated=ms>0&&!reduced
    check(`右栏 ${ms}ms${reduced?' 减少动效':''}：内容和占位保留至卸载，正文只扩宽一次`,!s.blank&&!s.early&&s.widths===2&&s.end.width>s.first.width, s)
    check(`右栏 ${ms}ms${reduced?' 减少动效':''}：遵守时长、退场时禁用交互`,animated?s.elapsed>=ms-30&&s.elapsed<ms+200&&s.last.visible<24&&s.inactive:s.elapsed<120,s)
  }
  await patch({panelMotionMs:600,reduceMotion:false})
  await ev(`(()=>{const b=document.querySelector('[data-testid="v3-side-close"]');b.focus();b.click()})()`)
  await sleep(35)
  const returned=await ev(`document.activeElement?.dataset.testid==='v3-rail-toggle'`)
  for(const type of ['keyDown','keyUp']) await cdp.call('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
  check('停靠左栏收起即归还焦点，Tab 不进入隐藏栏',returned&&await ev(`document.querySelector('.v3-side').inert&&!document.activeElement.closest('.v3-side')`),{returned})
  await dims(640)
  await waitFor(`!!document.querySelector('.v3-root[data-narrow="1"]')`,6000)
  await ev(`document.querySelector('[data-testid="v3-rail-toggle"]').click()`)
  await waitFor(`!!document.querySelector('.v3-scrim')`,6000)
  await sleep(700)
  await ev(`(()=>{document.querySelector('.v3-scrim').click();window.__exitHits=[];document.addEventListener('click',e=>window.__exitHits.push(e.target.classList.contains('v3-scrim')),{once:true,capture:true})})()`)
  await sleep(55)
  const hit=await ev(`(()=>{const r=document.querySelector('.v3-side').getBoundingClientRect(), x=Math.floor(r.right/2), y=Math.floor((r.top+r.bottom)/2);return {x,y,right:r.right,blocked:document.querySelector('.v3-main').inert}})()`)
  for(const type of ['mousePressed','mouseReleased']) await cdp.call('Input.dispatchMouseEvent',{type,x:hit.x,y:hit.y,button:'left',clickCount:1})
  check('窄窗抽屉仍可见时，真实鼠标点击落在遮罩',hit.right>10&&hit.blocked&&await ev(`window.__exitHits[0]===true`),hit)
  await waitFor(`!document.querySelector('.v3-scrim')`,2000)
  check('抽屉退完才释放主区并归还焦点',await ev(`!document.querySelector('.v3-main').inert&&document.activeElement?.dataset.testid==='v3-rail-toggle'`))
}
