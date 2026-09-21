/**
 * 来源「定位消息」的**发送链路**（方案 §8 的 S1）—— 真实模型回合，cost 1。
 *
 * ── 与 `source-locate.js` 的分工 ──
 * 那个探针（cost 0，进 `check`）验的是「关联已存在」之后：落盘、菜单入口、跳转。
 * 这里验**关联是怎么产生的**：发一条带图片附件的消息 → pi 写出 user 条目 →
 * 渲染端把附件对应的来源 id 绑到**那一条**消息上。
 *
 * 这一段必须走真实模型回合（user 条目的 id 由 pi 生成），所以不进 `check`。
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

  const waitFor = async (fn, ms = 10000, step = 120) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const v = await fn()
        if (v) return v
      } catch {
        /* 还没出现 */
      }
      await sleep(step)
    }
    return null
  }

  /* 先等界面把会话铺好（`send` 要拿 sessionId 做来源归属） */
  const sessionId = await waitFor(() => store.getState().session?.sessionId ?? null, 25000)
  if (!sessionId) return early(out.join('\n  ⤺ 没有会话 id，跳过\n'))
  out.push(`  sourcelink.sessionId=${sessionId}`)

  /* 1×1 透明 PNG（与 cost 0 探针同一张，字节确定） */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const name = `sendlive-${Date.now().toString(36)}.png`
  const text = `YAN-SOURCELINK-LIVE ${name}`

  /* ── 1. 把附件放进输入区（这是发送时推导来源 id 的**唯一**输入）── */
  store.getState().addAttachments([
    {
      id: `att-${Date.now().toString(36)}`,
      name,
      mimeType: 'image/png',
      size: 68,
      data: PNG,
      preview: PNG,
      kind: 'image'
    }
  ])
  const attached = await waitFor(() => store.getState().attachments.length > 0, 5000, 50)
  ok(!!attached, '附件进了输入区（接下来发送才带得出去）')

  /* ── 2. 发出去 ─────────────────────────────────────── */
  const sent = await store.getState().send(text, [{ data: PNG, mimeType: 'image/png' }])
  ok(sent === true, '消息发出去了（RPC 接收成功）')

  /*
   * ── 3. 等绑定落盘 ──
   * 绑定发生在「pi 写出 user 条目 → 渲染端收到 msg-add」之后，所以这里轮询
   * **主进程的关联表**（而不是 DOM）：它出现就说明整条链路真的走通了。
   */
  const linked = await waitFor(async () => {
    const listed = await window.yan.sources.list(sessionId)
    const hit = (listed?.links ?? []).filter((l) => l.sourceId.startsWith('image:'))
    return hit.length ? hit : null
  }, 90000, 400)
  if (!ok(!!linked, '发送后自动生成了来源关联', JSON.stringify(linked ?? null))) return early(out.join('\n'))

  const link = linked[linked.length - 1]
  out.push(`  sourcelink.sourceId=${link.sourceId}`)
  out.push(`  sourcelink.messageId=${link.messageId}`)

  /* ── 4. 绑的是**那一条**消息（不是随便一条 user 消息）── */
  const el = await waitFor(() => $(`.msg.user[data-msg-id="${link.messageId}"]`), 8000, 100)
  ok(!!el, '关联指向的那条消息就在界面上', link.messageId)
  ok(
    !!el && (el.textContent ?? '').includes('YAN-SOURCELINK-LIVE'),
    '而且是**刚发出去的那条**（文本对得上，不是历史里的旧消息）',
    (el?.textContent ?? '').trim().slice(0, 60)
  )

  /* 图片真的存进了来源目录（否则菜单里也没有这条来源可点） */
  const listed = await window.yan.sources.list(sessionId)
  ok(
    (listed?.images ?? []).some((i) => i.sourceId === link.sourceId),
    '这张图确实在来源目录里（菜单列得出来）',
    String((listed?.images ?? []).length)
  )

  return out.join('\n')
})()
