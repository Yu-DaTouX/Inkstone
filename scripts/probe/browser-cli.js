/**
 * `yan browser …` 宿主能力命令（01-S4b）——真实窗口 + 真实 CLI + 真实浏览器服务，不调模型。
 *
 * ── 为什么能 cost 0 ──
 *   砚有一条**不经模型**的直执行 shell 通道（`window.yan.runBash` → pi 的 `bash` RPC），
 *   它继承的正是 pi 子进程的环境：PATH 前置了 `yan` 启动器、`YAN_CLI_*` 身份也在里面。
 *   所以这条场景验的是**真正的进程外 CLI → 宿主端点 → 浏览器服务**整条链，
 *   而不是在渲染端直接调 IPC（那条链由 `browser` / `browserboundary` 覆盖）。
 *
 * ── 这条场景在防什么 ──
 *   ① 扩展不再注册模型工具/命令 → 能力只能从 CLI 来（否则 01-S5 一移除装载就丢能力）；
 *   ② CLI 三个入口（KNOWN_COMMANDS / runBrowserCommand / yan.mjs 用法表）真的成对；
 *   ③ 失败要**可读且可分支**：打错子命令、漏参数、浏览器没开、参数不是数字、
 *      用户接管 —— 五种都不许变成 Node 堆栈；
 *   ④ 大结果落文件、stdout 只有摘要（否则一次 observe 就是几十 KB 进上下文）。
 *
 * ── 外网依赖 ──
 *   只有 `about:blank`（不依赖外网可达性）。
 *
 * ── 鼠标类动作为什么默认跳过（实测记录）──
 *   本套测试默认**不上屏**（`YAN_PROBE_HIDDEN=1`）。实测：
 *   `Input.dispatchMouseEvent{type:'mouseWheel'}` 在隐藏窗口里**永远不返回**
 *   （20s 超时；同一台机器同一版代码，`YAN_SHOW_WINDOW=1` 时 213ms 返回）。
 *   这是 Chromium 对不可见窗口不做输入分发导致的，**迁移前就存在**
 *   （旧 `browser_scroll` 走的是同一个 `InputController.scroll`），
 *   本片只是把它钉成可复现记录。
 *   所以 scroll 的真实滚动只在窗口上屏时断言，否则显式跳过并打印原因。
 *   —— 跳过不是假装通过：证据表里写明了它们在哪种条件下被验过。
 *
 *   同一类问题还有两个（都是**同一次实测发现的、迁移前就有的**）：
 *   · `Page.captureScreenshot` 在 WebContentsView **没有 bounds** 时会挂住
 *     —— 用户没打开浏览器面板就不给视图排尺寸，截图因此永远等不到应答；
 *     所以 §10 先按真实 UI 路径把面板打开再截图。
 *   · `click` / `type` 需要**带元素的页面**，而 `about:blank` 上一个可交互元素
 *     也没有；唯一现成的本地页面 fixture 属于 L04（它跟一批 Cookie 转移断言绑定，
 *     不能跟着开关一起拿过来）。它们与旧工具的等价性因此靠
 *   “同一服务方法、只换调用方” + 同链路的 `press` 实测来背书。
 */
