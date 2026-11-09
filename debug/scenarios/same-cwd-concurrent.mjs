export const meta = { description: '同一目录里两个已打开的会话可以同时运行：第一个在流式输出时，第二个发送不会被拒绝，并改用 Inkstone/ 开头的隔离分支；不调用真实模型' }

export default async function run({ cdp, check, waitFor, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', permissionMode: 'all' })`)

  await ev(`window.__yanStore.getState().send('先开第一个会话')`)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning) && s.messages.length >= 2`, 60000, 100)
  const firstFile = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)
  await ev(`window.__yanStore.getState().newSession()`)
  await sleep(1500)
  await ev(`window.__yanStore.getState().send('再开第二个会话')`)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning) && s.messages.length >= 2`, 60000, 100)
  const secondFile = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)
  check('两个会话是不同的文件', !!firstFile && !!secondFile && firstFile !== secondFile)

  await ev(`window.__yanStore.getState().send('MDCODE 让它一直输出')`)
  await waitFor(`s.session?.isStreaming || s.session?.isAgentRunning`, 20000, 50)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(firstFile)})`)
  await sleep(1500)
  const before = await ev(`window.__yanStore.getState().messages.length`)
  await ev(`window.__yanStore.getState().send('第一个会话在对方运行时发送')`)
  await sleep(2500)
  const after = await ev(`window.__yanStore.getState().messages.length`)
  const toasts = await ev(`JSON.stringify(document.body.innerText.match(/同一工作目录还有另一个会话[^\\n]*/g) ?? [])`)
  const branch = await ev(`document.body.innerText.match(/Inkstone\\/\\d{8}-\\d+/)?.[0] ?? ''`)
  check('没有出现“同一工作目录还有另一个会话正在运行”', toasts === '[]', toasts)
  check('第一个会话的消息真的发出去了', after > before, `${before} -> ${after}`)
  check('隔离分支以 Inkstone/ 开头', branch.startsWith('Inkstone/'), branch)
  await shot('same-cwd-concurrent')
}
