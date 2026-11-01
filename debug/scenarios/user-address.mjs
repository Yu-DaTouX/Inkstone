import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '用户称呼：设置保存、主会话和子代理请求、改名与清空、主题与窄屏' }

export default async function run({ cdp, fake, box, check, waitFor, turn, sleep, shot }) {
  const requests = []
  fake.server.prependListener('request', (req) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const json = JSON.parse(body)
        const input = json.input ?? []
        const instructions = [json.instructions ?? '', ...input.filter((item) => item.role === 'system' || item.role === 'developer').map((item) => typeof item.content === 'string' ? item.content : (item.content ?? []).map((part) => part.text ?? '').join('\n'))].join('\n')
        requests.push({ instructions, input, tools: json.tools ?? [] })
      } catch {}
    })
  })
  const patch = (value) => cdp.evaluate(`window.__yanStore.getState().patchSettings(${JSON.stringify(value)})`)
  const inputSelector = '[data-testid="v3-session-user-address"] input'
  const enterName = async (name) => {
    await cdp.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(inputSelector)}); input.focus(); input.select() })()`)
    if (name) await cdp.call('Input.insertText', { text: name })
    else {
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
    await waitFor(`s.settings?.profile?.name === ${JSON.stringify(name)}`, 5000)
  }
  const promptFor = (marker) => requests.findLast((req) => req.tools.length > 0 && JSON.stringify(req.input).includes(marker))?.instructions ?? ''
  await patch({ theme: 'dark', lang: 'zh-CN', subagentNotify: false })
  await cdp.evaluate('window.__yanStore.getState().openSettings("session")')
  await sleep(700)
  await cdp.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).scrollIntoView({ block: 'center' })`)
  await enterName('小砚')
  const persisted = JSON.parse(readFileSync(join(box.dataDir, 'desktop.json'), 'utf8'))
  check('输入后 Enter 保存到 desktop.json', persisted.profile?.name === '小砚')
  await shot('user-address-dark')
  await cdp.evaluate('window.__yanStore.getState().closeSettings()')
  await turn('address-main-first')
  check('主会话请求包含设置称呼', promptFor('address-main-first').includes('"小砚"'))
  const started = await cdp.evaluate('window.yan.subagents.start("address-child-first", "fake/fake-model", "shared-cwd")')
  check('普通子代理已启动', started?.ok, started?.error)
  if (!started?.run?.id) throw new Error('子代理启动失败')
  const id = started.run.id
  await waitFor(`s.subagents?.some((run) => run.id === ${JSON.stringify(id)} && run.status === 'done')`, 20000)
  check('普通子代理请求包含同一称呼', promptFor('address-child-first').includes('"小砚"'))
  await patch({ profile: { ...persisted.profile, name: 'Alice' } })
  await turn('address-main-renamed')
  check('现有主会话下一轮使用新名且移除旧名', promptFor('address-main-renamed').includes('"Alice"') && !promptFor('address-main-renamed').includes('"小砚"'))
  const sent = await cdp.evaluate(`window.yan.subagents.send(${JSON.stringify(id)}, "address-child-renamed")`)
  check('子代理可续派', sent?.ok, sent?.error)
  await waitFor(`s.subagents?.some((run) => run.id === ${JSON.stringify(id)} && run.status === 'done' && run.transcript.some((msg) => msg.role === 'user' && msg.text.includes('address-child-renamed')))`, 20000)
  check('已有子代理续派读取新称呼', promptFor('address-child-renamed').includes('"Alice"') && !promptFor('address-child-renamed').includes('"小砚"'))
  await cdp.evaluate('window.__yanStore.getState().openSettings("session")')
  await sleep(500)
  await cdp.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).scrollIntoView({ block: 'center' })`)
  await enterName('')
  await cdp.evaluate('window.__yanStore.getState().closeSettings()')
  await turn('address-main-cleared')
  check('清空后主会话不再注入称呼', !promptFor('address-main-cleared').includes('preferred form of address'))
  await cdp.evaluate(`window.yan.subagents.send(${JSON.stringify(id)}, "address-child-cleared")`)
  await waitFor(`s.subagents?.some((run) => run.id === ${JSON.stringify(id)} && run.status === 'done' && run.transcript.some((msg) => msg.role === 'user' && msg.text.includes('address-child-cleared')))`, 20000)
  check('清空后子代理也不再注入称呼', !promptFor('address-child-cleared').includes('preferred form of address'))
  await patch({ theme: 'light', lang: 'en-US', profile: { ...persisted.profile, name: 'Alice' } })
  await cdp.evaluate('window.__yanStore.getState().openSettings("session")')
  await sleep(600)
  await cdp.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).scrollIntoView({ block: 'center' })`)
  await shot('user-address-light-english')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 780, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  await cdp.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).scrollIntoView({ block: 'center' })`)
  const fits = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(inputSelector)}); const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.value === 'Alice' })()`)
  check('780px 窄屏输入框可读可用', fits)
  await shot('user-address-narrow-english')
  await cdp.call('Emulation.clearDeviceMetricsOverride')
}