;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => {
    out.push(`  ${cond ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(cond)
  }
  const skip = (label, why) => out.push(`  ⤺ 跳过：${label}（${why}）`)
  const note = (label) => out.push(`  ⤺ ${label}`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  /** 跑一条直执行命令，等它结束（带硬超时：单步挂住不该让整个场景哑掉） */
  const runCli = async (command, waitMs = 20000) => {
    const started = Date.now()
    const raced = await Promise.race([
      window.yan
        .runBash(command)
        .then((v) => ({ done: 'ok', v }))
        .catch((e) => ({ done: 'err', v: String(e && e.message) })),
      sleep(waitMs).then(() => ({ done: 'timeout' }))
    ])
    if (raced.done !== 'ok') {
      return { ok: false, exitCode: null, output: '', error: `命令未在 ${waitMs}ms 内结束（${raced.done}）` }
    }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(120)
      const msgs = store.getState().messages.filter((m) => m.role === 'bash')
      const last = msgs[msgs.length - 1]
      const call = last && last.toolCalls && last.toolCalls[0]
      if (last && call && call.status !== 'running' && call.status !== 'pending') {
        return {
          ok: true,
          exitCode: last.bash ? last.bash.exitCode : null,
          output: call.output ?? '',
          elapsed: Date.now() - started
        }
      }
    }
    return { ok: false, exitCode: null, output: '', error: '等工具行完成超时' }
  }

  /** CLI 的最后一行 JSON 就是它的回执（stdout 只有这一段） */
  const lastJson = (text) => {
    const lines = String(text).split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* 继续往前找 */
      }
    }
    return null
  }

  /** 堆栈的形状：Node 的「at … :行:列」——可读错误里不该出现它 */
  const looksLikeStack = (text) => /\n\s+at\s+\S/.test(text) || /\bat\s+\S+\s+\(\S+:\d+:\d+\)/.test(text)

  /** 用 Node 读结果文件（渲染端拿不到任意文件读，直执行 shell 可以） */
  const readJsonFile = async (path) => {
    const res = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try {
      return JSON.parse(res.output)
    } catch {
      return null
    }
  }

  /** 用 Node 写一个小文件（内容用 JSON.stringify，避开 shell 引号地狱） */
  const writeFile = async (name, expression) => {
    const res = await runCli(
      `node -e "require('fs').writeFileSync(process.argv[1], ${expression})" "${name}"`
    )
    return res.exitCode === 0
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(250)
      } else await sleep(120)
    }

    let ready = false
    for (let i = 0; i < 40; i++) {
      if (store.getState().conn === 'ready') {
        ready = true
        break
      }
      await sleep(500)
    }
    if (!ready) {
      return early(`  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），本场景要真的跑 yan CLI`)
    }
    await sleep(400)

    /* ─────────────────────────────────────────── 0. 命令面 ─────────── */
    out.push('=== 0. 扩展面：browser 不再由扩展注册 ===')
    const commands = store.getState().commands ?? []
    const browserCommands = commands.filter((c) => String(c.name).toLowerCase() === 'browser')
    out.push(`  commands 里 name=browser 的 source：${JSON.stringify(browserCommands.map((c) => c.source))}`)
    ok(
      browserCommands.every((c) => c.source === 'yan'),
      '没有 source=extension 的 browser 命令（扩展的 registerCommand 已移除）'
    )
    ok(browserCommands.some((c) => c.source === 'yan'), 'Yan 自己的 /browser 仍在本机命令表里')
    note('模型工具面（getAllTools）没有 RPC 出口；「browser.js 注册 0 项」由 test:unit 断言')

    /* ─────────────────────────────────────────── 1. --help ─────────── */
    out.push('')
    out.push('=== 1. yan browser --help 真的能跑 ===')
    const help = await runCli('yan browser --help')
    out.push(`  退出码=${help.exitCode}`)
    ok(help.exitCode === 0, '退出码 0')
    ok(/yan browser <动作>/.test(help.output), '打出了 browser 分组的用法')
    ok(
      /navigate/.test(help.output) && /observe/.test(help.output) && /screenshot/.test(help.output),
      '用法里列出了 navigate / observe / screenshot'
    )
    ok(!looksLikeStack(help.output), '没有抛出堆栈')

    /* ─────────────────────────────── 2. 打错的子命令 ─────────────── */
    out.push('')
    out.push('=== 2. 未知子命令：可读提示，不是 unknown_command ===')
    const typo = await runCli('yan browser frobnicate')
    const typoBody = lastJson(typo.output)
    out.push(`  退出码=${typo.exitCode}  回执=${JSON.stringify(typoBody).slice(0, 170)}`)
    ok(typo.exitCode === 2, '用法错走退出码 2（不是 1）')
    ok(typoBody?.ok === false && /未知的 browser 子命令/.test(String(typoBody?.error)), '说明「未知的 browser 子命令」')
    ok(/navigate/.test(String(typoBody?.detail ?? '')), '详情里给出可用动作清单')
    ok(!looksLikeStack(typo.output), '没有堆栈')

    /* ─────────────────────────────────── 3. 缺参数 ─────────────── */
    out.push('')
    out.push('=== 3. 缺参数：CLI 侧 usage 错 + 宿主侧业务错两道 ===')
    const missing = await runCli('yan browser navigate')
    const missingBody = lastJson(missing.output)
    out.push(`  退出码=${missing.exitCode}  回执=${JSON.stringify(missingBody).slice(0, 170)}`)
    ok(missing.exitCode === 2, 'CLI 侧：退出码 2')
    ok(/--url/.test(String(missingBody?.error ?? '')), 'CLI 侧：指出缺 --url')
    ok(!looksLikeStack(missing.output), 'CLI 侧：没有堆栈')

    /*
     * 宿主侧那道防线用 `--request-file` 绕开 CLI 检查来验。
     * 取值用 `{"ref":"   "}`：在 CLI 眼里“非空”（能过 usage 检查），
     * 到宿主那里被 trim 成空 → 必须回 CapabilityCommandError。
     *
     * 请求文件用 `JSON.stringify` 写（**不在命令行里手写 JSON**）——
     * cmd.exe 会把内层双引号拆碎，写出来就不是合法 JSON 了（第一版就踩到了）。
     * 文件写在**会话工作目录**（本场景是 fixture 合成项目）。
     */
    const reqName = 'yan-browser-cli-req.json'
    ok(
      await writeFile(reqName, `JSON.stringify({ref:'   '})`),
      '写好了宿主侧用的请求文件'
    )
    const hostSide = await runCli(`yan browser click --request-file ${reqName}`)
    const hostSideBody = lastJson(hostSide.output)
    out.push(`  宿主侧退出码=${hostSide.exitCode}  回执=${JSON.stringify(hostSideBody).slice(0, 200)}`)
    ok(hostSide.exitCode === 1, '宿主侧：业务失败退出码 1')
    ok(
      hostSideBody?.ok === false && hostSideBody?.code === 'missing_ref',
      '宿主侧：回 code=missing_ref（CapabilityCommandError 业务错误，不是端点错误）'
    )
    ok(!looksLikeStack(hostSide.output), '宿主侧：没有堆栈')

    /* ──────────────────────────── 4. 浏览器没打开时的观察 ─────────── */
    out.push('')
    out.push('=== 4. 浏览器未打开：code=browser_not_open ===')
    await store.getState().closeBrowser()
    await sleep(300)
    const notOpen = await runCli('yan browser observe')
    const notOpenBody = lastJson(notOpen.output)
    out.push(`  回执=${JSON.stringify(notOpenBody).slice(0, 200)}`)
    ok(notOpenBody?.ok === false && notOpenBody?.code === 'browser_not_open', '回可读的 code=browser_not_open')
    ok(!looksLikeStack(notOpen.output), '没有堆栈')
    ok(notOpenBody?.resultFile === undefined, '业务错误不带数据时不落空结果文件')

    /* ─────────────────────────────────── 5. navigate ───────────── */
    out.push('')
    out.push('=== 5. navigate about:blank：真实调用 + 大结果落文件 ===')
    const nav = await runCli('yan browser navigate --url about:blank')
    const navBody = lastJson(nav.output)
    out.push(`  stdout=${JSON.stringify(navBody).slice(0, 240)}`)
    ok(navBody?.ok === true, 'CLI 回 ok=true')
    ok(typeof navBody?.operationId === 'string' && navBody.operationId.length > 0, '回执里有 operationId')
    ok(typeof navBody?.resultFile === 'string', '回执里有 resultFile')
    ok(navBody?.summary?.kind === 'browser' && navBody?.summary?.action === 'navigate', '摘要是 browser/navigate')
    ok(navBody?.summary?.open === true && navBody?.summary?.url === 'about:blank', '摘要里 open=true、url=about:blank')
    ok(!/"permissions"/.test(nav.output), 'stdout 里没有完整状态（permissions 这类只在结果文件里）')
    ok(store.getState().browserState.open === true, '渲染端状态同步为已打开（主进程真的开了原生视图）')
    ok(store.getState().browserState.url === 'about:blank', '渲染端 url=about:blank')

    if (typeof navBody?.resultFile === 'string') {
      const navFile = await readJsonFile(navBody.resultFile)
      ok(navFile !== null, '结果文件是合法 JSON（落盘契约）')
      ok(navFile?.url === 'about:blank' && navFile?.open === true, '结果文件里是完整状态（url/open）')
    }

    /* ─────────────────────────────────── 6. observe ────────────── */
    out.push('')
    out.push('=== 6. observe：结构化观察（URL / generationId / 元素数）===')
    const obs = await runCli('yan browser observe')
    const obsBody = lastJson(obs.output)
    out.push(`  stdout=${JSON.stringify(obsBody).slice(0, 240)}`)
    ok(obsBody?.ok === true, 'CLI 回 ok=true')
    ok(typeof obsBody?.summary?.generationId === 'string' && obsBody.summary.generationId.length > 0, '摘要里有 generationId')
    ok(typeof obsBody?.summary?.elements === 'number', '摘要里有元素数（规模，不是全文）')
    ok(!/"elements"\s*:\s*\[/.test(obs.output), 'stdout 里没有元素数组（全文在结果文件）')
    if (typeof obsBody?.resultFile === 'string') {
      const parsed = await readJsonFile(obsBody.resultFile)
      ok(parsed?.url === 'about:blank', '结果文件里的观察 url=about:blank', String(parsed?.url))
      ok(Array.isArray(parsed?.elements), '结果文件里的 elements 是数组（结构化观察契约没变）')
      ok(typeof parsed?.text === 'string', '结果文件里有可见文本字段')
    }

    /* ─────────────────────────────────── 7. 标签页 ─────────────── */
    out.push('')
    out.push('=== 7. state / new-tab / switch-tab / close-tab ===')
    const st = await runCli('yan browser state')
    const stBody = lastJson(st.output)
    ok(stBody?.ok === true && Array.isArray(stBody?.summary?.tabs), 'state 给出标签列表（模型拿得到 id）')
    const firstId = stBody?.summary?.tabs?.[0]?.id
    ok(typeof firstId === 'string' && firstId.length > 0, '标签有稳定 id', String(firstId))

    const newTab = await runCli('yan browser new-tab --url about:blank')
    const newBody = lastJson(newTab.output)
    const tabsAfter = store.getState().browserState.tabs ?? []
    ok(newBody?.ok === true && tabsAfter.length === 2, 'new-tab 后有两个标签', `tabs=${tabsAfter.length}`)
    const activeId = store.getState().browserState.activeTabId
    ok(typeof activeId === 'string' && activeId !== firstId, '新标签成为活动标签')

    const switchBack = await runCli(`yan browser switch-tab --id ${firstId}`)
    ok(lastJson(switchBack.output)?.ok === true, 'switch-tab 回 ok=true')
    await sleep(300)
    ok(store.getState().browserState.activeTabId === firstId, '活动标签切回目标 id')
    const closeOther = await runCli(`yan browser close-tab --id ${activeId}`)
    ok(lastJson(closeOther.output)?.ok === true, 'close-tab 回 ok=true')
    await sleep(300)
    ok((store.getState().browserState.tabs ?? []).length === 1, '关掉后只剩一个标签')

    /* ─────────────────────── 8. press / scroll ────────────────── */
    out.push('')
    out.push('=== 8. press：动作后带回新观察 ===')
    const press = await runCli('yan browser press --key Tab')
    const pressBody = lastJson(press.output)
    ok(pressBody?.ok === true, 'press 回 ok=true', String(pressBody?.error ?? ''))
    ok(typeof pressBody?.summary?.generationId === 'string', 'press 带回新观察（generationId）')

    out.push('')
    out.push('=== 9. scroll：坏参数可读；真滚动要看窗口是否可见 ===')
    const badScroll = await runCli('yan browser scroll --delta-y abc')
    const badBody = lastJson(badScroll.output)
    out.push(`  坏参数回执=${JSON.stringify(badBody).slice(0, 170)}`)
    ok(badBody?.ok === false && badBody?.code === 'invalid_number', '坏数字回 code=invalid_number（不把 NaN 传给 CDP）')
    ok(!looksLikeStack(badScroll.output), '坏参数没有堆栈')

    /*
     * ⚠️ `document.visibilityState` **不能**用来判断窗口是否真的上了屏：
     * Electron 的 `show:false` 窗口在渲染端依然报 'visible'（实测）。
     * 真正的判据是主进程那个开关（`YAN_PROBE_HIDDEN`），它对 pi 子进程可见，
     * 而直执行 shell 继承的正是 pi 的环境 —— 所以用 node 问一次环境变量。
     */
    const hiddenProbe = /^(1|true|yes)$/i.test(
      (await runCli(`node -e "process.stdout.write(String(process.env.YAN_PROBE_HIDDEN||''))"`)).output.trim()
    )
    out.push(`  YAN_PROBE_HIDDEN=${hiddenProbe}`)
    if (!hiddenProbe) {
      const scroll = await runCli('yan browser scroll --delta-y 20')
      const scrollBody = lastJson(scroll.output)
      ok(scrollBody?.ok === true, 'scroll 回 ok=true（上屏窗口）', `${scroll.elapsed ?? '?'}ms`)
      ok(typeof scrollBody?.summary?.generationId === 'string', 'scroll 带回新观察')
    } else {
      skip(
        'scroll 的真实滚动',
        'YAN_PROBE_HIDDEN：隐藏窗口里 Input.dispatchMouseEvent(mouseWheel) 不返回（实测 20s 超时；YAN_SHOW_WINDOW=1 时 213ms）'
      )
    }

    /* ─────────────────────────────────── 10. screenshot ─────────── */
    out.push('')
    out.push('=== 10. screenshot：PNG 落盘 + 摘要给路径 ===')
    /*
     * 截图同样需要**上屏**的窗口：隐藏窗口里 `Page.captureScreenshot`（fromSurface）
     * 永不返回（实测 20s 超时；YAN_SHOW_WINDOW=1 时 227ms）。
     * 本套测试默认不上屏（用户要求），所以默认跑显式跳过并在探针里标明原因；
     * 真实证据在 YAN_SHOW_WINDOW=1 的那一轮（见证据文档）。
     */
    if (hiddenProbe) {
      skip(
        'screenshot 的真实截图',
        'YAN_PROBE_HIDDEN：隐藏窗口里 Page.captureScreenshot(fromSurface) 不返回（实测 20s 超时；YAN_SHOW_WINDOW=1 时 227ms）'
      )
    } else {
      /*
       * 先把浏览器面板按**真实 UI 路径**打开：WebContentsView 的尺寸由渲染端
       * 的 BrowserSurface 同步（`setBounds`）。面板关着时视图没有 bounds，
       * 那是另一类“没有可绘制表面”的情形，不在本片验证范围。
       */
      if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
      await sleep(400)
      await store.getState().openBrowser('about:blank')
      let surface = false
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('[data-testid="browser-surface"]')) {
          surface = true
          break
        }
        await sleep(150)
      }
      ok(surface, '浏览器面板已按 UI 路径打开（视图有真实 bounds）')
      await sleep(500)
      const shot = await runCli('yan browser screenshot')
      const shotBody = lastJson(shot.output)
      out.push(`  stdout=${JSON.stringify(shotBody).slice(0, 240)}`)
      ok(shotBody?.ok === true, '截图回 ok=true', String(shotBody?.error ?? ''))
      ok(shotBody?.summary?.mimeType === 'image/png', '摘要里 mimeType=image/png')
      const savedTo = shotBody?.summary?.savedTo
      ok(typeof savedTo === 'string' && /\.png$/.test(String(savedTo)), '摘要里给了 .png 路径')
      if (typeof savedTo === 'string') {
        const magic = await runCli(
          `node -e "const b=require('fs').readFileSync(process.argv[1]);process.stdout.write(b.length+':'+b.subarray(0,4).toString('hex'))" "${savedTo}"`
        )
        const [bytes, hex] = String(magic.output).trim().split(':')
        out.push(`  文件字节=${bytes}  头 4 字节=${hex}`)
        ok(Number(bytes) > 0, 'PNG 文件非空')
        ok(hex === '89504e47', 'PNG 魔数正确（真的是图片，不是 base64 文本）')
      }
    }

    /* ─────────────────────────────────── 11. download ──────────── */
    out.push('')
    out.push('=== 11. download：没有下载时也回可读结果 ===')
    const dl = await runCli('yan browser download')
    const dlBody = lastJson(dl.output)
    ok(dlBody?.ok === true && dlBody?.summary?.has === false, 'download 回 ok=true, has=false')

    /* ─────────────────────── 12. request-user-control ──────────── */
    out.push('')
    out.push('=== 12. request-user-control：门禁仍然生效（没有放宽权限）===')
    const uc = await runCli('yan browser request-user-control --reason 探针')
    const ucBody = lastJson(uc.output)
    ok(ucBody?.ok === true && ucBody?.summary?.userControl === true, '回 userControl=true')
    await sleep(300)
    ok(store.getState().browserState.userControl === true, '渲染端状态同步为已接管')
    const blocked = await runCli('yan browser press --key Tab')
    const blockedBody = lastJson(blocked.output)
    out.push(`  接管期间 press 回执=${JSON.stringify(blockedBody).slice(0, 170)}`)
    ok(
      blockedBody?.ok === false && blockedBody?.code === 'USER_CONTROL_ACTIVE',
      '用户接管期间动作被拒（策略原样生效）'
    )
    await window.yan.browser.setUserControl(false)
    await sleep(200)
    ok(store.getState().browserState.userControl === false, '复位回 Agent 控制')

    /* ─────────────── 13. click / type（需要带元素的页面）─────── */
    out.push('')
    out.push('=== 13. click / type ===')
    skip(
      'click / type 的真实调用',
      '需要带元素的页面：about:blank 上没有可交互元素，而“任意页面 JavaScript”是被有意关掉的；' +
        '唯一现成的本地页面 fixture 属于 L04（与 Cookie 转移断言绑定）。' +
        '等价性依据：与旧工具调的是同一个 BrowserController.click/type（只换调用方），' +
        '同链路的参数读取与返回新观察由 §8 press 实测（同为 browserActionCommand 分支）'
    )

    await store.getState().closeBrowser()
    return out.join('\n')
  } catch (error) {
    out.push(`  ✗ 探针异常：${error instanceof Error ? error.message : String(error)}`)
    return out.join('\n')
  }
})()
