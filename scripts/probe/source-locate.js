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

  const $ = (sel) => document.querySelector(sel)
  const testid = (id) => document.querySelector(`[data-testid="${id}"]`)

  const waitFor = async (fn, ms = 10000, step = 80) => {
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

  const click = async (el) => {
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(60)
    return true
  }

  const openEnvMenu = async () => {
    if (testid('env-menu')) return true
    await click(testid('session-project'))
    return !!(await waitFor(() => testid('env-menu'), 5000))
  }

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  let firstUser = await waitFor(() => $('.msg.user[data-msg-id]'), 8000, 120)
  if (!firstUser) {
    const list = (await window.yan.listSessions().catch(() => [])) ?? []
    const target = list.find((s) => String(s?.id ?? '').includes('yan-ab-a')) ?? list.find((s) => s?.path)
    if (target) {
      out.push(`  切到 fixture 会话：${target.title ?? target.id}`)
      await store.getState().switchSession(target.path)
    }
    firstUser = await waitFor(() => $('.msg.user[data-msg-id]'), 20000)
  }
  if (!ok(!!firstUser, '会话里有可定位的用户消息（data-msg-id）')) return early(out.join('\n'))
  const messageId = firstUser.getAttribute('data-msg-id')
  out.push(`  目标消息 id = ${messageId}`)

  const sessionId = store.getState().session?.sessionId
  if (!sessionId) return early(out.join('\n  ⤺ 没有会话 id，跳过\n'))
  out.push(`  sourcelink.sessionId=${sessionId}`)
  out.push(`  sourcelink.messageId=${messageId}`)

  const ref = await window.yan.sources.addImage({
    sessionId,
    name: 'locate.png',
    mimeType: 'image/png',
    base64: PNG
  })
  ok(!!ref?.sourceId, '图片存到了来源目录', String(ref?.sourceId ?? ''))

  const linked = await window.yan.sources.link({ sessionId, sourceIds: [ref.sourceId], messageId })
  ok(linked?.ok === true && linked?.added === 1, '关联写进主进程', JSON.stringify(linked))
  const again = await window.yan.sources.link({ sessionId, sourceIds: [ref.sourceId], messageId })
  ok(again?.added === 0, '同一对重复登记是幂等的（不会越点越多）', JSON.stringify(again))
  out.push(`  sourcelink.sourceId=${ref.sourceId}`)

  const listed = await window.yan.sources.list(sessionId)
  const hit = (listed?.links ?? []).filter((l) => l.sourceId === ref.sourceId)
  ok(
    hit.length === 1 && hit[0].messageId === messageId,
    'list 回读到这条关联（来自磁盘，不是内存）',
    JSON.stringify(hit)
  )

  ok(await openEnvMenu(), '环境菜单打开')
  out.push(`  诊断 env-source-menu=${!!testid('env-source-menu')} src-list=${!!testid('src-list')} src-empty=${testid('src-empty')?.textContent?.trim() ?? '(无)'} src-item=${document.querySelectorAll('[data-testid="src-item"]').length}`)
  const locateBtn = await waitFor(() => testid('src-locate'), 10000)
  ok(!!locateBtn, '有关联的来源出现「定位消息」按钮')
  ok(
    !!testid('src-item'),
    '来源条目本身也在（不是只有按钮）',
    String(testid('src-item')?.textContent?.trim() ?? '')
  )

  const before = document.querySelector('.msg.msg-located')
  ok(!before, '点击前没有高亮残留（否则下面的断言什么都证明不了）')
  await click(locateBtn)
  const lit = await waitFor(() => $(`.msg.msg-located[data-msg-id="${messageId}"]`), 3000, 50)
  ok(!!lit, '点击后**那一条**消息被高亮（落点按 id 精确对上）')
  const gone = await waitFor(() => ($('.msg.msg-located') ? null : true), 5000, 100)
  ok(!!gone, '高亮是临时的（1.8 秒后自己掉，不留选中态）')

  return out.join('\n')
})()
