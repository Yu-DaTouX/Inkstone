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

    const tag = q('.ca-tile[data-kind="file"]')
    ok(!!tag, '文件引用渲染成独立标签（data-kind=file）')
    if (tag) {
      const text = tag.textContent ?? ''
      ok(/probe\.ts/.test(text), '标签带文件名（可访问名）')
      ok(tag.querySelector('.ui-file-card__name')?.textContent === 'probe.ts', '文件卡片显示名称')
      const title = tag.getAttribute('title') ?? ''
      ok(/probe\.ts/.test(title) && /2 KB/.test(title), '文件名与大小进 tooltip', JSON.stringify(title))
      ok(!!tag.querySelector('svg.lucide') && !tag.querySelector('img'), '标签用图标而不是图片缩略图')
      ok(!tag.querySelector('.ca-ref') && !tag.querySelector('[data-testid="attachment-open"]'), '文件标签没有 @图N 徽标与图片查看入口')
      const box = tag.getBoundingClientRect()
      const nameBox = tag.querySelector('.ui-file-card__name')?.getBoundingClientRect()
      ok(box.width > 40 && nameBox?.width > 1 && nameBox?.height > 1, '文件名在卡片内可见', `${Math.round(box.width)}×${Math.round(box.height)}`)
    }

    const send = q('[data-testid="composer-send"]')
    ok(!!send, '找到发送按钮')
    if (send) {
      const st = store.getState()
      out.push(`  发送按钮 disabled = ${send.disabled}（conn = ${st.conn}）`)
      ok(st.attachments.length === 1, '附件确实进了 store（发送判据用的就是它）')
      ok(send.disabled === false, '只有附件（没有文字）时发送按钮可用')
    }

    store.getState().clearAttachments()
    await sleep(200)
    ok(!q('.ca-tile[data-kind="file"]'), '清理后标签消失')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
