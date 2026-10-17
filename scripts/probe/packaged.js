;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const runtimeLogs = []
  const offLogs = window.yan.onPush((msg) => {
    if (msg.ch === 'log') runtimeLogs.push(String(msg.payload.text ?? ''))
    if (msg.ch === 'proc' && msg.payload.detail) runtimeLogs.push(msg.payload.detail)
  })
  const waitElement = async (selector) => {
    for (let i = 0; i < 80; i += 1) {
      const element = q(selector)
      if (element) return element
      await sleep(50)
    }
    throw new Error(`界面控件未出现：${selector}`)
  }
  const settingsOpen = () => q('[data-testid="v3-header-settings"]')?.dataset.active === '1'
  const openSettings = async (section) => {
    if (!settingsOpen()) (await waitElement('[data-testid="v3-header-settings"]')).click()
    await waitElement('[data-testid="settings-root"]')
    ;(await waitElement(`[data-testid="v3-settings-nav-${section}"]`)).click()
  }
  const closeSettings = async () => {
    for (let i = 0; i < 40 && settingsOpen(); i += 1) {
      document.activeElement?.blur?.()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(100)
    }
  }

  log('=== 打包产物：内置 pi ===')
  log('')

  let st = (await window.yan.agentStatus()).state
  for (let i = 0; i < 60 && st !== 'ready'; i++) {
    await sleep(500)
    st = (await window.yan.agentStatus()).state
  }
  ok(st === 'ready', `conn = ${st}（应为 ready —— 打包里的 pi 真的起来了）`)

  const info = await window.yan.piInfo()
  log('  piInfo = ' + JSON.stringify(info))
  const bin = String(info?.bin ?? '')
  ok(/pi-runtime[\\/]dist[\\/]bundle[\\/]cli\.js$/i.test(bin), 'pi 入口来自内置运行时（resources/pi-runtime/…/cli.js）')
  ok(!/AppData[\\/]Roaming[\\/]npm/i.test(bin), '没有退回到全局安装的 pi')
  ok(!!info?.version, `报到版本号：${info?.version || '(空)'}`)

  const cmds = await window.yan.listCommands()
  ok(Array.isArray(cmds), `get_commands 有返回（${cmds?.length ?? 0} 条）`)

  const ta = await waitElement('[data-testid="composer-input"]').catch(() => null)
  ok(ta && !ta.disabled, '输入框可用')

  const extErr = runtimeLogs.filter((l) => /extension_error/i.test(String(l)))
  log(`  日志里与扩展相关的报错行：${extErr.length}`)
  if (extErr.length) log('  ' + extErr.join('\n  '))
  ok(extErr.length === 0, '扩展加载没有报错')

  log('')
  log('=== Git 审查与写操作（解包态）===')
  const settingsForGit = await window.yan.getSettings().catch(() => null)
  const repoPath = (settingsForGit?.projects ?? []).find((p) => p.name === 'pkg-git-repo')?.cwd ?? null
  if (!repoPath) {
    ok(false, '项目列表里找不到夹具仓库（Node 侧没写进 desktop.json？）')
  } else {
    try {
      const gitState = await window.yan.git.state(repoPath)
      log(`  git.state = ${JSON.stringify({ repo: !!gitState?.repo, branch: gitState?.repo?.branch ?? null, error: gitState?.error ?? null })}`)
      ok(!!gitState?.repo, '解包实例认得这个仓库（git 子进程真跑起来了）')
      const res = await window.yan.git.action({
        requestId: 'pkg-git-stage-1',
        cwd: repoPath,
        expected: gitState?.expected,
        kind: 'stage',
        paths: ['tracked.txt']
      })
      log(`  git.action(stage) = ${JSON.stringify({ ok: res?.ok, failure: res?.failure ?? null })}`)
      ok(res?.ok === true, '解包实例里 stage 一个文件真的成功了')
    } catch (error) {
      ok(false, `包内 git 写操作报错：${error?.message ?? error}`)
    }
  }

  log('')
  log('=== 原生 pi 上下文（解包态）===')
  try {
    ok((await window.yan.getState())?.contextPolicy === undefined, '当前会话没有启用旧宿主上下文策略')
    const waitCompaction = async (enabled) => {
      for (let i = 0; i < 40; i += 1) {
        if ((await window.yan.getState())?.autoCompactionEnabled === enabled) return true
        await sleep(50)
      }
      return false
    }
    ok((await window.yan.setAutoCompaction(false)).ok === true, '原生 pi 自动压缩可关闭')
    ok(await waitCompaction(false), '关闭状态经 RPC 回传到当前会话')
    ok((await window.yan.setAutoCompaction(true)).ok === true, '原生 pi 自动压缩可重新开启')
    ok(await waitCompaction(true), '开启状态经 RPC 回传到当前会话')
    await openSettings('context')
    ok(!!(await waitElement('[data-testid="v3-context-settings"]').catch(() => null)), '上下文设置页在打包态渲染')
    await closeSettings()
    ok(!settingsOpen(), '关闭设置后回到会话')
  } catch (error) {
    ok(false, `原生上下文在打包态验收失败：${error?.message ?? error}`)
  }

  log('')
  log('=== 能力设置页（解包态）===')
  try {
    const capabilitySnapshot = await window.yan.capabilities.snapshot()
    const builtin = await window.yan.builtinCapabilities.list()
    const serialized = JSON.stringify(capabilitySnapshot)
    log(`  capability.snapshot = ${JSON.stringify({
      skills: capabilitySnapshot?.skills?.length ?? null,
      servers: capabilitySnapshot?.servers?.length ?? null,
      configWarning: capabilitySnapshot?.configWarning ?? null
    })}`)
    ok(Array.isArray(capabilitySnapshot?.skills), '解包态能力快照可读（skills 数组）')
    ok(Array.isArray(capabilitySnapshot?.servers), '解包态能力快照可读（MCP servers 数组）')
    ok(Array.isArray(builtin) && builtin.length > 0, '解包态内置能力列表可读')
    ok(!/(command|args|env|authRef)/i.test(serialized), '解包态能力快照不含命令 / 参数 / 环境 / 凭证引用字段')

    await openSettings('capabilities')
    ok(!!(await waitElement('[data-testid="caps-settings"]').catch(() => null)), '解包态能力设置页已打开')
    for (const tab of ['connections', 'search', 'skills']) {
      const button = await waitElement(`[data-testid="caps-tab-${tab}"]`).catch(() => null)
      button?.click()
      await sleep(200)
      ok(button?.getAttribute('aria-selected') === 'true', `解包态能力页签「${tab}」可切换`)
    }
    await closeSettings()
  } catch (error) {
    ok(false, `解包态能力设置页验收报错：${error?.message ?? error}`)
  }

  log('')
  log('=== 交互终端（原生依赖包内真跑）===')
  try {
    const avail = await window.yan.terminal.available()
    log('  terminal.available = ' + JSON.stringify(avail))
    ok(avail?.available === true, '解包态原生 PTY 依赖加载成功（asarUnpack 生效）')
    if (avail?.available) {
      const snap = await window.yan.terminal.start({ cols: 80, rows: 24 })
      ok(!!snap?.id && !!snap?.cwd, `终端已启动（${snap?.shell} @ ${snap?.cwd}）`)
      let seen = ''
      const off = window.yan.onPush((msg) => {
        if (msg.ch === 'terminal' && msg.payload.kind === 'data' && msg.payload.id === snap.id) {
          seen += msg.payload.data
        }
      })
      const token = 'YAN_PTY_OK'
      await window.yan.terminal.write(snap.id, `echo ${token}\r\n`)
      for (let i = 0; i < 48 && seen.split(token).length - 1 < 2; i += 1) await sleep(250)
      off()
      const hits = seen.split(token).length - 1
      ok(hits >= 2, `真实 PTY 输入 / 输出往返成功（${token} 出现 ${hits} 次）`)
      ok((await window.yan.terminal.resize(snap.id, 100, 30)) === true, 'resize 成功（原生 PTY 接受新尺寸）')
      const again = await window.yan.terminal.attach(snap.id)
      ok(again?.cols === 100 && again?.rows === 30, 'attach 快照反映新尺寸（断线重连可恢复）')
      ok(typeof again?.seq === 'number' && again.seq > 0, '快照带输出序号（重连去重依据）')
      ok((again?.buffer ?? '').includes(token), '重连缓冲带着之前的输出（不是空壳）')
      ok((await window.yan.terminal.kill(snap.id)) === true, '关闭终端成功')
      await sleep(400)
      ok((await window.yan.terminal.attach(snap.id)) === null, '关掉的会话不再可 attach（不返回幽灵快照）')
    }
  } catch (error) {
    ok(false, `解包态交互终端验收报错：${error?.message ?? error}`)
  }

  offLogs()
  return out.join('\n')
})()
