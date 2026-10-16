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

  log('\n=== 1. 切过去之后：应用手里的历史 vs 文件里的历史 ===')
  const t0 = Date.now()
  const peekDirect = await window.yan.peekSession(path).catch(() => null)
  log(`  peekSession 直调：${Date.now() - t0}ms，${peekDirect?.messages?.length ?? 0} 条`)
  log(`  文件里的 sessionId = ${peekDirect?.sessionId ?? 'null'}`)
  log(`  当前 state.sessionId = ${stateNow().session?.sessionId ?? 'null'}`)
  ok((peekDirect?.messages?.length ?? 0) > 0, 'peekSession 能直接读出文件内容', `${peekDirect?.messages?.length ?? 0} 条`)
  click(target)
  const trans = []
  let dipped = false
  const unsub = store.subscribe((s, p) => {
    if (s.messages !== p.messages && s.messages.length !== p.messages.length) {
      if (p.messages.length > 0 && s.messages.length === 0) dipped = true
      trans.push(
        `messages ${p.messages.length}→${s.messages.length} peeked=${s.peekedPath ? 'yes' : 'no'}` +
          ` runner=${s.activeRunnerId ?? '-'} sid=${String(s.session?.sessionId ?? '').slice(0, 8)}`
      )
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

  log('\n=== 3. 切界面语言：不重建实例、不丢历史 ===')
  const langBefore = stateNow().settings?.lang
  const instBefore = primary()
  const msgsBefore = stateNow().messages.length
  log(`  切语言前：实例 ${instanceKey(instBefore)}｜messages ${msgsBefore}｜lang=${langBefore}`)
  await stateNow().patchSettings({ lang: langBefore === 'zh-CN' ? 'en-US' : 'zh-CN' })
  await sleep(6000)
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

  if (stateNow().settings?.lang !== langBefore) {
    await stateNow().patchSettings({ lang: langBefore })
    await until(() => stateNow().settings?.lang === langBefore, 15000)
    log(`\n  收尾：语言恢复 ${langBefore}`)
  }
  return out.join('\n')
})()
