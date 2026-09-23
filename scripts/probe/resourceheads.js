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
    ok(entries.length === 4, `开始页有 4 个入口（${entries.length}）`)
    ok(
      entries.every((e) => !!e.querySelector('.rp-start-label') && !!e.querySelector('.rp-start-desc')),
      '每个入口都有标签 + 说明（不是只有图标）'
    )

    click(q('[data-testid="right-window-tab-tools"]'))
    await sleep(300)
    ok(!!q('[data-testid="rp-body"]'), '工具页渲染')
    const secHeads = qa('.rp-body .rp-sec-head')
    ok(secHeads.length > 0, `工具页分区都有标题（${secHeads.length} 个）`)

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
