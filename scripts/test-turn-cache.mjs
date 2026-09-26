/**
 * 轮次缓存纯逻辑（`src/renderer/src/state/turn-cache.ts`，实施-26 R2）的单测。
 *
 * 为什么值得单测：这一层决定「展开哪几个会话」「会话变了旧内容还能不能显示」
 * 「读失败会不会变成一张空卡」。这些在界面上都表现为「看起来正常」，
 * 只有把状态机钉住才能确定不是碰巧。
 */

const peek = (over = {}) => ({
  messages: over.messages ?? [],
  total: over.total ?? (over.messages?.length ?? 0),
  truncated: over.truncated ?? 0,
  bytes: over.bytes ?? 1024,
  ...over
})

const userMsg = (id, text, entryId) => ({ id, role: 'user', text, ...(entryId ? { entryId } : {}) })
const asstMsg = (id, text) => ({ id, role: 'assistant', text })

export async function runTurnCacheTests(ok, mod) {
  const {
    initialTurnCache,
    turnCacheBegin,
    turnCacheSettle,
    turnCacheSelect,
    snapshotFromPeek,
    loadTurnSnapshot,
    TURN_CACHE_MAX
  } = mod

  const snap = (version, turns = []) => ({ version, turns, total: turns.length, truncated: 0, bytes: 10 })

  /* ---- 首次请求 ---- */
  {
    const r = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1)
    ok(r.shouldLoad === true, '首次展开：需要真的去读')
    ok(r.state.entries['a.jsonl']?.status === 'loading', '首次展开：进入 loading')
    ok(turnCacheSelect(r.state, 'a.jsonl')?.status === 'loading', 'loading 态可以从 state 查到')
  }

  /* ---- 缓存命中：同版本已就绪不重读 ---- */
  {
    let state = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1).state
    state = turnCacheSettle(state, 'a.jsonl', 1, { ok: true, snapshot: snap(1, [{ id: 't' }]) })
    const again = turnCacheBegin(state, 'a.jsonl', 1)
    ok(again.shouldLoad === false, '同版本已就绪：命中缓存，不重读')
    ok(
      turnCacheSelect(again.state, 'a.jsonl')?.status === 'ready',
      '命中后仍是 ready（内容没被清掉）'
    )
  }

  /* ---- 同版本正在读：不重复发请求 ---- */
  {
    const first = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1)
    const second = turnCacheBegin(first.state, 'a.jsonl', 1)
    ok(second.shouldLoad === false, '同一版本已在读：不并发重复读同一个文件')
  }

  /* ---- 版本变化：旧轮次立刻不可见 ---- */
  {
    let state = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1).state
    state = turnCacheSettle(state, 'a.jsonl', 1, { ok: true, snapshot: snap(1, [{ id: 'old' }]) })
    const changed = turnCacheBegin(state, 'a.jsonl', 2)
    ok(changed.shouldLoad === true, '会话文件变了：需要重新读')
    ok(
      turnCacheSelect(changed.state, 'a.jsonl')?.status === 'loading',
      '版本变化后旧快照不再可见（不显示过期轮次）'
    )
  }

  /* ---- 空轮次是正常态，不是错误 ---- */
  {
    let state = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1).state
    state = turnCacheSettle(state, 'a.jsonl', 1, { ok: true, snapshot: snap(1, []) })
    const entry = turnCacheSelect(state, 'a.jsonl')
    ok(entry?.status === 'ready', '没有 user 消息的会话：ready 而非 error')
    ok(entry?.status === 'ready' && entry.snapshot.turns.length === 0, '空轮次快照可以正常取出')
  }

  /* ---- 读不出来：明确的 error，而不是空卡 ---- */
  {
    let state = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1).state
    state = turnCacheSettle(state, 'a.jsonl', 1, { ok: false, error: '内容不可读' })
    const entry = turnCacheSelect(state, 'a.jsonl')
    ok(entry?.status === 'error', '读失败：落到 error 态')
    ok(entry?.status === 'error' && entry.error === '内容不可读', 'error 文案可读、可展示')
  }

  /* ---- 竞态：慢结果不许覆盖新状态 ---- */
  {
    let state = turnCacheBegin(initialTurnCache(), 'a.jsonl', 1).state
    // 读还没回来，版本先变了
    state = turnCacheBegin(state, 'a.jsonl', 2).state
    // 旧请求（version 1）这时才回来
    const stale = turnCacheSettle(state, 'a.jsonl', 1, { ok: true, snapshot: snap(1, [{ id: 'stale' }]) })
    ok(stale === state, '迟到的旧版本结果被整份丢弃（state 引用不变）')
    ok(turnCacheSelect(stale, 'a.jsonl')?.status === 'loading', '丢弃后仍停在 loading，等新结果')
    const fresh = turnCacheSettle(stale, 'a.jsonl', 2, { ok: true, snapshot: snap(2, [{ id: 'fresh' }]) })
    ok(
      turnCacheSelect(fresh, 'a.jsonl')?.status === 'ready' &&
        turnCacheSelect(fresh, 'a.jsonl').snapshot.turns[0]?.id === 'fresh',
      '新版本结果正常落地'
    )
  }

  /* ---- LRU 上限：只留最近展开的 TURN_CACHE_MAX 个 ---- */
  {
    let state = initialTurnCache()
    for (const p of ['a', 'b', 'c', 'd']) {
      state = turnCacheBegin(state, p, 1).state
      state = turnCacheSettle(state, p, 1, { ok: true, snapshot: snap(1) })
    }
    const alive = Object.keys(state.entries)
    ok(alive.length === TURN_CACHE_MAX, `同时只保留 ${TURN_CACHE_MAX} 个会话的轮次`, alive.join(','))
    ok(!alive.includes('a'), '最久未用的被淘汰')
    ok(alive.includes('d'), '最近使用的保留')
  }

  /* ---- 正在读的条目不能被 LRU 淘汰（否则永远停在 loading） ---- */
  {
    let state = initialTurnCache()
    // 先把 a / b / c 读好，再让 a 重新进入 loading（版本变化）
    for (const p of ['a', 'b', 'c']) {
      state = turnCacheBegin(state, p, 1).state
      state = turnCacheSettle(state, p, 1, { ok: true, snapshot: snap(1) })
    }
    state = turnCacheBegin(state, 'a', 2).state // a 重新 loading
    state = turnCacheBegin(state, 'd', 1).state // 展开第 4 个
    state = turnCacheSettle(state, 'd', 1, { ok: true, snapshot: snap(1) })
    ok(
      turnCacheSelect(state, 'a')?.status === 'loading',
      '重新读中的会话不会被淘汰（结果还有地方落地）'
    )
    const settled = turnCacheSettle(state, 'a', 2, { ok: true, snapshot: snap(2) })
    ok(
      turnCacheSelect(settled, 'a')?.status === 'ready',
      '被保护的重读结果能正常 settle'
    )
  }

  /* ---- peekSession 结果 → 轮次快照 ---- */
  {
    const snapshot = snapshotFromPeek(7, {
      messages: [userMsg('m0', '问题', 'e1'), asstMsg('m1', '答案')],
      total: 2,
      truncated: 3,
      bytes: 999,
      sessionId: 's'
    })
    ok(snapshot.version === 7, 'snapshot 带上读取时的版本')
    ok(snapshot.turns.length === 1 && snapshot.turns[0]?.answer?.text === '答案', 'snapshot 里是切好的一轮')
    ok(snapshot.turns[0]?.question.entryId === 'e1', 'entryId 一路带到轮次（分叉锚点）')
    ok(snapshot.truncated === 3 && snapshot.bytes === 999, '截断数与字节数随快照带出（供卡片标注）')
  }

  /* ---- 读取器：正常 / 读不出来 / 抛异常 ---- */
  {
    const okOut = await loadTurnSnapshot('a.jsonl', 1, async () => peek({ messages: [userMsg('m0', 'Q', 'e')] }))
    ok(okOut.ok === true && okOut.snapshot.turns.length === 1, '读取器：正常把 peek 结果切成轮次')

    const nullOut = await loadTurnSnapshot('a.jsonl', 1, async () => null)
    ok(
      nullOut.ok === false && nullOut.error === '内容不可读',
      '读取器：peek 返回 null → 明确的「内容不可读」，不是空卡'
    )

    const errOut = await loadTurnSnapshot('a.jsonl', 1, async () => {
      throw new Error('ENOENT')
    })
    ok(errOut.ok === false && errOut.error === 'ENOENT', '读取器：异常转成可展示的错误文案')
  }
}
