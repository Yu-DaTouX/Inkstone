export const meta = { description: 'Mermaid 完整围栏到达后在流式回答中出图，未完成围栏只显示占位，收尾不重挂图形' }

export default async function run({ cdp, newSession, waitFor, check, shot, report }) {
  await newSession()
  await waitFor('s.conn === "ready" && !s.switchLoading', 10000)
  const prose = `document.querySelector('[data-turn-id="mermaid-live-answer"] .v3-prose')`
  const figure = `${prose}?.querySelector('.v3-visual-mermaid svg')`
  const open = '图前正文。\n\n```mermaid\nflowchart LR\nA --> B\n'
  const body = '%% diagram fixture padding\n'.repeat(100)
  const closed = open + body + '```\n'
  const setText = (text) => cdp.evaluate(`window.__yanStore.setState(s => ({messages: [...s.messages.slice(0, -1), {...s.messages.at(-1), text: ${JSON.stringify(text)}}]}))`)
  await cdp.evaluate(`(() => {
    const timestamp = Date.now()
    window.__yanStore.setState(s => ({ messages: [...s.messages,
      {id:'mermaid-live-user',role:'user',text:'画一个流程图',timestamp},
      {id:'mermaid-live-answer',role:'assistant',text:${JSON.stringify(open)},timestamp}],
      session:{...s.session,isStreaming:true,isAgentRunning:true},runTail:null }))
  })()`)
  await waitFor(`!!${prose}?.querySelector('.v3-visual-pending')`, 8000)
  check('未闭合时无图形和无源码外露', await cdp.evaluate(`!${figure} && !${prose}?.textContent.includes('A --> B')`))
  await setText(open + body + '```')
  check('最后一行尚未确认时保持占位', await cdp.evaluate(`!${figure} && !!${prose}?.querySelector('.v3-visual-pending')`))
  const began = performance.now()
  await setText(closed)
  await waitFor(`!!${figure}`, 1800, 20)
  report.closeToSvgMs = Math.round(performance.now() - began)
  check('完整围栏到达后在回答结束前出图', await cdp.evaluate(`!!window.__yanStore.getState().session.isStreaming && !!${figure}`), report.closeToSvgMs)
  await cdp.evaluate(`window.__liveMermaidSvg = ${figure}`)
  await setText(closed + '\n图后正文。')
  await waitFor(`${prose}?.textContent.includes('图后正文。')`, 8000)
  await shot('live-diagram')
  await cdp.evaluate(`window.__yanStore.setState(s => ({ session: {...s.session,isStreaming:false,isAgentRunning:false} }))`)
  await waitFor(`!${prose}?.querySelector('.v3-caret') && !!${figure}`, 8000)
  check('回合结束沿用同一图形节点且保留后续正文', await cdp.evaluate(`window.__liveMermaidSvg === ${figure} && ${prose}?.textContent.includes('图后正文。')`))
}
