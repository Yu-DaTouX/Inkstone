export const meta = { description: '预测下一句：回复结束后输入框出现灰字，Tab 填入、Esc 关掉、Enter 直接发送；收尾决策卡已删除' }

const KEY = 'inkstone_prompt_suggestion'
const SUGGESTION = '继续下一步'

export default async function run({ cdp, fake, check, waitFor, turn, sleep, shot, state }) {
  const ev = (expr) => cdp.evaluate(expr)
  const input = '[data-testid="composer-input"]'
  const press = async (key, code, vk) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  }
  const composer = () => ev(`(() => { const el = document.querySelector(${JSON.stringify(input)}); return el ? { text: el.innerText.trim(), suggestion: el.dataset.suggestion ?? null, placeholder: el.dataset.placeholder ?? null } : null })()`)
  const focus = () => ev(`document.querySelector(${JSON.stringify(input)}).focus()`)

  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', promptSuggestions: true })`)
  const before = fake.requests.length
  await turn('先随便回一句')
  await waitFor(`s.statuses?.[${JSON.stringify(KEY)}] === ${JSON.stringify(SUGGESTION)}`, 20000)
  const asked = fake.requests.slice(before).filter((request) => request.text.startsWith('[Inkstone: predict'))
  check('回复结束后发了一次预测请求', asked.length === 1, fake.requests.slice(before).map((request) => request.text))
  check('预测请求禁用了工具但没删工具', asked[0]?.tools > 0, asked[0])
  await sleep(300)
  const shown = await composer()
  check('输入框显示灰字建议', shown?.suggestion === 'true' && shown.placeholder === SUGGESTION && shown.text === '', shown)
  check('消息流里没有收尾决策卡', (await ev(`document.querySelectorAll('[data-testid="v3-wrap-up"]').length`)) === 0)
  await shot('prompt-suggestion-dark')

  await focus()
  await press('Tab', 'Tab', 9)
  await sleep(200)
  const filled = await composer()
  check('Tab 把建议填进输入框', filled?.text === SUGGESTION && filled.suggestion === null, filled)
  await ev(`window.__yanStore.getState().setSessionDraft('', undefined)`).catch(() => null)
  await focus()
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await press('Backspace', 'Backspace', 8)
  await sleep(200)
  const cleared = await composer()
  check('删掉文字后建议重新出现', cleared?.text === '' && cleared.suggestion === 'true', cleared)
  await press('Escape', 'Escape', 27)
  await sleep(200)
  const dismissed = await composer()
  check('Esc 关掉建议', dismissed?.suggestion === null, dismissed)

  await turn('再回一句')
  await waitFor(`s.statuses?.[${JSON.stringify(KEY)}] === ${JSON.stringify(SUGGESTION)}`, 20000)
  await sleep(300)
  const userCount = await state(`s.messages.filter((m) => m.role === 'user').length`)
  await focus()
  await press('Enter', 'Enter', 13)
  await waitFor(`s.messages.filter((m) => m.role === 'user').length > ${userCount}`, 10000)
  const lastUser = await state(`s.messages.filter((m) => m.role === 'user').at(-1)?.text ?? ''`)
  check('Enter 直接发送建议', lastUser === SUGGESTION, lastUser)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning)`, 60000)
  await sleep(4000)
  check('和刚发的那句一样的预测不再显示', !(await ev(`window.__yanStore.getState().statuses?.[${JSON.stringify(KEY)}]`)))
  await ev(`window.__yanStore.getState().send('再随便回一句')`)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning)`, 60000)
  await waitFor(`s.statuses?.[${JSON.stringify(KEY)}] === ${JSON.stringify(SUGGESTION)}`, 20000)

  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(400)
  await shot('prompt-suggestion-light')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', promptSuggestions: false })`)
  await sleep(300)
  check('设置关掉后不再显示', (await composer())?.suggestion === null)
}
