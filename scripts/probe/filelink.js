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
    ok(
      /README\.md/.test(range?.getAttribute('title') ?? ''),
      `范围链接的路径没有把 #L1-L5 吃进去（「${range?.getAttribute('title') ?? ''}」）`
    )

    /* 点击必须走主进程读文件，而不是把渲染进程导航走（窗口里没有地址栏）。 */
    ranged?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1400)
    const preview = store.getState().filePreview
    ok(!!preview, '点击文件链接打开了预览')
    ok(/README\.md$/.test(preview?.path ?? ''), `预览打开的就是链接那条路径（${preview?.path ?? '-'}）`)
    ok(!!preview?.data, '主进程真的读到了文件内容（不是空白壳）')
    ok(location.hash === '' || !location.hash.includes('L3'), '链接的 #L3 没有触发进程内导航')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
