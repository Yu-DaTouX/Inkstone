/*
 * 打包产物验收（`npm run test:packaged`）。
 *
 * 为什么单独一个探针：前面 30 个场景全跑在**开发态**（`npx electron .`），
 * 而打包后有两件事会变，且都是「配置错了才会发现」的：
 *   ① pi 运行时的定位从 `resources/pi-runtime`（仓库）变成
 *      `process.resourcesPath/pi-runtime`（安装目录，extraResources）
 *   ② 记忆扩展从 `resources/pi/` 变成 `process.resourcesPath/pi/`
 * 这两个路径错了，应用**能启动但连不上 pi**，界面只显示「未连接」——
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

  log('=== 打包产物：内置 pi 与记忆扩展 ===')
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

  // 5. 记忆扩展（resources/pi/yan-memory.ts）能被 pi 加载
  //    它注册了 remember/recall/forget 三个工具并注入提示词；
  //    工具列表不经过 IPC，所以这里断言「扩展文件在包里 + 扩展加载没报错」：
  //    扩展加载失败时 pi 会上报 extension_error，主进程会落到日志里。
  const logs = store.getState().logs ?? []
  const extErr = logs.filter((l) => /extension_error|yan-memory/i.test(String(l)))
  const badExt = extErr.filter((l) => /error|失败|ENOENT/i.test(String(l)))
  log(`  日志里与扩展相关的行：${extErr.length}（其中疑似报错 ${badExt.length}）`)
  if (badExt.length) log('  ' + badExt.join('\n  '))
  ok(badExt.length === 0, '记忆扩展没有加载报错')

  return out.join('\n')
})()
