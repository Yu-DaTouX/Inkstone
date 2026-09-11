/**
 * 模型接入（凭证）页。
 *
 * 被测的设计意图：
 *   ① 两条路**分得开** —— 订阅制给命令提示（不做输入框，因为 pi 的
 *      OAuth 登录只能在交互式 TUI 里发起），API key 给输入框
 *   ② **已配置但不在目录里**的 provider 也要显示（本会话踩过：用户已有
 *      `commandcode` 凭证、对话正常，界面却显示「0/N 已就绪」）
 *   ③ 写入是**合并**的（配第二个不会弄丢第一个）
 *   ④ 凭证路径可见（用户得知道文件在哪）
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
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }

  /* ================= 1. IPC：列表与路径 ================= */
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
  // 浅查要快（不能每项都起 pi 进程）
  ok(performance.now() - t0 < 3000, '浅查很快（不逐个问 pi）')

  const info = await window.yan.authFileInfo()
  log('  凭证文件 = ' + info.path + '  exists=' + info.exists + '  count=' + info.count)
  ok(info.path.includes('auth.json'), '凭证路径指向 auth.json')

  /*
   * 关键：已配置的 provider 必须出现在列表里 —— 哪怕它不在我们的目录中。
   * 否则用户会以为「什么都没配上」。
   */
  if (info.count > 0) {
    ok(
      list.some((x) => x.status === 'ready'),
      'auth.json 里有 ' + info.count + ' 条凭证，列表里至少一项标记为已就绪'
    )
  } else {
    log('  （auth.json 是空的，跳过「已配置项被列出」断言）')
  }

  /* ================= 2. 写入是合并的 ================= */
  log('')
  log('=== 2. 写入合并（不弄丢已有凭证）===')
  // 只写一个测试用的 provider，之后立刻清掉
  const TEST_ID = '__yan_probe__'
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

  /* 清理 */
  const c = await window.yan.clearAuth(TEST_ID)
  ok(c.ok, '移除测试凭证成功')
  const cleaned = await window.yan.authFileInfo()
  ok(cleaned.count === before, '移除后条目数还原（' + cleaned.count + '）')

  /* ================= 3. 界面 ================= */
  log('')
  log('=== 3. 设置 · 接入页 ===')
  store.getState().openSettings('auth')
  await sleep(900)

  const tabs = qa('.settings-tab').map((x) => x.textContent)
  log('  tabs = ' + JSON.stringify(tabs))
  ok(
    tabs.some((x) => /接入|Providers/.test(x)),
    '有「接入」tab'
  )

  const rows = qa('.auth-row')
  log('  行数 = ' + rows.length)
  ok(rows.length > 0, '渲染出接入方式列表')

  const cmds = qa('.auth-cmd')
  log('  订阅制的命令提示 = ' + cmds.length)
  ok(cmds.length > 0, '订阅制给的是命令提示（不是输入框）')

  const setBtns = qa('[data-testid^="auth-set-"]')
  ok(setBtns.length > 0, 'API key 有「填入 / 更换」按钮')

  ok(!!q('.auth-path'), '显示凭证文件路径')
  ok(!!q('[data-testid="auth-recheck"]'), '有「重新检测」按钮')

  /* 展开一个输入框，确认是 password 类型（不明文显示 key） */
  const first = setBtns[0]
  if (first) {
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(400)
    const inputs = qa('.auth-input')
    ok(inputs.length > 0, '点「填入」后出现输入框')
    if (inputs.length) {
      log('  输入框 type = ' + inputs[0].type)
      ok(inputs[0].type === 'password', '输入框是 password 类型（不暴露 key）')
    }
  }

  store.getState().closeSettings()
  await sleep(300)

  return out.join('\n')
})()
