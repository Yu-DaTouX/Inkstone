/**
 * 扩展来源诊断（`src/main/extensions-inventory.ts`）的测试。
 *
 * 为什么是真实临时目录而不是桩：这段逻辑只有两件事 —— 读目录、生成文案。
 * 桩掉 fs 之后剩下的就只是「文案里有没有某个词」，证明不了「读的是不是
 * 用户扩展目录」。用真目录也顺便验证了它**不会**碰用户真实的 `~/.pi`。
 */

export async function runExtensionInventoryTests(ok) {
  const { readUserExtensions, extensionDiagnostics, builtinCapabilities } = await import('../out/test/extensions-inventory.mjs')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
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
    ok(withUser[1].includes('language.js') && withUser[1].includes('薄层'), '第二行是砚薄层（用 basename）')
    ok(
      withUser[2].includes('left-panel-tasks') && withUser[2].includes('只读'),
      '有用户扩展时说明旧条目的只读语义'
    )
    /*
     * S4 后文案要跟 S3 的事实对齐（宿主真在写）：
     *   · 不能说「砚只读不写」—— 那是 S3 之前的真相；
     *   · 要说清同一轮两者的优先关系（否则用户排障时会猜错谁写的）。
     */
    ok(
      withUser[2].includes('宿主日志') && withUser[2].includes('以宿主日志为准'),
      '说明两条写入路径与「宿主日志优先」的规则'
    )
    ok(
      !withUser[2].includes('砚只读取并显示'),
      '不再声称砚只读不写（宿主从 S3 起真在写）'
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
      '/x/resources/pi-extensions/browser.js',
      '/x/resources/pi-extensions/capability-guide.js',
      '/x/resources/pi-extensions/language.js'
    ])
    ok(caps[0].id === 'task-plan', '第一条恒为宿主任务计划（它是服务，不是扩展文件）')
    ok(caps[0].file === undefined, '宿主任务计划没有文件名（界面不能拿它去指目录）')
    ok(caps.length === 4, `四个条目（实际 ${caps.length}）`)
    ok(
      caps.map((c) => c.id).join('|') === 'task-plan|browser|capability-guide|language',
      'id 按文件名去后缀、且保持传入顺序'
    )
    ok(caps[1].file === 'browser.js', '保留文件名（未登记文案时的兜底显示）')

    const dedup = builtinCapabilities(['/a/language.js', '/b/language.js'])
    ok(dedup.filter((c) => c.id === 'language').length === 1, '同名扩展只列一次（不同安装形态同源）')

    const empty = builtinCapabilities([])
    ok(empty.length === 1 && empty[0].id === 'task-plan', '没有薄层文件时仍列出宿主任务计划')

    const suffixes = builtinCapabilities(['/x/foo.mjs', '/x/bar.ts', '/x/baz.cjs'])
    ok(
      suffixes.map((c) => c.id).join('|') === 'task-plan|foo|bar|baz',
      '各种后缀都能去掉（.mjs / .ts / .cjs）'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
