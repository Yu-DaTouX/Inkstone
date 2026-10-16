;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  const waitFor = async (fn, ms = 12000, step = 150) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const v = await fn()
        if (v) return v
      } catch {
      }
      await sleep(step)
    }
    return null
  }
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

  const list = await waitFor(async () => {
    const all = (await window.yan.listSessions()) ?? []
    const opened = all.find((s) => String(s.id ?? '').includes('yan-n05-opened'))
    const hot = all.find((s) => String(s.id ?? '').includes('yan-n05-hot'))
    return opened && hot ? { opened, hot } : null
  }, 20000, 300)
  if (!ok(!!list, '会话列表里有 09-S3 那一对 fixture 会话（opened / hot）')) return early(out.join('\n'))
  const { opened, hot } = list
  out.push(`  opened=${opened.id}（活动 ${opened.lastActivityAt}，打开 ${opened.lastOpenedAt ?? '无'}）`)
  out.push(`  hot=${hot.id}（活动 ${hot.lastActivityAt}，打开 ${hot.lastOpenedAt ?? '无'}）`)
  out.push(`  projectopened.sessionId=${opened.id}`)
  out.push(`  projectopened.file=${opened.path}`)

  ok(
    (hot.lastActivityAt ?? 0) > (opened.lastActivityAt ?? 0),
    '前提成立：hot 的消息时间比 opened 新（所以这条断言不是在验“谁更新”）',
    `${hot.lastActivityAt} > ${opened.lastActivityAt}`
  )
  ok(!hot.lastOpenedAt, 'hot 从没在砚里被打开过（没有 lastOpenedAt）', String(hot.lastOpenedAt ?? '无'))

  await store.getState().switchSession(opened.path)
  const recorded = await waitFor(async () => {
    const all = (await window.yan.listSessions()) ?? []
    const now = all.find((s) => s.id === opened.id)
    return now?.lastOpenedAt ? now : null
  }, 20000, 300)
  ok(!!recorded, '打开之后主进程回读里出现了 lastOpenedAt（真的记了这次打开）', String(recorded?.lastOpenedAt ?? '无'))
  if (recorded) {
    ok(
      (recorded.lastOpenedAt ?? 0) > (opened.lastActivityAt ?? 0),
      '打开时间晚于那条旧消息（是这次打开写的，不是旧数据）',
      `${recorded.lastOpenedAt} > ${opened.lastActivityAt}`
    )
  }
  const onIt = await waitFor(() => {
    const cur = store.getState().session
    return cur && (norm(cur.sessionFile) === norm(opened.path) || cur.sessionId === opened.id) ? cur : null
  }, 15000, 200)
  ok(!!onIt, '视图真的切到了 opened', String(onIt?.sessionFile ?? onIt?.sessionId ?? ''))

  const cwd = opened.cwd
  const projectId = opened.projectId
  const mine = store.getState().runners ?? []
  for (const r of mine) await window.yan.stopRunner(r.id).catch(() => undefined)
  await store.getState().syncRunners()
  const gone = await waitFor(
    () => ((store.getState().runners ?? []).length > 0 ? null : true),
    15000,
    250
  )
  ok(!!gone, '所有运行实例都停下了（这才轮到 lastOpenedAt 说话）', `停了 ${mine.length} 个`)
  out.push(`  停机后 runners=${(store.getState().runners ?? []).length}`)

  await store.getState().refreshSessions()
  const freshOpened = (store.getState().sessions ?? []).find((s) => s.id === opened.id)
  ok(
    !!freshOpened?.lastOpenedAt,
    '决策输入里真的带着 lastOpenedAt（不是读的旧快照）',
    String(freshOpened?.lastOpenedAt ?? '无')
  )
  const picked = store.getState().pickProjectSession(cwd, projectId)
  const seen = (store.getState().sessions ?? [])
    .filter((s) => String(s.id ?? '').includes('yan-n05'))
    .map((s) => `${s.id.slice(-8)}:act=${s.lastActivityAt ?? '-'}:open=${s.lastOpenedAt ?? '-'}`)
  out.push(`  决策输入：runners=${(store.getState().runners ?? []).length}｜sessions=${seen.join(' ')}`)
  ok(
    norm(picked) === norm(opened.path),
    '没有实例时选中的是「打开过」的 opened，而不是消息更新的 hot',
    `${picked}（hot 是 ${hot.path}）`
  )
  ok(
    (store.getState().sessions ?? []).some((s) => s.id === hot.id),
    'hot 仍在候选列表里（上面的选择不是因为它缺席）'
  )

  return out.join('\n')
})()
