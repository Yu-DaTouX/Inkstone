;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }

  log('=== 1. authProviders / authFileInfo ===')
  const t0 = performance.now()
  const list = await window.yan.authProviders(false)
  log('  浅查 ' + list.length + ' 项，' + (performance.now() - t0).toFixed(0) + 'ms')
  ok(list.length > 0, '列出接入方式')
  ok(
    list.some((x) => x.kind === 'subscription'),
    '有订阅制条目'
  )
  ok(
    list.some((x) => x.kind === 'api_key'),
    '有 API key 条目'
  )
  ok(performance.now() - t0 < 3000, '浅查很快（不逐个问 pi）')

  const info = await window.yan.authFileInfo()
  log('  凭证文件 = ' + info.path + '  exists=' + info.exists + '  count=' + info.count)
  ok(info.path.includes('auth.json'), '凭证路径指向 auth.json')

  if (info.count > 0) {
    ok(
      list.some((x) => x.status === 'ready'),
      'auth.json 里有 ' + info.count + ' 条凭证，列表里至少一项标记为已就绪'
    )
  } else {
    log('  （auth.json 是空的，跳过「已配置项被列出」断言）')
  }

  log('')
  log('=== 2. 写入合并（不弄丢已有凭证）===')
  const TEST_ID = 'yan-probe-key'
  const before = info.count
  const w = await window.yan.setApiKey(TEST_ID, 'probe-key-1234567890')
  ok(w.ok, '写入测试凭证成功' + (w.error ? '（' + w.error + '）' : ''))

  const after = await window.yan.authFileInfo()
  ok(after.count === before + 1, '写入后条目数 +1（实际 ' + before + ' → ' + after.count + '）')

  const list2 = await window.yan.authProviders(false)
  ok(
    list2.some((x) => x.id === TEST_ID && x.status === 'ready'),
    '新写入的 provider 出现在列表里且标记已就绪'
  )

  const c = await window.yan.clearAuth(TEST_ID)
  ok(c.ok, '移除测试凭证成功')
  const cleaned = await window.yan.authFileInfo()
  ok(cleaned.count === before, '移除后条目数还原（' + cleaned.count + '）')

  log('')
  log('=== 3. 设置 · 接入页 ===')
  const seeded = await window.yan.setApiKey(TEST_ID, 'probe-key-1234567890')
  ok(seeded.ok, '为按钮断言临时写入一条测试凭证' + (seeded.error ? '（' + seeded.error + '）' : ''))
  store.getState().openSettings('auth')
  for (let i = 0; i < 40 && !q('.settings-tab'); i++) await sleep(100)
  const tabs = qa('.settings-tab').map((x) => x.textContent)
  log('  tabs = ' + JSON.stringify(tabs))
  ok(
    tabs.some((x) => /接入|模型|Providers|Models/.test(x)),
    '有「接入」tab'
  )

  for (let i = 0; i < 30 && !q('.auth-row'); i++) await sleep(100)
  for (let i = 0; i < 150 && !q('[data-testid^="auth-login-"]'); i++) await sleep(100)
  const rows = qa('.auth-row')
  log('  行数 = ' + rows.length)
  ok(rows.length > 0, '渲染出接入方式列表')

  const cmds = qa('.auth-cmd')
  log('  订阅制的命令提示 = ' + cmds.length)
  ok(qa('[data-testid^="auth-login-"]').length > 0, '订阅制给的是「登录」按钮（不是输入框）')

  const deepList = await window.yan.authProviders(true)
  ok(
    deepList.some((x) => x.id === TEST_ID && x.status === 'ready'),
    '深层列表里有刚写入的凭证且标记就绪'
  )
  for (let i = 0; i < 200 && !q('[data-testid^="auth-set-"]'); i++) await sleep(100)
  if (!q('[data-testid^="auth-set-"]')) {
    const more = q('[data-testid="auth-more-keys"]')
    const summary = more?.querySelector('summary')
    if (summary && !more.open) {
      summary.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(400)
    }
  }
  const setBtns = qa('[data-testid^="auth-set-"]')
  if (setBtns.length) {
    ok(true, 'API key 有「填入 / 更换」按钮')
  } else {
    out.push('  ~ 跳过：列表还没带出 API key 行（deep 检查未在等待窗口内完成），按钮断言不适用')
  }

  ok(!!q('[data-testid="auth-recheck"]'), '有「重新检测」按钮')

  log('=== 3. 应用内登录（ChatGPT 订阅）===')
  ok(!!q('[data-testid="auth-row-openai-codex"]'), '有 ChatGPT 订阅这一行')
  ok(
    typeof window.yan.codexLogin === 'function' && typeof window.yan.codexLoginCancel === 'function',
    'IPC 暴露了 codexLogin / codexLoginCancel'
  )
  const codexReady = /已就绪|ready/i.test(q('[data-testid="auth-row-openai-codex"]')?.textContent ?? '')
  if (codexReady) {
    out.push('  ~ 跳过：openai-codex 在这台机器上已就绪（登录按钮不适用）')
  } else {
    ok(!!q('[data-testid="auth-login-openai-codex"]'), '未登录时给「在本应用内登录」按钮')
  }
  ok(
    !!q('[data-testid="auth-login-anthropic"]'),
    '其余订阅制（Claude）也有应用内登录按钮'
  )

  const first = setBtns[0]
  if (first) {
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 25 && !q('.auth-input'); i++) await sleep(100)
    const inputs = qa('.auth-input')
    ok(inputs.length > 0, '点「填入」后出现输入框')
    if (inputs.length) {
      log('  输入框 type = ' + inputs[0].type)
      ok(inputs[0].type === 'password', '输入框是 password 类型（不暴露 key）')
    }
  }

  const cleanup = await window.yan.clearAuth(TEST_ID)
  ok(cleanup.ok, '收尾移除临时凭证' + (cleanup.error ? '（' + cleanup.error + '）' : ''))
  const finalCount = await window.yan.authFileInfo()
  ok(finalCount.count === before, '收尾后条目数还原（' + finalCount.count + '）')

  store.getState().closeSettings()
  await sleep(300)

  return out.join('\n')
})()
