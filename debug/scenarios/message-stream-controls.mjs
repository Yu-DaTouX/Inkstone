export const meta = { description: '消息流控件：搜索默认展开和开合持久化、待办显式状态、思考重挂计时、过程树稳定；隔离假模型与合成消息' }

export default async function run({ cdp, newSession, turn, waitFor, sleep, check, shot, report }) {
  await newSession()
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', reduceMotion: false, rightPanelOpen: false, promptSuggestions: false })`)
  const evaluate = (script) => cdp.evaluate(script)
  const sources = [{ title: '原始资料', url: 'https://example.invalid/reference', domain: 'example.invalid', snippet: '隔离样本来源', source: '' }]
  const user = { id: 'controls-user', role: 'user', text: '消息流控件验收', timestamp: Date.now() - 20000 }
  const search = (id, status = 'running') => ({ id, name: 'web_search', args: { query: id }, status, ...(status === 'ok' ? { details: { search: { action: 'query', query: id, items: sources } } } : {}) })
  const message = (call) => ({ id: 'controls-search', role: 'assistant', text: '', toolCalls: [call], timestamp: Date.now() })
  const inject = async (messages, extra = {}) => {
    await evaluate(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, session: {...s.session, isAgentRunning:true, isStreaming:true}, historyLoading:false, switchLoading:false, ...${JSON.stringify(extra)} }) })()`)
    await sleep(120)
  }
  const capOpen = () => evaluate(`document.querySelector('[data-testid="ws-capsule"]')?.getAttribute('aria-expanded')`)
  const moveAway = () => cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })

  await inject([user, { id: 'controls-reply', role: 'assistant', text: '正在输出', timestamp: Date.now() }])
  const liveNotice = '[data-testid="v3-turn-activity"][data-working="working"]'
  await waitFor(`!!document.querySelector('${liveNotice} [data-testid="v3-act-spin"][data-variant="orbit"]')`)
  check('消息流「进行中」用小号墨色 Orbit，不再显示蓝色盲文圆点', await evaluate(`(() => {
    const notice = document.querySelector('${liveNotice}')
    const orbit = notice.querySelector('[data-testid="v3-act-spin"]')
    const style = getComputedStyle(orbit)
    return notice.textContent.includes('进行中') && orbit.children.length === 9 && parseFloat(style.width) <= 12 &&
      style.color === 'rgb(255, 255, 255)' && getComputedStyle(orbit.firstElementChild).animationName === 'ui-term-orbit'
  })()`))
  await shot('working-notice-orbit')

  await inject([user, message(search('auto-search'))])
  check('运行中的搜索自动展开轻量进度', await capOpen() === 'true' && await evaluate(`!!document.querySelector('[data-testid="ws-sources-pending"]')`))
  await moveAway()
  await inject([user, message(search('auto-search', 'ok'))])
  check('搜索完成后不会立即收起', await capOpen() === 'true')
  await sleep(1100)
  check('搜索完成后持续展开，不再定时收起', await evaluate(`(() => { const cap=document.querySelector('[data-testid="ws-capsule"]'); const panel=document.getElementById(cap?.getAttribute('aria-controls')); return cap?.getAttribute('aria-expanded')==='true' && !panel?.inert && panel.getBoundingClientRect().height>0 })()`))

  await inject([user, message(search('manual-search'))])
  await evaluate(`document.querySelector('[data-testid="ws-capsule"]').click()`)
  await inject([user, message(search('manual-search', 'ok'))])
  await sleep(1000)
  check('运行中手动收起后，完成不再改用户选择', await capOpen() === 'false')
  await evaluate(`document.querySelector('[data-testid="ws-capsule"]').click()`)
  await inject([user])
  await inject([user, message(search('manual-search', 'ok'))])
  check('搜索重挂保留手动展开', await capOpen() === 'true')
  await inject([user, { ...message(search('manual-search', 'ok')), toolCalls: [search('manual-search', 'ok'), search('second-search', 'ok')] }])
  check('合并搜索组继承展开，只保留一个主条并去重来源', await evaluate(`document.querySelector('[data-testid="ws-group"]')?.getAttribute('aria-expanded')==='true' && document.querySelectorAll('[data-testid="ws-capsule"]').length===0 && document.querySelectorAll('.ui-source-card').length===1`))
  await shot('search-dark-expanded')
  const merged = (third) => [user, { ...message(search('merge-first', 'ok')), toolCalls: [search('merge-first', 'ok'), search('merge-second', 'ok'), ...(third ? [search('merge-third', third)] : [])] }]
  await inject(merged())
  check('历史搜索组默认展开，外层不再重复显示通用工具条', await evaluate(`document.querySelector('[data-testid="ws-group"]')?.getAttribute('aria-expanded')==='true' && !document.querySelector('[data-testid="v3-process-toggle"]')`))
  await evaluate(`document.querySelector('[data-testid="ws-group"]').click()`)
  await inject(merged('running'))
  check('第三次搜索运行中沿用同一主条，保留手动折叠', await evaluate(`document.querySelectorAll('[data-testid="ws-group"]').length===1 && !document.querySelector('[data-testid="ws-capsule"]') && document.querySelector('[data-testid="ws-group"]')?.getAttribute('aria-expanded')==='false' && document.querySelector('[data-testid="ws-group"]')?.dataset.state==='running'`))
  await inject(merged('ok'))
  await sleep(1100)
  check('第三次搜索结束仍保留手动折叠，不强制打开', await evaluate(`document.querySelector('[data-testid="ws-group"]')?.getAttribute('aria-expanded')==='false'`))
  await evaluate(`document.querySelector('[data-testid="ws-group"]').click()`)
  await sleep(450)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`window.__yanStore.getState().patchSettings({ theme:'light', lang:'en-US' })`)
  await sleep(500)
  check('浅色英文窄窗搜索胶囊不横向溢出', await evaluate(`(() => { const host=document.querySelector('.v3-stream'); return !!host && host.scrollWidth<=host.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1 })()`))
  await shot('search-light-en-narrow')
  await evaluate(`window.__yanStore.getState().patchSettings({ theme:'dark', lang:'zh-CN', reduceMotion:true })`)
  await sleep(100)
  check('减少动效时来源开合无过渡', await evaluate(`getComputedStyle(document.querySelector('.ui-source-reveal')).transitionDuration.split(',').every(value=>parseFloat(value)<=0.00001)`))
  await cdp.call('Emulation.clearDeviceMetricsOverride')
  await evaluate(`window.__yanStore.getState().patchSettings({ reduceMotion:false })`)

  const thinking = { id: 'controls-thinking', role: 'assistant', text: '', thinking: '核对运行状态', thinkingLive: true, thinkingStartedAt: Date.now() - 15000, timestamp: Date.now() - 20000 }
  await inject([user, thinking])
  const elapsed = () => evaluate(`document.querySelector('[data-testid="v3-thinking-elapsed"]')?.textContent ?? ''`)
  const before = await elapsed()
  check('思考已有过程摘要时，不叠加第二个打散状态行', await evaluate(`!document.querySelector('.v3-process[data-live]') || !document.querySelector('[role="status"] .ui-scramble')`))
  await inject([user])
  await inject([user, thinking])
  const after = await elapsed()
  check('思考视图重挂继续使用宿主起点，不从0秒重放', parseInt(before, 10) >= 15 && parseInt(after, 10) >= 15, { before, after })

  const todo = (text, status) => ({ text, done: status === 'done', status })
  const todos = [todo('等待资料', 'pending'), todo('修改', 'running'), todo('初步检查', 'done')]
  await inject([user, thinking], { todos, todoHistory: [{ id: 'controls-plan', round: 1, at: new Date().toISOString(), todos }] })
  check('待办以显式running项显示当前工作', await evaluate(`document.querySelector('.plan-card-now')?.textContent==='修改'`))
  const completed = todos.map((item) => todo(item.text, 'done'))
  await inject([user, thinking], { todos: completed, todoHistory: [{ id: 'controls-plan-done', round: 1, at: new Date().toISOString(), todos: completed }] })
  check('全部完成保留完成回执', await evaluate(`document.querySelector('[data-testid="plan-card"]')?.hasAttribute('data-complete') && document.querySelector('[data-testid="plan-card"]')?.textContent.includes('3/3')`))
  await shot('plan-completed')
  await inject([user, thinking, { ...user, id: 'next-user' }], { todos: completed, todoHistory: [{ id: 'controls-plan-done', round: 1, at: new Date().toISOString(), todos: completed }] })
  check('新一轮开始清场已完成计划', await evaluate(`!document.querySelector('[data-testid="plan-card"]')`))
  await inject([user, thinking, { ...user, id: 'next-user' }], { todos, todoHistory: [{ id: 'controls-stale', round: 1, at: new Date().toISOString(), todos }] })
  await evaluate(`document.querySelector('[data-testid="plan-card-close"]')?.click()`)
  check('上一轮计划可本地关闭，不删除待办数据', await evaluate(`!document.querySelector('[data-testid="plan-card"]') && window.__yanStore.getState().todos.length===3`))

  await evaluate(`(() => { const s=window.__yanStore.getState(); window.__yanStore.setState({session:{...s.session,isAgentRunning:false,isStreaming:false},todos:[],todoHistory:[],messages:[]}) })()`)
  await newSession()
  let captured = false
  await turn('FLOW SHORT 消息流稳定性', { timeout: 180000, settleMs: 800, during: async () => {
    await waitFor(`!!document.querySelector('.v3-process[data-live] [data-testid="v3-step"]')`, 60000)
    await evaluate(`window.__controlsProcess=document.querySelector('.v3-process[data-live] [data-testid="v3-step"]').closest('.v3-process')`)
    const head = `window.__controlsProcess.querySelector('[data-testid="v3-process-toggle"]')`
    const panel = `document.getElementById((${head}).getAttribute('aria-controls'))`
    const orbit = `${head}.querySelector('.ui-term-spinner[data-variant="orbit"]')`
    const phases = await evaluate(`Array.from(${orbit}?.children ?? [], pixel => {
      const style = getComputedStyle(pixel)
      return [style.animationName, style.animationDelay, style.animationDuration]
    })`)
    check('运行中显示 Orbit 3×3 像素环，外围顺时针亮起，中心静止',
      phases.length === 9 && phases[4][0] === 'none' &&
      [0, 1, 2, 5, 8, 7, 6, 3].every((index, phase) =>
        phases[index][0] === 'ui-term-orbit' && Math.round(parseFloat(phases[index][1]) * 1000) === phase * 110 && phases[index][2] === '0.95s'),
      phases)
    const appearance = await evaluate(`(() => {
      const el = ${orbit}
      const style = getComputedStyle(el)
      return { width: parseFloat(style.width), height: parseFloat(style.height), color: style.color }
    })()`)
    check('Orbit 紧凑、不超过 12px，深色主题使用白色墨色', appearance.width > 0 && appearance.width <= 12 &&
      appearance.height === appearance.width && appearance.color === 'rgb(255, 255, 255)', appearance)
    await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    check('系统减少动态效果时 Orbit 保持静止', await evaluate(`${orbit}?.children.length === 9 && Array.from(${orbit}.children).every(pixel => getComputedStyle(pixel).animationName === 'none')`))
    await cdp.call('Emulation.setEmulatedMedia', { features: [] })
    await shot('flow-orbit-running')
    await waitFor(`(${head}).getAttribute('aria-expanded')==='true' && (${panel}).getBoundingClientRect().height>0`)
    check('运行预览的头部展开语义与可见面板一致', await evaluate(`(${head}).getAttribute('aria-expanded')==='true' && (${panel}).getBoundingClientRect().height>0`))
    await evaluate(`(${head}).click()`)
    await waitFor(`window.__controlsProcess.dataset.open==='true'`)
    check('运行中第一次点击短过程会完全展开', await evaluate(`window.__controlsProcess.dataset.open==='true' && !window.__controlsProcess.querySelector('[data-testid="v3-process-body"]').dataset.stage`))
    await evaluate(`(${head}).click()`)
    await waitFor(`(${head}).getAttribute('aria-expanded')==='false' && (${panel}).getBoundingClientRect().height<1`)
    check('运行中可手动完全收起过程', await evaluate(`(${head}).getAttribute('aria-expanded')==='false' && (${panel}).getBoundingClientRect().height<1`))
    await evaluate(`(${head}).click()`)
    await waitFor(`window.__controlsProcess.querySelector('[data-testid="v3-process-body"]')?.dataset.stage==='true'`)
    check('折叠后再次点击回到短显示', await evaluate(`window.__controlsProcess.querySelector('[data-testid="v3-process-body"]')?.dataset.stage==='true'`))
    await evaluate(`(${head}).click()`)
    await waitFor(`window.__controlsProcess.dataset.open==='true'`)
    await evaluate(`window.__controlsProcess.querySelector('[data-testid="v3-step"]').click()`)
    captured = await evaluate(`(() => { const step=window.__controlsProcess.querySelector('[data-testid="v3-step"]'); window.__controlsStep=step; return !!step })()`)
  } })
  check('运行结束沿用同一棵过程树，已打开工具行不重挂', captured && await evaluate(`!!window.__controlsStep?.isConnected && window.__controlsStep.getAttribute('aria-expanded')==='true'`))
  check('回合结束后移除 Orbit', await evaluate(`!document.querySelector('.v3-process .ui-term-spinner[data-variant="orbit"]')`))
  await shot('flow-ended-preserved')

  const visual = `document.querySelector('[data-testid="v3-turn-activity"] .ui-scramble__visual')`
  await evaluate(`(() => {
    const frames = new Set()
    const timings = new Map()
    window.__scrambleFrames = frames
    window.__scrambleTimings = timings
    const record = () => {
      const node = ${visual}
      const text = node?.textContent
      if (!text) return
      frames.add(text)
      const start = timings.get(node)?.start
      if (text !== '等待回复…' && !start) timings.set(node, { start: performance.now(), end: 0 })
      else if (text === '等待回复…' && start) timings.get(node).end ||= performance.now()
    }
    const observer = new MutationObserver(record)
    observer.observe(document.querySelector('.v3-stream'), { subtree: true, childList: true, characterData: true })
    window.__stopScrambleFrames = () => observer.disconnect()
  })()`)
  await turn('HOLD2000 等待回复动效验收', { during: async () => {
    await waitFor(`window.__scrambleFrames.size > 1`, 4500, 18)
    const scrambled = (await evaluate('[...window.__scrambleFrames]')).find((text) => text !== '等待回复…') ?? ''
    check('Scramble 未复原的文字只用 ASCII 符号', /^[!@#$%&*+=?]{4}…$/.test(scrambled), scrambled)
    check('首字前文字短暂打散，读屏仍是真实状态', await evaluate(`${visual}.getAttribute('aria-hidden') === 'true' && ${visual}.parentElement.querySelector('.sr-only').textContent === '等待回复…'`))
    await waitFor(`!!window.__scrambleTimings.get(${visual})?.end`)
    const duration = await evaluate(`(() => { const { start, end } = window.__scrambleTimings.get(${visual}); return end - start })()`)
    check('Scramble 保持可见约 0.85 秒', duration >= 750 && duration <= 1050, duration)
    await sleep(450)
    check('打散只播一次，等待期间不轮播文案', await evaluate(`${visual}?.textContent === '等待回复…'`))
    await shot('waiting-reply-scramble-settled')
  } })
  await evaluate(`window.__stopScrambleFrames()`)
  check('回复到达后移除等待动效', await evaluate(`!document.querySelector('.ui-scramble')`))
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await turn('HOLD1300 减少动态效果验收', { during: async () => {
    await waitFor(`!!${visual}`)
    const frames = await evaluate(`(async () => {
      const values = new Set()
      for (let i = 0; i < 22; i++) {
        values.add(${visual}?.textContent)
        await new Promise(requestAnimationFrame)
      }
      return [...values]
    })()`)
    check('减少动态效果时直接显示完整文字', frames.join() === '等待回复…', frames)
  } })
  await cdp.call('Emulation.setEmulatedMedia', { features: [] })
  report.controls = { thinkingElapsed: { before, after } }
}
