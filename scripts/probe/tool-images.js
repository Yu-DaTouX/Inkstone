/**
 * 工具结果里的图片 + 附件目录的占用与手动清理。
 *
 * 两件事共用同一条约定：「落盘之后，消息里只留地址」。
 *
 *   ① `role:"toolResult"` 的 content 与用户消息是同一个形状
 *      （`{type,data,mimeType}`），以前只取 text，截图就这样丢了。
 *      两种形态都必须渲染：实时是本次运行期内存里的 base64（`data:`），
 *      历史重读是落盘后的地址（`file:`）。
 *   ② 附件目录只做「可见 + 手动清」。判据（按内容 sha1 找引用）的纯逻辑
 *      由 scripts/test-attachments.mjs 钉住，这里只验**真的能调通**：
 *      IPC 链路返回形状对，且设置页那节能读出来。
 */
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
  /*
   * 现场画一张 24×24 的可见图当「截图」。
   *
   * 不用 1×1 透明 PNG：那样 DOM 里确实有 img、断言也过，但截图上什么都看不到，
   * 视觉验收时会误以为没渲染。
   */
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
    /* 先等应用真的挂载好；太早注入会被紧随其后的 bootstrap / sync 冲掉 */
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store.getState().settings) break
      await sleep(250)
    }
    await sleep(1200)

    /*
     * 图片在**行内详情**里，而 `ToolRowImpl` 的 `autoOpen` 跟随 `toolDetail` 设置
     * （默认收起，行内只给一行摘要）。不打开就只是「图片没渲染」的假象。
     */
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
            /* 实时形态：内存里的 base64 */
            images: [{ mimeType: 'image/png', data: PNG }]
          },
          {
            id: 'ti-history',
            name: 'bash',
            args: { command: 'screenshot --history' },
            status: 'ok',
            output: '历史截图\n',
            /* 历史重读形态：已经落盘，只有地址 */
            images: [{ mimeType: 'image/png', data: '', url: 'file:///C:/yan-probe/nonexistent.png' }]
          }
        ]
      }
    ]
    /*
     * 一条 `running`、一条 `ok`，两条就都会自动展开：
     *   · 并行时只有**最新开始**的 running 自动展开（TurnView 的 activeToolId），
     *     两条都设 running 的话前一条要点行头才展开；
     *   · 已结束的只有**单独一条**时独立成行且默认展开（两条就会进 ToolGroup）。
     */
    const inject = () => store.getState().applyPush({ ch: 'sync', payload })
    inject()
    for (let i = 0; i < 40; i++) {
      if (q('[data-testid="tool-images"]')) break
      await sleep(250)
      /* 应用自己也收 pi 的 sync（它才是权威的），定期重注入 */
      if (i % 6 === 5) inject()
    }

    out.push('=== 1. 工具结果里的图片 ===')
    out.push('  渲染出的工具行 ' + qa('.trow').length + ' 个')
    /* 已结束的工具收进 ToolGroup，默认收起 —— 先展开才看得到行内详情 */
    const group = q('[data-testid="tool-group-toggle"]')
    if (group && group.getAttribute('aria-expanded') === 'false') {
      click(group)
      await sleep(500)
    }
    /*
     * 已结束的行**不会**自动展开（`open = manual ?? (running && autoDetail && autoOpen)`），
     * 得点行头。这顺带验了「已记录的行随时能点开」。
     */
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
    /* 图片要整张看到，不能被详情区那层 max-height + overflow 套住 */
    const overflow = wraps[0] ? getComputedStyle(wraps[0]).overflowY : ''
    out.push('  图片容器 overflow-y = ' + JSON.stringify(overflow))
    ok(overflow !== 'auto' && overflow !== 'scroll', '图片容器自己不带滚动条')

    /*
     * 给视觉验收留个窗口：`YAN_PROBE_SHOT` 的连拍比断言慢，不停一下的话
     * 只能拍到后面已经打开的设置页，看不见这段（实测踩到过）。
     */
    await sleep(2500)

    out.push('')
    out.push('=== 2. 附件目录：占用与手动清理 ===')
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
    out.push('=== 3. 设置 → 包与数据：附件那一节 ===')
    store.getState().openSettings('packages')
    await sleep(900)
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
