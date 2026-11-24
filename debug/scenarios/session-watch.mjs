import { freePort } from '../lib/env.mjs'

export const meta = { description: '会话旁观：在会话菜单里共享，经命令面板用邀请加入，右栏只读窗格实时跟随流式输出，停止共享后显示已结束；深浅主题截图' }

export default async function run({ cdp, check, waitFor, turn, sleep, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const cc = (method, params) => cdp.call(method, params)
  const MOD_CTRL = 2
  const press = async (key, code, vk, modifiers = 0) => {
    await cc('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers })
    await cc('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
  }
  const click = async (selector) => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 10000)
    await ev(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await sleep(300)
  }

  await cc('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await waitFor('s.conn === "ready"', 60000)
  await turn('你好，先打个招呼')
  await waitFor(`s.messages.some((m) => m.role === 'assistant' && (m.text ?? '').trim())`, 20000)

  const port = await freePort()
  const status = await ev(`window.yan.remote.configure({ enabled: true, bind: 'loopback', port: ${port} })`)
  check('远程服务在本机回环地址启动', !!status?.running, { running: status?.running, error: status?.error })

  const sessionFile = await ev(`window.__yanStore.getState().session?.sessionFile`)
  await waitFor(`!!document.querySelector('[data-session-path]')`, 10000)
  await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-session-path]')]
    const row = rows.find((el) => el.getAttribute('data-session-path') === ${JSON.stringify(sessionFile)}) ?? rows[0]
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="v3-session-menu"] [data-key="share"]')`, 5000)
  await shot('session-watch-menu')
  await ev(`document.querySelector('[data-testid="v3-session-menu"] [data-key="share"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="watch-share-dialog"]')`, 5000)
  await sleep(300)
  await shot('session-watch-share-before')
  await click('[data-testid="watch-share-start"]')
  await waitFor(`!!document.querySelector('[data-testid="watch-share-invite"] textarea')?.value`, 10000)
  const invite = await ev(`document.querySelector('[data-testid="watch-share-invite"] textarea').value`)
  check('生成邀请', typeof invite === 'string' && invite.startsWith('inkstone-watch:'), invite?.slice(0, 40))
  await shot('session-watch-share-invite')
  await press('Escape', 'Escape', 27)
  await sleep(400)

  await press('k', 'KeyK', 75, MOD_CTRL)
  await waitFor(`!!document.querySelector('[data-testid="v3-command-input"]')`, 5000)
  await cc('Input.insertText', { text: '加入共享会话' })
  await sleep(400)
  await press('Enter', 'Enter', 13)
  await waitFor(`!!document.querySelector('[data-testid="watch-join-dialog"]')`, 5000)
  await ev(`document.querySelector('[data-testid="watch-join-input"] textarea').focus()`)
  await cc('Input.insertText', { text: invite })
  await sleep(200)
  await shot('session-watch-join')
  await click('[data-testid="watch-join-submit"]')
  await waitFor(`!!document.querySelector('[data-testid="watch-pane"]')`, 20000)
  await waitFor(`document.querySelector('[data-testid="watch-pane-status"]')?.textContent === '实时'`, 20000)
  await waitFor(`document.querySelectorAll('[data-testid="watch-pane-stream"] .v3-stream-row').length >= 2`, 10000)
  check('旁观窗格显示已有消息', true)
  const viewers = await ev(`window.yan.sessionShare.get(window.__yanStore.getState().session.sessionId).then((v) => v?.viewers.length ?? 0)`)
  check('主机名单里出现旁观者', viewers === 1, viewers)

  const sent = ev(`window.__yanStore.getState().send('LONGTEXT 给我一份长文')`)
  await waitFor(`!!(s.session?.isStreaming || s.session?.isAgentRunning)`, 15000)
  const before = await ev(`(document.querySelector('[data-testid="watch-pane-stream"]')?.textContent ?? '').length`)
  await waitFor(`(document.querySelector('[data-testid="watch-pane-stream"]')?.textContent ?? '').length > ${before} + 400`, 20000)
  await shot('session-watch-streaming')
  const midStream = await ev(`(() => {
    const host = window.__yanStore.getState()
    const text = host.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
    const pane = (document.querySelector('[data-testid="watch-pane-stream"]')?.textContent ?? '').replace(/\\s+/g, '')
    const probe = text.replace(/[\\s*_#>|\`-]+/g, '').slice(0, 12)
    return { running: !!(host.session?.isStreaming || host.session?.isAgentRunning), hostChars: text.length, paneHasHead: pane.includes(probe) }
  })()`)
  check('主机还在输出时旁观窗格已经同步出字', midStream.running && midStream.paneHasHead, midStream)
  await sleep(1500)
  const later = await ev(`({ running: !!(window.__yanStore.getState().session?.isStreaming || window.__yanStore.getState().session?.isAgentRunning), pane: (document.querySelector('[data-testid="watch-pane-stream"]')?.textContent ?? '').length })`)
  log('流式中窗格长度', later)
  await sent
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning)`, 120000)
  await sleep(1500)
  const compare = await ev(`(() => {
    const host = window.__yanStore.getState().messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
    const pane = document.querySelector('[data-testid="watch-pane-stream"]')
    const rows = pane ? pane.querySelectorAll('.v3-stream-row').length : 0
    const tail = host.replace(/[\\s*_#>|\`-]+/g, '').slice(-30)
    const paneText = (pane?.textContent ?? '').replace(/[\\s*_#>|\`-]+/g, '')
    return { rows, tail, contains: paneText.includes(tail) }
  })()`)
  check('结束后旁观窗格与主机最后一段一致', compare.contains && compare.rows >= 4, compare)
  await shot('session-watch-done-dark')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(600)
  await shot('session-watch-done-light')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(400)

  await ev(`window.yan.sessionShare.stop(window.__yanStore.getState().session.sessionId)`)
  await waitFor(`!!document.querySelector('[data-testid="watch-pane-ended"]')`, 10000)
  const ended = await ev(`document.querySelector('[data-testid="watch-pane-ended"]').textContent`)
  check('停止共享后旁观窗格显示已结束', /停止共享/.test(ended), ended)
  await shot('session-watch-ended')
  await click('[data-testid="watch-pane-leave"]')
  await waitFor(`!document.querySelector('[data-testid="watch-pane"]')`, 5000)
  check('退出旁观后窗格关闭', true)
  log('done')
}
