import { readFileSync } from 'node:fs'

export const meta = { description: '长文本流式、40 步工具、运行中切大会话、6000 行输出、空闲切换耗时、图片（需要 2 个大会话样本）', samples: 2 }

function diskUserCount(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(lines.filter((line) => line.id).map((line) => [line.id, line]))
  let leaf = null
  for (const line of lines) if (line.id && line.type !== 'session_info' && line.type !== 'label') leaf = line.id
  let count = 0
  for (let id = leaf; id; id = byId.get(id)?.parentId) if (byId.get(id)?.type === 'message' && byId.get(id).message?.role === 'user') count++
  return count
}

export default async function run(ctx) {
  const { cdp, state, waitFor, check, report, newSession, turn, autoApprove, shot, sleep, box, fake } = ctx
  const [big1, big2] = box.samples
  if (!big2) throw new Error('需要 2 个大会话样本：先跑 npm run debug -- samples pick')
  const ev = (expr) => cdp.evaluate(expr)
  const phase = (name) => ev(`window.__lt.phase = ${JSON.stringify(name)}`)
  const longtasks = (label) => ev(`(() => { const xs = window.__lt.entries.filter((e) => e.phase === ${JSON.stringify(label)}); const d = xs.map((e) => e.d); return { count: xs.length, total: Math.round(d.reduce((a, b) => a + b, 0)), max: Math.round(Math.max(0, ...d)), frames: window.__lt.frames[${JSON.stringify(label)}] ?? null } })()`)
  await ev(`(() => {
    window.__lt = { phase: 'boot', entries: [], frames: {} }
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lt.entries.push({ phase: window.__lt.phase, d: e.duration }) }).observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    const tick = (now) => { const f = window.__lt.frames[window.__lt.phase] ??= { n: 0, over50: 0, max: 0 }; const gap = now - last; f.n++; if (gap > 50) f.over50++; if (gap > f.max) f.max = Math.round(gap); last = now; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })()`)
  await autoApprove()
  await shot('01-boot')
  check('启动后一次就新建到目标目录', (await newSession()) === 0)
  const testPath = await state('s.session.sessionFile')

  await phase('hello')
  await turn('你好')
  check('普通回合', (await state('s.messages.length')) >= 2)

  await phase('longtext')
  await turn('请输出 LONGTEXT', { during: async () => { await sleep(4000); await shot('02-longtext-mid') } })
  report.timings.longtext = await longtasks('longtext')
  const lastText = await state(`s.messages.filter((x) => x.role === 'assistant').at(-1)?.text ?? ''`)
  check('长文本完整', lastText.includes('结束。') && lastText.includes('a60'), `len=${lastText.length}`)
  check('长文本已渲染到底', await ev(`document.body.innerText.includes('结束。') && document.body.innerText.includes('列表第 120 项')`))

  await phase('manytools')
  const tools = await turn('MANYTOOLS 跑四十步', {
    timeout: 180000,
    during: async () => {
      await sleep(2500)
      await phase('switch-while-running')
      let t = Date.now()
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(big1)})`)
      await waitFor(`!s.switchLoading && s.messages.length > 50`, 30000, 20)
      report.timings.switchToBigWhileRunningMs = Date.now() - t
      await shot('03-big-while-running')
      await sleep(1500)
      t = Date.now()
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(testPath)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(testPath)}`, 30000, 20)
      report.timings.switchBackRunningMs = Date.now() - t
      await phase('manytools')
    }
  })
  report.timings.manytools = { ...tools, ...(await longtasks('manytools')), switchPhase: await longtasks('switch-while-running') }
  check('四十步工具全部到达', tools.requests === 41, `requests=${tools.requests}`)
  check('切走再切回后最终回复可见', await ev(`document.body.innerText.includes('四十步都完成了')`))
  check('切回后不在 peek 态', await state('!s.peekedPath && !s.peekedSessionId'))

  await phase('bigout')
  await turn('BIGOUT 打印长输出', { timeout: 180000 })
  report.timings.bigout = await longtasks('bigout')
  check('长输出结果到达', await state(`JSON.stringify(s.messages.slice(-4)).includes('line 6000')`))
  await shot('04-bigout-end')

  await sleep(1500)
  const diskUsers = diskUserCount(testPath)
  check('界面用户消息数与磁盘当前分支一致', (await state(`s.messages.filter((m) => m.role === 'user').length`)) === diskUsers, `disk=${diskUsers}`)

  const idle = []
  await phase('idle-switch')
  for (const target of [big1, big2, testPath, big1, testPath]) {
    const t = Date.now()
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target)})`)
    await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(target)} && s.messages.length > 0`, 30000, 10)
    idle.push(Date.now() - t)
    await sleep(700)
  }
  report.timings.idleSwitchMs = idle
  report.timings.idleSwitchLongtasks = await longtasks('idle-switch')
  check('空闲切换后消息数不变', (await state(`s.messages.filter((m) => m.role === 'user').length`)) === diskUsers)

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await ev(`window.__yanStore.getState().addAttachments([{ id: 'img-1', name: 'dot.png', mimeType: 'image/png', size: 68, data: '${png}', preview: 'data:image/png;base64,${png}', kind: 'image' }])`)
  await turn('看看这张图', { images: [{ data: png, mimeType: 'image/png' }] })
  check('图片消息发送并显示', await state(`JSON.stringify(s.messages.filter((m) => m.role === 'user').at(-1)).includes('image')`))
  await ev(`window.__yanStore.getState().clearAttachments()`)
  report.timings.bootPhase = await longtasks('boot')
  report.requests = fake.requests.length
}
