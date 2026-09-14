#!/usr/bin/env node
/**
 * 一键启动「砚」。
 *
 * 为什么需要它（而不是让用户记 `npm run dev`）：
 *   ① **首次克隆的仓库跑不起来** —— 新克隆缺两样生成物：
 *      · `node_modules`（字体是 npm 依赖，不装就没字体）
 *      · `resources/pi-runtime/`（内置 pi 运行时，20MB，不入库）
 *      用户只会看到「窗口一片空白」或「pi 未连接」，猜不到要去跑 vendor:pi。
 *   ② **改了源码要用旧的还是新的** —— `npx electron .` 读的是 `out/`（构建产物），
 *      源码改了但没构建就会跑旧版本。这里会比对时间自动决定要不要 build。
 *   ③ **控制台窗口不该一直挂着** —— Electron 是 GUI 程序，
 *      启动后把父进程退掉，控制台自己关。
 *
 * 用法：
 *   node scripts/launch.mjs            正常启动（需要时自动构建）
 *   node scripts/launch.mjs --dev      开发模式（HMR，改渲染层即时生效）
 *   node scripts/launch.mjs --rebuild  强制重新构建
 *   node scripts/launch.mjs --dry      只做检查，不启动（排查用）
 */
import { existsSync, statSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`
}

const say = (...a) => console.log(...a)
const step = (s) => say(`\n${C.b('▸')} ${s}`)

/*
 * 横幅在这里而不在 .cmd 里。
 * 原因：cmd.exe 按系统 OEM 代码页（中文 Windows 是 GBK）读 .cmd 文件，
 * 文件里的非 ASCII 字节会在 `chcp` 生效**之前**就把行解析弄崩
 * （实测：整个 .cmd 一行都没执行成功）。所以 .cmd 保持纯 ASCII，
 * 中文一律由 node 打印 —— 配合 .cmd 里的 `chcp 65001`，显示正常。
 */
say('')
say(`  ${C.b('砚')} ${C.dim('·')} 个人 agent 桌面端`)
say(`  ${C.dim('─'.repeat(38))}`)

/* 1. 依赖检查 */
step('检查环境')

if (!existsSync(join(root, 'package.json'))) {
  say(C.err('  找不到 package.json —— 这个脚本要在项目根目录下运行'))
  process.exit(1)
}

if (!existsSync(join(root, 'node_modules', 'electron'))) {
  say(C.warn('  缺 node_modules，开始安装依赖（首次需要几分钟）…'))
  const r = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    say(C.err('  npm install 失败，请手动跑一次看看报错'))
    process.exit(1)
  }
}
say(`  ${C.ok('✓')} node_modules`)

/*
 * 内置 pi 运行时（20MB，不入库 —— 由 npm run vendor:pi 从本机已装的 pi 抽取）。
 * 没有它应用能启动，但连不上 pi（界面会显示「pi 未连接」），
 * 所以这里主动补上，而不是让用户对着错误信息猜。
 */
const piRuntime = join(root, 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')
if (!existsSync(piRuntime)) {
  say(C.warn('  缺内置 pi 运行时，开始抽取（需要本机装过一个 pi）…'))
  const r = spawnSync('node', [join(root, 'scripts', 'vendor-pi.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (r.status !== 0) {
    say(C.err('  抽取失败。先装一个 pi：npm i -g @earendil-works/pi-coding-agent'))
    say(C.dim('  （只是抽取时需要它，装好之后最终用户不需要）'))
    process.exit(1)
  }
}
say(`  ${C.ok('✓')} 内置 pi 运行时`)

/* GUI 进程不能带 ELECTRON_RUN_AS_NODE —— 从 Electron 应用内嵌的终端里启动时，
   它会把 Electron 二进制降级成纯 Node（无窗口、静默 exit 0）。见 test-packaged.mjs。 */
const launchEnv = { ...process.env }
delete launchEnv.ELECTRON_RUN_AS_NODE

/* 2. 开发模式：直接交给 electron-vite（它自己会 build + watch） */
if (has('--dev') || has('-d')) {
  step('开发模式（HMR）')
  say(C.dim('  改 src/renderer/** 即时生效；改 src/main/** 需要重启（或加 --watch）'))
  const child = spawn('npm', ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: true, env: launchEnv })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  /* 3. 生产模式：out/ 比源码旧就重新构建 */
  const outMain = join(root, 'out', 'main', 'index.js')

  /** 源码里最新的一个 mtime（只看目录，不看 node_modules / out） */
  const newestSource = () => {
    let newest = 0
    const walk = (dir, depth = 0) => {
      if (depth > 6) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'out' || e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else {
          if (!/\.(ts|tsx|css|json|html)$/.test(e.name)) continue
          const m = statSync(p).mtimeMs
          if (m > newest) newest = m
        }
      }
    }
    walk(join(root, 'src'))
    for (const f of ['package.json', 'electron.vite.config.ts']) {
      const p = join(root, f)
      if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs)
    }
    return newest
  }

  const needBuild =
    has('--rebuild') || !existsSync(outMain) || newestSource() > statSync(outMain).mtimeMs

  if (needBuild) {
    step(has('--rebuild') ? '重新构建（--rebuild）' : '构建（产物不存在或比源码旧）')
    const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
    if (r.status !== 0) {
      say(C.err('  构建失败，应用不会启动'))
      process.exit(1)
    }
  } else {
    step('构建产物是最新的')
    say(C.dim('  跳过构建（要强制重建：node scripts/launch.mjs --rebuild）'))
  }

  if (has('--dry')) {
    say(`\n${C.ok('检查通过')} ${C.dim('（--dry：不启动）')}`)
    process.exit(0)
  }

  /* 4. 启动 Electron（脱离父进程 → 控制台自己关掉） */
  step('启动')
  const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const bin = existsSync(electron) ? electron : 'npx'

  /*
   * detached + stdio:'ignore' + unref()：
   *   三个都要。detached 让子进程成为独立进程组（关掉宿主终端不会连带杀掉窗口），
   *   ignore 让 stdout/stderr 不再拴住父进程，
   *   unref 让 node 事件循环不再等待它 —— 这样这个脚本立刻退出、
   *   控制台窗口自动关闭，只留下应用窗口。
   * 要排查启动问题就加 --dev（那个模式是 stdio:inherit，日志都在）。
   */
  const child = spawn(bin, existsSync(electron) ? ['.'] : ['electron', '.'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    shell: !existsSync(electron),
    env: launchEnv
  })
  child.unref()

  say(`  ${C.ok('✓')} 已启动 ${C.dim('（这个窗口稍后会自动关闭）')}`)
  setTimeout(() => process.exit(0), 400)
}
