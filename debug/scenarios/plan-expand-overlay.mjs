export const meta = { description: '展开计划时不顶高消息流（消息位置与底部留白不变）；“回到最新消息”按钮在右侧且更矮；不调用真实模型' }

export default async function run({ cdp, check, waitFor, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light', lang: 'zh-CN' })`)
  for (let i = 0; i < 8; i++) {
    await ev(`window.__yanStore.getState().send('先聊几句 ${i}')`)
    await sleep(2200)
  }
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning)`, 60000, 100)
  await ev(`window.__yanStore.setState({ todos: [{ text: '第一项', done: false }, { text: '第二项', done: false }, { text: '第三项', done: false }, { text: '第四项', done: false }], todoHistory: [{ id: 'p', todos: [{ text: '第一项', done: false }, { text: '第二项', done: false }, { text: '第三项', done: false }, { text: '第四项', done: false }], round: 1 }] })`)
  await waitFor(`!!document.querySelector('[data-testid="plan-card"]')`, 10000, 100)
  await sleep(500)
  const toggle = `document.querySelector('[data-testid="plan-card-toggle"]')`
  if ((await ev(`${toggle}.getAttribute('aria-expanded')`)) === 'true') {
    await ev(`${toggle}.click()`)
    await sleep(500)
  }
  const measure = () => ev(`(() => { const s = document.querySelector('.v3-stream'); const rows = [...document.querySelectorAll('.v3-stream-inner *')].filter((e) => e.children.length === 0 && /先聊几句 7/.test(e.textContent)); const last = rows.at(-1); return { composerH: getComputedStyle(document.querySelector('.v3-conv')).getPropertyValue('--composer-h'), lastTop: last ? Math.round(last.getBoundingClientRect().top) : null, scrollTop: Math.round(s.scrollTop), scrollH: s.scrollHeight } })()`)
  const before = await measure()
  await ev(`${toggle}.click()`)
  await sleep(700)
  const after = await measure()
  console.log('展开前后', JSON.stringify({ before, after }))
  await shot('plan-expanded')
  check('展开计划后底部留白变量不变', before.composerH === after.composerH, `${before.composerH} -> ${after.composerH}`)
  check('展开计划后消息位置不变', before.lastTop === after.lastTop, `${before.lastTop} -> ${after.lastTop}`)
  check('展开计划后消息流内容高度不变', before.scrollH === after.scrollH, `${before.scrollH} -> ${after.scrollH}`)
  await ev(`${toggle}.click()`)
  await sleep(500)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 300, deltaX: 0, deltaY: -400 })
  await waitFor(`!!document.querySelector('[data-testid="v3-jump"]')`, 10000, 100)
  await sleep(500)
  const jump = await ev(`(() => { const b = document.querySelector('[data-testid="v3-jump"]').getBoundingClientRect(); const h = document.querySelector('.v3-stream-host').getBoundingClientRect(); const c = document.querySelector('.v3-composer > *')?.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height), hostLeft: Math.round(h.left), hostRight: Math.round(h.right), composerRight: c ? Math.round(c.right) : null } })()`)
  console.log('按钮', JSON.stringify(jump))
  await shot('jump-button')
  check('回到最新消息按钮靠右，右边缘与输入框对齐', jump.composerRight !== null && Math.abs(jump.right - jump.composerRight) <= 4, JSON.stringify(jump))
  check('回到最新消息按钮高度不超过 24px', jump.height <= 24, String(jump.height))
}
