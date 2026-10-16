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
      }
      await sleep(step)
    }
    return null
  }

  const sessionId = await waitFor(() => store.getState().session?.sessionId ?? null, 25000)
  if (!sessionId) return early(out.join('\n  ⤺ 没有会话 id，跳过\n'))
  out.push(`  sourcelink.sessionId=${sessionId}`)

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const name = `sendlive-${Date.now().toString(36)}.png`
  const text = `YAN-SOURCELINK-LIVE ${name}`

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

  const sent = await store.getState().send(text, [{ data: PNG, mimeType: 'image/png' }])
  ok(sent === true, '消息发出去了（RPC 接收成功）')

  const linked = await waitFor(async () => {
    const listed = await window.yan.sources.list(sessionId)
    const hit = (listed?.links ?? []).filter((l) => l.sourceId.startsWith('image:'))
    return hit.length ? hit : null
  }, 90000, 400)
  if (!ok(!!linked, '发送后自动生成了来源关联', JSON.stringify(linked ?? null))) return early(out.join('\n'))

  const link = linked[linked.length - 1]
  out.push(`  sourcelink.sourceId=${link.sourceId}`)
  out.push(`  sourcelink.messageId=${link.messageId}`)

  const el = await waitFor(() => $(`.msg.user[data-msg-id="${link.messageId}"]`), 8000, 100)
  ok(!!el, '关联指向的那条消息就在界面上', link.messageId)
  ok(
    !!el && (el.textContent ?? '').includes('YAN-SOURCELINK-LIVE'),
    '而且是**刚发出去的那条**（文本对得上，不是历史里的旧消息）',
    (el?.textContent ?? '').trim().slice(0, 60)
  )

  const listed = await window.yan.sources.list(sessionId)
  ok(
    (listed?.images ?? []).some((i) => i.sourceId === link.sourceId),
    '这张图确实在来源目录里（菜单列得出来）',
    String((listed?.images ?? []).length)
  )

  return out.join('\n')
})()
