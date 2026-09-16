/**
 * 切换会话会不会把历史弄丢（用户报：「切换会话的时候会话历史会丢失」）。
 *
 * 判据不是「屏幕上有没有消息」，而是**文件里的历史与切过去之后应用手里的历史是否一致**：
 *   ① 先在左栏挑一条**历史最长**的会话，用 peekSession 读它（和切换时铺内容同一条路径）
 *      记下条数与**第一条消息的文本**；
 *   ② 点它 → 等 pi 切完推来的权威 `sync` 落定；
 *   ③ 再对一次：条数与第一条消息还在不在。
 * 如果 ② 之后少了，用户看到的就是「切过去历史没了」—— 而且这条会话在磁盘上仍然是全的，
 * 所以切走再切回会「又出现一下再消失」。
 *
 * 第二位覆盖现实路径：**切界面语言会重建 pi 实例**（restartAgent），
 * 重建之后实例注册表与「新会话」都换了一茬，再切会话最容易出问题。
 *
 * 不花 token：不跑回合，只切换与观察。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  if (!store) return '✗ 拿不到 window.__yanStore'

  const until = async (fn, ms = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(150)
    }
    return fn()
  }
  const pathOf = (el) => el?.closest('.srow-wrap')?.getAttribute('data-session-path') ?? ''
  const msgCount = () => qa('.msg').length
  const stateNow = () => store.getState()
  const primary = () => {
    const rs = stateNow().runners ?? []
    return rs.find((r) => r.active) ?? rs[0]
  }
  const instanceKey = (r) => (r ? `${r.runId}@${r.createdAt}` : 'none')
  /** 取第一条「能看出内容」的消息文本，用来判断历史头部是否还在 */
  const headText = (messages) =>
    String(messages.find((m) => m.role === 'user' && m.text)?.text ?? messages.find((m) => m.text)?.text ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 40)
  const sameHead = (a, b) => !!a && !!b && (a === b || a.startsWith(b.slice(0, 20)) || b.startsWith(a.slice(0, 20)))

  for (let i = 0; i < 60; i++) {
    if (stateNow().conn === 'ready') break
    await sleep(500)
  }
  log(`  conn=${stateNow().conn}`)
  stateNow().setRailPinned(true)
  await until(() => !q('.app')?.classList.contains('rail-off'), 5000)
  const rows = qa('.rail .srow')
  if (rows.length < 2) return out.join('\n') + '\n  ⤺ 跳过：左栏会话不足 2 条'

  /* ---------------- 0. 挑一条历史最长的会话 ---------------- */
  let target = null
  let targetPeek = null
  for (const row of rows) {
    const path = pathOf(row)
    if (!path) continue
    const peek = await window.yan.peekSession(path).catch(() => null)
    if (!peek?.messages?.length) continue
    if (!targetPeek || peek.messages.length > targetPeek.messages.length) {
      target = row
      targetPeek = peek
    }
  }
  if (!target || !targetPeek) return out.join('\n') + '\n  ⤺ 跳过：没有带历史的会话'
  const path = pathOf(target)
  const fileHead = headText(targetPeek.messages)
  const fileCount = targetPeek.messages.length
  log(`  目标会话：${JSON.stringify((target.querySelector('.srow-name')?.textContent ?? '').slice(0, 30))}`)
  log(`  文件历史：${fileCount} 条｜首条 ${JSON.stringify(fileHead)}`)
  log(`  path=${path}`)

  /* ---------------- 1. 切过去：文件历史必须原样搬进视图 ---------------- */
  log('\n=== 1. 切过去之后：应用手里的历史 vs 文件里的历史 ===')
  /* 先单测一次 peek 的耗时与条数：它不应该退化成「读不出来只能等 pi」 */
  const t0 = Date.now()
  const peekDirect = await window.yan.peekSession(path).catch(() => null)
  log(`  peekSession 直调：${Date.now() - t0}ms，${peekDirect?.messages?.length ?? 0} 条`)
  /*
   * 身份对得上吗？渲染端的 sync 守卫用 `runtime.sessionId` 与 peek 的
   * `sessionId` 比对，两边如果不是同一个字符串，守卫就会误删好 sync。
   */
  log(`  文件里的 sessionId = ${peekDirect?.sessionId ?? 'null'}`)
  log(`  当前 state.sessionId = ${stateNow().session?.sessionId ?? 'null'}`)
  ok((peekDirect?.messages?.length ?? 0) > 0, 'peekSession 能直接读出文件内容', `${peekDirect?.messages?.length ?? 0} 条`)
  click(target)
  /*
   * 盯住这一次点击后的每一次 messages 变化。
   *
   * 为什么要看全程而不是只看 5 秒后的结果：用户报的「历史丢失」有两种形态 ——
   *   ① 铺上后又被清掉/换掉（闪一下又没了）；
   *   ② 切过去就只有压缩后的那一截。
   * 只看末态只能抓到 ②，所以这里把「曾经降到 0」当成失败。
   */
  const trans = []
  let dipped = false
  const unsub = store.subscribe((s, p) => {
    if (s.messages !== p.messages && s.messages.length !== p.messages.length) {
      if (p.messages.length > 0 && s.messages.length === 0) dipped = true
      trans.push(`messages ${p.messages.length}→${s.messages.length} peeked=${s.peekedPath ? 'yes' : 'no'}`)
    }
  })
  const peeked = await until(
    () => stateNow().peekedPath === path || stateNow().messages.length >= fileCount * 0.9,
    15000
  )
  ok(peeked || stateNow().messages.length > 0, '点开后有内容', `nodes=${msgCount()} messages=${stateNow().messages.length}`)
  const afterPeek = stateNow().messages.length
  log(`  peek 后 messages=${afterPeek}（文件 ${fileCount}）`)
  await sleep(4000)
  unsub()
  for (const line of trans.slice(0, 12)) log('    · ' + line)
  ok(!dipped, '铺上内容之后没被打回 0（不闪空白）', `${trans.length} 次变化`)
  /* 等 pi 的权威 sync 落定（peekedPath 被清掉就是收到 sync 了） */
  const settled = await until(() => stateNow().peekedPath === null, 20000)
  await sleep(2500)
  const after = stateNow().messages.length
  const headAfter = headText(stateNow().messages)
  log(`  sync 落定后 messages=${after}（文件 ${fileCount}）｜首条 ${JSON.stringify(headAfter)}`)
  ok(settled, 'pi 的权威 sync 已到达（peekedPath 已清）')
  ok(
    sameHead(headAfter, fileHead),
    '历史**开头**还在（没有被压掉/换成别的会话）',
    `文件 ${JSON.stringify(fileHead)} vs 现在 ${JSON.stringify(headAfter)}`
  )
  ok(
    after >= fileCount * 0.9,
    '历史条数没有大幅缩水',
    `${after}/${fileCount}`
  )

  /* ---------------- 2. 切走再切回来 ---------------- */
  log('\n=== 2. 切走再切回：仍然一致 ===')
  const other = rows.find((r) => r !== target && pathOf(r) && pathOf(r) !== path)
  if (other) {
    click(other)
    await until(() => msgCount() > 0 || stateNow().messages.length === 0, 10000)
    await until(() => stateNow().peekedPath === null, 15000)
    await sleep(1500)
    log(`  切到别的会话后 messages=${stateNow().messages.length}`)
  }
  click(target)
  await until(() => stateNow().peekedPath === null || stateNow().messages.length >= fileCount * 0.9, 15000)
  await sleep(2500)
  const backCount = stateNow().messages.length
  const backHead = headText(stateNow().messages)
  log(`  切回后 messages=${backCount}（文件 ${fileCount}）｜首条 ${JSON.stringify(backHead)}`)
  ok(sameHead(backHead, fileHead), '切回来历史开头仍在', JSON.stringify(backHead))
  ok(backCount >= fileCount * 0.9, '切回来条数没有缩水', `${backCount}/${fileCount}`)

  /* ---------------- 3. 切语言：不重建实例、不丢历史、下一轮生效 ---------------- */
  log('\n=== 3. 切界面语言：不重建实例、不丢历史 ===')
  const langBefore = stateNow().settings?.lang
  const instBefore = primary()
  const msgsBefore = stateNow().messages.length
  log(`  切语言前：实例 ${instanceKey(instBefore)}｜messages ${msgsBefore}｜lang=${langBefore}`)
  await stateNow().patchSettings({ lang: langBefore === 'zh-CN' ? 'en-US' : 'zh-CN' })
  await sleep(6000)
  /*
   * 这里断言**没有重建**：语言要求改由内置扩展每轮读设置注入，
   * 所以切语言不该动任何 pi 实例。
   * （早期实现是 restartAgent 重建：会抢掉后台会话，还会让界面短暂
   *   停在一条空会话上，用户看到的就是「切完语言历史没了」，D37。）
   */
  ok(
    primary()?.createdAt === instBefore?.createdAt,
    '切语言没有重建 pi 实例（下一轮生效，不打断任何会话）',
    `${instanceKey(instBefore)} → ${instanceKey(primary())}`
  )
  ok(primary()?.conn === 'ready' && stateNow().conn === 'ready', '切语言后连接仍是 ready')
  ok(stateNow().messages.length === msgsBefore, '切语言没有丢当前会话的消息', `${stateNow().messages.length}/${msgsBefore}`)
  ok(
    stateNow().settings?.lang === (langBefore === 'zh-CN' ? 'en-US' : 'zh-CN'),
    '设置里的语言已落盘',
    String(stateNow().settings?.lang)
  )

  click(other ?? target)
  await until(() => stateNow().peekedPath === null, 20000)
  await sleep(2000)
  log(`  切语言后切到别的会话 messages=${stateNow().messages.length}`)
  click(target)
  await until(() => stateNow().peekedPath === null, 20000)
  await sleep(2500)
  const rebuiltCount = stateNow().messages.length
  const rebuiltHead = headText(stateNow().messages)
  log(`  切语言后切回目标 messages=${rebuiltCount}（文件 ${fileCount}）｜首条 ${JSON.stringify(rebuiltHead)}`)
  ok(sameHead(rebuiltHead, fileHead), '切语言后切回来历史开头仍在', JSON.stringify(rebuiltHead))
  ok(rebuiltCount >= fileCount * 0.9, '切语言后条数没有缩水', `${rebuiltCount}/${fileCount}`)

  /* 收尾：语言恢复 */
  if (stateNow().settings?.lang !== langBefore) {
    await stateNow().patchSettings({ lang: langBefore })
    await until(() => stateNow().settings?.lang === langBefore, 15000)
    log(`\n  收尾：语言恢复 ${langBefore}`)
  }
  return out.join('\n')
})()
