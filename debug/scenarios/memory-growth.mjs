import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useRealWindow } from '../lib/perf-probes.mjs'
import { memoryByKind, sampleProcessTree } from '../lib/process-tree.mjs'

export const meta = { observation: true, description: '内存增长：三个会话各跑 FLOW/MANYTOOLS/LONGTEXT，之后循环 N 轮（YAN_MEM_ROUNDS，默认 25）切换会话、开关分屏与文件预览、再发一轮流式，每轮强制 GC 后记录 JS 堆、DOM 节点、事件监听器，输出曲线与首尾增量；YAN_MEM_SNAPSHOT=1 在第 3 轮与最后一轮存堆快照', }

export default async function run({ cdp, box, runDir, report, sleep, log, newSession, state, turn, waitFor, check }) {
  const ev = (expr) => cdp.evaluate(expr)
  const rounds = Number(process.env.YAN_MEM_ROUNDS ?? 25)
  const imagesOn = process.env.YAN_MEM_IMAGES === '1'
  const marker = box.userData
  const snapshotOn = process.env.YAN_MEM_SNAPSHOT === '1'
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await cdp.call('Performance.enable')
  await cdp.call('HeapProfiler.enable')

  const makeImages = () => ev(`(() => { const out = []; for (const [w, h] of [[1280, 800], [3840, 2160]]) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); const d = g.createImageData(w, h); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255 } g.putImageData(d, 0, 0); out.push({ data: c.toDataURL('image/png').split(',')[1], mimeType: 'image/png' }) } return out })()`)
  const images = imagesOn ? await makeImages() : undefined
  const measure = async () => {
    for (let i = 0; i < 3; i++) { await cdp.call('HeapProfiler.collectGarbage'); await sleep(150) }
    const m = Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]))
    const switchMarks = await ev(`performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('yan:switch-')).length`)
    return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, frames: m.Frames, switchMarks, proc: memoryByKind(sampleProcessTree(marker)) }
  }
  const snapshot = async (name) => {
    cdp.events.length = 0
    await cdp.call('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    const chunks = cdp.events.filter((e) => e.method === 'HeapProfiler.addHeapSnapshotChunk').map((e) => e.params.chunk)
    cdp.events.length = 0
    writeFileSync(join(runDir, name + '.heapsnapshot'), chunks.join(''))
  }

  const complete = async (prompt, ending, options) => {
    const { requests } = await turn(prompt, options)
    const finished = await state(`(() => {
      const from = s.messages.findLastIndex(message => message.role === 'user');
      return s.messages[from]?.text === ${JSON.stringify(prompt)} &&
        s.messages.slice(from + 1).findLast(message => message.role === 'assistant')?.text?.trimEnd().endsWith(${JSON.stringify(ending)});
    })()`)
    if (!requests || !finished) throw new Error(`${prompt}：未收到完整的假模型回复（${requests} 次请求）`)
  }
  const previewPath = join(box.project, 'memory-preview.json')
  const previewText = 'memory-preview-fixture'
  writeFileSync(previewPath, JSON.stringify({ name: previewText }, null, 2), { flag: 'wx' })
  const preview = `document.querySelector('[data-testid="v3-preview"] [data-testid="v3-code-view"]')`
  const tiles = `document.querySelectorAll('[data-tile-key]').length`
  const sessions = []
  for (const [index, project] of [0, 1, 2].map((i) => [i, box.projects[i] ?? box.projects[0] ?? box.project])) {
    await newSession(project)
    const tag = 'ABC'[index]
    await complete(`FLOW SHORT ${tag}1 先看看项目`, '最终答案结束。', images ? { images } : {})
    await complete(`MANYTOOLS ${tag}2 跑四十步`, '四十步都完成了。', { timeout: 180000 })
    await complete(`LONGTEXT ${tag}3 长文`, '结束。')
    sessions.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile'), project })
  }
  const curve = []
  curve.push({ round: 0, ...(await measure()) })
  for (let round = 1; round <= rounds; round++) {
    for (const target of sessions) {
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target.path)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(target.path)}`, 30000, 10)
      await sleep(250)
    }
    await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(sessions.map(({ sessionId, path }) => ({ sessionId, path })))}, live: 1 })`)
    await waitFor(`${tiles} === ${sessions.length}`)
    await ev(`window.__yanSplit.getState().close()`)
    await waitFor(`${tiles} === 0`)
    await ev(`window.__yanStore.getState().previewFile(${JSON.stringify(previewPath)}, 1, ${JSON.stringify(box.project)})`)
    await waitFor(`${preview}?.textContent.includes(${JSON.stringify(previewText)}) && ${preview}.getClientRects().length > 0`)
    await ev(`window.__yanRightPanel.getState().setOpen(false)`)
    await waitFor(`!${preview}?.getClientRects().length`)
    if (process.env.YAN_MEM_TURN !== '0') await complete(`FLOW SHORT R${round} 再看一眼`, '最终答案结束。', images ? { images } : {})
    const row = { round, ...(await measure()) }
    curve.push(row)
    log('round', row)
    if (snapshotOn && (round === 3 || round === rounds)) await snapshot('heap-round-' + round)
  }
  const first = curve[3] ?? curve[1]
  const last = curve.at(-1)
  report.curve = curve
  report.delta = { heapMB: +(last.heapMB - first.heapMB).toFixed(1), nodes: last.nodes - first.nodes, listeners: last.listeners - first.listeners, from: first.round, to: last.round }
  log('delta', report.delta)
  const marks = curve.slice(1).map((row) => row.switchMarks)
  check('会话切换计时标记保留最新阶段且总量不累积', marks.length > 0 && marks.every((count) => count >= 3 && count <= 4), marks)
  writeFileSync(join(runDir, 'curve.json'), JSON.stringify(curve, null, 1))
}
