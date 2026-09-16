/**
 * 分批跑视觉矩阵：**每组一个 Electron 进程**。
 *
 * 为什么不直接 `electron scripts/visual-matrix.mjs`（一个进程跑完 7 组）：
 * 这台机器上跑满时，后半程会出现 `Network service crashed` +
 * `GPU process exited unexpectedly`，脚本停住不动（只截到前几张）。
 * 拆开之后每组都能独立成功，某一组失败也不影响其它组，重跑也只重跑那一组。
 *
 * ── 为什么从 `spawnSync` 改成 `spawn` + 超时（2026-09-16 事故）──
 *
 * `spawnSync` 会**阻塞事件循环**：子进程一旦不退出，这个 runner 就永远醒不过来，
 * 既接不了 Ctrl+C，也做不了超时。而子进程真的会不退出 —— 日志管道断开（EPIPE）
 * 会让 Electron 弹一个**模态**错误框，主进程的事件循环被它挡住，脚本自己的
 * 10 分钟看门狗都跑不到，`app.exit()` 永远不执行。实测后果：一条
 * `npm run visual:matrix` 链在进程表里挂了几个小时，反复吐 EPIPE。
 * 现在：超时到点**收掉整棵进程树**（taskkill /T），信号也转发给它。
 *
 * 子进程自己的 stdio 护栏见 `scripts/lib/stdio-guard.mjs`（那是第一道防线）。
 *
 * 用法：
 *   npm run visual:matrix          # 全部组
 *   npm run visual:matrix -- 0 2   # 只跑指定组
 */
import './lib/stdio-guard.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')

const ALL = ['0', '1', '2', '3', '4', '5', '6', 'onboarding']
const wanted = process.argv.slice(2).filter(Boolean)
const groups = wanted.length ? wanted : ALL

/**
 * 单组上限。
 *
 * 脚本自带 10 分钟看门狗，这里留 2 分钟余量 —— 正常一组是几十秒。
 * 超过就当作“卡住了”（模态框 / GPU 崩在等不到的 promise 上），收掉再继续下一组：
 * 一组坏掉不该让后面 7 组都不跑。
 *
 * `YAN_MATRIX_TIMEOUT_MS` 只是**验证这个超时通路本身**的旋钮
 *（设成 5000 就能看到“收掉进程树”那行），不是日常配置。
 */
const GROUP_TIMEOUT_MS = Number(process.env.YAN_MATRIX_TIMEOUT_MS ?? 12 * 60_000)

let current = null

/** 收掉整棵进程树：Windows 上 child.kill() 只杀直接子进程，GPU/渲染/pi 会变孤儿。 */
function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 已经退了 */
    }
  }
  try {
    child.kill()
  } catch {
    /* 同上 */
  }
}

/*
 * Ctrl+C / 被 kill：**先收子进程再退**。
 *
 * 不收的话 Electron 会活着继续往一个没人读的管道写日志 —— 那正是这次
 * EPIPE 事故里“重复错误 + 僵尸进程”的来源。
 */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTree(current)
    process.exit(130)
  })
}

function runGroup(g) {
  return new Promise((resolvePromise) => {
    /*
     * 必须显式清掉 `ELECTRON_RUN_AS_NODE`：pi 运行时会注入它，
     * 带着它 electron 二进制会退化成纯 Node，报
     * `does not provide an export named 'BrowserWindow'`（看着像启动失败）。
     */
    const env = { ...process.env, YAN_MATRIX_GROUP: g }
    delete env.ELECTRON_RUN_AS_NODE
    console.log(`\n${'='.repeat(64)}\n▶ 组 ${g}\n${'='.repeat(64)}`)

    const child = spawn(electron, [join(root, 'scripts/visual-matrix.mjs')], {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true
    })
    current = child

    const timer = setTimeout(() => {
      console.log(`  ⤺ 组 ${g} 超过 ${Math.round(GROUP_TIMEOUT_MS / 1000)}s 没结束 → 收掉进程树，继续下一组`)
      killTree(child)
    }, GROUP_TIMEOUT_MS)

    const done = (code) => {
      clearTimeout(timer)
      if (current === child) current = null
      resolvePromise(code)
    }
    child.on('exit', (code) => done(code ?? -1))
    child.on('error', (err) => {
      console.error(`  ✗ 组 ${g} 起不来：${err.message}`)
      done(-1)
    })
  })
}

const results = []
for (const g of groups) {
  results.push({ g, code: await runGroup(g) })
}

console.log(`\n${'='.repeat(64)}`)
const bad = results.filter((r) => r.code !== 0)
for (const r of results) console.log(`  ${r.code === 0 ? '✓' : '✗'} 组 ${r.g}（退出码 ${r.code}）`)
console.log(bad.length ? `✗ ${bad.length}/${results.length} 组失败` : `✓ 全部 ${results.length} 组通过`)
process.exit(bad.length ? 1 : 0)
