import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const skip = await compile(undefined, { platform: 'neutral', stdin: { contents: "export * from './src/shared/pi-extension-skip'\nexport { setUiLang } from './src/shared/ui-lang'", resolveDir: process.cwd(), loader: 'ts' } })

  const host = ['C:\\app\\resources\\pi-extensions\\danger-guard.js', 'C:\\app\\resources\\pi-extensions\\question.js', 'C:\\Users\\me\\.yan\\providers\\bridge.js']
  const userExt = 'C:\\Users\\me\\.pi\\agent\\extensions\\herdr-agent-state.ts'
  const goodExt = 'C:\\Users\\me\\.pi\\agent\\extensions\\good.ts'
  const pkgExt = 'C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\fancy\\index.ts'
  const loadFail = (path, reason = "Cannot find module './host-message.js'") => `\u001b[31mError: Failed to load extension "${path}": ${reason}\u001b[0m`

  const userPlan = skip.planPiExtensionSkip(['noise', loadFail(userExt)], host)
  ok(userPlan.kind === 'skip' && userPlan.culprits.length === 1 && userPlan.culprits[0].path === userExt, '用户扩展加载失败：只跳过这一个', JSON.stringify(userPlan))

  const hostPlan = skip.planPiExtensionSkip([loadFail(host[0])], host)
  ok(hostPlan.kind === 'none', '砚随包扩展坏：不跳过')
  const thinPath = 'C:\\Program Files\\Inkstone\\resources\\yan-thin\\language.js'
  ok(skip.planPiExtensionSkip([loadFail(thinPath)], [thinPath]).kind === 'none', '安装版 yan-thin 里由砚传入的扩展不跳过')
  const userNamed = 'D:\\dev\\pi-extensions\\mine.ts'
  ok(skip.planPiExtensionSkip([loadFail(userNamed)], host).kind === 'skip', '用户放在 pi-extensions 同名目录里的扩展仍按用户扩展处理')
  ok(skip.planPiExtensionSkip([loadFail(host[2])], host).kind === 'none', '砚显式传入的 Provider 扩展也不跳过')
  ok(skip.planPiExtensionSkip([loadFail(userExt), loadFail(host[0])], host).kind === 'none', '同时有砚扩展坏时整体不跳过')
  ok(skip.planPiExtensionSkip([loadFail('builtin:mcp', 'boom')], host).kind === 'none', 'pi 内置扩展坏不跳过')

  const conflictUserLater = skip.planPiExtensionSkip([`Error: Failed to load extension "${goodExt}": Tool "web_search" conflicts with ${host[0]}`], host)
  ok(conflictUserLater.kind === 'skip' && conflictUserLater.culprits[0].path === goodExt && conflictUserLater.culprits[0].conflict, '与砚扩展工具重名：跳过用户那一方')
  const conflictHostLater = skip.planPiExtensionSkip([`Error: Failed to load extension "builtin:codemode": Tool "code" conflicts with ${userExt}`], host)
  ok(conflictHostLater.kind === 'skip' && conflictHostLater.culprits[0].path === userExt && conflictHostLater.culprits[0].name === 'herdr-agent-state.ts', '被记在内置扩展名下的重名，跳过占名的用户扩展', JSON.stringify(conflictHostLater))
  const flagConflict = skip.planPiExtensionSkip([`Error: Failed to load extension "${goodExt}": Flag "--plan" conflicts with ${userExt}`], host)
  ok(flagConflict.kind === 'skip' && flagConflict.culprits[0].path === goodExt, 'flag 重名跳过后加载的那一个')
  ok(skip.planPiExtensionSkip([`Error: Failed to load extension "${host[1]}": Tool "ask" conflicts with ${host[0]}`], host).kind === 'none', '两个砚扩展互相重名：不跳过')

  ok(skip.planPiExtensionSkip(['Error: something else', 'pi exited'], host).kind === 'none', '与扩展无关的启动失败不重试')
  ok(skip.planPiExtensionSkip(['Hint: Start without extensions using "pi -ne".'], host).kind === 'all-user', '只有扩展提示、定位不到具体扩展：跳过全部用户扩展')

  const yanArgs = ['--extension', host[1], '--extension', host[0], '--extension', host[2], '--skill', 'C:\\skills\\a', '--session-dir', 'C:\\s']
  const resolved = [
    { path: pkgExt, enabled: true },
    { path: userExt, enabled: true },
    { path: goodExt, enabled: true },
    { path: 'C:\\Users\\me\\.pi\\agent\\extensions\\off.ts', enabled: false },
    { path: 'builtin:llama.cpp', enabled: false },
    { path: 'builtin:codemode', enabled: true },
    { path: 'builtin:mcp', enabled: true }
  ]
  const some = skip.piExtensionSkipArgs({ args: yanArgs, hostPaths: host, plan: userPlan, resolved })
  const loaded = some.args.filter((_, i) => i > 0 && some.args[i - 1] === '--extension')
  ok(some.args[0] === '--no-extensions' && some.skip.mode === 'some', '只跳过一个时关闭自动发现、显式列出其余扩展')
  ok(!loaded.includes(userExt) && loaded.includes(goodExt) && loaded.includes(pkgExt), '坏扩展不加载，其余用户扩展和包扩展照常加载', JSON.stringify(loaded))
  ok(loaded.includes('builtin:codemode') && loaded.includes('builtin:mcp') && !loaded.includes('builtin:llama.cpp'), '内置扩展按用户设置保留，设置里关掉的仍不加载')
  ok(!loaded.includes('C:\\Users\\me\\.pi\\agent\\extensions\\off.ts'), '用户设置里停用的扩展仍不加载')
  const sameDir = skip.piExtensionSkipArgs({ args: yanArgs, hostPaths: host, plan: userPlan, resolved: [...resolved, { path: userNamed, enabled: true }] })
  ok(sameDir.args.includes(userNamed), '跳过别的扩展时，pi-extensions 同名目录下的用户扩展照常加载')
  ok(!some.skip.builtinsSkipped && !skip.piExtensionSkipSummary(some.skip).includes('内置扩展'), '内置扩展照常加载时不提内置扩展')
  ok(loaded.indexOf(host[1]) < loaded.indexOf(host[0]) && loaded.indexOf(host[0]) < loaded.indexOf(pkgExt) && loaded.indexOf(pkgExt) < loaded.indexOf(goodExt), '加载顺序与原来一致：砚扩展在前，用户扩展按 pi 解析顺序')
  ok(some.args.includes('--skill') && some.args.includes('--session-dir'), '其他启动参数原样保留')
  ok(some.skip.extensions[0].name === 'herdr-agent-state.ts' && some.skip.othersSkipped === 0, '记录跳过的扩展')

  const pkgPlan = skip.planPiExtensionSkip([loadFail(pkgExt, 'SyntaxError')], host)
  const pkgSkip = skip.piExtensionSkipArgs({ args: yanArgs, hostPaths: host, plan: pkgPlan, resolved })
  ok(pkgSkip.skip.mode === 'some' && !pkgSkip.args.includes(pkgExt) && pkgSkip.args.includes(userExt), '包里的扩展坏只跳过这个包入口')

  const unknown = skip.piExtensionSkipArgs({ args: yanArgs, hostPaths: host, plan: userPlan, resolved: null })
  const unknownLoaded = unknown.args.filter((_, i) => i > 0 && unknown.args[i - 1] === '--extension')
  ok(unknown.skip.mode === 'all-user' && !unknownLoaded.some((path) => path.includes('.pi')), '无法枚举用户扩展时退回跳过全部用户扩展')
  ok(unknownLoaded.includes(host[0]) && unknownLoaded.includes(host[2]), '跳过全部用户扩展时砚扩展照常加载')
  ok(unknown.skip.builtinsSkipped === true && !unknownLoaded.some((path) => path.startsWith('builtin:')), '枚举失败时内置扩展也没加载，并记下来')
  ok(skip.piExtensionSkipSummary(unknown.skip).includes('内置扩展（含 MCP）本会话也未加载') && skip.piExtensionSkipDetail(unknown.skip).includes('内置扩展（含 MCP）本会话也未加载'), '横幅写明内置扩展（含 MCP）也未加载')

  const elsewhere = skip.planPiExtensionSkip([loadFail('D:\\other\\ext.ts')], host)
  const allUser = skip.piExtensionSkipArgs({ args: yanArgs, hostPaths: host, plan: elsewhere, resolved })
  const allLoaded = allUser.args.filter((_, i) => i > 0 && allUser.args[i - 1] === '--extension')
  ok(allUser.skip.mode === 'all-user' && allUser.skip.othersSkipped === 3, '定位到的路径不在解析清单里：跳过全部用户扩展并计数', JSON.stringify(allUser.skip))
  ok(allLoaded.includes('builtin:mcp') && !allLoaded.includes(goodExt), '跳过全部用户扩展时仍保留内置扩展')

  const projectPkg = 'E:\\proj\\node_modules\\proj-pkg'
  const legacyArgs = ['--no-extensions', '--extension', host[0], '--extension', projectPkg, '--model', 'x']
  const legacyPlan = skip.planPiExtensionSkip([loadFail(`${projectPkg}\\extension.js`)], [host[0]])
  const legacy = skip.piExtensionSkipArgs({ args: legacyArgs, hostPaths: [host[0]], plan: legacyPlan, resolved: null })
  ok(!legacy.skip.builtinsSkipped, '旧版 pi 本来就不加载内置扩展，不额外提示')
  ok(legacy.skip.mode === 'some' && !legacy.args.includes(projectPkg) && legacy.args.filter((arg) => arg === '--no-extensions').length === 1, '旧版 pi：只去掉出错的项目包')

  const summary = skip.piExtensionSkipSummary(some.skip)
  const detail = skip.piExtensionSkipDetail(some.skip)
  ok(summary.includes('herdr-agent-state.ts') && summary.includes('跳过'), '提示写明跳过了哪个扩展', summary)
  ok(detail.includes("Cannot find module './host-message.js'") && detail.includes(userExt), '详情写明原因与位置', detail)
  ok(detail.includes('修好或移走出问题的扩展后') && detail.includes('新建会话或重启本会话') && detail.includes('没有改动你的 pi 设置'), '详情说明修好后如何恢复、且没改用户配置')
  ok(skip.piExtensionSkipRetryFailure(some.skip, 'pi 启动后立即退出。') === '跳过扩展「herdr-agent-state.ts」后仍失败，真正原因：pi 启动后立即退出。', '跳过后仍失败的文案指明真正原因')
  const allText = skip.piExtensionSkipDetail(allUser.skip)
  ok(skip.piExtensionSkipSummary(allUser.skip).includes('全部用户扩展') && allText.includes('另有 3 个'), '跳过全部用户扩展时说明范围')
  skip.setUiLang('en-US')
  const englishOne = skip.piExtensionSkipDetail({ mode: 'all-user', extensions: [], othersSkipped: 1 })
  skip.setUiLang('zh-CN')
  ok(englishOne.includes('1 other user extension was skipped') && !englishOne.includes(' it,') && englishOne.includes('the failing extension'), '英文单复数与指代正确', englishOne)
  const { readFile, readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { selectedPiRuntime } = await import('./lib/pi-runtime-location.mjs')
  const chunks = join(selectedPiRuntime('resources/pi-runtime'), 'dist', 'bundle', 'chunks')
  const found = []
  for (const file of await readdir(chunks)) {
    const text = await readFile(join(chunks, file), 'utf8')
    if (text.includes('builtInExtensions=[')) found.push(skip.parsePiBuiltinNames(text))
  }
  ok(found.length === 1 && JSON.stringify(found[0]) === JSON.stringify(['llama.cpp', 'codemode', 'tool-search', 'mcp']), '随包 pi 恰好取到 4 个内置扩展名', JSON.stringify(found))
  ok(skip.parsePiBuiltinNames('x') === null, '找不到内置扩展清单时按失败处理')
  ok(skip.parsePiBuiltinNames('var builtInExtensions=[];') === null, '内置扩展清单为空时按失败处理')
  ok(skip.parsePiBuiltinNames('var builtInExtensions=[{name:"mcp",factory:a,builtin:!0},{name:"surprise",factory:b,builtin:!0}];') === null, '出现意料外的内置扩展名时按失败处理')
  ok(skip.parsePiBuiltinNames('var builtInExtensions=[{name:"mcp",factory:a,opts:{name:"inner"}}];') === null, '多取到嵌套的 name 时按失败处理')
  ok(JSON.stringify(skip.parsePiBuiltinNames('var builtInExtensions=[{name:"mcp",factory:a,builtin:!0}];')) === '["mcp"]', '格式正常时取出名字')
  const conflictSkip = skip.piExtensionSkipArgs({ args: yanArgs, hostPaths: host, plan: conflictUserLater, resolved }).skip
  ok(skip.piExtensionSkipDetail(conflictSkip).includes('重名'), '工具重名的提示写明是重名')
})
