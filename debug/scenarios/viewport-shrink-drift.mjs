import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export const meta = { description: '窗口缩到 720 再还原后阅读位置是否漂移：大会话副本（YAN_LONG_SCROLL_SOURCE）在底部、中部、顶部三处，记录锚点逐帧位置，不调用模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep }) {
  const source = process.env.YAN_LONG_SCROLL_SOURCE
  if (!source) throw new Error('需要 YAN_LONG_SCROLL_SOURCE 指向测试用会话副本')
  const dir = join(box.sessionsDir, '--long-scroll-fixture--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, basename(source))
  copyFileSync(source, file)
  report.fixture = { bytes: statSync(file).size }
  const size = (width) => cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 958, deviceScaleFactor: 1, mobile: false })
  await size(1778)
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', workspaceTiles: true })`)
  await cdp.evaluate(`window.__yanStore.getState().refreshSessions()`)
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  await waitFor(`!s.switchLoading && s.messages.length > 500`, 60000)
  await sleep(1500)
  const anchor = () => cdp.evaluate(`(() => {
    const el = document.querySelector('.v3-stream'); const top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll('.v3-msg[data-turn-id]')].find((r) => r.getBoundingClientRect().bottom > top + 4)
    return { id: row?.dataset.turnId ?? null, offset: row ? Math.round(row.getBoundingClientRect().top - top) : null, scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) }
  })()`)
  const watch = () => cdp.evaluate(`(() => {
    const el = document.querySelector('.v3-stream'); const w = window.__shrinkWatch = { frames: [], maxGap: 0, last: 0 }
    const tick = (now) => {
      if (w.last) w.maxGap = Math.max(w.maxGap, now - w.last)
      w.last = now
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll('.v3-msg[data-turn-id]')].find((r) => r.getBoundingClientRect().bottom > top + 4)
      w.frames.push({ id: row?.dataset.turnId ?? null, off: row ? Math.round(row.getBoundingClientRect().top - top) : null, st: Math.round(el.scrollTop) })
      w.raf = requestAnimationFrame(tick)
    }
    w.raf = requestAnimationFrame(tick)
  })()`)
  const unwatch = () => cdp.evaluate(`(() => { const w = window.__shrinkWatch; cancelAnimationFrame(w.raf); const ids = new Set(w.frames.map((f) => f.id)); const offs = w.frames.filter((f) => f.off !== null).map((f) => f.off); return { frames: w.frames.length, maxGap: Math.round(w.maxGap), distinctAnchors: ids.size, offMin: Math.min(...offs), offMax: Math.max(...offs), stMin: Math.min(...w.frames.map((f) => f.st)), stMax: Math.max(...w.frames.map((f) => f.st)) } })()`)
  const places = [
    ['bottom', async () => { await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); el.scrollTop = el.scrollHeight })()`) }],
    ['mid', async () => { await cdp.evaluate(`document.querySelector('[data-testid="v3-outline-tick"][data-index="40"]')?.click()`); await sleep(1800) }],
    ['top', async () => { await cdp.evaluate(`document.querySelector('[data-testid="v3-outline-tick"][data-index="3"]')?.click()`); await sleep(1800) }]
  ]
  report.drift = {}
  for (const [name, go] of places) {
    await go()
    await sleep(1200)
    const before = await anchor()
    await watch()
    await size(720)
    await sleep(1200)
    const narrow = await anchor()
    await size(1778)
    await sleep(1500)
    const after = await anchor()
    const series = await unwatch()
    const sameAnchor = before.id === after.id
    const driftOffset = sameAnchor ? after.offset - before.offset : null
    report.drift[name] = { before, narrow, after, series, sameAnchor, driftOffset }
    console.log(name, JSON.stringify(report.drift[name]))
    check(`${name}：缩到 720 再还原后锚点回合不变`, sameAnchor, { before, after })
    check(`${name}：还原后锚点偏移漂移不超过 24px`, sameAnchor && Math.abs(driftOffset) <= 24, { before, after })
    check(`${name}：还原后距底部距离不变`, name !== 'bottom' || after.fromBottom <= 4, after)
  }
}
