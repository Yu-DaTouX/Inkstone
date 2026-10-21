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
    const names = readUserExtensions(piDir)
    ok(names.length === 3, `列出 3 项（实际 ${names.length}：${names.join('、')}）`)
    ok(names.includes('left-info-panel.ts'), '.ts 扩展被列出')
    ok(names.includes('helper.js'), '.js 扩展被列出')
    ok(names.includes('packed-ext'), '扩展包目录被列出（它可能是 index.ts）')
    ok(!names.includes('notes.md'), '普通文件不被当成扩展')
    ok(!names.includes('.hidden.ts'), '隐藏文件被跳过')
    ok(names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'), '顺序稳定（诊断可 diff）')

    ok(readUserExtensions(join(root, 'nope')).length === 0, '目录不存在时返回空清单（不抛）')

    const withUser = extensionDiagnostics({ piDir, yanThinPaths: ['/x/resources/pi-extensions/language.js'], nativeDiscovery: false })
    ok(withUser.length === 3, `有用户扩展时 3 行（实际 ${withUser.length}）`)
    ok(withUser[0].includes('用户扩展 3 项'), '第一行列出来源与数量')
    ok(withUser[0].includes('left-info-panel.ts'), '第一行含具体条目名')
    ok(withUser[0].includes('--no-extensions') && withUser[0].includes('不自动加载'), '旧版诊断与隔离发现参数一致')
    ok(withUser[1].includes('language.js') && withUser[1].includes('薄层'), '第二行是砚薄层（用 basename）')
    ok(
      !withUser[1].includes('yan context recall'),
      '薄层诊断不再提已退役的归档回读'
    )
    ok(
      withUser[1].includes('question') && withUser[1].includes('todos') && withUser[1].includes('yan question ask') && withUser[1].includes('兼容入口'),
      '薄层诊断说明提问与待办是回到宿主执行的工具，CLI 保留为兼容入口'
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

    await rm(extDir, { recursive: true, force: true })
    const clean = extensionDiagnostics({ piDir, yanThinPaths: ['/x/resources/pi-extensions/language.js'], nativeDiscovery: true })
    ok(clean.length === 3, `干净环境 3 行（实际 ${clean.length}）`)
    ok(clean[0].includes('未检测到用户扩展'), '第一行如实说没有')
    ok(clean.some((l) => l.includes('left-panel-tasks') && l.includes('只读')), '没有用户扩展也保留历史任务只读边界说明')

    const noThin = extensionDiagnostics({ piDir: join(root, 'missing'), yanThinPaths: [], nativeDiscovery: true })
    ok(noThin[1].includes('（无）'), '没有薄层时显示「（无）」而不是空字符串拼接')

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

  {
    const HOST_ONLY_COMMAND_FILE = 'native-session-bridge.js'
    const HOST_ONLY_COMMAND_NAME = '__inkstone_native'

    function scanThinLayerSources(sources) {
      const offenders = []
      for (const [file, source] of sources) {
        const toolCalls = source.match(/\.registerTool\s*\(/g)?.length ?? 0
        const bashOverride =
          file === 'shell-fallback.js' &&
          toolCalls === 1 &&
          /const template = core\.createBashToolDefinition\(/.test(source) &&
          /\.registerTool\(\{\s*\.\.\.template,\s*execute:/.test(source)
        const mcpAppProxy =
          file === 'mcp-app-proxy.js' && toolCalls === 1 && /\.registerTool\(definition\)/.test(source)
        const hostTool =
          (file === 'question.js' && toolCalls === 1 && /\.registerTool\(createQuestionTool\(\)\)/.test(source)) ||
          (file === 'capability-guide.js' && toolCalls === 1 && /\.registerTool\(createTodosTool\(\)\)/.test(source))
        const readOnlyTools =
          file === 'readonly-tools.js' &&
          toolCalls === 3 &&
          ['GIT_INSPECT_TOOL', 'WEB_SEARCH_TOOL', 'WEB_FETCH_TOOL'].every((name) => source.includes(`.registerTool(${name})`))
        if (toolCalls && !bashOverride && !mcpAppProxy && !hostTool && !readOnlyTools) offenders.push(`${file}:registerTool`)

        const commandCalls = source.match(/\.registerCommand\s*\(/g)?.length ?? 0
        if (commandCalls === 0) continue
        if (file !== HOST_ONLY_COMMAND_FILE) {
          offenders.push(`${file}:registerCommand`)
          continue
        }
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

    const offenders = scanThinLayerSources(sources)
    ok(
      offenders.length === 0,
      `薄层只注册经批准的模型工具（shell-fallback / mcp-app-proxy / question / todos / 只读子代理工具），pi 命令只放行宿主专用那一个（扫了 ${files.length} 个文件）`,
      offenders.join('、')
    )

    const bridgeSource = sources.find(([file]) => file === HOST_ONLY_COMMAND_FILE)?.[1] ?? ''
    ok(bridgeSource.includes(`export const NATIVE_COMMAND = '${HOST_ONLY_COMMAND_NAME}'`), '宿主命令名精确为 __inkstone_native')
    ok((bridgeSource.match(/\.registerCommand\s*\(/g)?.length ?? 0) === 1, '宿主桥只注册一个命令')
    ok(!/\.registerTool\s*\(/.test(bridgeSource), '宿主桥不注册任何模型工具')
    ok(/YAN_NATIVE_BRIDGE\s*!==\s*'1'/.test(bridgeSource), '宿主桥由 YAN_NATIVE_BRIDGE 环境闸门限制')

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
