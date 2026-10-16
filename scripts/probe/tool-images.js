;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const bad = (s) => out.push('  ✗ ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const openProcess = async () => {
    for (let i = 0; i < 25; i++) {
      const toggle = q('[data-testid="turn-process-toggle"]')
      if (toggle) {
        if (toggle.getAttribute('aria-expanded') === 'false') {
          click(toggle)
          await sleep(300)
        }
        return !!q('.trow')
      }
      await sleep(200)
    }
    return false
  }
  const canvas = document.createElement('canvas')
  canvas.width = 24
  canvas.height = 24
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#2f6f4f'
  ctx.fillRect(0, 0, 24, 24)
  ctx.fillStyle = '#9ae6b4'
  ctx.fillRect(5, 5, 14, 14)
  const PNG = canvas.toDataURL('image/png').split(',')[1]

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store.getState().settings) break
      await sleep(250)
    }
    await sleep(1200)

    await store.getState().patchSettings({ toolDetail: true, toolDetailExplicit: true })
    await sleep(400)

    const payload = [
      { id: 'ti-user', role: 'user', text: '截个图' },
      {
        id: 'ti-a1',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'ti-live',
            name: 'bash',
            args: { command: 'screenshot' },
            status: 'running',
            output: '截图完成\n',
            images: [{ mimeType: 'image/png', data: PNG }]
          },
          {
            id: 'ti-history',
            name: 'bash',
            args: { command: 'screenshot --history' },
            status: 'ok',
            output: '历史截图\n',
            images: [{ mimeType: 'image/png', data: '', url: 'file:///C:/yan-probe/nonexistent.png' }]
          }
        ]
      }
    ]
    const inject = () => store.getState().applyPush({ ch: 'sync', payload })
    inject()
    await openProcess()
    for (let i = 0; i < 40; i++) {
      if (q('.trow')) break
      await sleep(250)
      if (i % 6 === 5) {
        inject()
        await openProcess()
      }
    }

    out.push('=== 1. 工具结果里的图片 ===')
    out.push('  渲染出的工具行 ' + qa('.trow').length + ' 个')
    const group = q('[data-testid="tool-group-toggle"]')
    if (group && group.getAttribute('aria-expanded') === 'false') {
      click(group)
      await sleep(500)
    }
    for (const head of qa('.trow:not(.open) > .trow-head')) {
      click(head)
      await sleep(300)
    }
    const wraps = qa('[data-testid="tool-images"]')
    ok(wraps.length >= 1, '工具行里有图片容器（' + wraps.length + ' 个）')
    const imgs = qa('[data-testid="tool-images"] img')
    out.push('  图片 ' + imgs.length + ' 张，src 前缀 ' + JSON.stringify(imgs.map((i) => i.src.slice(0, 22))))
    ok(imgs.length >= 2, '两张图都渲染出来')
    ok(
      imgs.some((i) => i.src.startsWith('data:image/png;base64,')),
      '实时形态（data: base64）直接渲染'
    )
    ok(
      imgs.some((i) => i.src.startsWith('file:///')),
      '落盘形态（file:// 地址）也渲染'
    )
    const overflow = wraps[0] ? getComputedStyle(wraps[0]).overflowY : ''
    out.push('  图片容器 overflow-y = ' + JSON.stringify(overflow))
    ok(overflow !== 'auto' && overflow !== 'scroll', '图片容器自己不带滚动条')

    await sleep(2500)

    out.push('')
    out.push('=== 2. 真实会话的图片（main 读文件 → 落盘 → 渲染）===')
    const list = (await window.yan.listSessions()) ?? []
    out.push('  会话列表 ' + list.length + ' 条，开始找含图的')
    let target = null
    let expect = 0
    for (const s of list.slice(0, 15)) {
      let peek = null
      try {
        peek = await window.yan.peekSession(s.path)
      } catch {
        continue
      }
      const n = (peek?.messages ?? []).reduce(
        (a, m) =>
          a +
          (m.images?.length ?? 0) +
          (m.toolCalls ?? []).reduce((b, c) => b + (c.images?.length ?? 0), 0),
        0
      )
      if (n > 0) {
        target = s
        expect = n
        break
      }
    }

    if (!target) {
      out.push('  ⚠ 本机没找到含图的会话，这一段跳过')
    } else {
      out.push('  选中 …' + String(target.path).slice(-26))
      const peek = await window.yan.peekSession(target.path)
      const msgs = peek?.messages ?? []
      const userImgs = msgs.reduce((a, m) => a + (m.images?.length ?? 0), 0)
      const toolImgs = msgs.reduce(
        (a, m) => a + (m.toolCalls ?? []).reduce((b, c) => b + (c.images?.length ?? 0), 0),
        0
      )
      out.push('  消息 ' + msgs.length + ' 条：用户图 ' + userImgs + ' 张，工具图 ' + toolImgs + ' 张')
      const userMsgs = msgs.filter((m) => (m.images?.length ?? 0) > 0)
      const toolMsgs = msgs.filter((m) => (m.toolCalls ?? []).some((c) => c.images?.length))
      const withImg = userMsgs.length ? userMsgs : toolMsgs
      out.push(
        '  含图的消息 ' + withImg.length + ' 条（用户 ' + userMsgs.length + ' / 工具 ' + toolMsgs.length + '），只铺这些'
      )
      store.setState({ messages: withImg })
      await sleep(600)
      for (const head of qa('.trow:not(.open) > .trow-head').slice(0, 15)) {
        click(head)
        await sleep(80)
      }
      let seen = []
      for (let i = 0; i < 30; i++) {
        await sleep(250)
        seen = qa('.msg-images img, .trow-images img')
        if (seen.some((im) => im.naturalWidth > 0)) break
      }
      const decoded = seen.filter((im) => im.naturalWidth > 0).length
      const broken = seen.filter((im) => im.complete && im.naturalWidth === 0).length
      out.push('  DOM 里 ' + seen.length + ' 张，解码出 ' + decoded + ' 张，坏图 ' + broken + ' 张')
      ok(seen.length > 0, '真实会话铺开后 DOM 里有图片元素')
      ok(decoded > 0, '真实会话的图片真的解码出了像素（不是坏图）')
      ok(broken === 0, '没有加载失败的图片（truncateDeep 截断 base64 的回归）')
      const ids = msgs.map((m) => m.id)
      out.push('  前几个 id: ' + JSON.stringify(ids.slice(0, 4)) + ' … 共 ' + ids.length + ' 条')
      ok(ids.every((id) => /^m\d+$/.test(id)), '历史重读的消息 id 都是 m<序号>')
      ok(
        ids.map((i) => Number(i.slice(1))).every((n, i) => n === i),
        'id 序号从 0 连续递增（实时流必须用同一口径，否则 artifact 挂不上）'
      )
      await sleep(3000)
    }

    out.push('')
    out.push('=== 3. 附件目录：占用与手动清理 ===')
    const usage = await window.yan.attachments.usage()
    out.push('  usage = ' + JSON.stringify(usage))
    ok(
      typeof usage?.files === 'number' && typeof usage?.bytes === 'number',
      '占用接口返回 {files, bytes}'
    )
    const pruned = await window.yan.attachments.prune()
    out.push('  prune = ' + JSON.stringify(pruned))
    ok(
      typeof pruned?.removed === 'number' &&
        typeof pruned?.bytes === 'number' &&
        typeof pruned?.kept === 'number',
      '清理接口返回 {removed, bytes, kept}'
    )
    ok(pruned.kept <= usage.files, '留下来的不会多于原有文件数')

    out.push('')
    out.push('=== 3. 设置 → 市场 → pi 插件：附件那一节 ===')
    store.getState().openSettings('market')
    for (let i = 0; i < 30 && !q('[data-testid="plugin-market"]'); i++) await sleep(200)
    const piTab = [...document.querySelectorAll('[role="tab"], button')].find((el) => el.innerText === 'pi 插件')
    piTab?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 30 && !q('[data-testid="set-attachments"]'); i++) await sleep(200)
    ok(!!q('[data-testid="set-attachments"]'), '设置里有「图片附件」一节')
    const sizeText = q('[data-testid="set-attach-size"]')?.textContent ?? ''
    out.push('  占用文案 = ' + JSON.stringify(sizeText))
    ok(!!sizeText.trim(), '显示当前占用')
    const btn = q('[data-testid="set-attach-clean"]')
    ok(!!btn, '有清理按钮')
    if (btn) {
      const emptied = usage.files === 0
      out.push('  目录为空 = ' + emptied + '，按钮 disabled = ' + btn.disabled)
      ok(emptied ? btn.disabled : !btn.disabled, emptied ? '目录为空时按钮禁用' : '有文件时按钮可用')
    }
    store.getState().closeSettings()
  } catch (error) {
    bad('探针异常：' + (error?.message ?? error))
  }
  return out.join('\n')
})()
