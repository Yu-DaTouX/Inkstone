import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { observation: true, description: '分屏新增与关闭的过渡逐帧截取（screencast），写到 SPLIT_FRAMES_DIR' }

export default async function run({ cdp, box, sleep, report, log, autoApprove, newSession, state, turn }) {
  const ev = (x) => cdp.evaluate(x)
  const dir = process.env.SPLIT_FRAMES_DIR ?? '.'
  mkdirSync(dir, { recursive: true })
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  const refs = []
  for (const [index, project] of [box.projects[0] ?? box.project, box.projects[1] ?? box.project].entries()) {
    await newSession(project)
    await turn(`FLOW SHORT ${index ? 'B' : 'A'}1`)
    await turn(`LONGTEXT ${index ? 'B' : 'A'}2`)
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(refs[0].path)})`)
  await sleep(1500)
  const capture = async (name, act) => {
    const frames = []
    const stamp = []
    const before = cdp.events.length
    await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })
    const t0 = Date.now()
    await act()
    await sleep(1100)
    await cdp.call('Page.stopScreencast')
    for (const event of cdp.events.slice(before)) {
      if (event.method !== 'Page.screencastFrame') continue
      frames.push(event.params.data)
      stamp.push(Math.round(event.params.metadata.timestamp * 1000 - t0))
    }
    frames.forEach((data, i) => writeFileSync(join(dir, `${name}-${String(i).padStart(2, '0')}.jpg`), Buffer.from(data, 'base64')))
    return stamp
  }
  report.add = await capture('add', () => ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 1 })`))
  await sleep(1500)
  report.close = await capture('close', () => ev('window.__yanSplit.getState().close()'))
  log('split-frames', report)
}
