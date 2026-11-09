export const meta = { description: '运行中的回合里折叠过程条后，消息流底部不再留下一大片空白；不调用真实模型' }

export default async function run({ cdp, check, waitFor, sleep, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', permissionMode: 'all' })`)
  for (let i = 0; i < 4; i++) {
    await ev(`window.__yanStore.getState().send('先聊几句 ${i}')`)
    await sleep(2200)
  }
  await ev(`window.__yanStore.getState().send('STORM-blank STEPS40')`)
  await waitFor(`/运行 [2-3]\\d 条命令/.test(document.querySelector('.v3-stream')?.innerText ?? '') && !!window.__yanStore.getState().session?.isStreaming`, 120000, 100)
  const blank = () => ev(`(() => { const inner = document.querySelector('.v3-stream-inner'); const last = inner?.lastElementChild; if (!inner || !last) return -1; return Math.round(inner.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(inner).paddingBottom) || 0)) })()`)
  const click = async () => {
    const p = await ev(`(() => { const hs = [...document.querySelectorAll('.v3-process-head')]; const r = hs[hs.length - 1].getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }
  const before = await blank()
  await click()
  await sleep(1500)
  const after = await blank()
  log('空白高度', JSON.stringify({ before, after }))
  await shot('process-collapse-blank')
  check('折叠后底部空白不超过 120px', after >= 0 && after <= 120, String(after))
}
