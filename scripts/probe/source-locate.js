/**
 * 来源「定位消息」（方案 §8 的 S1）—— 真实窗口验收，cost 0，不调模型。
 *
 * ── 这一片为什么值得单独一个探针 ──
 * 「这份来源参与了哪条消息」在这个应用里是**新数据**：图片只有字节哈希、
 * 文件只有路径指纹、网页只有 URL，而消息 id 属于会话 JSONL —— 两边本来没有交集。
 * 所以这里要证明的是三件事同时成立：
 *   ① 关联**真的落到磁盘**（不是只活在 React state 里）；
 *   ② 菜单读得到它，并给出「定位消息」入口；
 *   ③ 点下去**真的滚到那条消息**（用 `data-msg-id` 精确对上，不是"看起来跳了"）。
 *
 * 发送链路（发一条带附件的消息 → 绑定到 pi 写出的 user 条目）需要模型回合，
 * 由 cost 1 场景覆盖；这里走的是「关联已存在」之后的全部路径。
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

  const $ = (sel) => document.querySelector(sel)
  const testid = (id) => document.querySelector(`[data-testid="${id}"]`)

  const waitFor = async (fn, ms = 10000, step = 80) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        /* 谓词可能是 async（要等一次 IPC）—— 不 await 的话 Promise 本身是 truthy */
        const v = await fn()
        if (v) return v
      } catch {
        /* 还没出现 */
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

  /* 1×1 透明 PNG —— 只要字节确定，内容不重要 */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  /* ── 0. 前置：界面里得有可定位的消息（否则这套断言证明不了任何事）── */
  /*
   * 场景刚开时界面可能停在一个空会话上（fixture 里既有带消息的，也有新建的）。
   * 先显式切到列表里最新的那个会话 —— `switchSession` 会先读文件把消息铺上，
   * 不必等 pi。
   */
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
  /* 退出后检查靠这三行定位磁盘上的关联文件（渲染端伪造不了那一层） */
  out.push(`  sourcelink.sessionId=${sessionId}`)
  out.push(`  sourcelink.messageId=${messageId}`)

  /* ── 1. 存一张图（来源菜单只列主进程目录里的图片）────────── */
  const ref = await window.yan.sources.addImage({
    sessionId,
    name: 'locate.png',
    mimeType: 'image/png',
    base64: PNG
  })
  ok(!!ref?.sourceId, '图片存到了来源目录', String(ref?.sourceId ?? ''))

  /* ── 2. 落盘关联 ─────────────────────────────────────── */
  const linked = await window.yan.sources.link({ sessionId, sourceIds: [ref.sourceId], messageId })
  ok(linked?.ok === true && linked?.added === 1, '关联写进主进程', JSON.stringify(linked))
  const again = await window.yan.sources.link({ sessionId, sourceIds: [ref.sourceId], messageId })
  ok(again?.added === 0, '同一对重复登记是幂等的（不会越点越多）', JSON.stringify(again))
  out.push(`  sourcelink.sourceId=${ref.sourceId}`)

  /* 主进程回读：落盘的证据（渲染端伪造不了这一条） */
  const listed = await window.yan.sources.list(sessionId)
  const hit = (listed?.links ?? []).filter((l) => l.sourceId === ref.sourceId)
  ok(
    hit.length === 1 && hit[0].messageId === messageId,
    'list 回读到这条关联（来自磁盘，不是内存）',
    JSON.stringify(hit)
  )

  /* ── 3. 菜单里的入口 ─────────────────────────────────── */
  ok(await openEnvMenu(), '环境菜单打开')
  /* 诊断：来源区在不在、里面是什么（菜单是分区渲染的，找不到时得知道卡在哪） */
  out.push(`  诊断 env-source-menu=${!!testid('env-source-menu')} src-list=${!!testid('src-list')} src-empty=${testid('src-empty')?.textContent?.trim() ?? '(无)'} src-item=${document.querySelectorAll('[data-testid="src-item"]').length}`)
  const locateBtn = await waitFor(() => testid('src-locate'), 10000)
  ok(!!locateBtn, '有关联的来源出现「定位消息」按钮')
  ok(
    !!testid('src-item'),
    '来源条目本身也在（不是只有按钮）',
    String(testid('src-item')?.textContent?.trim() ?? '')
  )

  /* ── 4. 点下去真的到那条消息上 ───────────────────────── */
  const before = document.querySelector('.msg.msg-located')
  ok(!before, '点击前没有高亮残留（否则下面的断言什么都证明不了）')
  await click(locateBtn)
  const lit = await waitFor(() => $(`.msg.msg-located[data-msg-id="${messageId}"]`), 3000, 50)
  ok(!!lit, '点击后**那一条**消息被高亮（落点按 id 精确对上）')
  const gone = await waitFor(() => ($('.msg.msg-located') ? null : true), 5000, 100)
  ok(!!gone, '高亮是临时的（1.8 秒后自己掉，不留选中态）')

  return out.join('\n')
})()
