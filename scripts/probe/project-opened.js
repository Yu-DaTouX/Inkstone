/**
 * 「每个项目最后一个会话」的恢复判断（实施-09 S3）—— cost 0，不调模型。
 *
 * ── 这一片要证明什么 ──
 * 口径是「**不新增第二份真源**：会话文件是唯一真源，`lastOpenedAt` 只解决
 * 恢复哪一个的问题」。所以这里不验界面长什么样，而是验三件事：
 *
 *   ① **前提**：「活跃」与「打开过」在这个 fixture 里真的是两回事 ——
 *      `hot` 的消息时间比 `opened` 新，只按活动时间排一定会选错；
 *   ② **记录**：真的打开 `opened` 之后，主进程回读的会话列表里
 *      `opened.lastOpenedAt` 有值、`hot` 没有（或更旧）；
 *   ③ **决策**：把 `opened` 的实例停掉（模拟应用重启 / 实例回收 ——
 *      这是 `lastOpenedAt` 真正起作用的场合）后，`pickProjectSession`
 *      仍然选 `opened`，而不是消息更新的 `hot`。
 *
 * 退出后还有一个 Node 侧检查：读 `session-layout.json` 确认那条记录真的落盘。
 */
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
        /* 还没就绪 */
      }
      await sleep(step)
    }
    return null
  }
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

  /* ── 0. 找到那两条 fixture 会话 ───────────────────────── */
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

  /* ── ① 前提：只按活动时间排会选错 ─────────────────────── */
  ok(
    (hot.lastActivityAt ?? 0) > (opened.lastActivityAt ?? 0),
    '前提成立：hot 的消息时间比 opened 新（所以这条断言不是在验“谁更新”）',
    `${hot.lastActivityAt} > ${opened.lastActivityAt}`
  )
  ok(!hot.lastOpenedAt, 'hot 从没在砚里被打开过（没有 lastOpenedAt）', String(hot.lastOpenedAt ?? '无'))

  /* ── ② 真的打开 opened，主进程应记下这次打开 ─────────── */
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
  /* 界面确实停在它上面（不是只写了一条记录却没真的切过去） */
  const onIt = await waitFor(() => {
    const cur = store.getState().session
    return cur && (norm(cur.sessionFile) === norm(opened.path) || cur.sessionId === opened.id) ? cur : null
  }, 15000, 200)
  ok(!!onIt, '视图真的切到了 opened', String(onIt?.sessionFile ?? onIt?.sessionId ?? ''))

  /* ── ③ 停掉实例（= 重启 / 回收），决策仍应选 opened ─── */
  /*
   * 停掉**所有**运行实例（不只是同 cwd 的）。
   *
   * 为什么要全停：`pickProjectSession` 的实例分支只要求「有 sessionFile +
   * cwd 命中」，**不要求 `running`** —— 同 cwd 少一个实例就少一次命中，
   * 而实例的 cwd 可能不是 `opened.cwd`（新建会话可以落在项目根）。
   * 第一版只停同 cwd 的，结果一个都没停到（`mine.length = 0`），断言其实一直在
   * 验实例分支；反向验证（把排序改回纯活动时间）仍然绿 —— 才发现这一点。
   */
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

  /*
   * 决策前必须拉新列表：`switchProject` 自己会先 `refreshSessions()`（见 Rail），
   * 而探针直接调 store action —— 不刷新的话验的是**旧快照**（里面没有 lastOpenedAt）。
   * 反向验证（改回纯活动时间排序）当时因为这一点继续变绿，白跑了一轮。
   */
  await store.getState().refreshSessions()
  const freshOpened = (store.getState().sessions ?? []).find((s) => s.id === opened.id)
  ok(
    !!freshOpened?.lastOpenedAt,
    '决策输入里真的带着 lastOpenedAt（不是读的旧快照）',
    String(freshOpened?.lastOpenedAt ?? '无')
  )
  const picked = store.getState().pickProjectSession(cwd, projectId)
  /*
   * 诊断：把**决策时真正看到的输入**打印出来。
   * 反向验证时曾经出现过「改了排序仍然绿」——当时就是因为没有这行，看不出
   * 决策到底走的是哪条分支、排序键又是什么值。
   */
  const seen = (store.getState().sessions ?? [])
    .filter((s) => String(s.id ?? '').includes('yan-n05'))
    .map((s) => `${s.id.slice(-8)}:act=${s.lastActivityAt ?? '-'}:open=${s.lastOpenedAt ?? '-'}`)
  out.push(`  决策输入：runners=${(store.getState().runners ?? []).length}｜sessions=${seen.join(' ')}`)
  ok(
    norm(picked) === norm(opened.path),
    '没有实例时选中的是「打开过」的 opened，而不是消息更新的 hot',
    `${picked}（hot 是 ${hot.path}）`
  )
  /* 反向对照：确认 hot 真的在候选里（否则上面的断言可能只是“列表里只有它”） */
  ok(
    (store.getState().sessions ?? []).some((s) => s.id === hot.id),
    'hot 仍在候选列表里（上面的选择不是因为它缺席）'
  )

  return out.join('\n')
})()
