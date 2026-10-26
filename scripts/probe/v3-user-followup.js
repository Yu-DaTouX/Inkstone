;(async () => {
  const out=[]
  const check=(ok,label)=>out.push(`  ${ok?'✓':'✗'} ${label}`)
  const wait=(ms)=>new Promise((r)=>setTimeout(r,ms))
  const q=(id)=>document.querySelector(`[data-testid="${id}"]`)
  const stage=async(name)=>{ window.__followupStage=name; if(window.__followupDriver)for(let i=0;i<160&&window.__followupDone!==name;i++)await wait(50);else await wait(300) }
  const store=window.__yanStore
  try{
    if(!store)throw new Error('missing store')
    location.hash='#/'
    await wait(100)
    store.setState({messages:[],peekedMessages:null})
    await wait(500)
    check(!!q('v3-sidebar-resizer'),'左侧会话列表右边缘有正式拖拽条')
    const dragFrom=q('v3-sidebar').getBoundingClientRect().width
    await stage('sidebar-drag')
    check(window.__followupSidebarDrag===true,'可信指针拖动实际改变会话列表宽度')
    check(Number(localStorage.getItem('inkstone.v3.sidebarWidth'))>dragFrom+20,'拖宽结果已持久化')
    const sb=()=>q('v3-sidebar'), width=sb().getBoundingClientRect().width
    const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(50)}return fn()}
    const untilAsync=async(fn,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await wait(50)}return await fn()}
    const hidden=()=>{const s=getComputedStyle(sb());return s.display==='none'||s.visibility==='hidden'}
    const docked=()=>!hidden()&&sb().getBoundingClientRect().width>1&&getComputedStyle(sb()).position!=='absolute'
    q('v3-side-close').click()
    const collapsed=await until(()=>hidden()&&sb().getBoundingClientRect().width<1)
    check(collapsed,'收起后列表退出常驻布局')
    if(!collapsed)out.push(`    诊断：data-side=${document.querySelector('.v3-root')?.getAttribute('data-side')} width=${sb().getBoundingClientRect().width} visibility=${getComputedStyle(sb()).visibility} display=${getComputedStyle(sb()).display} connected=${!!sb()}`)
    const before=document.querySelector('.v3-main').getBoundingClientRect().left
    await stage('sidebar-hover')
    check(!hidden()&&document.querySelector('.v3-root')?.getAttribute('data-sidebar-preview')==='1','鼠标悬停左缘展开会话列表')
    check(Math.abs(document.querySelector('.v3-main').getBoundingClientRect().left-before)<1,'悬停预览不挤动正文')
    await stage('sidebar-leave')
    check(await until(hidden),'鼠标离开临时预览后收回')
    if(!docked())q('v3-rail-toggle')?.click()
    await until(()=>docked()&&Math.abs(sb().getBoundingClientRect().width-width)<1)
    check(Math.abs(sb().getBoundingClientRect().width-width)<1,'再次展开沿用拖宽结果')
    const cursor=document.querySelector('.v3-hello-cursor')
    const blinkStates=new Set()
    for(let i=0;i<8&&cursor;i++){blinkStates.add(cursor.dataset.blink);await new Promise((r)=>setTimeout(r,200))}
    check(cursor&&blinkStates.has('on')&&blinkStates.has('off'),'HELLO WORLD 末尾光标持续闪烁')
    check(document.querySelectorAll('.start-usage [role="tablist"]').length===0,'首页用量精简为摘要，分析控件进入详情')
    const cells=[...document.querySelectorAll('.start-heat .start-cell')].slice(0,30).map((el)=>el.getBoundingClientRect())
    check(cells.length>0&&cells.every((r)=>Math.abs(r.width-r.height)<.1&&Math.abs(r.width-cells[0].width)<.1),'Token格子为等宽正方形')
    check(cells.length>0&&Math.abs(cells[0].width*devicePixelRatio-Math.round(cells[0].width*devicePixelRatio))<.05,'格子宽度对齐整物理像素')
    await stage('home')
    const models=Array.from({length:120},(_,i)=>({id:`fixture-${i}`,name:`模型 ${i} · 长显示名`,provider:i<60?'provider-a':'provider-b',reasoning:true,contextWindow:200000}))
    store.setState({models,thinkingLevels:['off','minimal','low','medium','high','xhigh','max'],session:{...store.getState().session,model:models[0],thinkingLevel:'medium',thinkingLevelsStatus:'known'}})
    const main=document.querySelector('.v3-main'),bounds=main.getBoundingClientRect()
    q('model-picker').click()
    let stable=true,drift=''
    for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);const next=main.getBoundingClientRect();if(Math.abs(next.left-bounds.left)>.5||Math.abs(next.width-bounds.width)>.5){stable=false;drift=drift||`帧${i} left ${bounds.left.toFixed(1)}→${next.left.toFixed(1)} width ${bounds.width.toFixed(1)}→${next.width.toFixed(1)}`}}
    check(stable,'打开模型菜单不改变正文位置或宽度')
    if(!stable)out.push(`    诊断：${drift}`)
    const pop=document.querySelector('.mtp-pop'),dialog=document.querySelector('.mtp-dialog'),list=document.querySelector('.mtp-scroll')
    check(pop&&dialog&&dialog.scrollWidth<=dialog.clientWidth+1&&pop.scrollWidth<=pop.clientWidth+1,'模型浮层和内部对话框均无横向溢出')
    check(list.scrollHeight>list.clientHeight&&getComputedStyle(list).overflowY==='auto','大量模型只在列表内纵向滚动')
    check(getComputedStyle(dialog).overflowX==='hidden','菜单底部不会显示横向滚动条')
    await stage('picker')
    q('model-picker').click();await wait(100)
    if(document.querySelector('.mtp-pop'))out.push('    诊断：再点模型按钮后浮层仍在')
    if(!q('v3-schedule-entry'))q('v3-side-more')?.click()
    await until(()=>!!q('v3-schedule-entry'),2000)
    q('v3-schedule-entry').click()
    await until(()=>!!document.querySelector('.sched-page-head')&&!!document.querySelector('.sched-page-notice'),4000)
    const head=document.querySelector('.sched-page-head'),notice=document.querySelector('.sched-page-notice')
    const aligned=!!head&&!!notice&&Math.abs(head.getBoundingClientRect().left-notice.getBoundingClientRect().left)<1
    check(aligned,'定时任务标题与说明对齐')
    if(!aligned)out.push(`    诊断：head=${head?.getBoundingClientRect().left} notice=${notice?.getBoundingClientRect().left} hash=${location.hash} page=${!!q('v3-schedule-page')}`)
    await stage('schedule')
    q('wb-more-tools')?.click()
    await until(()=>!!q('v3-always-on-top'),2000)
    const pin=q('v3-always-on-top'),wasTop=(await window.yan.getSettings()).alwaysOnTop===true
    pin.click()
    const toggled=await untilAsync(async()=>((await window.yan.getSettings()).alwaysOnTop===true)!==wasTop,3000)
    check(toggled,'窗口置顶入口调用正式动作')
    await window.yan.win.setAlwaysOnTop(wasTop)
    check(await untilAsync(async()=>((await window.yan.getSettings()).alwaysOnTop===true)===wasTop,3000),'窗口置顶可恢复原状态')
    await stage('pin')
    await stage('narrow')
    check(document.documentElement.scrollWidth<=innerWidth+1,'800px窄屏没有整页横向溢出')
    await stage('done')
  }catch(error){out.push(`  ✗ ${error.stack??error}`)}
  return out.join('\n')
})()
