export const meta = { description: '宿主续接消息（会话移动、自动续跑、额度恢复）在消息流里显示为一行短提示，不显示成用户气泡；深浅主题截图' }

export default async function run({ cdp, check, waitFor, turn, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await turn('你好')
  await waitFor(`s.messages.some((m) => m.role === 'assistant' && (m.text ?? '').trim())`, 20000)
  await ev(`(() => {
    const store = window.__yanStore
    const now = Date.now()
    const moved = '[砚宿主通知：用户批准的会话移动已完成]\\n当前工作目录（路径数据）：' + JSON.stringify('C:\\\\Users\\\\YuDaTou\\\\Desktop\\\\测试') + '\\n请核对新目录的 AGENTS.md 与项目设置……'
    const extra = [
      { id: 'host-moved', role: 'user', text: moved, timestamp: now - 3000 },
      { id: 'host-moved-a', role: 'assistant', text: '会话已经切到新目录，原任务已完成。', timestamp: now - 2900 },
      { id: 'host-loop', role: 'user', text: '[循环恢复 · 自动继续 1/1]\\n上一轮因输出重复被安全中止。', timestamp: now - 2000 },
      { id: 'host-loop-a', role: 'assistant', text: '接着做完了。', timestamp: now - 1900 },
      { id: 'host-quota', role: 'user', text: '额度已恢复，请从上一轮中断的地方继续完成任务。', timestamp: now - 1000 },
      { id: 'host-quota-a', role: 'assistant', text: '继续完成。', timestamp: now - 900 }
    ]
    store.setState({ messages: [...store.getState().messages, ...extra] })
  })()`)
  await sleep(800)
  const state = await ev(`(() => {
    const notices = [...document.querySelectorAll('[data-testid="v3-host-notice"]')].map((el) => el.textContent)
    const bubbles = [...document.querySelectorAll('.v3-msg.user')].map((el) => el.textContent)
    return { notices, leaked: bubbles.filter((t) => /砚宿主通知|自动继续|额度已恢复/.test(t)).length }
  })()`)
  check('三条宿主消息都显示为短提示', state?.notices?.length === 3, state)
  check('短提示含新目录路径', !!state?.notices?.[0]?.includes('C:\\Users\\YuDaTou\\Desktop\\测试'), state?.notices?.[0])
  check('宿主消息不进用户气泡', state?.leaked === 0, state)
  await shot('host-notice-dark')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(500)
  await shot('host-notice-light')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
}
