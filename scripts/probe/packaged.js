/*
 * 打包产物验收（`npm run test:packaged`）。
 *
 * 为什么单独一个探针：前面 30 个场景全跑在**开发态**（`npx electron .`），
 * 而打包后 pi 运行时的定位从 `resources/pi-runtime`（仓库）变成
 * `process.resourcesPath/pi-runtime`（安装目录，extraResources）——
 * 路径错了应用**能启动但连不上 pi**，界面只显示「未连接」，
 * 开发态的测试全绿也照样复现不了。
 *
 * 所以这里断言的是「用的是打包里的那份运行时」而不是「随便找到了一份 pi」。
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

  log('=== 打包产物：内置 pi ===')
  log('')

  // 1. 连接就绪 —— 打包后 pi 入口走 process.resourcesPath，找不到就会一直 starting
  let st = store.getState().conn
  for (let i = 0; i < 60 && st !== 'ready'; i++) {
    await sleep(500)
    st = store.getState().conn
  }
  ok(st === 'ready', `conn = ${st}（应为 ready —— 打包里的 pi 真的起来了）`)

  // 2. 关键：pi 入口必须落在**打包出来的** resources/pi-runtime 里
  const info = await window.yan.piInfo()
  log('  piInfo = ' + JSON.stringify(info))
  const bin = String(info?.bin ?? '')
  ok(/pi-runtime[\\/]dist[\\/]bundle[\\/]cli\.js$/i.test(bin), 'pi 入口来自内置运行时（resources/pi-runtime/…/cli.js）')
  ok(!/AppData[\\/]Roaming[\\/]npm/i.test(bin), '没有退回到全局安装的 pi')
  ok(!!info?.version, `报到版本号：${info?.version || '(空)'}`)

  // 3. RPC 真的活着（不是只把状态置成了 ready）
  const cmds = await window.yan.listCommands()
  ok(Array.isArray(cmds), `get_commands 有返回（${cmds?.length ?? 0} 条）`)

  // 4. 没显示连接失败条；输入框可用
  ok(!q('.connbar'), '没有连接失败条')
  const ta = q('[data-testid="composer"]')
  ok(ta && !ta.disabled, '输入框可用')

  // 5. 扩展加载不报错（用户自己的扩展如 left-info-panel 仍然会加载）
  const logs = store.getState().logs ?? []
  const extErr = logs.filter((l) => /extension_error/i.test(String(l)))
  log(`  日志里与扩展相关的报错行：${extErr.length}`)
  if (extErr.length) log('  ' + extErr.join('\n  '))
  ok(extErr.length === 0, '扩展加载没有报错')

  /*
   * 6. 项目知识可读（实施-03 S6）：证明**解包实例**也能走通
   * 「按当前会话推导身份 → 读 YAN_DIR 下的知识」这条路。
   *
   * 读写到底落在哪里由 Node 侧核验（探针读不到 YAN_DIR）；
   * 这里只看「要得回来」与「拿的是自己的项目」。
   */
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
      /* 主进程还没就绪 */
    }
    await sleep(500)
  }
  log('  knowledge.list = ' + JSON.stringify(kn ? { projectId: kn.projectId, ids: (kn.entries ?? []).map((e) => e.id) } : null))
  ok(!!kn, '项目知识列表能读回来（IPC 在打包态可用）')
  ok((kn?.entries ?? []).some((entry) => entry.id === 'kn-packaged'), '读到 fixture 条目（项目身份对得上）')

  log('')
  log('=== Git 审查与写操作（解包态，实施-07 包验收）===')
  /*
   * 何时要真做一次写操作：开发态的 `gitwrite` 场景验的是「仓库能写」，
   * 而包里可能踩的是另一类坑（git 子进程找不着、路径校验过不去、写到了别处）。
   * 仓库是 Node 侧建的临时仓库，在项目列表里注册；写完之后由 Node 侧
   * 跑 `git status --porcelain` 核对 —— 渲染端伪造不了那一层。
   */
  const settingsForGit = await window.yan.getSettings().catch(() => null)
  const repoPath = (settingsForGit?.projects ?? []).find((p) => p.name === 'pkg-git-repo')?.cwd ?? null
  if (!repoPath) {
    ok(false, '项目列表里找不到夹具仓库（Node 侧没写进 desktop.json？）')
  } else {
    try {
      const st = await window.yan.git.state(repoPath)
      log(`  git.state = ${JSON.stringify({ repo: !!st?.repo, branch: st?.repo?.branch ?? null, error: st?.error ?? null })}`)
      ok(!!st?.repo, '解包实例认得这个仓库（git 子进程真跑起来了）')

      /*
       * 审查面板是**只读**的另一条链路（snapshot → patch → content），
       * 与下面的写操作坏在不同地方：写会坏在权限与路径校验，读会坏在
       * diff 解析、编码与临时文件。所以先读一次真实改动，再写。
       *
       * 断言的是**内容**而不是「返回了对象」：数量与新增行文本必须和
       * Node 侧制造的那次改动（`one` → `one\ntwo`）对得上。
       */
      const reviewScope = { kind: 'unstaged' }
      const snap = await window.yan.git.snapshot({
        cwd: repoPath,
        scope: reviewScope,
        requestId: 'pkg-git-review-1'
      })
      const changed = (snap?.files ?? []).find((f) => f.path === 'tracked.txt')
      log(
        `  git.snapshot = ${JSON.stringify({ ok: snap?.ok, files: (snap?.files ?? []).map((f) => f.path), stats: snap?.stats ?? null })}`
      )
      ok(snap?.ok === true && !!changed, '审查快照读到那次未暂存改动（tracked.txt 在清单里）')

      const patch = await window.yan.git.patch({
        cwd: repoPath,
        scope: reviewScope,
        path: 'tracked.txt',
        requestId: 'pkg-git-review-2'
      })
      const added = (patch?.hunks ?? [])
        .flatMap((h) => h.lines ?? [])
        .filter((l) => l.type === 'add')
        .map((l) => l.text.trim())
      log(
        `  git.patch = ${JSON.stringify({ ok: patch?.ok, additions: patch?.additions ?? null, deletions: patch?.deletions ?? null, added }) }`
      )
      ok(
        patch?.ok === true && patch.additions === 1 && patch.deletions === 0 && added.join('|') === 'two',
        '审查补丁拿到真实 hunk（新增行 two / 增 1 删 0 —— 与 Node 侧制造的改动一致）'
      )

      const content = await window.yan.git.content({
        cwd: repoPath,
        scope: reviewScope,
        path: 'tracked.txt',
        side: 'new',
        requestId: 'pkg-git-review-3'
      })
      log(`  git.content = ${JSON.stringify({ ok: content?.ok, side: content?.side, bytes: content?.bytes ?? null })}`)
      ok(
        content?.ok === true && String(content?.text ?? '').replace(/\r\n/g, '\n') === 'one\ntwo\n',
        '「显示完整文件」那条路读得到新侧内容（one / two 两行）'
      )

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
  log('=== 上下文策略设置项（解包态，实施-06 包验收）===',)
  /*
   * 解包实例里「设置项能不能读写」在开发态永远是绿的（读的是仓库里的 out/ 与真实的
   * 用户目录）。包里的风险是另一类：设置落到安装目录、或写入通道在打包后被裁掉。
   * 所以这里真写一次再读回 —— 值的往返本身就是证据。
   */
  try {
    const before = await window.yan.getSettings()
    log(`  写前 contextPolicy = ${JSON.stringify(before?.contextPolicy ?? null)}`)
    const after1 = await window.yan.patchSettings({ contextPolicy: { workingSetCap: 123456 } })
    log(`  contextPolicy.workingSetCap 写 123456 → 读回 ${after1?.contextPolicy?.workingSetCap}`)
    ok(after1?.contextPolicy?.workingSetCap === 123456, '上下文策略设置项在打包态可写可读（往返一致）')

    /*
     * 再改一次：证明是**真在改**而不是“第一次写进去后就不动了”。
     * 不把值改回去 —— 这是隔离沙箱里的一次性实例，没有“探针留下的怪设置”可留；
     * 硬要写回默认值反而会撞上主进程对“等于默认就清掉覆盖”的归一化（实测踩过）。
     */
    const after2 = await window.yan.patchSettings({ contextPolicy: { workingSetCap: 200000 } })
    log(`  再写 200000 → 读回 ${after2?.contextPolicy?.workingSetCap}`)
    ok(after2?.contextPolicy?.workingSetCap === 200000, '再改一次仍然生效（不是只能写一次）')
    log(`  策略视图 = ${JSON.stringify(after2?.contextPolicy ?? null)}`)
  } catch (error) {
    ok(false, `上下文策略设置项在打包态读写失败：${error?.message ?? error}`)
  }

  log('')
  log('=== 交接（解包态）===')
  /*
   * 交接（实施-05 S5b / S6）：解包态能读回状态，且**自动交接默认开**。
   *
   * 为何必须在包里验：`handoffCommitEnabled` 读的是环境变量，
   * 而用户装完启动时的环境是干净的 —— 「装完即默认开」是产品口径本身。
   */
  let handoff = null
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await window.yan.getHandoff()
      if (res && typeof res.autoCommit === 'boolean') {
        handoff = res
        break
      }
    } catch {
      /* 主进程还没就绪 */
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
  ok(handoff?.autoCommit === true, '自动交接默认开（用户拍板；装完即生效）')
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

    store.getState().openSettings('capabilities')
    await sleep(700)
    ok(!!q('[data-testid="set-capabilities"]'), '解包态能力设置页已打开')
    ok(!!q('[data-testid="cap-strategy"]'), '解包态能力策略区域已渲染')
    ok(!!q('[data-testid="cap-search"]'), '解包态能力搜索区域已渲染')
    ok(!!q('[data-testid="cap-builtins"]'), '解包态内置能力区域已渲染')
    ok(!!q('[data-testid="cap-mcp"]'), '解包态 MCP 区域已渲染')
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
      /* 出现两次：一次是输入回显，一次是命令真的执行后的输出 */
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

  return out.join('\n')
})()
