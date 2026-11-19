export const meta = { description: '长命令不挤掉步骤标签，展开后可读完整命令' }

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
}
