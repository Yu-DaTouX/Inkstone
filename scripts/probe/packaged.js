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
  const openSettings = async (tab) => {
    ;(await waitElement('[data-testid="rail-settings"]')).click()
    ;(await waitElement(`#settings-tab-${tab === 'context' ? 'workspace' : tab}`)).click()
    if (tab === 'context') {
      ;(await waitElement('[data-testid="settings-section-context"]')).click()
      await waitElement('[data-testid="ctx-native-settings"]')
    } else await waitElement('[data-testid="set-capabilities"]')
  }
  const closeSettings = async () => {
    q('.settings-close')?.click()
    await sleep(400)
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

  ok(!q('.connbar'), '没有连接失败条')
  const ta = q('[data-testid="composer"]')
  ok(ta && !ta.disabled, '输入框可用')

  const logs = runtimeLogs
  const extErr = logs.filter((l) => /extension_error/i.test(String(l)))
  log(`  日志里与扩展相关的报错行：${extErr.length}`)
  if (extErr.length) log('  ' + extErr.join('\n  '))
  ok(extErr.length === 0, '扩展加载没有报错')

  log('')
  log('=== 项目知识（解包态）===')
  let kn = null
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await window.yan.knowledge.list()
      if (res && res.ok && res.projectId) {
        kn = res
        break
      }
    } catch {
    }
    await sleep(500)
  }
  log('  knowledge.list = ' + JSON.stringify(kn ? { projectId: kn.projectId, ids: (kn.entries ?? []).map((e) => e.id) } : null))
  ok(!!kn, '项目知识列表能读回来（IPC 在打包态可用）')
  ok((kn?.entries ?? []).some((entry) => entry.id === 'kn-packaged'), '读到 fixture 条目（项目身份对得上）')

  log('')
  log('=== Git 审查与写操作（解包态，实施-07 包验收）===')
  const settingsForGit = await window.yan.getSettings().catch(() => null)
  const repoPath = (settingsForGit?.projects ?? []).find((p) => p.name === 'pkg-git-repo')?.cwd ?? null
  if (!repoPath) {
    ok(false, '项目列表里找不到夹具仓库（Node 侧没写进 desktop.json？）')
  } else {
    try {
      const st = await window.yan.git.state(repoPath)
      log(`  git.state = ${JSON.stringify({ repo: !!st?.repo, branch: st?.repo?.branch ?? null, error: st?.error ?? null })}`)
      ok(!!st?.repo, '解包实例认得这个仓库（git 子进程真跑起来了）')

      const res = await window.yan.git.action({
        requestId: 'pkg-git-stage-1',
        cwd: repoPath,
        expected: st?.expected,
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
    await sleep(500)
    ok(!!q('[data-testid="ctx-native-settings"]'), '上下文设置页渲染原生 pi 控件')
    await closeSettings()
  } catch (error) {
    ok(false, `原生上下文在打包态验收失败：${error?.message ?? error}`)
  }

  log('')
  log('=== 历史交接读取（解包态）===')
  let handoff = null
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await window.yan.getHandoff()
      if (res && typeof res.autoCommit === 'boolean') {
        handoff = res
        break
      }
    } catch {
    }
    await sleep(500)
  }
  log(
    '  getHandoff = ' +
      JSON.stringify(
        handoff
          ? {
              autoCommit: handoff.autoCommit,
              threshold: handoff.threshold,
              transaction: handoff.transaction,
              pending: handoff.pending,
              hasKey: !!handoff.sessionKey
            }
          : null
      )
  )
  ok(!!handoff, '交接状态能读回来（IPC 在打包态可用）')
  ok(handoff?.transaction === null, '没有历史事务时如实为 null（不造半条）')

  log('')
  log('=== 能力设置页（解包态，实施-04 S7 包验收）===')
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
    await sleep(700)
    ok(!!q('[data-testid="set-capabilities"]'), '解包态能力设置页已打开')
    ok(!!q('[data-testid="cap-strategy"]'), '解包态能力策略区域已渲染')
    ;(await waitElement('[data-testid="settings-section-connections"]')).click()
    await waitElement('[data-testid="cap-search"]')
    ok(!!q('[data-testid="cap-search"]'), '解包态能力搜索区域已渲染')
    ok(!!q('[data-testid="cap-skills"]'), '解包态技能区域已渲染（内置能力并入技能列表）')
    ok(!!q('[data-testid="cap-mcp"]'), '解包态 MCP 区域已渲染')
    ;(await waitElement('[data-testid="settings-section-general"]')).click()
    const codemode = () => q('[data-testid="cap-codemode"]')
    const waitCodemode = async (enabled) => {
      for (let i = 0; i < 40; i += 1) {
        if (codemode()?.getAttribute('aria-checked') === String(enabled)) return true
        await sleep(50)
      }
      return false
    }
    ok(codemode()?.getAttribute('role') === 'switch', 'Codemode 开关可访问')
    ok(await waitCodemode(true), '旧配置未设置 Codemode 时默认开启')
    codemode()?.click()
    ok(await waitCodemode(false), '点击关闭 Codemode 更新界面')
    ok((await window.yan.getSettings()).codemodeEnabled === false, '关闭偏好经打包态 IPC 保存')
    await closeSettings()
    await openSettings('capabilities')
    await sleep(500)
    ok(await waitCodemode(false), '重开设置保留关闭偏好')
    codemode()?.click()
    ok(await waitCodemode(true), '点击重新开启 Codemode 更新界面')
    ok((await window.yan.getSettings()).codemodeEnabled === true, '重新开启偏好经打包态 IPC 保存')
    await closeSettings()
  } catch (error) {
    ok(false, `解包态能力设置页验收报错：${error?.message ?? error}`)
  }

  log('')
  log('=== 交互终端（H-11，原生依赖包内真跑）===')
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
