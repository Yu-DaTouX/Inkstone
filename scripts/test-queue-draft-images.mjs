export async function runQueueImageTests(ok) {
  const { queueImagesToAttachments, mergeQueueAttachments, planQueueRecovery } = await import(
    '../out/test/queue-images.mjs'
  )

  console.log('\n--- 队列图片回到输入框 ---')

  const limits = { maxCount: 20, maxImageBytes: 20 * 1024 * 1024 }
  const raw = Buffer.from('hello queue image').toString('base64')
  const dataUrl = `data:image/png;base64,${raw}`

  {
    const [fromRaw] = queueImagesToAttachments([{ data: raw, mimeType: 'image/png' }], limits, 'q')
    const [fromUrl] = queueImagesToAttachments([{ data: dataUrl, mimeType: 'image/jpeg' }], limits, 'q')
    ok(fromRaw.data === raw && fromUrl.data === raw, 'dataURL 前缀被剥掉，两种形状得到同一份 base64')
    ok(fromUrl.preview === dataUrl && fromRaw.preview === dataUrl, '预览都用可渲染的 dataURL')
    ok(fromRaw.size === Buffer.from(raw, 'base64').length, '体积按解码后的字节，不拿 base64 长度冒充')
    ok(fromUrl.mimeType === 'image/jpeg' && fromRaw.mimeType === 'image/png', 'mimeType 按入参保留')
    ok(fromRaw.kind === 'image' && fromRaw.name.length > 0, '附件标记为图片且带名字')
  }

  {
    const list = queueImagesToAttachments(
      [{ data: '', mimeType: 'image/png' }, { data: raw, mimeType: '' }],
      limits,
      'q'
    )
    ok(list.length === 1 && list[0].mimeType === 'image/png', '空 data 跳过，缺 mimeType 兜底为 png')
    ok(queueImagesToAttachments(undefined, limits, 'q').length === 0, '没有图片时返回空数组')
    ok(queueImagesToAttachments([{ data: raw, mimeType: 'image/png' }], { maxCount: 0, maxImageBytes: 0 }, 'q').length === 0, '上限为 0 时不回填')
  }

  {
    const list = queueImagesToAttachments(
      Array.from({ length: 5 }, () => ({ data: raw, mimeType: 'image/png' })),
      limits,
      'q'
    )
    ok(new Set(list.map((item) => item.id)).size === 5, '同一张图回填多次，id 仍各不相同')
  }

  {
    const existing = Array.from({ length: 19 }, (_, i) => ({ id: `e${i}`, name: 'x', mimeType: 'image/png', size: 1, data: '', preview: '', kind: 'image' }))
    const incoming = queueImagesToAttachments(
      Array.from({ length: 3 }, () => ({ data: raw, mimeType: 'image/png' })),
      limits,
      'q'
    )
    const { attachments, skipped } = mergeQueueAttachments(existing, incoming, limits)
    ok(attachments.length === 20 && skipped === 2, '附件数量上限仍生效，超出的回填图被跳过')
    ok(attachments.slice(0, 19).every((item, i) => item.id === `e${i}`), '用户已有附件保持在前面，不被回填挤掉')

    const big = queueImagesToAttachments([{ data: raw, mimeType: 'image/png' }], limits, 'q')
    big[0].size = limits.maxImageBytes
    const merged = mergeQueueAttachments([], big, limits)
    ok(merged.attachments.length === 1 && merged.skipped === 0, '刚好等于上限的图片可以回填')
    const over = mergeQueueAttachments([], [{ ...big[0], size: limits.maxImageBytes + 1 }], limits)
    ok(over.attachments.length === 0 && over.skipped === 1, '超过图片合计上限的图被跳过')
  }

  {
    const plan = planQueueRecovery({
      sameSession: true,
      text: '看这张图',
      images: [{ data: raw, mimeType: 'image/png' }],
      existing: [],
      limits,
      idPrefix: 'q'
    })
    ok(plan.queueRestore === '看这张图', '文字交回草稿')
    ok(plan.attachments.length === 1 && plan.restoredImages === 1 && plan.droppedImages === 0, '图片放回输入框')
  }

  {
    const plan = planQueueRecovery({
      sameSession: true,
      text: '',
      images: [{ data: raw, mimeType: 'image/png' }],
      existing: [],
      limits,
      idPrefix: 'q'
    })
    ok(plan.queueRestore === null, '纯图片消息不产生空草稿')
    ok(plan.attachments.length === 1 && plan.restoredImages === 1, '纯图片消息的图片仍然回来')
  }

  {
    const plan = planQueueRecovery({
      sameSession: false,
      text: '撤回的话',
      images: [{ data: raw, mimeType: 'image/png' }, { data: raw, mimeType: 'image/png' }],
      existing: [],
      limits,
      idPrefix: 'q'
    })
    ok(plan.queueRestore === '撤回的话' && plan.attachments.length === 0, '跨会话只回文字，不往当前输入框塞图')
    ok(plan.restoredImages === 0 && plan.droppedImages === 2, '没能回填的图片被计数，交给调用方提示')
  }

  {
    const plan = planQueueRecovery({ sameSession: true, text: '', images: [], existing: [], limits, idPrefix: 'q' })
    ok(plan.queueRestore === null && plan.attachments.length === 0 && plan.droppedImages === 0, '空队列项不产生任何回填')
  }

  {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/renderer/src/state/store.ts', import.meta.url), 'utf8')
    )
    ok(source.includes("from './queue-images'") && !source.includes('function mergeQueueImages'), 'store 复用共享回填逻辑，没有第二份实现')
  }
}
