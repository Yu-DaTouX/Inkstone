import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { click, MOD, press, typeText } from '../lib/review-kit.mjs'

export const meta = { description: '斜杠菜单单滚动区、会话信息、确认选项及导入和克隆的实际目标；仅假模型，不批准操作' }

export default async function run({ cdp, box, newSession, turn, waitFor, state, check, shot, sleep, fake }) {
  const input = '[data-testid="composer-input"]'
  const menu = '[data-composer-command-root]'
  const query = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const testId = (id) => `[data-testid="${id}"]`
  const visible = (id) => `!!${query(testId(id))}`
  const wait = (expr) => waitFor(expr, 10000)
  const key = (key, modifiers) => press(cdp, key, { modifiers, waitMs: 100 })
  const readPath = () => state('s.peekedPath ?? s.session?.sessionFile')
  const put = async (text) => {
    await cdp.evaluate(`${query(input)}.focus()`)
    await key('a', MOD.ctrl)
    await key('Backspace')
    await typeText(cdp, text)
    await sleep(240)
  }
  const command = async (text) => {
    await put(text)
    if (await cdp.evaluate(`!!${query(menu)}`)) await key('Escape')
    await key('Enter')
  }
  const step = async (label, action) => {
    try { await action(); check(label, true) }
    catch (error) { check(label, false, error.message) }
  }
  await newSession(box.project)
  await turn('SlashSurfaceMarker')
  const original = await readPath()
  const originalId = await state('s.session.sessionId')
  if (!original || !original.startsWith(box.sessionsDir)) throw Error('需要本轮隔离会话')
  const file = join(box.project, 'slash fixture.jsonl')

  await step('菜单只有一处溢出滚动，键盘可走到末项', async () => {
    await put('/')
    await wait(`!!${query(menu)}`)
    const overflow = await cdp.evaluate(`[...${query(menu)}.querySelectorAll('*')].filter(e => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).map(e => e.className)`)
    if (overflow.length !== 1 || !overflow[0].includes('scroll-area__viewport')) throw Error(JSON.stringify(overflow))
    const count = await cdp.evaluate(`document.querySelectorAll('${menu} [role=option]').length`)
    for (let i = 1; i < count; i++) await key('ArrowDown')
    await wait(`(() => { const options = document.querySelectorAll('${menu} [role=option]'); const active = ${query(input)}.getAttribute('aria-activedescendant'); return options[options.length - 1]?.id === active && ${query(`${menu} [data-slot="scroll-area-viewport"]`)}.scrollTop > 0 })()` )
    await shot('slash-one-scrollbar')
    await key('Escape')
  })
  await step('/session 显示分行详情和完整文件路径，Esc 关闭', async () => {
    await command('/name SlashSurfaceName')
    await command('/session')
    const dialog = query(testId('native-session-info'))
    await wait(`${dialog}?.querySelectorAll('dt').length === 7 && ${dialog}.innerText.includes(${JSON.stringify(original)}) && ${dialog}.innerText.includes('SlashSurfaceName') && ${dialog}.innerText.includes(${JSON.stringify(originalId)})`)
    await shot('session-info')
    await key('Escape')
    await wait(`!${visible('native-session-info')}`)
  })
  await step('/llama 不进菜单，手输给终端说明而非模型消息', async () => {
    const n = fake.requests.length
    await put('/llama')
    if (await cdp.evaluate(`((${query(menu)})?.innerText ?? '').includes('Manage llama.cpp router models')`)) throw Error('仍展示扩展')
    if (await cdp.evaluate(`!!${query(menu)}`)) await key('Escape')
    await key('Enter')
    await wait(`document.body.innerText.includes('模型路由管理仅在')`)
    if (fake.requests.length !== n) throw Error('命令发送给了模型')
  })
  const cancel = async (name, title, parent) => {
    const scope = parent ? `${testId(parent)} ` : ''
    const card = query(`${scope}${testId('v3-question')}`)
    await wait(`${card}?.innerText.includes(${JSON.stringify(title)})`)
    const controls = await cdp.evaluate(`({ forbidden: ${card}.querySelectorAll('input,[data-testid="v3-question-submit"],[data-testid="v3-question-skip"]').length, options: [...${card}.querySelectorAll('.v3-qoption-row')].map(e=>e.innerText.trim()), total: document.querySelectorAll('[data-testid="v3-question"]').length })`)
    if (controls.forbidden || controls.total !== 1 || controls.options.length !== 2 || !['取消', 'Cancel'].includes(controls.options[1])) throw Error(JSON.stringify(controls))
    await shot(name)
    await click(cdp, `${scope}${testId('v3-question-option-1')}`)
    await wait(`!${visible('v3-question')}`)
  }
  await step('/share 只有明确选项且可取消', async () => {
    await command('/share')
    await cancel('share-cancel', 'GitHub gist')
    if (await readPath() !== original) throw Error('取消后切换了会话')
  })
  await step('/export 覆盖只能点选，取消保持原文件', async () => {
    await command(`/export "${file}"`)
    for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100)
    const before = readFileSync(file, 'utf8')
    if (!before.includes('SlashSurfaceMarker')) throw Error('导出缺少合成消息')
    await command(`/export "${file}"`)
    await cancel('export-cancel', '覆盖导出文件')
    if (readFileSync(file, 'utf8') !== before) throw Error('取消后文件发生改变')
  })
  await step('/export HTML 落盘且保留合成会话正文', async () => {
    const htmlPath = join(box.project, 'slash fixture.html')
    await command(`/export "${htmlPath}"`)
    for (let i = 0; i < 50 && !existsSync(htmlPath); i++) await sleep(100)
    const html = readFileSync(htmlPath, 'utf8')
    const data = /<script\b[^>]*\bid="session-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
    if (!data || !Buffer.from(data.trim(), 'base64').toString('utf8').includes('SlashSurfaceMarker')) throw Error('HTML 载荷缺少合成会话正文')
    if (await readPath() !== original) throw Error('HTML 导出切换了当前会话')
  })
  await step('/trust 确认在模态内且可取消', async () => {
    await command('/trust')
    await wait(visible('native-trust-state'))
    const before = await cdp.evaluate(`${query(testId('native-trust-state'))}.innerText`)
    await click(cdp, testId('native-trust-save'))
    await cancel('trust-cancel', '信任', 'native-surface-trust')
    await wait(`${query(testId('native-trust-state'))}?.innerText === ${JSON.stringify(before)}`)
    await key('Escape')
    await wait(`!${visible('native-surface-trust')}`)
  })
  await step('/import 切到独立文件且保留消息', async () => {
    await command(`/import "${file}"`)
    await wait(`!!(s.peekedPath ?? s.session?.sessionFile) && (s.peekedPath ?? s.session?.sessionFile) !== ${JSON.stringify(original)} && !s.switchLoading && s.messages.some(m => JSON.stringify(m).includes('SlashSurfaceMarker'))`)
    const imported = await readPath()
    if (imported === file || !readFileSync(imported, 'utf8').includes('SlashSurfaceMarker')) throw Error('未切到导入副本')
  })
  await step('/clone 切到新文件且接着可以发送', async () => {
    const before = await readPath()
    await command('/clone')
    await wait(`!!(s.peekedPath ?? s.session?.sessionFile) && (s.peekedPath ?? s.session?.sessionFile) !== ${JSON.stringify(before)} && !s.switchLoading && s.messages.some(m => JSON.stringify(m).includes('SlashSurfaceMarker'))`)
    const clone = await readPath()
    if (clone === original || clone === file || !readFileSync(clone, 'utf8').includes('SlashSurfaceMarker')) throw Error('未切到复制副本')
    await put('CloneFollowupMarker')
    await key('Enter')
    await wait('s.messages.some(m => JSON.stringify(m).includes("CloneFollowupMarker"))')
    await wait('!s.session?.isAgentRunning && !s.session?.isStreaming')
    if (await readPath() !== clone) throw Error('发送跑到别的会话')
  })
  await step('普通 Agent 单选仍能自填', async () => {
    await put('QUESTION')
    await key('Enter')
    await wait(visible('v3-question-option-0'))
    await shot('ordinary-select')
    await put('OrdinaryCustomAnswer')
    await key('Enter')
    await wait(`!${visible('v3-question')} && s.messages.some(m => (m.toolCalls ?? []).some(c => c.name === 'question' && JSON.stringify(c.output).includes('OrdinaryCustomAnswer'))) && !s.messages.some(m => m.role === 'user' && JSON.stringify(m).includes('OrdinaryCustomAnswer'))`)
  })
}
