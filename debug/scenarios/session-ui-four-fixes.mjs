import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const meta = { description: '工具行无箭头、收起竖线不残留、@菜单不跟随鼠标、更改卡文件可点击；仅隔离合成数据' }

export default async function run({ cdp, box, newSession, sleep, check, shot, report, waitFor }) {
  const ev = (code) => cdp.evaluate(code)
  await newSession()
  await ev(`window.__yanStore.getState().patchSettings({theme:'dark',lang:'zh-CN',rightPanelOpen:false,promptSuggestions:false,reduceMotion:false})`)
  const user = { id: 'four-user', role: 'user', text: '界面回归样本', timestamp: Date.now() - 20000 }
  const output = Array.from({ length: 20 }, (_, i) => 'fixture output line ' + i).join('\n')
  const command = { id: 'four-command', name: 'bash', args: { command: 'fixture command', description: '检查命令' }, status: 'running', output, startedAt: Date.now() - 5000 }
  const messages = (call) => [user, { id: 'four-assistant', role: 'assistant', text: '', toolCalls: [call], timestamp: Date.now() - 5000 }]
  const inject = async (items, live = true) => {
    await ev(`(()=>{const s=window.__yanStore.getState();window.__yanStore.setState({messages:${JSON.stringify(items)},session:{...s.session,isAgentRunning:${live},isStreaming:${live}},historyLoading:false,switchLoading:false})})()`)
    await sleep(300)
  }
  await inject(messages(command))
  check('工具行不再显示前置箭头', await ev(`!document.querySelector('[data-testid="v3-step"] .ui-chevron')`))
  await ev(`document.querySelector('[data-testid="v3-step"]').click()`)
  await sleep(600)
  await shot('command-expanded-dark')
  const sampleGap = async (action) => ev(`new Promise(resolve=>{
    const rows=[];const start=performance.now();
    const measure=()=>{const body=document.querySelector('[data-testid="v3-process-body"]');const r=body.getBoundingClientRect();let bottom=r.top;for(const c of body.children)bottom=Math.max(bottom,c.getBoundingClientRect().bottom);rows.push({ms:Math.round(performance.now()-start),gap:r.bottom-bottom,height:r.height,reserved:body.parentElement.getBoundingClientRect().height-r.height,min:body.parentElement.style.minHeight});if(performance.now()-start<1600)requestAnimationFrame(measure);else resolve(rows)};
    ${action};requestAnimationFrame(measure);
  })`)
  const manual = await sampleGap(`document.querySelector('[data-testid="v3-step"]').click()`)
  const manualTail = manual.filter((row) => row.ms > 350)
  check('手动收起命令后竖线不拖尾', manualTail.every((row) => row.gap < 2), manualTail.filter((row) => row.gap >= 2).slice(0, 4))
  await sleep(650)
  const done = { ...command, status: 'ok', endedAt: Date.now() }
  const automatic = await sampleGap(`window.__yanStore.setState({messages:${JSON.stringify(messages(done))}})`)
  check('命令结束移除实时输出后竖线不超出内容', automatic.filter((row) => row.ms > 350).every((row) => row.gap < 2), automatic.filter((row) => row.ms > 350 && row.gap >= 2).slice(0, 4))
  await shot('command-collapsed-dark')
  const parent = { id:'four-parent', name:'codemode', args:{code:'fixture'}, status:'running' }
  const nested = { ...command, id:'four-child', parentToolCallId:parent.id }
  await inject([user,{id:'four-nested',role:'assistant',text:'',toolCalls:[parent,nested]}])
  await sleep(650)
  const collapsing = sampleGap(`window.__yanStore.setState({messages:${JSON.stringify([user,{id:'four-nested',role:'assistant',text:'',toolCalls:[{...parent,status:'ok'},{...nested,status:'ok'}]}])}})`)
  await sleep(450)
  await shot('nested-collapsing-dark')
  const nestedDone = await collapsing
  check('嵌套命令自动收起后竖线不超出内容', nestedDone.filter((row)=>row.ms>350).every((row)=>row.gap<2), nestedDone.filter((row)=>row.ms>350&&row.gap>=2).slice(0,4))
  check('防跳动占位仍保留，但不撑长竖线', nestedDone.some((row)=>row.ms>350&&row.reserved>20&&row.gap<2))
  report.border = { manual, automatic, nestedDone }

  await inject([], false)
  await Promise.all(Array.from({length:35}, (_,i) => writeFile(join(box.project, 'fixture-'+String(i).padStart(2,'0')+'.ts'), 'fixture\n')))
  await ev(`window.__yanStore.setState({editorInject:{text:'@fixture-',mode:'replace',id:Date.now()}})`)
  await sleep(250)
  await ev(`document.querySelector('[data-testid="composer-input"]').focus()`)
  await waitFor(`document.querySelectorAll('[data-composer-item-id]').length>20`)
  const active = () => ev(`document.querySelector('[data-composer-item-id][aria-selected="true"]')?.getAttribute('data-composer-item-id')`)
  const first = await active()
  const point = await ev(`(()=>{const r=document.querySelectorAll('[data-composer-item-id]')[3].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await sleep(100)
  check('@菜单鼠标移动不改变选中项', await active() === first)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: 100, deltaX: 0 })
  await sleep(250)
  check('@菜单滚轮不改变选中项', await active() === first)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  await sleep(150)
  check('@菜单仍可用键盘切换', await active() !== first)
  await shot('at-menu-dark')
  await ev(`document.querySelectorAll('[data-composer-item-id]')[2].click()`)
  await sleep(150)
  check('@菜单仍可点击插入文件', await ev(`document.querySelector('[contenteditable="true"]').textContent.includes('fixture-02.ts')`))

  const change = (id, path, status = 'modified') => ({ id, name: 'edit', status: 'ok', args: { path }, details: { fileDiff: { path, status, added: 2, removed: 1, patch: '', before: { text: 'old' }, after: { text: 'new' } } } })
  const showChanges = async (paths) => inject([user, { id: 'four-changes', role: 'assistant', text: '改动完成。', timestamp: Date.now(), toolCalls: paths.map((path, i) => change('file-' + i, path)) }], false)
  await ev(`(()=>{const st=window.__yanStore;window.__fourPreview=[];window.__fourPreviewFile=st.getState().previewFile;st.setState({previewFile:async(...args)=>{window.__fourPreview.push(args)}})})()`)
  await showChanges(['src/one.ts'])
  const clickFile = async (name, keyboard = false) => {
    const selector = `[data-testid="v3-turn-changes"] button[title="${name}"]`
    const found = await ev(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (!found) return false
    await ev(`document.querySelector(${JSON.stringify(selector)}).${keyboard ? 'focus' : 'click'}()`)
    if (keyboard) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    }
    await sleep(100)
    return ev(`window.__fourPreview.at(-1)?.[0]===${JSON.stringify(name)}&&window.__fourPreview.at(-1)?.[2]===${JSON.stringify(box.project)}`)
  }
  check('单文件改动卡可点击打开文件', await clickFile('src/one.ts'))
  await showChanges(['src/two.ts', 'src/three.ts'])
  check('多文件改动卡可点击打开文件', await clickFile('src/two.ts'))
  check('改动卡文件可通过键盘打开', await clickFile('src/three.ts', true))
  await ev(`window.__yanStore.setState({previewFile:window.__fourPreviewFile})`)
  await shot('changes-dark')
  await ev(`window.__yanStore.getState().patchSettings({theme:'light'})`)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  check('浅色窄窗改动卡无横向溢出', await ev(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.v3-stream').scrollWidth<=document.querySelector('.v3-stream').clientWidth+1`))
  await shot('changes-light-narrow')
  await writeFile(join(box.project, 'four-preview.ts'), 'export const cardOpen = "four-preview-content";\n')
  await showChanges(['four-preview.ts'])
  const realFile = await ev(`!!document.querySelector('[data-testid="v3-turn-change-file"]')`)
  if (realFile) {
    await ev(`document.querySelector('[data-testid="v3-turn-change-file"]').click()`)
    await waitFor(`s.filePreview?.data?.ok===true && document.querySelector('[data-testid="v3-preview-text"]')?.textContent.includes('four-preview-content')`)
  }
  check('点击改动卡通过宿主读文件并显示预览正文', realFile && await ev(`window.__yanStore.getState().filePreview?.data?.ok===true&&document.querySelector('[data-testid="v3-preview-text"]')?.textContent.includes('four-preview-content')`))
  await sleep(600)
  await shot('changes-real-preview-light')
}
