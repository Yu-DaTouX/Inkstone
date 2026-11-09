;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  try {
    for (let i = 0; i < 60; i++) {
      if (q('[data-testid="composer-input"]') && store?.getState().settings) break
      await sleep(250)
    }
    await sleep(600)

    out.push('=== 主进程校验通道 ===')
    const bad = await window.yan.describeFiles(['C:\\definitely\\not\\here\\nope.ts'])
    ok(Array.isArray(bad) && bad.length === 1, 'describeFiles 返回数组')
    ok(bad[0]?.ok === false, '不存在的路径被主进程拒绝（而不是当成可以引用）')
    out.push(`  拒绝原因 = ${JSON.stringify(bad[0]?.error ?? '')}`)

    const rel = await window.yan.describeFiles(['package.json'])
    ok(rel[0]?.ok === false, '相对路径被拒绝（授权只认真实绝对路径）')

    out.push('')
    out.push('=== 标签渲染 ===')
    store.getState().clearAttachments()
    store.getState().addAttachments([
      {
        id: 'probe-ref',
        name: 'probe.ts',
        mimeType: 'text/typescript',
        size: 2048,
        data: '',
        preview: '',
        kind: 'file',
        path: 'C:\\tmp\\probe.ts'
      }
    ])
    await sleep(300)

    const tag = [...document.querySelectorAll('[data-testid="composer-v3"] .t3-attachment-file')].find((el) => (el.textContent ?? '').includes('probe.ts'))
    ok(!!tag, '文件引用渲染成独立的文件行')
    if (tag) {
      ok(tag.querySelector('.t3-attachment-file__name')?.textContent === 'probe.ts', '文件行显示名称')
      const size = tag.querySelector('.t3-attachment-file__size')?.textContent ?? ''
      ok(/^2(\.0)? ?KB$/.test(size), '文件行显示大小', JSON.stringify(size))
      ok(!!tag.querySelector('.ui-file-icon svg') && !tag.querySelector('img'), '用文件类型图标而不是图片缩略图')
      ok(!tag.querySelector('.t3-attachment__ref') && !tag.querySelector('.t3-attachment__open'), '文件行没有 @图N 徽标与图片查看入口')
      ok(/probe\.ts/.test(tag.querySelector('button[aria-label]')?.getAttribute('aria-label') ?? ''), '移除按钮的可访问名带文件名', tag.querySelector('button[aria-label]')?.getAttribute('aria-label') ?? '')
      const box = tag.getBoundingClientRect()
      const nameBox = tag.querySelector('.t3-attachment-file__name')?.getBoundingClientRect()
      ok(box.width > 40 && nameBox?.width > 1 && nameBox?.height > 1, '文件名可见', `${Math.round(box.width)}×${Math.round(box.height)}`)
    }

    const send = q('[data-testid="composer-v3"] .t3-send')
    ok(!!send, '找到发送按钮')
    if (send) {
      const st = store.getState()
      out.push(`  发送按钮 disabled = ${send.disabled}（conn = ${st.conn}）`)
      ok(st.attachments.length === 1, '附件确实进了 store（发送判据用的就是它）')
      ok(send.disabled === false, '只有附件（没有文字）时发送按钮可用')
    }

    store.getState().clearAttachments()
    await sleep(200)
    ok(!q('[data-testid="composer-v3"] .t3-attachment-file'), '清理后文件行消失')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
