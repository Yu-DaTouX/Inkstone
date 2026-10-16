/**
 * 扩展来源诊断（`src/main/extensions-inventory.ts`）的测试。
 *
 * 为什么是真实临时目录而不是桩：这段逻辑只有两件事 —— 读目录、生成文案。
 * 桩掉 fs 之后剩下的就只是「文案里有没有某个词」，证明不了「读的是不是
 * 用户扩展目录」。用真目录也顺便验证了它**不会**碰用户真实的 `~/.pi`。
 */

export async function runExtensionInventoryTests(ok) {
  const { readUserExtensions, extensionDiagnostics, builtinCapabilities } = await import('../out/test/extensions-inventory.mjs')
  const { mkdtemp, mkdir, writeFile, rm, readFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  console.log('\n--- 扩展来源诊断 ---')

  const root = await mkdtemp(join(tmpdir(), 'yan-ext-inv-'))
  const piDir = join(root, 'pi-agent')
  const extDir = join(piDir, 'extensions')
  await mkdir(join(extDir, 'packed-ext'), { recursive: true })
  await writeFile(join(extDir, 'left-info-panel.ts'), 'export default () => {}\n', 'utf8')
  await writeFile(join(extDir, 'helper.js'), 'export default () => {}\n', 'utf8')
  await writeFile(join(extDir, 'notes.md'), '# 不是扩展\n', 'utf8')
  await writeFile(join(extDir, '.hidden.ts'), 'export default () => {}\n', 'utf8')

  try {
    // 1. 只列扩展（文件按后缀、目录保留），不列无关文件与隐藏项
    const names = readUserExtensions(piDir)
    ok(names.length === 3, `列出 3 项（实际 ${names.length}：${names.join('、')}）`)
    ok(names.includes('left-info-panel.ts'), '.ts 扩展被列出')
    ok(names.includes('helper.js'), '.js 扩展被列出')
    ok(names.includes('packed-ext'), '扩展包目录被列出（它可能是 index.ts）')
    ok(!names.includes('notes.md'), '普通文件不被当成扩展')
    ok(!names.includes('.hidden.ts'), '隐藏文件被跳过')
    ok(names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'), '顺序稳定（诊断可 diff）')

    // 2. 目录不存在 / 读不到 → 空清单，不是异常
    ok(readUserExtensions(join(root, 'nope')).length === 0, '目录不存在时返回空清单（不抛）')

    // 3. 诊断文案：有用户扩展时必须说清「谁写的、谁是只读的」
    const withUser = extensionDiagnostics({ piDir, yanThinPaths: ['/x/resources/pi-extensions/language.js'], nativeDiscovery: false })
    ok(withUser.length === 3, `有用户扩展时 3 行（实际 ${withUser.length}）`)
    ok(withUser[0].includes('用户扩展 3 项'), '第一行列出来源与数量')
    ok(withUser[0].includes('left-info-panel.ts'), '第一行含具体条目名')
    ok(withUser[0].includes('--no-extensions') && withUser[0].includes('不自动加载'), '旧版诊断与隔离发现参数一致')
    ok(withUser[1].includes('language.js') && withUser[1].includes('薄层'), '第二行是砚薄层（用 basename）')
    ok(
      withUser[1].includes('yan context recall'),
      '薄层诊断点明归档回读走宿主 CLI'
    )
    ok(
      withUser[1].includes('yan question ask') && withUser[1].includes('不注册模型工具'),
      '薄层诊断说明提问 / 回读都走宿主 CLI，薄层不注册模型工具'
    )
    ok(
      withUser[2].includes('left-panel-tasks') && withUser[2].includes('只读'),
      '有用户扩展时说明旧条目的只读语义'
    )
    ok(
      withUser[2].includes('宿主日志') && withUser[2].includes('不会覆盖或回写'),
      '说明宿主日志与旧条目不会被覆盖 / 回写'
    )
    ok(
      !withUser[1].includes('上下文维护的两个命令') && withUser[1].includes('Agent 原生管理'),
      '诊断不再宣称退役宿主上下文命令存在'
    )
    const native = extensionDiagnostics({ piDir, yanThinPaths: [], nativeDiscovery: true })
    ok(native[0].includes('由 pi 原生发现') && native[0].includes('pi 设置与项目信任'), '原生诊断尊重 pi 的发现与授权策略')
    ok(native[0].includes('目录清单不代表已加载') && !native[0].includes('--no-extensions'), '原生诊断不误报扩展被禁用或已加载')
    ok(native[2].includes('只读') && native[2].includes('不会覆盖或回写'), '原生发现保留旧任务记录只读边界')

    // 4. 没有用户扩展也说明历史任务只读边界，且明确说「未检测到」。
    await rm(extDir, { recursive: true, force: true })
    const clean = extensionDiagnostics({ piDir, yanThinPaths: ['/x/resources/pi-extensions/language.js'], nativeDiscovery: true })
    ok(clean.length === 3, `干净环境 3 行（实际 ${clean.length}）`)
    ok(clean[0].includes('未检测到用户扩展'), '第一行如实说没有')
    ok(clean.some((l) => l.includes('left-panel-tasks') && l.includes('只读')), '没有用户扩展也保留历史任务只读边界说明')

    // 5. 薄层一个都没有也不能崩（打包异常时仍要能启动并说清楚）
    const noThin = extensionDiagnostics({ piDir: join(root, 'missing'), yanThinPaths: [], nativeDiscovery: true })
    ok(noThin[1].includes('（无）'), '没有薄层时显示「（无）」而不是空字符串拼接')

    /*
     * 6. 受信内置能力清单（实施-02 S4）。
     * 它必须从**实际加载路径**派生 —— 否则设置页显示的清单会
     * 与 pi 真正加载的扩展漂移（那正是「不要把内置冒充成用户装的包」的反面）。
     */
    const caps = builtinCapabilities([
      '/x/resources/pi-extensions/capability-guide.js',
      '/x/resources/pi-extensions/language.js'
    ])
    ok(caps[0].id === 'task-plan', '第一条恒为宿主任务计划（它是服务，不是扩展文件）')
    ok(caps[0].file === undefined, '宿主任务计划没有文件名（界面不能拿它去指目录）')
    ok(caps[1].id === 'browser', '第二条是宿主内置浏览器（空壳扩展已移除，能力仍在清单里）')
    ok(caps[1].file === undefined, '宿主浏览器能力没有文件名（它由 yan browser CLI 提供）')
    ok(caps.length === 4, `四个条目（实际 ${caps.length}）`)
    ok(
      caps.map((c) => c.id).join('|') === 'task-plan|browser|capability-guide|language',
      '宿主固定项在前，薄层扩展按文件名去后缀、保持传入顺序'
    )
    ok(caps[2].file === 'capability-guide.js', '保留文件名（未登记文案时的兜底显示）')

    const dedup = builtinCapabilities(['/a/language.js', '/b/language.js'])
    ok(dedup.filter((c) => c.id === 'language').length === 1, '同名扩展只列一次（不同安装形态同源）')

    const empty = builtinCapabilities([])
    ok(empty.length === 2 && empty[0].id === 'task-plan' && empty[1].id === 'browser', '没有薄层文件时仍列出两个宿主能力')

    const suffixes = builtinCapabilities(['/x/foo.mjs', '/x/bar.ts', '/x/baz.cjs'])
    ok(
      suffixes.map((c) => c.id).join('|') === 'task-plan|browser|foo|bar|baz',
      '各种后缀都能去掉（.mjs / .ts / .cjs）'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  /*
   * 5. 架构检查（静态版）：砚薄层**只**承载宿主没有 CLI / RPC 等价物的
   * 生命周期钩子 —— 不得注册模型工具；pi 命令只允许一个宿主专用例外。
   *
   * 扫描全部随包适配，防止未进入专项测试的文件重新注册退役入口。
   *
   * 允许的例外有两个，都是**精确到文件、命令名、注册次数与环境闸门**的放行，
   * 而不是放行整个文件：
   *   · shell-fallback.js：用 pi 的 createBashToolDefinition 同名覆盖内置 bash
   *     （不新增工具，只换 Windows 上的执行方式）；参数一致性由 test-bash-transport 实测。
   *   · native-session-bridge.js：注册**唯一**宿主专用命令 `__inkstone_native`。
   *     pi 1.2.0 的 `ctx.navigateTree()` / `ctx.reload()` 只挂在命令上下文上，
   *     RPC 没有对应入口，宿主必须经这个扩展命令才能触达（见该文件头注释、
   *     `src/main/native-session-runtime.ts` 与 `docs/ARCHITECTURE.md`）。它是宿主
   *     内部通道：只有宿主用 `--extension` 显式加载并注入 `YAN_NATIVE_BRIDGE=1`
   *     时才注册；`agent.ts` 拒绝用户直接发送 `/__inkstone_native`，
   *     `command-registry.ts` 也会把它从命令表里过滤掉。
   *
   * 为防「白名单变成无保护空放行」，扫描写成纯函数，并用合成源码做负对照：
   * 任意 registerTool、非宿主文件的 registerCommand、宿主文件里多注册 / 改名 /
   * 不用导出的常量 / 缺环境闸门都必须被判为缺陷。
   */
  {
    const HOST_ONLY_COMMAND_FILE = 'native-session-bridge.js'
    const HOST_ONLY_COMMAND_NAME = '__inkstone_native'

    /** 纯扫描：`sources` 是 [文件名, 源码] 的可迭代。返回缺陷描述数组。 */
    function scanThinLayerSources(sources) {
      const offenders = []
      for (const [file, source] of sources) {
        const toolCalls = source.match(/\.registerTool\s*\(/g)?.length ?? 0
        const bashOverride =
          file === 'shell-fallback.js' &&
          toolCalls === 1 &&
          /const template = core\.createBashToolDefinition\(/.test(source) &&
          /\.registerTool\(\{\s*\.\.\.template,\s*execute:/.test(source)
        if (toolCalls && !bashOverride) offenders.push(`${file}:registerTool`)

        const commandCalls = source.match(/\.registerCommand\s*\(/g)?.length ?? 0
        if (commandCalls === 0) continue
        if (file !== HOST_ONLY_COMMAND_FILE) {
          offenders.push(`${file}:registerCommand`)
          continue
        }
        /* 唯一命令：恰好一次，且名字必须等于导出的 NATIVE_COMMAND 常量。 */
        if (commandCalls !== 1) {
          offenders.push(`${file}:registerCommand×${commandCalls}`)
          continue
        }
        const declared = /export const NATIVE_COMMAND = '([^']+)'/.exec(source)
        if (!declared || declared[1] !== HOST_ONLY_COMMAND_NAME) {
          offenders.push(`${file}:registerCommand-name`)
          continue
        }
        if (!/\.registerCommand\(\s*NATIVE_COMMAND\s*,/.test(source)) {
          offenders.push(`${file}:registerCommand-arg`)
          continue
        }
        /* host-only：必须在注册前拒绝非宿主环境；仅出现比较表达式不算闸门。 */
        const hostGate = /if\s*\(\s*process\.env\.YAN_NATIVE_BRIDGE\s*!==\s*'1'\s*\)\s*return\b/.exec(source)
        if (!hostGate || hostGate.index > source.indexOf('.registerCommand')) {
          offenders.push(`${file}:registerCommand-ungated`)
        }
      }
      return offenders
    }

    const dir = join('resources', 'pi-extensions')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js')).sort()
    const sources = []
    for (const file of files) sources.push([file, await readFile(join(dir, file), 'utf8')])

    /* 真实随包薄层：只允许 native-session-bridge.js 的那一个宿主命令。 */
    const offenders = scanThinLayerSources(sources)
    ok(
      offenders.length === 0,
      `薄层不注册模型工具，pi 命令只放行宿主专用那一个（扫了 ${files.length} 个文件）`,
      offenders.join('、')
    )

    /* 确认真实宿主命令名 / 注册次数 / host-only 闸门，而不是「没报错就算」。 */
    const bridgeSource = sources.find(([file]) => file === HOST_ONLY_COMMAND_FILE)?.[1] ?? ''
    ok(bridgeSource.includes(`export const NATIVE_COMMAND = '${HOST_ONLY_COMMAND_NAME}'`), '宿主命令名精确为 __inkstone_native')
    ok((bridgeSource.match(/\.registerCommand\s*\(/g)?.length ?? 0) === 1, '宿主桥只注册一个命令')
    ok(!/\.registerTool\s*\(/.test(bridgeSource), '宿主桥不注册任何模型工具')
    ok(/YAN_NATIVE_BRIDGE\s*!==\s*'1'/.test(bridgeSource), '宿主桥由 YAN_NATIVE_BRIDGE 环境闸门限制')

    /* 负对照：任何偏离都必须被扫描抓住。 */
    const negative = [
      ['任意文件 registerCommand', [['evil.js', "pi.registerCommand('help', { handler: () => {} })"]]],
      ['任意文件 registerTool', [['evil.js', "pi.registerTool({ name: 'bash', execute: () => {} })"]]],
      [
        '宿主桥多注册一个命令',
        [
          [
            HOST_ONLY_COMMAND_FILE,
            `export const NATIVE_COMMAND = '${HOST_ONLY_COMMAND_NAME}'\n` +
              `if (process.env.YAN_NATIVE_BRIDGE !== '1') return\n` +
              `pi.registerCommand(NATIVE_COMMAND, { handler: () => {} })\n` +
              `pi.registerCommand('sneaky', { handler: () => {} })\n`
          ]
        ]
      ],
      [
        '宿主桥改名',
        [
          [
            HOST_ONLY_COMMAND_FILE,
            `export const NATIVE_COMMAND = '__inkstone_native2'\n` +
              `if (process.env.YAN_NATIVE_BRIDGE !== '1') return\n` +
              `pi.registerCommand(NATIVE_COMMAND, { handler: () => {} })\n`
          ]
        ]
      ],
      [
        '宿主桥不引用导出的常量',
        [
          [
            HOST_ONLY_COMMAND_FILE,
            `export const NATIVE_COMMAND = '${HOST_ONLY_COMMAND_NAME}'\n` +
              `if (process.env.YAN_NATIVE_BRIDGE !== '1') return\n` +
              `pi.registerCommand('${HOST_ONLY_COMMAND_NAME}', { handler: () => {} })\n`
          ]
        ]
      ],
      [
        '宿主桥缺少环境闸门',
        [
          [
            HOST_ONLY_COMMAND_FILE,
            `export const NATIVE_COMMAND = '${HOST_ONLY_COMMAND_NAME}'\n` +
              `pi.registerCommand(NATIVE_COMMAND, { handler: () => {} })\n`
          ]
        ]
      ],
      [
        '宿主桥闸门方向反转',
        [[HOST_ONLY_COMMAND_FILE, bridgeSource.replace("YAN_NATIVE_BRIDGE !== '1'", "YAN_NATIVE_BRIDGE === '1'")]]
      ],
      [
        '宿主桥注册后才检查环境',
        [[HOST_ONLY_COMMAND_FILE, bridgeSource.replace("if (process.env.YAN_NATIVE_BRIDGE !== '1') return", '') + "\nif (process.env.YAN_NATIVE_BRIDGE !== '1') return\n"]]
      ],
      [
        '宿主桥同时注册模型工具',
        [
          [
            HOST_ONLY_COMMAND_FILE,
            `export const NATIVE_COMMAND = '${HOST_ONLY_COMMAND_NAME}'\n` +
              `if (process.env.YAN_NATIVE_BRIDGE !== '1') return\n` +
              `pi.registerCommand(NATIVE_COMMAND, { handler: () => {} })\n` +
              `pi.registerTool({ name: 'x', execute: () => {} })\n`
          ]
        ]
      ]
    ]
    for (const [label, synthetic] of negative) {
      ok(scanThinLayerSources(synthetic).length > 0, `负对照被抓：${label}`)
    }
    ok(
      scanThinLayerSources([[HOST_ONLY_COMMAND_FILE, bridgeSource]]).length === 0,
      '正对照：真实宿主桥单独扫描无缺陷'
    )
  }
}
