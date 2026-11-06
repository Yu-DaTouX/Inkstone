import { useRealWindow } from '../lib/perf-probes.mjs'
export const meta = { description: '窄分屏格的输入框：三格并排时每格里模型选择钮的标签宽度与可见文字，核对不会缩到只剩首字母，不调用真实模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: false })
  await autoApprove()

  const start = async (project, text) => {
    await newSession(project)
    const sent = await ev(`window.__yanStore.getState().send(${JSON.stringify(text)})`)
    if (sent === false) throw new Error('发送失败：' + text)
    await waitFor(`!!s.session?.sessionFile && !!s.session?.sessionId && !${running} && s.messages.length >= 2`, 30000, 50)
    return { sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') }
  }
  const tiles = []
  const count = Number(process.env.YAN_SPLIT_TILES ?? 3)
  for (let i = 0; i < count; i++) tiles.push(await start(box.projects[i % Math.max(1, box.projects.length)] ?? box.project, `第 ${i + 1} 个会话`))
  await ev(`(() => { const st = window.__yanStore; st.setState({ models: st.getState().models.map((m) => ({ ...m, name: 'Claude Sonnet 5.5 Extended' })) }) })()`)
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(tiles)}, live: 0 })`)
  await sleep(1500)
  const width = Number(process.env.YAN_SPLIT_WIDTH ?? 0)
  if (width) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(1200)
  }
  await shot(`split-narrow-${count}`)

  await ev(`document.querySelectorAll('[data-chat-provider-model-picker-label]').forEach((el) => { el.textContent = 'Claude Sonnet 5.5 Extended' })`)
  await sleep(500)
  await shot(`split-narrow-${count}-long`)
  const labels = await ev(`[...document.querySelectorAll('[data-pane]')].map((pane) => {
    const label = pane.querySelector('[data-chat-provider-model-picker-label]')
    const box = pane.getBoundingClientRect()
    const rect = label?.getBoundingClientRect()
    return { pane: box.width, labelWidth: rect ? Math.round(rect.width) : null, text: label?.textContent ?? null, clipped: label ? label.scrollWidth > label.clientWidth : null }
  })`)
  const footer = await ev(`(() => { const host = document.querySelector('[data-chat-composer-controls="footer"]'); if (!host) return null; const kids = (el, depth) => [...el.children].map((c) => ({ tag: c.tagName.toLowerCase(), cls: (c.className || '').toString().slice(0, 50), w: Math.round(c.getBoundingClientRect().width), kids: depth > 0 ? kids(c, depth - 1) : undefined })); return { w: Math.round(host.getBoundingClientRect().width), kids: kids(host, 2) } })()`)
  log('footer', footer)
  log('labels', labels)
  report.labels = labels
  check('每个分屏格的模型名至少有 4 个字符宽度', labels.every((item) => item.labelWidth === null || item.labelWidth >= 40), JSON.stringify(labels))
}
