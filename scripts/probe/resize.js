/* Real UI split controls: sidebar persistence and workspace geometry, including keyboard operation. */
;(async () => {
  const out = [], store = window.__yanStore
  const ok = (v, label) => out.push(`  ${v ? '✓' : '✗'} ${label}`)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const q = s => document.querySelector(s)
  const width = s => q(s)?.getBoundingClientRect().width ?? 0
  const drag = async (el, dx, dy=0, documentEvents=false) => {
    const r=el.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2
    const pe=(type, offset) => new PointerEvent(type, { bubbles:true, cancelable:true, pointerId:73, button:0, buttons:type==='pointerup'?0:1, clientX:x+dx*offset, clientY:y+dy*offset })
    el.dispatchEvent(pe('pointerdown',0)); await sleep(80)
    const target=documentEvents?document:el
    for(let i=1;i<=10;i++) target.dispatchEvent(pe('pointermove',i/10))
    target.dispatchEvent(pe('pointerup',1)); await sleep(500)
  }
  try {
    store.getState().setRailPinned(true); await sleep(600)
    const rail=q('[data-testid="resizer-rail"]'), initial=width('.rail')
    ok(rail?.getAttribute('role')==='separator' && rail.tabIndex>=0, '侧栏把手为可聚焦分隔控件')
    await drag(rail,90)
    const wider=width('.rail')
    ok(wider>initial+40, '侧栏右拖变宽')
    ok(Math.abs(store.getState().settings.railWidth-wider)<2, '侧栏宽度经IPC落盘')
    rail.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})); await sleep(400)
    ok(width('.rail')<wider, '方向键调整侧栏宽度')
    rail.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); await sleep(700)
    ok(store.getState().settings.railWidth===0, '双击恢复默认宽度设置')
    const pane=await window.__yanOpenWorkspaceTool('文件','files'), node=pane.querySelector('[role="tree"]')
    const separator=q('.tile-separator[aria-orientation="vertical"]')
    ok(!!separator && separator.tabIndex>=0, '工作区宽度分隔线可聚焦')
    const before=pane.getBoundingClientRect().width, saved=localStorage.getItem('inkstone.workspace.tiles.v1')
    await drag(separator,-60,0,true)
    const after=pane.getBoundingClientRect().width
    ok(Math.abs(after-before)>20, '拖分隔线实时调整磁贴宽度')
    ok(localStorage.getItem('inkstone.workspace.tiles.v1')!==saved, '磁贴比例保存到所属会话布局')
    const current=q('.tile-separator[aria-orientation="vertical"]')
    current.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})); await sleep(400)
    ok(Math.abs(pane.getBoundingClientRect().width-after)>1, '方向键调整磁贴比例')
    ok(pane.querySelector('[role="tree"]')===node, '调整尺寸保留文件树组件身份')
    ok(q('.tile-workspace-scroll').clientWidth>0 && document.documentElement.scrollWidth<=window.innerWidth+1, '尺寸调整不撑破应用外层')
  } catch(error) { ok(false,error.stack??String(error)) }
  return out.join('\n')
})()
