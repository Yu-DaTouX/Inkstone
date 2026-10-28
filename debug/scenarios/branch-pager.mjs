export const meta = { description: '编辑重发产生分支后：分页器立即出现、切走切回只显示当前分支、翻页切到另一分支' }

export default async function run({ cdp, state, until, check, log, newSession, turn, shot, sleep, box }) {
  const users = () => state(`s.messages.filter((m) => m.role === 'user').map((m) => (m.text ?? '').slice(0, 12)).join(' | ')`)
  const pagers = () => cdp.evaluate(`[...document.querySelectorAll('[data-testid=v3-branch-pager]')].map((e) => e.dataset.index + '/' + e.dataset.count)`)
  await newSession()
  await turn('第一句')
  await turn('第二句 A')
  check('实时消息带条目 id', await state(`s.messages.every((m) => !!m.entryId)`))
  const sessionId = await state('s.session.sessionId')
  const sessionFile = await state('s.session.sessionFile')
  const tree = await cdp.evaluate(`window.yan.nativeSession({ action: 'tree', expectedSessionId: ${JSON.stringify(sessionId)} })`)
  const userEntries = []
  const walk = (nodes) => { for (const node of nodes ?? []) { if (node.entry?.type === 'message' && node.entry.message?.role === 'user') userEntries.push([node.entry.id, JSON.stringify(node.entry.message.content)]); walk(node.children) } }
  walk(tree?.tree)
  const second = userEntries.find(([, text]) => text.includes('第二句'))
  await cdp.evaluate(`window.yan.nativeSession({ action: 'navigate', expectedSessionId: ${JSON.stringify(sessionId)}, entryId: ${JSON.stringify(second[0])} })`)
  await sleep(1500)
  check('回到分叉点后只剩第一句', (await users()) === '第一句', await users())
  await turn('第二句 B')
  await until(`document.querySelectorAll('[data-testid=v3-branch-pager]').length > 0`, 5000)
  check('重发后不重开会话就出现分页器', JSON.stringify(await pagers()) === '["2/2"]', await pagers())
  await shot('branch-b')
  await turn('第三句 接在 B 后')
  await newSession()
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(sessionFile)})`)
  await until(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(sessionFile)}`, 30000)
  await sleep(1500)
  check('切走切回只显示当前分支', (await users()) === '第一句 | 第二句 B | 第三句 接在 B 后', await users())
  check('切回后分页器仍在', JSON.stringify(await pagers()) === '["2/2"]', await pagers())
  const clicked = await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid=v3-branch-prev]'); if (!b) return false; b.click(); return true })()`)
  check('点到上一分支按钮', clicked)
  if (!(await until(`s.messages.some((m) => m.text === '第二句 A')`, 5000))) {
    log('翻页后分页器区域', await cdp.evaluate(`[...document.querySelectorAll('[data-testid=v3-branch-pager]')].map((e) => e.parentElement?.textContent).join(' || ')`))
    log('翻页后会话', await state('({ id: s.session?.sessionId, pending: s.pendingActivation, active: s.activeRunnerId, runners: s.runners?.map((r) => [r.id, r.sessionId, r.isActive]) })'))
    const target = userEntries.find(([, text]) => text.includes('第二句 A'))?.[0]
    log('直接 navigate', await cdp.evaluate(`window.yan.nativeSession({ action: 'navigate', expectedSessionId: ${JSON.stringify(sessionId)}, entryId: ${JSON.stringify(target)} })`))
  }
  await sleep(800)
  check('翻页后显示 A 分支且不留 B 的消息', (await users()) === '第一句 | 第二句 A', await users())
  check('翻页后分页器为 1/2', JSON.stringify(await pagers()) === '["1/2"]', await pagers())
  await shot('branch-a')
  log('project', box.project)
}
