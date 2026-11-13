import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '/ask 与 /plan 会话模式：输入框模式开关进只读、写被拦读放行、一键退出；斜杠命令进计划模式、出计划进待办、批准后执行；核对系统提示与工具定义字符数不随模式变化，深浅主题与窄屏截图' }

async function key(cdp, name, code, keyCode) {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode })
}

export default async function run({ cdp, fake, box, waitFor, check, sleep, shot, log, autoApprove, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  const state = (expr) => ev(`(() => { const s = window.__yanStore.getState(); return ${expr} })()`)
  const idle = `(() => { const s = window.__yanStore.getState(); return !!s.session && !s.session.isAgentRunning && !s.session.isStreaming })()`
  const toolCalls = (name) => state(`s.messages.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === ${JSON.stringify(name)}).map((c) => ({ status: c.status, isError: !!c.isError, output: String(c.output ?? '').slice(0, 400) }))`)
  const setViewport = async (width, height) => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
  }
  const pickMenu = async (label) => {
    await ev(`document.querySelector('[data-testid="session-mode-toggle"]').click()`)
    await waitFor(`!![...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.includes(${JSON.stringify(label)}))`, 5000, 50)
    await ev(`[...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.includes(${JSON.stringify(label)})).click()`)
  }
  const waitTurn = async (expr) => {
    await waitFor(`(() => { const s = window.__yanStore.getState(); return s.session?.isAgentRunning || s.session?.isStreaming || s.messages.length > 0 })()`, 30000, 50)
    await waitFor(`${idle} && (${expr})`, 90000, 100)
    await sleep(800)
  }
  const prefixOf = (request) => `${request.instructions.length}/${request.toolsChars}`

  await setViewport(1280, 860)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', promptSuggestions: false })`)
  await autoApprove()

  await newSession(box.project)
  await waitFor(`!!window.__yanStore.getState().session?.sessionId`, 30000, 50)
  check('新会话默认没有模式', !(await state('s.session?.sessionMode')))
  check('模式关闭时没有模式横幅', await ev(`!document.querySelector('[data-testid="session-mode-banner"]')`))
  check('输入框有模式开关', await ev(`!!document.querySelector('[data-testid="session-mode-toggle"][data-mode="off"]')`))

  const baselineAt = fake.requests.length
  await ev(`window.__yanStore.getState().send('先打个招呼')`)
  await waitTurn(`s.messages.some((m) => m.role === 'assistant' && (m.text ?? '').includes('好的'))`)
  const baseline = fake.requests.slice(baselineAt).find((request) => request.tools > 0)
  log('baseline', { system: baseline?.instructions.length, toolsChars: baseline?.toolsChars, tools: baseline?.tools })

  await ev(`document.querySelector('[data-testid="session-mode-toggle"]').focus()`)
  await key(cdp, 'Enter', 'Enter', 13)
  await sleep(300)
  check('键盘回车能打开模式菜单', await ev(`!!document.querySelector('[role="menu"]')`))
  await key(cdp, 'Escape', 'Escape', 27)
  await sleep(300)
  check('Esc 关闭模式菜单', await ev(`!document.querySelector('[role="menu"]')`))

  await pickMenu('只读问答')
  await waitFor(`window.__yanStore.getState().session?.sessionMode === 'ask'`, 5000, 50)
  await waitFor(`!!document.querySelector('[data-testid="session-mode-banner"][data-mode="ask"]')`, 5000, 50)
  check('输入框开关切到只读，横幅显示当前模式', true)
  check('只读模式没有批准按钮', await ev(`!document.querySelector('[data-testid="session-mode-approve"]')`))
  await shot('ask-on-dark')

  const askAt = fake.requests.length
  await ev(`window.__yanStore.getState().send('MODEASK 看看项目说明，顺手记个笔记')`)
  await waitTurn(`s.messages.some((m) => m.role === 'assistant' && (m.text ?? '').includes('读取正常'))`)
  const writes = await toolCalls('write')
  const reads = await toolCalls('read')
  log('ask tool calls', { writes, reads })
  check('只读模式下 write 被拦', writes.length === 1 && writes[0].output.includes('Read-only mode (/ask) is on'), writes)
  check('被拦的文件没有写出', !existsSync(join(box.project, 'notes', 'ask-blocked.md')))
  check('只读模式下 read 放行', reads.length === 1 && reads[0].status === 'ok' && reads[0].output.startsWith('# '), reads)
  const askRequests = fake.requests.slice(askAt).filter((request) => request.tools > 0)
  await shot('ask-blocked-dark')

  await ev(`document.querySelector('[data-testid="session-mode-exit"]').click()`)
  await waitFor(`!window.__yanStore.getState().session?.sessionMode`, 5000, 50)
  await waitFor(`!document.querySelector('[data-testid="session-mode-banner"]')`, 5000, 50)
  check('横幅一键退出只读', await ev(`!!document.querySelector('[data-testid="session-mode-toggle"][data-mode="off"]')`))

  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
  const paletteItem = (label) => `[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes(${JSON.stringify(label)}))`
  await waitFor(`!!${paletteItem('进入计划模式')}`, 5000, 50)
  check('命令面板列出 /ask 与 /plan', await ev(`!!${paletteItem('进入只读问答模式')}`))
  await ev(`${paletteItem('进入计划模式')}.click()`)
  await waitFor(`window.__yanStore.getState().session?.sessionMode === 'plan'`, 5000, 50)
  check('命令面板进入计划模式', await ev(`!!document.querySelector('[data-testid="session-mode-banner"][data-mode="plan"]')`))
  await ev(`document.querySelector('[data-testid="session-mode-exit"]').click()`)
  await waitFor(`!window.__yanStore.getState().session?.sessionMode`, 5000, 50)

  await newSession(box.project)
  await waitFor(`!!window.__yanStore.getState().session?.sessionId`, 30000, 50)
  check('另开的新会话不继承模式', !(await state('s.session?.sessionMode')))
  const planAt = fake.requests.length
  await ev(`window.__yanStore.getState().insertIntoComposer('/plan MODEPLAN 把项目说明整理成笔记')`)
  await waitFor(`document.querySelector('[data-testid="composer-input"]').innerText.includes('MODEPLAN')`, 5000, 50)
  await ev(`document.querySelector('[data-testid="composer-input"]').focus()`)
  await sleep(1200)
  await key(cdp, 'Escape', 'Escape', 27)
  await key(cdp, 'End', 'End', 35)
  await key(cdp, 'Enter', 'Enter', 13)
  await waitFor(`window.__yanStore.getState().session?.sessionMode === 'plan'`, 10000, 50)
  check('斜杠命令 /plan <任务> 进入计划模式', true)
  await waitTurn(`s.messages.some((m) => m.role === 'assistant' && (m.text ?? '').includes('请批准后执行'))`)
  const planWrites = await toolCalls('write')
  check('计划模式下 write 被拦', planWrites.length === 1 && planWrites[0].output.includes('Plan mode (/plan) is on'), planWrites)
  check('批准前文件没有写出', !existsSync(join(box.project, 'notes', 'too-early.md')))
  check('任务作为用户消息发出（不带 /plan）', await state(`s.messages.some((m) => m.role === 'user' && (m.text ?? '').startsWith('MODEPLAN'))`))
  check('计划写进待办面板', (await state('s.todos.length')) === 2)
  await waitFor(`!!document.querySelector('[data-testid="plan-card"]')`, 5000, 50)
  check('批准按钮可用', await ev(`(() => { const b = document.querySelector('[data-testid="session-mode-approve"]'); return !!b && !b.disabled && b.getAttribute('data-disabled') !== 'true' })()`))
  await shot('plan-proposed-dark')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(600)
  await shot('plan-proposed-light')
  await setViewport(560, 860)
  check('窄屏下横幅与按钮都在视口内', await ev(`(() => { const b = document.querySelector('[data-testid="session-mode-banner"]'); const a = document.querySelector('[data-testid="session-mode-approve"]'); const x = document.querySelector('[data-testid="session-mode-exit"]'); if (!b || !a || !x) return false; return [b, a, x].every((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 }) })()`))
  await shot('plan-proposed-narrow-light')
  await setViewport(1280, 860)
  const planRequests = fake.requests.slice(planAt).filter((request) => request.tools > 0)

  const runAt = fake.requests.length
  await ev(`document.querySelector('[data-testid="session-mode-approve"]').click()`)
  await waitFor(`!window.__yanStore.getState().session?.sessionMode`, 5000, 50)
  await waitTurn(`s.messages.some((m) => m.role === 'assistant' && (m.text ?? '').includes('已按计划执行完毕'))`)
  check('批准后横幅消失', await ev(`!document.querySelector('[data-testid="session-mode-banner"]')`))
  check('批准后发出一条批准消息', await state(`s.messages.some((m) => m.role === 'user' && (m.text ?? '').includes('计划已批准'))`))
  check('批准后按计划写出文件', existsSync(join(box.project, 'notes', 'plan-done.md')))
  check('待办全部完成', await state(`s.todos.length === 2 && s.todos.every((t) => t.done === true || t.status === 'done')`))
  await shot('plan-done-light')
  const runRequests = fake.requests.slice(runAt).filter((request) => request.tools > 0)

  const groups = { baseline: baseline ? [baseline] : [], ask: askRequests, plan: planRequests, approved: runRequests }
  const sizes = Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, [...new Set(list.map(prefixOf))]]))
  log('prefix chars (system/tools)', sizes)
  check('各状态的系统提示与工具定义字符数相同', !!baseline && Object.values(groups).every((list) => list.length > 0 && list.every((request) => prefixOf(request) === prefixOf(baseline))), sizes)
  check('各状态的系统提示逐字相同', Object.values(groups).every((list) => list.every((request) => request.instructions === baseline?.instructions)))
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
}
