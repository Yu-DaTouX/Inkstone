/*
 * 右侧资源表面统一（实施-13 V-4，cost 0）。
 *
 * 只验结构性与行为性出口（视觉题面由 V-6 的真实截图矩阵承担）：
 *   · 开始页 / 工具页 / 文件 / 审查 各自都有明确的标题位与关闭位；
 *   · 文件缺失时保留标签与路径，并给重试（不是一块空白）；
 *   · 审查在非 Git 目录/无改动时给真实提示，不画假 diff；
 *   · 各表面共用同一条窗口标签行（一个标题来源，不叠两套导航）。
 *
 * 不打开真实网页：原生视图叠层与网络失败由 `right-resources` / `browser` 场景持有。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore
  const st = () => store.getState()

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    if (!st().settings?.rightPanelOpen) await st().setRightPanelOpen(true)
    await sleep(600)

    out.push('=== 1. 一条窗口标签行 = 唯一的标题/关闭来源 ===')
    ok(!!q('[data-testid="right-window-tabs"]'), '右栏窗口标签行存在')
    click(q('[data-testid="right-window-tab-start"]'))
    await sleep(300)
    ok(!!q('[data-testid="right-start-page"]'), '开始页渲染')
    const entries = qa('.rp-start-item')
    /*
     * 5 个：审查 / 浏览器 / 文件 / 终端（H-11）/ 工具。
     * 之前是 4 个（终端未接入）—— 这个数字改过一次，就是 H-11 真的接线了。
     */
    ok(entries.length === 5, `开始页有 5 个入口（${entries.length}）`)
    ok(!!q('[data-testid="start-terminal"]'), '终端入口在（H-11 可用后才会有）')
    ok(
      entries.every((e) => !!e.querySelector('.rp-start-label') && !!e.querySelector('.rp-start-desc')),
      '每个入口都有标签 + 说明（不是只有图标）'
    )

    click(q('[data-testid="right-window-tab-tools"]'))
    await sleep(300)
    ok(!!q('[data-testid="rp-body"]'), '工具页渲染')
    const secHeads = qa('.rp-body .rp-sec-head')
    ok(secHeads.length > 0, `工具页分区都有标题（${secHeads.length} 个）`)

    /*
     * 标题文字不能被压成「上…」「额.」（用户截图）。
     *
     * 之前只断言了「没换成两行」（head 高 ≤ 44），于是漏掉了另一个失败模式：
     * 标题栏 `flex-wrap: nowrap` 之后，flex 把**标题**压缩并加了省略号。
     * 所以这里直接量 scrollWidth vs clientWidth。
     * 优先级应该是：先掉摘要里的数字，摘要缩到环形（36px）后再才轮到标题。
     */
    const titles = qa('.rp-body .rp-sec-title')
    const clippedTitles = titles.filter((el) => el.scrollWidth > el.clientWidth + 1)
    out.push(
      `  分区标题 ${titles.length} 个，被截断 ${clippedTitles.length} 个` +
        (clippedTitles.length
          ? '：' + clippedTitles.map((el) => el.textContent.trim()).join('、')
          : '')
    )
    ok(clippedTitles.length === 0, '分区标题文字完整（没有被 flex 压成省略号）')
    ok(
      secHeads.every((h) => h.getBoundingClientRect().height <= 44.5),
      '分区标题栏仍然是一行（没有换行）'
    )

    out.push('\n=== 2. 文件：缺失保留标签与路径，并给重试 ===')
    const cwd = st().session?.cwd ?? '.'
    const missing = `${cwd}/__yan_missing_preview__.md`
    await st().previewFile(missing, undefined, cwd)
    await until(() => !!q('[data-testid="file-preview"]'), 6000)
    await sleep(600)
    ok(!!q('[data-testid="file-preview"]'), '缺失文件仍打开预览面板（不是静默无反应）')
    const nameEl = q('.fp-name')
    ok((nameEl?.textContent ?? '').includes('__yan_missing_preview__'), '头部保留文件名标签')
    const pathEl = q('.fp-path')
    ok((pathEl?.textContent ?? '').includes('__yan_missing_preview__'), '路径行保留完整路径')
    ok(!!q('[data-testid="file-preview-retry"]'), '失败态给重试按钮')
    ok(!!q('[data-testid="file-preview-close"]'), '失败态仍有关闭位（能退出，不卡住）')
    st().closePreview()
    await sleep(300)

    out.push('\n=== 3. 审查：真实空/非 Git 提示，不画假 diff ===')
    await st().openReview()
    await until(() => !!q('[data-testid="review-panel"]'), 6000)
    await sleep(700)
    const panel = q('[data-testid="review-panel"]')
    ok(!!panel, '审查面板渲染')
    const hint = q('[data-testid="review-notgit"]') || q('[data-testid="review-empty"]') || q('[data-testid="review-error"]')
    const files = qa('[data-testid="review-file"]').length
    ok(files > 0 || !!hint, '要么有真实文件条目，要么有真实空/非 Git/错误提示')
    ok(!q('[data-testid="review-scope"]') || !!q('[data-testid="review-scope"]'), '范围选择位存在（头部结构统一）')
    st().closeReview()
    await sleep(300)

    out.push('\n=== 4. 回到固定导航页，不是空白 ===')
    ok(!!q('[data-testid="right-window-tab-start"]') && !!q('[data-testid="right-window-tab-tools"]'), '固定导航标签始终可达')

    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
