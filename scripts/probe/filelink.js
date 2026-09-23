/*
 * Markdown 文件链接的呈现与点击（实施-11 H-4 的解析 / 呈现切片，cost 0）。
 *
 * 搬运自 DeepSeek Harness 的 `file-link.ts`（见 shared/links.ts 的许可说明）：
 * 在原有 `path:42` 之外支持 GitHub 风格的 `path#L42` / `path#L42-L60`，
 * 并保证「范围不被当成文件名」。这里验的是**接进界面之后**的行为：
 *   · 文件链接带 `data-link-kind="file"` 与 `data-line`；
 *   · title 里带行号（悬停能读到完整路径 + 行号）；
 *   · 范围链接取首行，不把 `#L1-L5` 当路径；
 *   · 点击真的走 `previewFile(path, line)`（主进程读文件），不做进程内导航。
 */

;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    /* 注入一条含三种文件引用的助手消息：普通、#L 单行、#L 范围。 */
    store.getState().applyPush({
      ch: 'sync',
      payload: [
        { id: 'fl-u1', role: 'user', text: '这几个文件在哪几行', timestamp: Date.now() },
        {
          id: 'fl-a1',
          role: 'assistant',
          text: '见 [README 第 3 行](README.md#L3)、[普通引用](README.md) 与 [一段范围](README.md#L1-L5)。'
        }
      ]
    })
    await sleep(900)

    const links = [...document.querySelectorAll('a.md-link[data-link-kind="file"]')]
    ok(links.length === 3, `三个文件引用都渲染成文件链接（实际 ${links.length}）`)
    if (links.length < 3) return out.join('\n')

    const ranged = links.find((a) => a.getAttribute('data-line') === '3')
    ok(!!ranged, '#L3 解析出 data-line=3')
    const title = ranged?.getAttribute('title') ?? ''
    ok(/README\.md:3/.test(title), `title 里带路径与行号（「${title}」）`)

    const plain = links.find((a) => (a.textContent ?? '').includes('普通引用'))
    ok(!!plain && !plain.hasAttribute('data-line'), '没有行号的链接不写 data-line')
    ok(/README\.md/.test(plain?.getAttribute('title') ?? ''), '普通引用的 title 仍给出完整路径')

    const range = links.find((a) => (a.textContent ?? '').includes('一段范围'))
    ok(range?.getAttribute('data-line') === '1', '#L1-L5 取首行 1（范围不被当成文件名）')
    ok(range?.getAttribute('data-line-end') === '5', '#L1-L5 带出末行 5（H-4 范围高亮）')
    ok(
      /README\.md/.test(range?.getAttribute('title') ?? ''),
      `范围链接的路径没有把 #L1-L5 吃进去（「${range?.getAttribute('title') ?? ''}」）`
    )
    ok(
      /README\.md:1-5/.test(range?.getAttribute('title') ?? ''),
      `范围链接的 title 写明 1-5（「${range?.getAttribute('title') ?? ''}」）`
    )

    /* 点击必须走主进程读文件，而不是把渲染进程导航走（窗口里没有地址栏）。 */
    ranged?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1400)
    const preview = store.getState().filePreview
    ok(!!preview, '点击文件链接打开了预览')
    ok(/README\.md$/.test(preview?.path ?? ''), `预览打开的就是链接那条路径（${preview?.path ?? '-'}）`)
    ok(!!preview?.data, '主进程真的读到了文件内容（不是空白壳）')
    const readMode = document.querySelector('[data-testid="file-preview-read"]')
    const sourceMode = document.querySelector('[data-testid="file-preview-source"]')
    ok(!!readMode && !!sourceMode, 'Markdown 预览提供阅读 / 源码切换')
    sourceMode?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(120)
    ok(!!document.querySelector('.fp-code'), '切换源码后显示带行号的源码')
    readMode?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(120)
    ok(!!document.querySelector('[data-testid="file-preview-markdown"]'), '切回阅读后显示 Markdown 呈现')
    ok(location.hash === '' || !location.hash.includes('L3'), '链接的 #L3 没有触发进程内导航')

    /*
     * 范围高亮（H-4）：点 `#L1-L5`，源码里 1..5 行要真的被标出来。
     * README 只有 3 行正文，所以断言“高亮的行都 ≤ 5 且从 1 开始”，
     * 而不是写死五行（否则这个 fixture 改长/改短就会假红）。
     */
    range?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1400)
    const rangedPreview = store.getState().filePreview
    ok(
      rangedPreview?.line === 1 && rangedPreview?.lineEnd === 5,
      `范围链接把 1-5 带进预览（line=${rangedPreview?.line} end=${rangedPreview?.lineEnd}）`
    )
    const sourceBtn = document.querySelector('[data-testid="file-preview-source"]')
    sourceBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(150)
    const highlighted = [...document.querySelectorAll('.fp-row[data-in-range="1"]')].map((el) =>
      Number(el.getAttribute('data-line'))
    )
    out.push(`  高亮行 = ${JSON.stringify(highlighted)}`)
    ok(
      highlighted.length > 0 && highlighted[0] === 1 && highlighted.every((n) => n <= 5),
      '范围 1-5 内的行被高亮，从第 1 行开始'
    )
    ok(
      !highlighted.includes(6) && !document.querySelector('.fp-row[data-line="6"]'),
      '范围之外的第六行没有高亮'
    )
    ok(
      !!document.querySelector('[data-testid="file-preview-line"]') &&
        /1.5/.test(document.querySelector('[data-testid="file-preview-line"]')?.textContent ?? ''),
      `头部显示范围 1-5（实际 ${JSON.stringify(document.querySelector('[data-testid="file-preview-line"]')?.textContent ?? null)}）`
    )

    /*
     * 大文件窗口化（H-4）：指向第 4000 行的链接必须真的定位到那一段 ——
     * 不是只读文件开头、也不是估算滚动位置。
     */
    store.getState().applyPush({
      ch: 'sync',
      payload: [
        { id: 'fl-u2', role: 'user', text: '大文件在哪一行', timestamp: Date.now() },
        { id: 'fl-a2', role: 'assistant', text: '见 [第 4000 行](big.txt#L4000)。' }
      ]
    })
    await sleep(700)
    const bigLink = [...document.querySelectorAll('a.md-link[data-link-kind="file"]')].find((a) =>
      (a.textContent ?? '').includes('第 4000 行')
    )
    ok(!!bigLink, '大文件链接渲染出来')
    bigLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1600)
    const big = store.getState().filePreview
    out.push(
      `  大文件：windowStart=${big?.data?.windowStart ?? '-'} windowEnd=${big?.data?.windowEnd ?? '-'} totalLines=${big?.data?.totalLines ?? '-'}`
    )
    ok(
      big?.data?.windowStart === 3800,
      `窗口从目标行前 200 行开始（实际 ${big?.data?.windowStart ?? '-'}）`
    )
    ok((big?.data?.totalLines ?? 0) >= 5000, '总行数如实报出（不是“未知”）')
    ok(!!document.querySelector('[data-testid="file-preview-window"]'), '界面写明这是大文件的哪一段')
    ok(!!document.querySelector('.fp-row[data-line="3800"]'), '第一行就是真实行号 3800（不从 1 重新数）')
    ok(
      !!document.querySelector('.fp-row[data-line="4000"]'),
      '目标行 4000 真的渲染出来了（不是估算滚动）'
    )
    ok(!document.querySelector('.fp-row[data-line="1"]'), '没有把文件开头当成第一行')

    /* H-4 出口 7：文件不在了 —— 保留原路径 + 重试 + 定位父目录 */
    store.getState().applyPush({
      ch: 'sync',
      payload: [
        { id: 'fl-u3', role: 'user', text: '那个文件还在吗', timestamp: Date.now() },
        { id: 'fl-a3', role: 'assistant', text: '见 [不存在的文件](gone/never-here.ts#L1)。' }
      ]
    })
    await sleep(700)
    const goneLink = [...document.querySelectorAll('a.md-link[data-link-kind="file"]')].find((a) =>
      (a.textContent ?? '').includes('不存在的文件')
    )
    ok(!!goneLink, '不存在的文件链接渲染出来')
    goneLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1200)
    const gonePreview = store.getState().filePreview
    ok(gonePreview?.data?.ok === false, '不存在的文件进入失败态（不假装读到）')
    ok(
      (gonePreview?.path ?? '').includes('never-here.ts'),
      `失败态保留原路径（不回退到空标签：${gonePreview?.path ?? '-'}）`
    )
    ok(!!document.querySelector('[data-testid="file-preview-retry"]'), '失败态提供重试')
    ok(
      !!document.querySelector('[data-testid="file-preview-reveal-dir"]'),
      'H-4：失败态提供「定位父目录」（不把用户丢在死路上）'
    )
    ok(
      typeof gonePreview?.data?.dir === 'string' && gonePreview.data.dir.length > 0,
      '父目录真的算出来了（不是空按钮）'
    )

    /* H-4 出口 3：文档内相对链接按**文档目录**解析（`../README.md` → 根 README） */
    const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd ?? ''
    await store.getState().previewFile(`${cwd}\\docs\\a.md`, undefined, cwd)
    await sleep(1500)
    const docLink = document.querySelector(
      '[data-testid="file-preview-markdown"] a.md-link[data-link-kind="file"]'
    )
    ok(!!docLink, '阅读模式里的相对链接渲染成可点的文件链接')
    docLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1200)
    const afterDoc = store.getState().filePreview
    ok(
      /README\.md$/.test(afterDoc?.data?.abs ?? ''),
      `相对链接以文档所在目录为基准（实际打开 ${afterDoc?.data?.abs ?? '-'}）`
    )
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
