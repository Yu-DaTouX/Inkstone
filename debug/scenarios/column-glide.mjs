export const meta = { description: '右栏与会话栏开合时，消息列和输入框从旧位置平滑滑到新位置，文字只重排一次；逐帧量正文左缘' }

const PROBE = (action) => `(async () => {
  const reserveBefore = document.querySelector('.v3-chat')?.dataset.barReserve ?? null
  const samples = []
  const t0 = performance.now()
  const tick = () => setTimeout(measure, 0)
  const measure = () => {
    const p = document.querySelector('[data-turn-id="glide-a"] p')
    const c = document.querySelector('.v3-composer > :first-child')
    samples.push([performance.now() - t0, p ? Math.round(p.getBoundingClientRect().left) : -1, p ? Math.round(p.getBoundingClientRect().width) : -1, c ? Math.round(c.getBoundingClientRect().left) : -1])
    if (performance.now() - t0 < 900) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  ${action}
  await new Promise(r => setTimeout(r, 1000))
  const settled = samples.slice(2)
  const steps = (i) => settled.slice(1).filter((s, k) => s[i] !== settled[k][i]).length
  const jump = (i) => Math.max(0, ...settled.slice(1).map((s, k) => Math.abs(s[i] - settled[k][i])))
  const lefts = samples.map(s => s[1])
  const seq = samples.filter((s, i) => i === 0 || s[1] !== samples[i - 1][1]).slice(0, 12).map(s => Math.round(s[0]) + ':' + s[1]).join(' ')
  return { seq, reserve: [reserveBefore, document.querySelector('.v3-chat')?.dataset.barReserve ?? null], range: Math.max(...lefts) - Math.min(...lefts), steps: steps(1), jump: jump(1), composerSteps: steps(3), composerJump: jump(3), widths: new Set(samples.map(s => s[2])).size }
})()`

export default async function run({ cdp, check, waitFor, sleep, newSession, report }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
  await newSession()
  await ev(`window.__yanStore.getState().patchSettings({ panelMotionMs: 300, reduceMotion: false, workspaceTiles: true })`)
  await ev(`(() => {
    const text = Array.from({ length: 20 }, (_, i) => '第 ' + i + ' 段：现在会先检查输出目录，已有同名文件时不再静默覆盖，并补了对应的测试用例和说明。').join('\\n\\n')
    window.__yanStore.setState(s => ({ messages: [{ id: 'glide-u', role: 'user', text: '看看导出脚本' }, { id: 'glide-a', role: 'assistant', text }], session: { ...s.session, isAgentRunning: false, isStreaming: false }, historyLoading: false, switchLoading: false }))
  })()`)
  await waitFor(`!!document.querySelector('[data-turn-id="glide-a"] p')`, 12000)
  await waitFor(`!document.documentElement.matches('[data-window-resizing], [data-motion-hold], [data-reduce-motion]')`, 12000)
  await sleep(600)
  const panelOpen = `document.querySelector('.v3-root').dataset.panel === 'inline'`
  if (await ev(panelOpen)) { await ev(`document.querySelector('[data-testid="v3-head-panel-toggle"]').click()`); await sleep(900) }
  const toggle = `document.querySelector('[data-testid="v3-head-panel-toggle"]').click()`
  const bar = `document.querySelector('[data-testid="v3-head-sessionbar-toggle"]').click()`
  report.state = await ev(`({ chat: document.querySelector('.v3-chat')?.clientWidth, bar: !!document.querySelector('.v3-sessionbar'), pressed: document.querySelector('[data-testid="v3-head-sessionbar-toggle"]')?.getAttribute('aria-pressed'), tiles: window.__yanStore.getState().settings?.workspaceTiles, msgs: window.__yanStore.getState().messages.length, chats: [...document.querySelectorAll('.v3-chat')].map(c => [c.dataset.barReserve ?? '-', c.dataset.sessionbar ?? '-', c.clientWidth]) })`)
  report.glide = {}
  for (const [name, action] of [['会话栏收起', bar], ['会话栏展开', bar], ['右栏打开', toggle], ['右栏收起', toggle]]) {
    const r = await ev(PROBE(action))
    report.glide[name] = r
    const moved = r.range > 40
    check(`${name}：消息列逐帧滑动，没有整段跳变`, !moved || (r.steps >= 10 && r.jump <= 40), r)
    check(`${name}：输入框随消息列一起滑动`, !moved || (r.composerSteps >= 10 && r.composerJump <= 40), r)
    check(`${name}：正文宽度最多变一次`, r.widths <= 2, r)
    await sleep(300)
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1900, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  for (const [name, action] of [['宽窗右栏打开', toggle], ['宽窗右栏收起', toggle]]) {
    const r = await ev(PROBE(action))
    report.glide[name] = r
    check(`${name}：消息列逐帧滑动，没有整段跳变`, r.range > 40 && r.steps >= 10 && r.jump <= 40, r)
    check(`${name}：输入框随消息列一起滑动`, r.composerSteps >= 10 && r.composerJump <= 40, r)
    await sleep(300)
  }
  check('至少有一组开合让消息列移动', Object.values(report.glide).some((r) => r.range > 40), report.glide)
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
  await waitFor(`document.documentElement.dataset.reduceMotion === 'true'`, 5000).catch(() => {})
  const reduced = await ev(PROBE(toggle))
  report.reduced = reduced
  check('减少动效时直接到位，不滑动', reduced.steps <= 2, reduced)
}
