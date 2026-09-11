;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => { out.push('✗ ' + s); return out.join('\n') }
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  log('=== 图片真的能发给模型（会真调模型）===')

  const ta = q('[data-testid="composer"]')
  if (!ta) return fail('找不到输入框')

  /* 造一张 8x8 的纯红 PNG —— 足够让模型回答颜色 */
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 8, 8)
  const dataUrl = canvas.toDataURL('image/png')
  const b64 = dataUrl.split(',')[1]

  ok(b64.length > 50, `生成测试图 ${b64.length} 字节 base64`)

  /* 通过 store 加附件（与粘贴/选文件同一条路径） */
  store.getState().addAttachments([
    { id: 'img-test', name: 'red.png', mimeType: 'image/png', size: 100, data: b64, preview: b64 }
  ])
  await sleep(400)

  ok(store.getState().attachments.length === 1, '附件已就绪')
  ok(qa('.attach').length === 1, '缩略图已显示')

  /* 发出去 */
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '这张图是什么颜色？只回答颜色名，两个字以内。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  const nBefore = qa('.msg').length
  q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  // 发完应该立刻清空附件
  await sleep(600)
  ok(store.getState().attachments.length === 0, '发送后附件被清空（不会重复发）')

  // 等回答
  let answered = false
  for (let i = 0; i < 200; i++) {
    await sleep(500)
    const busy = store.getState().session?.isStreaming || !!q('.cursor')
    const txt = qa('.msg.assistant .md').map((e) => e.textContent).join('')
    if (!busy && txt.length > 0 && qa('.msg').length > nBefore) { answered = true; break }
    if (i > 8 && !busy && txt.length > 0) { answered = true; break }
  }
  await sleep(1200)

  ok(qa('.msg').length > nBefore, `新增消息（${nBefore} → ${qa('.msg').length}）`)

  /* 用户消息里应该能看到图 */
  const userWithImg = qa('.msg.user').filter((m) => m.querySelector('.msg-images img'))
  ok(userWithImg.length > 0, '用户消息里渲染了图片缩略图')
  if (userWithImg.length) {
    const src = userWithImg[userWithImg.length - 1].querySelector('img').src
    ok(src.startsWith('data:image/png;base64,'), '图片以 data URI 渲染')
  }

  /* 模型的回答 */
  const all = qa('.msg.assistant .md').map((e) => e.textContent.trim()).filter(Boolean)
  const last = all[all.length - 1] ?? ''
  log('  模型回答: ' + JSON.stringify(last.slice(0, 120)))
  ok(last.length > 0, '模型有回答')
  ok(/红|red/i.test(last), '★ 模型认出了红色 —— 说明图片真的传过去了')

  /* 检查 session 里确实存了 image 块 */
  const history = await window.yan.getMessages()
  const withImages = history.filter((m) => m.images && m.images.length > 0)
  ok(withImages.length > 0, `会话历史里有 ${withImages.length} 条带图消息（图片进了上下文）`)
  if (withImages.length) {
    ok(withImages[0].images[0].mimeType === 'image/png', 'mimeType 正确')
    ok(withImages[0].images[0].data.length > 50, 'base64 数据完整')
  }

  return out.join('\n')
})()
