/**
 * 文件引用（拖入的普通文件）在界面上的形态 + 主进程校验通道。
 *
 * 为什么合成注入而不是真拖：探针里造不出带真实路径的 `File`
 * （`webUtils.getPathForFile` 对合成对象返回空串），
 * 真实拖放留给真实窗口验收（方案 13）。
 *
 * 这里钉住的是：
 *   · 渲染端真的能走 `describeFiles` 这条 IPC，而且主进程会拒绝坏路径
 *   · 文件引用渲染成**独立标签**（不是图片缩略图卡片）
 *   · 只有附件、没有文字时也能发送（历史上被 `if (!raw) return` 挡住过）
 */
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
      if (q('[data-testid="composer"]') && store?.getState().settings) break
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

    const tag = q('.attach[data-kind="file"]')
    ok(!!tag, '文件引用渲染成独立标签（data-kind=file）')
    if (tag) {
      const text = tag.textContent ?? ''
      ok(/probe\.ts/.test(text), '标签显示文件名')
      ok(/2\.0 KB|KB/.test(text), '标签显示大小')
      ok(!!tag.querySelector('.ico'), '标签用图标而不是图片缩略图')
    }

    const send = q('[data-testid="send"]')
    ok(!!send, '找到发送按钮')
    if (send) {
      const st = store.getState()
      out.push(`  发送按钮 disabled = ${send.disabled}（conn = ${st.conn}）`)
      /*
       * 发送按钮同时受**连接状态**与「有没有内容」两个条件控制。
       * 探针环境里 pi 可能没就绪（conn !== ready），那 disabled 就是 true ——
       * 这时不能把这个当失败，只报告状态。
       */
      if (st.conn === 'ready') {
        ok(send.disabled === false, '只有附件（没有文字）时发送按钮可用')
      } else {
        out.push('  （跳过）连接未就绪，按钮由 conn 决定禁用，与附件无关')
        ok(st.attachments.length === 1, '附件确实进了 store（发送判据用的就是它）')
      }
    }

    /* 清理：别把探针的附件留给后面的场景 */
    store.getState().clearAttachments()
    await sleep(200)
    ok(!q('.attach[data-kind="file"]'), '清理后标签消失')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
