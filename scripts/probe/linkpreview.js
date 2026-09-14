/**
 * 链接路由 + 只读文件预览（方案 5.2）。
 *
 * 覆盖：
 *   · Markdown 链接被贴上 data-link-kind（url / file / invalid）
 *   · 点文件链接 → 右侧真的出现只读预览（不是跳走、也不是没反应）
 *   · 危险协议点不动（样式上也不是可点链接）
 *
 * 不覆盖（留给真实窗口验收）：内部浏览器与原生网页视图的遮挡关系。
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
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store?.getState().settings) break
      await sleep(250)
    }
    await sleep(800)

    /* 找一个项目内的文本文件当预览目标 */
    const listing = await window.yan.listDir('')
    const file = listing.entries.find((e) => !e.dir && /\.(ts|tsx|js|mjs|json|md|txt|jsonl)$/i.test(e.name))
    out.push(`  项目内可选文件：${file?.name ?? '(没找到)'}`)
    if (!file) {
      out.push('  （跳过）隔离项目里没有可预览的文本文件')
      return out.join('\n')
    }

    const payload = [
      { id: 'lp-user', role: 'user', text: '看两个链接' },
      {
        id: 'lp-a1',
        role: 'assistant',
        text: `项目内文件：[${file.name}](<${file.name}>)\n危险链接：[点我](javascript:alert(1))`,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }
      }
    ]
    store.getState().applyPush({ ch: 'sync', payload })
    for (let i = 0; i < 40; i++) {
      if (qa('.md-link').length >= 2) break
      await sleep(250)
      if (i % 6 === 5) store.getState().applyPush({ ch: 'sync', payload })
    }

    const links = qa('.md-link')
    out.push(`  渲染出 ${links.length} 个链接`)
    ok(links.length >= 2, 'Markdown 链接渲染成统一入口（.md-link）')

    const fileLink = links.find((a) => a.getAttribute('data-link-kind') === 'file')
    const badLink = links.find((a) => a.getAttribute('data-link-kind') === 'invalid')
    ok(!!fileLink, '文件链接被识别为 file')
    ok(!!badLink, 'javascript: 链接被标记为 invalid')
    if (badLink) {
      out.push(`  危险链接样式 = ${badLink.className}`)
      ok(badLink.classList.contains('blocked'), '危险链接有 blocked 样式提示（不是看起来能点）')
    }

    /* 点危险链接：什么都不该发生 */
    const before = q('[data-testid="file-preview"]')
    if (badLink) {
      click(badLink)
      await sleep(300)
      ok(q('[data-testid="file-preview"]') === before, '点危险链接不会打开预览')
    }

    /* 点文件链接：右侧出现只读预览 */
    if (fileLink) {
      click(fileLink)
      for (let i = 0; i < 40; i++) {
        const fp = q('[data-testid="file-preview"]')
        if (fp && fp.querySelector('[data-testid="file-preview-body"]')?.textContent?.length > 0) break
        await sleep(250)
      }
      const fp = q('[data-testid="file-preview"]')
      ok(!!fp, '点文件链接打开了右侧只读预览面板')
      if (fp) {
        const body = fp.querySelector('[data-testid="file-preview-body"]')?.textContent ?? ''
        out.push(`  预览正文长度 = ${body.length}`)
        ok(body.length > 0, '预览里真的有内容（或明确的错误说明）')
        const state = store.getState().filePreview
        out.push(`  store.filePreview = ${state ? JSON.stringify({ path: state.path, loading: state.loading, ok: state.data?.ok }) : 'null'}`)
        ok(!!state && state.loading === false, '预览请求已结束（没有卡在 loading）')
        ok(state?.data?.ok === true, `预览成功读到内容（error=${state?.data?.error ?? '无'}）`)
      }

      /* 关闭按钮：收起来 */
      const close = q('[data-testid="file-preview-close"]')
      ok(!!close, '预览面板有关闭按钮')
      if (close) {
        click(close)
        await sleep(300)
        ok(!q('[data-testid="file-preview"]'), '关闭后预览面板消失')
      }
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
