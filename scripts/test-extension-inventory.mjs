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
    const withUser = extensionDiagnostics({ piDir, yanThinPaths: ['/x/resources/pi-extensions/language.js'] })
    ok(withUser.length === 3, `有用户扩展时 3 行（实际 ${withUser.length}）`)
    ok(withUser[0].includes('用户扩展 3 项'), '第一行列出来源与数量')
    ok(withUser[0].includes('left-info-panel.ts'), '第一行含具体条目名')
    ok(withUser[0].includes('--no-extensions') && withUser[0].includes('不加载'), '第一行说明砚默认不加载用户扩展')
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
      withUser[2].includes('默认启动不会加载'),
      '说明默认启动不会加载用户扩展'
    )

    // 4. 没有用户扩展：两行，且明确说「未检测到」
    await rm(extDir, { recursive: true, force: true })
    const clean = extensionDiagnostics({ piDir, yanThinPaths: ['/x/resources/pi-extensions/language.js'] })
    ok(clean.length === 2, `干净环境 2 行（实际 ${clean.length}）`)
    ok(clean[0].includes('未检测到用户扩展'), '第一行如实说没有')
    ok(!clean.some((l) => l.includes('left-panel-tasks')), '干净环境不提旧任务条目（没有这个上下文）')

    // 5. 薄层一个都没有也不能崩（打包异常时仍要能启动并说清楚）
    const noThin = extensionDiagnostics({ piDir: join(root, 'missing'), yanThinPaths: [] })
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
   * 生命周期钩子 —— 不得注册模型工具，也不得注册 pi 命令（01 §1）。
   *
   * 运行时那一条写在 `test-context-transform.mjs`（把假 pi 对象塞进扩展，看它
   * 调不调 registerTool）；这里扫源码，因为「某个还没被单测加载的扩展偷偷注册了
   * 一个工具」运行时断言看不见。两者互补，不互相替代。
   */
  {
    const dir = join('resources', 'pi-extensions')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js')).sort()
    const offenders = []
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8')
      if (/\.registerTool\s*\(/.test(source)) offenders.push(`${file}:registerTool`)
      if (/\.registerCommand\s*\(/.test(source)) offenders.push(`${file}:registerCommand`)
    }
    ok(
      offenders.length === 0,
      `薄层不注册模型工具 / pi 命令（扫了 ${files.length} 个文件）`,
      offenders.join('、')
    )
  }
}
