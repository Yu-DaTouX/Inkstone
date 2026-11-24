export const meta = { description: '检查面板退场的鼠标隔离、键盘焦点、标签可见性和正文占位' }

export default async function run({ cdp, newSession, waitFor, sleep, check, shot, box, report }) {
  const ev = expr => cdp.evaluate(expr)
  const dims = width => cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false })
  const patch = settings => ev(`window.__yanStore.getState().patchSettings(${JSON.stringify(settings)})`)
  await dims(1600)
  await newSession(box.project)
  await patch({ theme: 'dark', windowGlass: 'off', workspaceTiles: false, reduceMotion: false })
  await waitFor(`document.documentElement.dataset.theme==='dark' && document.documentElement.dataset.glass==='off'`)
  await ev(`window.__yanStore.setState({messages:[{id:'wrap',role:'assistant',text:'这段文字用于核对面板开合时的换行。'.repeat(240),timestamp:Date.now()-12000}]})`)
  await ev(`window.__yanRightPanel.getState().setOpen(false)`)
  await waitFor(`!document.documentElement.matches('[data-window-resizing], [data-motion-hold]') && document.querySelector('.v3-root[data-panel="closed"]') && !document.querySelector('.t3-rp--docked')`)
  const chromePositions = `() => {
    const x = id => Math.round(document.querySelector('[data-testid="'+id+'"]').getBoundingClientRect().left)
    return [x('v3-head-panel-toggle'), x('v3-min'), x('v3-max'), x('v3-close')].join(',')
  }`
  const overviewX = `() => Math.round(document.querySelector('[data-testid="v3-head-sessionbar-toggle"]').getBoundingClientRect().left)`
  const tabX = `() => Math.round(document.querySelector('.t3-rp--docked [data-testid="rp-new-tab"]')?.getBoundingClientRect().left ?? -1)`
  report.exits = []
  report.entries = []
  for (const [ms, reduced] of [[300,false],[600,false],[0,false],[600,true]]) {
    await patch({panelMotionMs:ms,reduceMotion:reduced})
    await waitFor(`document.documentElement.style.getPropertyValue('--panel-dur')===${JSON.stringify(ms+'ms')} && (document.documentElement.dataset.reduceMotion==='true')===${reduced}`)
    const animated=ms>0&&!reduced
    const entering=ev(`new Promise(resolve => {
      const t=performance.now(), frames=[]
      const chrome=${chromePositions}, overview=${overviewX}, tab=${tabX}
      function take() {
        const surface=document.querySelector('.t3-rp--docked [data-rp-surface]')
        frames.push({t:Math.round(performance.now()-t),panel:Math.round(surface?.getBoundingClientRect().width ?? 0),overview:overview(),chrome:chrome(),tab:tab()})
      }
      take()
      window.__yanRightPanel.getState().open({id:'files',kind:'files'})
      function tick(){take();if(performance.now()-t<${ms+160})requestAnimationFrame(tick);else resolve(frames)}
      requestAnimationFrame(tick)
    })`)
    if (ms===600 && !reduced) { await sleep(160); await shot('right-panel-entering') }
    const frames=await entering
    const start=frames[0], end=frames.at(-1)
    const entry={start,end,panelSteps:frames.filter(f=>f.panel>12&&f.panel<end.panel-12).length,
      overviewSteps:frames.filter(f=>f.overview<start.overview-12&&f.overview>end.overview+12).length,
      fixedChrome:frames.every(f=>f.chrome===start.chrome), fixedTabs:end.tab>0&&frames.every(f=>f.tab===-1||f.tab===end.tab)}
    report.entries.push(entry)
    check(`右栏 ${ms}ms${reduced?' 减少动效':''}：从右缘露出，文件标签和右上角控件不移动`,
      entry.fixedChrome&&entry.fixedTabs&&end.panel>200&&start.overview-end.overview>100&&(animated?entry.panelSteps>=3&&entry.overviewSteps>=3:entry.panelSteps===0&&entry.overviewSteps===0),entry)
    await waitFor(`!!document.querySelector('.t3-rp--docked .rp-surface:not([hidden])')`,6000)
    if (ms===600 && !reduced) {
      check('深色右栏与主页面同黑，内容区不额外铺底',await ev(`(()=>{const bg=s=>getComputedStyle(document.querySelector(s)).backgroundColor;return bg('[data-rp-surface]')===bg('.v3-main') && bg('[data-rp-surface]')==='rgb(0, 0, 0)' && bg('.t3-rp-frame__content')==='rgba(0, 0, 0, 0)'})()`))
      const hit=await ev(`(() => {
        const toggle=document.querySelector('[data-testid="v3-head-panel-toggle"]'), pin=document.querySelector('[data-testid="v3-always-on-top"]'), add=document.querySelector('.t3-rp--docked [data-testid="rp-new-tab"]')
        const r=toggle.getBoundingClientRect(), a=add.getBoundingClientRect()
        return {noOverlap:a.right<=r.left, pinInHeader:!!pin.closest('.v3-head-actions'),
          reachable:[toggle,pin,add].every(node=>{const b=node.getBoundingClientRect();return node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})}
      })()`)
      check('置顶在聊天顶栏，右栏标签栏与固定控件均可点击',hit.noOverlap&&hit.pinInHeader&&hit.reachable,hit)
      await shot('right-panel-open-dark')
    }
    await ev(`(()=>{
      const host=document.querySelector('.t3-rp--docked'), surface=host.querySelector('[data-rp-surface]'), tab=host.querySelector('.rp-surface:not([hidden])'), prose=document.querySelector('.v3-prose'), t=performance.now(), frames=window.__exitFrames=[]
      const toggle=document.querySelector('[data-testid="v3-head-panel-toggle"]'), chrome=${chromePositions}, overview=${overviewX}, tabLeft=${tabX}
      function take(){const r=surface.getBoundingClientRect();frames.push({t:Math.round(performance.now()-t),connected:host.isConnected,visible:Math.round(r.width),content:tab.getBoundingClientRect().height>0,inert:host.inert,width:Math.round(prose.getBoundingClientRect().width),overview:overview(),chrome:chrome(),tab:tabLeft()})}
      take();toggle.click();function tick(){take();if(host.isConnected&&performance.now()-t<1500)requestAnimationFrame(tick)}requestAnimationFrame(tick)
    })()`)
    if (ms===600 && !reduced) { await sleep(95); await shot('right-panel-leaving') }
    await waitFor(`window.__exitFrames.at(-1)?.connected===false`,2500)
    const s=await ev(`(()=>{const f=window.__exitFrames,live=f.filter(x=>x.connected),first=f[0],end=f.at(-1);return {elapsed:end.t,first,last:live.at(-1),end,widths:new Set(f.map(x=>x.width)).size,widenAtStart:live.filter(x=>x.t>40).every(x=>x.width===end.width),blank:live.some(x=>x.visible>10&&!x.content),inactive:live.some(x=>x.inert),overviewSteps:f.filter(x=>x.overview>first.overview+12&&x.overview<end.overview-12).length,panelSteps:live.filter(x=>x.visible>12&&x.visible<first.visible-12).length,fixedChrome:f.every(x=>x.chrome===first.chrome),fixedTabs:live.every(x=>x.tab===first.tab)}})()`)
    report.exits.push(s)
    check(`右栏 ${ms}ms${reduced?' 减少动效':''}：向右缘收起，文件标签和右上角控件不移动`,s.fixedChrome&&s.fixedTabs&&s.end.overview-s.first.overview>100&&(animated?s.panelSteps>=3&&s.overviewSteps>=3:s.panelSteps===0&&s.overviewSteps===0),s)
    check(`右栏 ${ms}ms${reduced?' 减少动效':''}：内容保留至卸载，正文在收起开始时一次扩宽`,!s.blank&&s.widenAtStart&&s.widths===2&&s.end.width>s.first.width, s)
    check(`右栏 ${ms}ms${reduced?' 减少动效':''}：遵守时长、退场时禁用交互`,animated?s.elapsed>=ms-30&&s.elapsed<ms+200&&s.last.visible<24&&s.inactive:s.elapsed<120,s)
  }
  await patch({panelMotionMs:0,reduceMotion:false})
  const winPosition = `(${chromePositions})()`
  const winAtRest = await ev(winPosition)
  await ev(`window.__windowChrome=document.querySelector('.v3-window-chrome')`)
  await ev(`window.__yanRightPanel.getState().setOpen(true);window.__yanRightPanel.getState().setMaximized(true)`)
  await waitFor(`!!document.querySelector('[data-testid="rp-maximize"]')`)
  check('右栏最大化时窗口按钮不重挂且不遮挡还原按钮', await ev(`(()=>{
    const chrome=document.querySelector('.v3-window-chrome'), restore=document.querySelector('[data-testid="rp-maximize"]')
    const r=restore.getBoundingClientRect()
    return chrome===window.__windowChrome && JSON.stringify(${winPosition})===${JSON.stringify(JSON.stringify(winAtRest))} && r.right<=chrome.getBoundingClientRect().left && restore.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))
  })()`))
  await ev(`window.__yanRightPanel.getState().setOpen(false)`)
  await waitFor(`!document.querySelector('.t3-rp--docked')`)
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
  const narrowWin = await ev(winPosition)
  await ev(`document.querySelector('[data-testid="v3-head-panel-toggle"]').click()`)
  await waitFor(`!!document.querySelector('.t3-rp-frame__sheet') && document.documentElement.hasAttribute('data-rp-sheet-open')`)
  await waitFor(`getComputedStyle(document.querySelector('.rp-sheet-overlay')).opacity==='1'`)
  const narrow = await ev(`(()=>{
    const sheet=document.querySelector('.t3-rp-frame__sheet'), main=document.querySelector('.v3-root'), chrome=document.querySelector('.v3-window-chrome')
    return {sheet:getComputedStyle(sheet).backgroundColor,main:getComputedStyle(main).backgroundColor,top:sheet.getBoundingClientRect().top,chrome:chrome.getBoundingClientRect().bottom,win:${winPosition}}
  })()`)
  check('窄窗右栏仍与主页面同黑，窗口按钮位置不变', narrow.sheet === 'rgb(0, 0, 0)' && narrow.sheet === narrow.main && narrow.top >= narrow.chrome - 1 && JSON.stringify(narrow.win) === JSON.stringify(narrowWin), narrow)
  await shot('right-panel-sheet-dark')
}
