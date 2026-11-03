import { copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const meta = { description: '长会话（虚拟列表）运行中仿「拍照确认」流程（快命令、读图、叙述、慢命令），整轮反复往上滚几格再往下滚回底部：逐帧记录滚动位置，检查往下滚时有没有被往回拉；YAN_SCROLL_PROMPT 可换假模型指令', samples: 1 }

export default async function run({ cdp, state, waitFor, check, report, turn, box, runDir, sleep, shot, log, autoApprove, running }) {
  const [big] = box.samples
  if (!big) throw new Error('需要大会话样本：先跑 npm run debug -- samples pick')
  const camDir = join(runDir, 'cam')
  const prompt = process.env.YAN_SCROLL_PROMPT || `CAMSHOT STEPS6 DIR=${camDir.replace(/\\/g, '/')}`
  const image = resolve('build/installer-sidebar-generated.png')
  mkdirSync(camDir, { recursive: true })
  for (let i = 1; i <= 12; i++) copyFileSync(image, join(camDir, `check${i}.png`))

  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.sessions.length > 0', 30000)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(big)})`)
  await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(big)}`, 30000, 20)
  check('切到大会话后激活成功', (await ev('window.__yanStore.getState().ensureActivated()')) !== false)
  await waitFor('!s.pendingActivation && !s.peekedPath', 30000, 20)
  const model = await ev(`window.__yanStore.getState().setModel('fake', 'fake-model', true)`)
  check('切到假模型', model?.ok !== false, model)
  await autoApprove()
  log('虚拟列表', await ev(`!document.querySelector('.v3-stream-host .v3-stream-inner')`))

  await ev(`(() => {
    const rec = window.__scrollRec = { frames: [], on: true }
    const tick = (t) => {
      const el = document.querySelector('.v3-stream-host .v3-stream')
      const live = [...document.querySelectorAll('.v3-msg[data-turn-id]')].at(-1)
      if (rec.on && el) rec.frames.push({ t, top: Math.round(el.scrollTop), h: el.scrollHeight, c: el.clientHeight, lh: live ? Math.round(live.getBoundingClientRect().height) : 0, ex: live ? live.querySelectorAll('[aria-expanded="true"]').length : 0, img: live ? live.querySelectorAll('.v3-step-panel img').length : 0, minH: live?.querySelector('.v3-process-body')?.style.minHeight || '' })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)

  const center = await ev(`(() => { const r = document.querySelector('.v3-stream-host').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const wheel = (deltaY) => cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY })

  const click = async (x, y) => {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const expandLive = async () => {
    for (const selector of ['[data-testid="v3-step-group"]', '[data-testid="v3-step-group-list"] [data-testid="v3-step"]']) {
      const points = await ev(`(() => {
        const live = [...document.querySelectorAll('.v3-msg.streaming')].at(-1)
        if (!live) return []
        const view = document.querySelector('.v3-stream-host').getBoundingClientRect()
        return [...live.querySelectorAll(${JSON.stringify(selector)})]
          .filter((el) => el.getAttribute('aria-expanded') === 'false' && (el.textContent.includes('读取') || el.dataset.testid === 'v3-step-group'))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.top > view.top + 10 && r.bottom < view.bottom - 180)
          .map((r) => ({ x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) }))
      })()`)
      for (const point of points) { await click(point.x, point.y); await sleep(250) }
    }
  }
  let expanded = 0

  const windows = []
  let shots = 0
  await turn(prompt, {
    timeout: 300000,
    settleMs: 0,
    during: async () => {
      await sleep(3000)
      while (await state(running)) {
        const before = await ev(`document.querySelectorAll('.v3-msg.streaming [aria-expanded="true"]').length`)
        await expandLive()
        expanded = Math.max(expanded, await ev(`document.querySelectorAll('.v3-msg.streaming [aria-expanded="true"]').length`) - before)
        for (let i = 0; i < 4; i++) { await wheel(-200); await sleep(50) }
        await sleep(600)
        const from = await ev('performance.now()')
        for (let i = 0; i < 14; i++) { await wheel(100); await sleep(90) }
        await sleep(400)
        const to = await ev('performance.now()')
        windows.push({ from, to, live: await state(running) })
        if (shots < 3 && windows.length % 6 === 0) await shot(`down-${shots++}`)
      }
    }
  })

  await ev('window.__scrollRec.on = false')
  const result = await ev(`(() => {
    const rec = window.__scrollRec
    return ${JSON.stringify(windows)}.map(({ from, to }) => {
      const frames = rec.frames.filter((f) => f.t >= from && f.t <= to)
      const back = []
      for (let i = 1; i < frames.length; i++) {
        const drop = frames[i - 1].top - frames[i].top
        if (drop > 24) back.push({ t: Math.round(frames[i].t - from), drop, top: frames[i].top, h: frames[i].h, prevH: frames[i - 1].h, prev: frames.slice(Math.max(0, i - 3), i).map(({ lh, ex, img, minH }) => ({ lh, ex, img, minH })), now: { lh: frames[i].lh, ex: frames[i].ex, img: frames[i].img, minH: frames[i].minH } })
      }
      const last = frames.at(-1)
      return { back, endGap: last ? last.h - last.c - last.top : null }
    })
  })()`)
  const midRun = result.filter((_, index) => windows[index].live)
  const pulled = midRun.flatMap((item, index) => item.back.map((b) => ({ cycle: index, ...b })))
  const notBottom = midRun.map((item, index) => ({ cycle: index, gap: item.endGap })).filter((item) => item.gap === null || item.gap > 40)
  report.cycles = result
  log('展开过的条目', expanded)
  log('跨过收尾的那轮', result.filter((_, index) => !windows[index].live).map((item) => item.back.map(({ drop, h, prevH }) => ({ drop, h, prevH }))))
  check(`运行中往下滚 ${midRun.length} 次都没有被往回拉`, pulled.length === 0, pulled.slice(0, 12))
  log('滚动结束时离底超过 40px 的轮次（刚滚到底 1 秒内新内容不跟随）', notBottom.slice(0, 12))
}
