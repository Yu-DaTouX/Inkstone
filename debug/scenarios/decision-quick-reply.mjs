export const meta = { description: '等你决定卡：预测下一句开启时不显示快捷回复；关闭后是非问句显示「好 / 先不」，点击后发送并转为已回复；选择问句不显示' }

export default async function run({ cdp, waitFor, check, newSession, turn, shot, sleep, state }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await newSession()
  await turn('DECIDEYN 问是非')
  await waitFor(`!!document.querySelector('[data-testid="v3-decision"][data-state="open"]')`, 15000, 50)
  await sleep(300)
  check('预测下一句开启时不显示快捷回复', await ev(`!document.querySelector('[data-testid="v3-decision-actions"]')`))
  await shot('decision-suggestions-on')

  await ev(`window.__yanStore.getState().patchSettings({ promptSuggestions: false })`)
  await waitFor(`!!document.querySelector('[data-testid="v3-decision"][data-state="open"] [data-testid="v3-decision-yes"]')`, 10000, 50)
  await sleep(500)
  await shot('decision-open')
  check('关闭预测后是非问句显示两个按钮', await ev(`document.querySelectorAll('[data-testid="v3-decision-actions"] button').length === 2`))
  const before = await state(`s.messages.filter((m) => m.role === 'user').length`)
  await ev(`document.querySelector('[data-testid="v3-decision-yes"]').click()`)
  await waitFor(`s.messages.filter((m) => m.role === 'user').length === ${before + 1} && !s.streaming`, 20000, 50)
  check('点击后发出「好」', await state(`s.messages.filter((m) => m.role === 'user').at(-1)?.text`) === '好')
  await waitFor(`!document.querySelector('[data-testid="v3-decision-actions"]')`, 10000, 50)
  check('作答后按钮消失', true)
  await sleep(500)
  await shot('decision-answered')

  await turn('DECIDEOR 问个选择')
  await waitFor(`!!document.querySelector('[data-testid="v3-decision"][data-state="open"]')`, 15000, 50)
  await sleep(300)
  check('选择问句不显示快捷回复', await ev(`!document.querySelector('[data-testid="v3-decision-actions"]')`))
}
