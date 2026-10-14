/**
 * 「队列内容放回草稿时图片不能丢」（state/queue-images.ts）的纯逻辑测试。
 *
 * 为什么单独钉住：用户报的「模型运行中插话/排队的消息图片被吞掉」有两个层次 ——
 * 主进程队列本身丢图（scripts/test-queue-rpc-live.mjs 覆盖），以及图片从队列
 * 回到输入框这一段。后者错法都很安静：体积算错会绕过 20MB 上限、跨会话回填会
 * 把图放进**另一条会话**的对话框、把纯图片消息当成「没有内容」就整条丢掉。
 */
export async function runQueueImageTests(ok) {
  const { queueImagesToAttachments, mergeQueueAttachments, planQueueRecovery } = await import(
    '../out/test/queue-images.mjs'
  )

  console.log('\n--- 队列图片回到输入框 ---')

  const limits = { maxCount: 20, maxImageBytes: 20 * 1024 * 1024 }
  const raw = Buffer.from('hello queue image').toString('base64')
  const dataUrl = `data:image/png;base64,${raw}`

  /* 两种形状（裸 base64 / dataURL）都要能还原，体积按解码后的字节算 */
  {
    const [fromRaw] = queueImagesToAttachments([{ data: raw, mimeType: 'image/png' }], limits, 'q')
    const [fromUrl] = queueImagesToAttachments([{ data: dataUrl, mimeType: 'image/jpeg' }], limits, 'q')
    ok(fromRaw.data === raw && fromUrl.data === raw, 'dataURL 前缀被剥掉，两种形状得到同一份 base64')
    ok(fromUrl.preview === dataUrl && fromRaw.preview === dataUrl, '预览都用可渲染的 dataURL')
    ok(fromRaw.size === Buffer.from(raw, 'base64').length, '体积按解码后的字节，不拿 base64 长度冒充')
    ok(fromUrl.mimeType === 'image/jpeg' && fromRaw.mimeType === 'image/png', 'mimeType 按入参保留')
    ok(fromRaw.kind === 'image' && fromRaw.name.length > 0, '附件标记为图片且带名字')
  }

  /* 空数据、缺 mimeType 的兜底 */
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

  /* 同一批里 id 必须唯一 —— 附件列表靠 id 去重与删除，重复会让删一张掉两张 */
  {
    const list = queueImagesToAttachments(
      Array.from({ length: 5 }, () => ({ data: raw, mimeType: 'image/png' })),
      limits,
      'q'
    )
    ok(new Set(list.map((item) => item.id)).size === 5, '同一张图回填多次，id 仍各不相同')
  }

  /* 上限裁剪：数量满了、图片合计超了都不收，且不动用户已有的附件 */
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

  /* 还在原会话：文字与图片都回到输入框 */
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

  /* 纯图片消息：没有文字也不能整条丢掉 */
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

  /* 已切到别的会话：文字回原会话草稿，图片不回填，而且要说清有几张没回来 */
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

  /* 没有任何内容时不能凭空产生改动 */
  {
    const plan = planQueueRecovery({ sameSession: true, text: '', images: [], existing: [], limits, idPrefix: 'q' })
    ok(plan.queueRestore === null && plan.attachments.length === 0 && plan.droppedImages === 0, '空队列项不产生任何回填')
  }

  /* 渲染端 store 必须走这份纯逻辑，不能自己再写一份体积/上限算法 */
  {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/renderer/src/state/store.ts', import.meta.url), 'utf8')
    )
    ok(source.includes("from './queue-images'") && !source.includes('function mergeQueueImages'), 'store 复用共享回填逻辑，没有第二份实现')
  }
}
