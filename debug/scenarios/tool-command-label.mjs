export const meta = { description: '长命令的窄窗布局、键盘展开与运行计时的读屏名称' }

export default async function run({ cdp, newSession, waitFor, check, shot }) {
  const ev = expr => cdp.evaluate(expr)
  await newSession()
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({theme:'light',lang:'zh-CN',workspaceTiles:false,rightPanelOpen:false,reduceMotion:true})`)
  const code = `text('${'fixture'.repeat(80)}');\ntext('codemode-end');`
  const command = `printf '%s' '${'fixture'.repeat(80)}shell-end'`
  const toolCalls = [{ id:'long-code', name:'codemode', args:{code}, status:'ok' }, { id:'long-shell', name:'bash', args:{command}, status:'ok' }]
  await ev(`window.__yanStore.setState(s=>({messages:[{id:'u',role:'user',text:'显示命令'},{id:'a',role:'assistant',text:'夹具',toolCalls:${JSON.stringify(toolCalls)}}],session:{...s.session,isStreaming:false,isAgentRunning:false},switchLoading:false,historyLoading:false}))`)
  const process = '[data-turn-id="a"] [data-testid="v3-process-toggle"]'
  await waitFor(`!!document.querySelector('${process}')`,6000)
  await ev(`document.querySelector('${process}[aria-expanded="false"]')?.click()`)
  const group = '[data-turn-id="a"] [data-testid="v3-step-group"][aria-expanded="false"]'
  await ev(`document.querySelector('${group}')?.click()`)
  for (const [name, detail, tail] of [['codemode','.v3-step-code','codemode-end'],['bash','.v3-step-cmd-line','shell-end']]) {
    const row = `.v3-step[data-tool="${name}"]`
    const trigger = `${row} [data-testid="v3-step"]`
    await waitFor(`!!document.querySelector('${trigger}')`,5000)
    const stats = await ev(`(()=>{const row=document.querySelector('${row}'),label=row.querySelector('.v3-step-label'),target=row.querySelector('.v3-step-target');const range=document.createRange();range.selectNodeContents(label.querySelector('span')??label);return {label:label.textContent,width:label.clientWidth,needed:range.getBoundingClientRect().width,target:target.clientWidth,fullTarget:target.scrollWidth}})()`)
    check(`${name} 标签完整，命令预览可以缩短`,stats.width>=stats.needed-1&&stats.target>40&&stats.target<stats.fullTarget,stats)
    await ev(`document.querySelector('${trigger}').click()`)
    await waitFor(`!!document.querySelector('${row} ${detail}')`,5000)
    check(`${name} 展开后保留命令末尾`,await ev(`document.querySelector('${row} ${detail}').textContent.includes('${tail}')`))
    if(name==='codemode') await shot('command-label-expanded')
    await ev(`document.querySelector('${trigger}').click()`)
  }

  const startedAt = Date.now() - 2000
  const running = { id: 'timed-tool', name: 'bash', args: { command: 'timed-fixture', description: 'ACTION_TIMER_FIXTURE' }, startedAt, status: 'running' }
  await ev(`window.__yanStore.setState(s=>({messages:[{id:'timed-user',role:'user',text:'计时'},{id:'timed-assistant',role:'assistant',text:'',toolCalls:${JSON.stringify([running])}}],session:{...s.session,isStreaming:true,isAgentRunning:true}}))`)
  const row = '[data-turn-id="timed-assistant"] [data-testid="v3-step"]'
  const time = `${row} [data-testid="v3-step-elapsed"]`
  const processTime = '[data-turn-id="timed-assistant"] [data-testid="v3-process-toggle"] [data-kind="elapsed"]'
  await waitFor(`!!document.querySelector('${time}')`, 6000)
  const sample = () => ev(`(() => {const step=document.querySelector('${time}');const process=document.querySelector('${processTime}');return {text:step.textContent,stepHidden:step.getAttribute('aria-hidden'),processHidden:process?.getAttribute('aria-hidden')}})()`)
  const before = await sample()
  await cdp.call('Accessibility.enable')
  const names = async () => (await cdp.call('Accessibility.getFullAXTree')).result.nodes.filter(n=>!n.ignored&&n.role?.value==='button').map(n=>n.name?.value ?? '').filter(name=>name.includes('timed-fixture') || name.includes('ACTION_TIMER_FIXTURE'))
  const beforeNames = await names()
  await waitFor(`document.querySelector('${time}')?.textContent!==${JSON.stringify(before.text)}`, 3500)
  const after = await sample()
  const afterNames = await names()
  check('计时继续更新，但不会改变工具按钮读屏名称', before.text !== after.text && before.stepHidden === 'true' && beforeNames.length > 0 && JSON.stringify(beforeNames) === JSON.stringify(afterNames), { before, after, beforeNames, afterNames })
  check('外层过程计时也不加进按钮读屏名称', before.processHidden === 'true', before)
  await ev(`document.querySelector('${row}').focus()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`document.querySelector('${row}')?.getAttribute('aria-expanded')==='true'`, 5000)
  check('键盘可展开运行中的工具，焦点保留在按钮', await ev(`document.activeElement===document.querySelector('${row}')`))
  await shot('timed-tool-expanded-by-keyboard')

  await ev(`window.__yanStore.getState().patchSettings({reduceMotion:false})`)
  await waitFor(`document.querySelector('${row}')?.getAttribute('aria-expanded')==='true'`, 5000)
  const closed = await ev(`(async () => {
    const header = document.querySelector('${row}');
    const panel = document.getElementById(header.getAttribute('aria-controls'));
    const copy = panel.querySelector('.v3-step-detail-bar button');
    if (!copy) return {missingCopy:true};
    header.focus();
    header.click();
    await new Promise(requestAnimationFrame);
    const keptForAnimation = copy.isConnected && !panel.hasAttribute('hidden');
    copy.focus();
    return {keptForAnimation, collapsed:header.getAttribute('aria-expanded')==='false', focusStayed:document.activeElement===header};
  })()`)
  check('收起动画保留详情内容，但内部按钮不再能获得焦点', closed.keptForAnimation && closed.collapsed && closed.focusStayed, closed)

  const reused = '[data-turn-id="scope-answer"] [data-testid="v3-step"]'
  const reusedProcess = '[data-turn-id="scope-answer"] [data-testid="v3-process-toggle"]'
  const loadRepeatedTool = async (command, output = '') => {
    await ev(`window.__yanStore.setState(s=>({messages:[{id:'scope-user',role:'user',text:'检查展开范围'},{id:'scope-answer',role:'assistant',text:'夹具',toolCalls:[{id:'same-tool-id',name:'bash',args:{command:${JSON.stringify(command)}},output:${JSON.stringify(output)},status:'ok'}]}],session:{...s.session,isStreaming:false,isAgentRunning:false},switchLoading:false,historyLoading:false}))`)
    await waitFor(`!!document.querySelector('${reusedProcess}')`, 6000)
    await ev(`document.querySelector('${reusedProcess}[aria-expanded="false"]')?.click()`)
    await waitFor(`!!document.querySelector('${reused}')`, 6000)
    return ev('window.__yanStore.getState().session.sessionId')
  }
  await newSession()
  const firstSession = await loadRepeatedTool('dir first-scope')
  await ev(`document.querySelector('${reused}').click()`)
  await waitFor(`document.querySelector('${reused}')?.getAttribute('aria-expanded')==='true'`, 6000)
  await newSession()
  const longOutput = `prefix-${'x'.repeat(3300)}🧪${'x'.repeat(1592)}-suffix`
  const secondSession = await loadRepeatedTool('dir second-scope', longOutput)
  check('两个真实会话复用工具 ID 时，展开状态不会带到新会话', !!firstSession && !!secondSession && firstSession !== secondSession && await ev(`document.querySelector('${reused}')?.getAttribute('aria-expanded')==='false'`))
  await ev(`document.querySelector('${reused}').click()`)
  const output = '[data-turn-id="scope-answer"] [data-testid="v3-step-output"]'
  const toggle = '[data-turn-id="scope-answer"] [data-testid="v3-step-output-toggle"]'
  await waitFor(`!!document.querySelector('${output}')`, 5000)
  const preview = await ev(`document.querySelector('${output}').textContent`)
  check('单行输出尾部预览不拆开 emoji，也不虚报隐藏行数', preview.isWellFormed() && preview.length < 1700 && !preview.includes('prefix-') && preview.endsWith('-suffix') && await ev(`!document.querySelector('[data-turn-id="scope-answer"] [data-testid="v3-step-output-earlier"]')`), { previewLength: preview.length })
  await ev(`document.querySelector('${toggle}').focus()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`document.querySelector('${toggle}')?.getAttribute('aria-expanded')==='true'`, 5000)
  check('键盘展开后可读完整单行输出', await ev(`document.querySelector('${output}').textContent===${JSON.stringify(longOutput)}`))
  await shot('single-line-output-expanded')
}
