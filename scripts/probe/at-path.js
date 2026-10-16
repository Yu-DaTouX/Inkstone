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

  const state = store.getState()
  const cwd = state.session?.cwd ?? state.settings?.cwd ?? ''
  const runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
  const summary = state.sessions.find((item) => item.id === state.session?.sessionId || item.path === state.session?.sessionFile)
  const context = {
    cwd,
    generation: runner?.generation ?? 0,
    ...(runner?.projectId ?? summary?.projectId ? { projectId: runner?.projectId ?? summary?.projectId } : {})
  }
  log('  cwd = ' + cwd)

  /*
   * 列一层条目。
   *
   * ⚠️ 不要绑到具体子目录的内容（上一版用 'src/main/'，那里只有 .ts
   *    文件、没有子目录，于是「目录带尾斜杠」那条断言落空 —— 它以前靠
   *    cwd=家目录时 'Desktop/' 里碰巧有子目录才通过）。
   *    改用根层前缀 's'：项目根下同时有 src/ scripts/（目录）与
   *    LICENSE 等（文件），两种形态都能验。
   */
  const hitPrefix = 's'
  const hitResult = await window.yan.completePath(hitPrefix, cwd, context)
  const hits = hitResult.paths
  log('  completePath("s") = ' + hits.length + ' 项')
  log('    ' + JSON.stringify(hits.slice(0, 6)))
  ok(hitResult.status === 'ok' || hitResult.status === 'empty', '返回带状态的补全结果')
  ok(hitResult.request?.cwd?.toLowerCase() === cwd.toLowerCase(), '补全响应回显当前项目 cwd')
  ok(hits.length > 0, '能列出目录下的条目')
  const hitDirs = hits.filter((h) => h.endsWith('/'))
  log('  其中目录 ' + hitDirs.length + ' 项')
  ok(hitDirs.length > 0, '目录带尾斜杠（界面靠它区分目录 / 文件）')
  ok(hits.includes('scripts/') || hits.includes('src/'), '目录名带尾斜杠（如 src/）')
  ok(
    hits.every((h) => !h.endsWith('/') || !h.slice(0, -1).includes('/')),
    '尾斜杠只出现在目录名后面'
  )

  const up = (await window.yan.completePath('../../', cwd, context)).paths
  ok(up.length === 0, '拒绝 ../ 跳出 cwd（返回 ' + up.length + ' 项）')
  const abs = (await window.yan.completePath('C:/Windows/', cwd, context)).paths
  ok(abs.length === 0, '拒绝绝对路径（返回 ' + abs.length + ' 项）')

  const noisy = (await window.yan.completePath('', cwd, context)).paths
  ok(
    !noisy.some((n) => n.includes('node_modules') || n.startsWith('.')),
    '不列 node_modules 与隐藏文件'
  )

  log('')
  log('=== 界面 ===')
  const ta = q('.composer textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  if (!ta || !setter) {
    ok(false, '拿不到输入框')
    return out.join('\n')
  }

  const menuPrefix = ''
  setter.call(ta, '@' + menuPrefix)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  let menu = null
  let itemCount = 0
  for (let i = 0; i < 40; i++) {
    menu = q('[data-testid="at-menu"]')
    itemCount = menu?.querySelectorAll('.slash-item').length ?? 0
    if (itemCount > 0 || q('[data-testid="at-error"]')) break
    await sleep(120)
  }
  log('  菜单前缀 @' + menuPrefix + ' → ' + (menu ? '出现' : '超时（textarea="' + ta.value + '"）'))
  ok(!!menu, '输入裸 @ 后弹出根层补全菜单')
  if (menu) {
    const items = [...menu.querySelectorAll('.slash-item')].map((x) => x.textContent)
    log('  条目 ' + items.length + ' 个: ' + JSON.stringify(items.slice(0, 3)))
    ok(items.length > 0, '菜单里有条目')
  }

  setter.call(ta, '')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  return out.join('\n')
})()
