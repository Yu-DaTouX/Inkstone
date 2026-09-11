/**
 * `@` 文件引用补全（pi 的 @files 用法）。
 *
 * 为什么单独一个场景而不是塞进 features：
 *   那段有大量引号嵌套，往 features.js 里注入时被 bash 转义坑过三次；
 *   而且它与 features 的其它断言没有共享状态。做成独立场景更清楚。
 *
 * 被测的三件事：
 *   ① 能列出目录条目（目录带尾斜杠 —— 界面靠它区分目录 / 文件）
 *   ② 安全：拒绝 ../ 跳出 cwd、拒绝绝对路径
 *   ③ 输入 `@前缀` 时界面真的弹出补全菜单
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }

  log('=== @ 文件引用补全 ===')

  const cwd = store.getState().settings?.cwd ?? ''
  log('  cwd = ' + cwd)

  // cwd 可能是用户主目录（不是项目目录），所以挑一个一定存在的子目录
  const probe = cwd.includes('pi-desktop') ? 'src/main/' : 'Desktop/'
  const hits = await window.yan.completePath(probe)
  log('  completePath(' + probe + ') = ' + hits.length + ' 项')
  log('    ' + JSON.stringify(hits.slice(0, 5)))
  ok(hits.length > 0, '能列出目录下的条目')
  ok(
    hits.some((h) => h.endsWith('/')),
    '目录带尾斜杠（界面靠它区分目录 / 文件）'
  )

  /* 安全：不能跳出 cwd */
  const up = await window.yan.completePath('../../')
  ok(up.length === 0, '拒绝 ../ 跳出 cwd（返回 ' + up.length + ' 项）')
  const abs = await window.yan.completePath('C:/Windows/')
  ok(abs.length === 0, '拒绝绝对路径（返回 ' + abs.length + ' 项）')

  /* 隐藏文件与噪声目录不列（node_modules / .git / 点开头） */
  const noisy = await window.yan.completePath('')
  ok(
    !noisy.some((n) => n.includes('node_modules') || n.startsWith('.')),
    '不列 node_modules 与隐藏文件'
  )

  /* 界面：输入 @ 前缀 → 菜单出现 */
  log('')
  log('=== 界面 ===')
  const ta = q('.composer textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  if (!ta || !setter) {
    ok(false, '拿不到输入框')
    return out.join('\n')
  }

  setter.call(ta, '@' + probe)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(800)

  const menu = q('[data-testid="at-menu"]')
  ok(!!menu, '输入 @ 后弹出补全菜单')
  if (menu) {
    const items = [...menu.querySelectorAll('.slash-item')].map((x) => x.textContent)
    log('  条目 ' + items.length + ' 个: ' + JSON.stringify(items.slice(0, 3)))
    ok(items.length > 0, '菜单里有条目')
  }

  /* 还原输入框 */
  setter.call(ta, '')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  return out.join('\n')
})()
