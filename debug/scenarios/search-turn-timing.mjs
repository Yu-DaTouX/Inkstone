export const meta = { description: '插话前后的总用时、收尾与读档，以及混排命令栏里的搜索来源状态' }

export default async function run({ cdp, state, waitFor, newSession, autoApprove, turn, check, shot, sleep, report }) {
  const ev = (expression) => cdp.evaluate(expression)
  const rail = '[data-rail-section="stats"]'
  const time = '[data-testid="wb-rail-stats-time"]'
  const receipt = '[data-testid="v3-turn-receipt"]'
  const readUi = () => ev(`(() => ({ rail: document.querySelector(${JSON.stringify(time + ' .wb-rs-num')})?.textContent ?? null, receipts: [...document.querySelectorAll(${JSON.stringify(receipt)})].map(n => n.textContent.trim()) }))()`)
  const openStats = async () => {
    await waitFor(`!!document.querySelector(${JSON.stringify(rail)})`)
    await ev(`(() => { const card = document.querySelector(${JSON.stringify(rail)}); if (card.dataset.folded !== '0') card.querySelector('.wb-tile-toggle').click() })()`)
    await waitFor(`!!document.querySelector(${JSON.stringify(time)})`)
  }
  const lastTiming = () => state('s.messages.findLast(m => m.turnTiming)?.turnTiming ?? null')
  const timing = (n) => `${Math.round(n / 1000)}s`
  await newSession()
  await autoApprove()
  await ev(`window.__yanRightPanel.getState().setOpen(false); window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', workspaceTiles: true, promptSuggestions: false })`)
  await turn('MANYTOOLS 先跑工具，收到插话后简短作答。', { during: async () => {
    await waitFor('!!s.session?.runStartedAt && s.messages.some(m => m.toolCalls?.some(c => c.endedAt))')
    const start = await state('s.session.runStartedAt')
    await openStats()
    await ev(`(() => { const samples = []; window.__timingSamples = samples; window.__timingSample = setInterval(() => { const s = window.__yanStore.getState(); samples.push({ startedAt: s.session?.runStartedAt ?? null, running: s.session?.isAgentRunning ?? false, timing: s.messages.findLast(m => m.turnTiming)?.turnTiming?.elapsedMs ?? null, rail: document.querySelector('[data-testid="wb-rail-stats-time"] .wb-rs-num')?.textContent ?? null, at: Date.now() }) }, 25) })()`)
    await ev(`window.__yanStore.getState().send('WFAGENT WFDELAY2200 补充说明：继续本次运行。', [], 'steer')`)
    await waitFor(`s.messages.some(m => m.role === 'user' && m.text.includes('补充说明'))`)
    check('插话已送达，仍用运行的原始起点', await state('s.session?.runStartedAt') === start, { start })
  } })
  const liveTiming = await lastTiming()
  const samples = await ev('clearInterval(window.__timingSample); window.__timingSamples')
  const file = await state('s.session.sessionFile')
  const settled = await readUi()
  report.timing = { liveTiming, settled, samples: samples.slice(-15) }
  check('收尾只留下一个本次运行的计时', await state('s.messages.filter(m => m.turnTiming).length') === 1 && liveTiming?.elapsedMs > 0, liveTiming)
  check('回执和右栏显示同一整轮用时', settled.receipts.length === 1 && settled.receipts[0].includes(timing(liveTiming?.elapsedMs)) && settled.rail === timing(liveTiming?.elapsedMs), settled)
  check('收尾没有把同一运行的实时钟与实测值相加', samples.length > 0 && samples.every(s => {
    const clock = /^(?:(\d+)m )?(\d+)s$/.exec(s.rail ?? '')
    const shownMs = clock ? (Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 1000 : null
    return shownMs === null || shownMs <= Math.max(s.timing ?? 0, s.at - liveTiming.startedAt) + 1000
  }))
  const setRunning = (running) => ev(`window.__yanStore.setState(s => ({ session: { ...s.session, isAgentRunning: ${running}, runStartedAt: ${running ? liveTiming.startedAt : 'undefined'} } }))`)
  await setRunning(true)
  await sleep(450)
  const overlapping = await readUi()
  check('完成记录先于停止状态到达时，不重复显示实时用时', overlapping.rail === settled.rail, overlapping)
  await setRunning(false)
  await ev(`document.querySelector(${JSON.stringify(receipt)})?.scrollIntoView({ block: 'center' })`)
  await sleep(500)
  await shot('turn-timing-settled')
  await newSession()
  await waitFor(`s.session?.sessionFile !== ${JSON.stringify(file)}`)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  await waitFor(`s.session?.sessionFile === ${JSON.stringify(file)} && !s.historyLoading && s.messages.some(m => m.turnTiming)`)
  await openStats()
  await sleep(500)
  const restored = await readUi()
  check('重开会话仍有同一整轮用时', (await lastTiming())?.elapsedMs === liveTiming?.elapsedMs && JSON.stringify(restored) === JSON.stringify(settled), restored)

  await newSession()
  await ev('window.__yanStore.getState().patchSettings({ workspaceTiles: false })')
  const queries = ['site:minecraft.net 建筑高度、塔楼尺寸与原版方块属性参考'.repeat(5), 'minecraft tower roof']
  const search = (id, serverSide, items = []) => ({ id, name: 'web_search', serverSide, args: { queries }, status: 'ok', details: { search: { action: 'query', query: queries[0], items } } })
  const bash = (id) => ({ id, name: 'bash', args: { command: 'echo checked', description: '检查塔楼尺寸' }, status: 'ok', output: 'checked' })
  const messages = [
    { id: 'search-user', role: 'user', text: '查塔楼的建造资料。' },
    { id: 'search-mixed', role: 'assistant', text: '', toolCalls: [search('missing1', true), search('missing2', true), bash('bash1'), search('empty', false), bash('bash2'), search('cited', true, [{ title: '塔楼结构示例', url: 'https://fixture.invalid/tower', domain: 'fixture.invalid', snippet: '' }])] },
    { id: 'search-final', role: 'assistant', text: '已核对塔楼资料。' }
  ]
  await ev(`window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, historyLoading: false, switchLoading: false })`)
  await waitFor(`!!document.querySelector('[data-testid="v3-process-toggle"]')`)
  await ev(`document.querySelector('[data-testid="v3-process-toggle"]').click()`)
  await sleep(700)
  const caps = await ev(`Array.from(document.querySelectorAll('.ws-cap'), c => ({ count: c.querySelector('[data-testid="ws-capsule-count"]')?.textContent ?? null, label: c.textContent, button: c.tagName === 'BUTTON', fits: c.scrollWidth <= c.clientWidth + 1 }))`)
  report.search = caps
  check('命令条区分未记录来源、真实零结果和有引用', caps.length === 3 && caps[0].count === null && caps[0].label.includes('未记录来源') && !caps[0].button && caps[1].count === '0' && !caps[1].button && caps[2].count === null && caps[2].button, caps)
  check('长查询不撑破胶囊', caps.every(c => c.fits), caps)
  await ev(`document.querySelector('button.ws-cap[aria-expanded="true"]')?.click()`)
  await waitFor(`!!document.querySelector('button.ws-cap[aria-expanded="false"]')`)
  await ev(`document.querySelector('button.ws-cap[aria-expanded="false"]').click()`)
  await sleep(400)
  check('有引用的胶囊收起后可以重新展开实际来源', await ev(`document.querySelector('.ui-source-reveal[data-open="true"]')?.textContent.includes('塔楼结构示例')`))
  await ev(`document.querySelector('.ws-cap')?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  await shot('search-capsules-mixed')
}
