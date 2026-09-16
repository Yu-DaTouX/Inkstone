/**
 * 独立 Electron / Node 脚本的 **stdio 护栏**（导入即生效）。
 *
 * ── 为什么需要（2026-09-16 实测事故）──
 *
 * 现象：一条 `npm run visual:matrix` 链在终端里跑了几个小时不结束，反复出现
 * `EPIPE: broken pipe, write`（一次在 `console.error`、一次在 `console.log`），
 * 进程表里留着一串 Electron，窗口标题是 **「Error」**。
 *
 * 链路（全部实测确认）：
 *
 *   ① 父进程（终端 / CI / agent 的 bash 会话）先退出或读端被关 → 管道的**读端没了**；
 *   ② 脚本还在 `console.log` → Windows 上写入返回 EPIPE，Node 把错误作为
 *      `'error'` 事件抛在 `process.stdout` / `process.stderr` 上；
 *   ③ 没人监听 `'error'` → 变成 `uncaughtException`；
 *   ④ Electron 主进程的**默认**处理是弹一个**模态**框「A JavaScript error occurred
 *      in the main process」，标题就是「Error」—— 弹框之后进程既不退出也不继续，
 *      `app.exit()` 永远不会被调用；
 *   ⑤ 父进程（`spawnSync`）在等子进程退出 → 等一辈子；整条链泄漏。子进程还活着，
 *      渲染端继续打 IPC，日志继续 EPIPE → 于是「重复的 EPIPE」。
 *
 * 对照实验（`out/scratch/pipe-test.mjs`：每 300ms 打一行，管道交给 `head -3`）：
 * `head` 退出后 Electron **不退出**，窗口标题变成 `Error`，stderr 里一个字都没有
 *（错误被弹框吃掉了）—— 也就是“真正的错误被 EPIPE 掩盖”的那个现象。
 *
 * ── 这个模块做三件事 ──
 *
 * 1. `process.stdout` / `process.stderr` 上的 `'error'` 一律**吞掉但不装作没事**：
 *    EPIPE 记进 `stdioPipeBroken()`（读端没了是正常场景：用户关了终端、
 *    agent 的 bash 会话结束了），其它错误码只报一次、且**绝不 rethrow**
 *    —— 从 `'error'` 监听里 throw 只会再走一遍 ③④，正是这次事故的形态。
 * 2. 脚本模式下接管 `uncaughtException` / `unhandledRejection`：把错误打到 stderr
 *    （best-effort）后**以退出码 1 结束**。脚本要的是「快点失败、让上层看见」，
 *    不是弹一个没人点得到的模态框然后把父进程一起拖死。
 * 3. 不隐藏原始异常：错误信息先尽力写 stderr；若连 stderr 也断了，
 *    退出码仍然非 0，父进程/CI 依旧能看到失败。
 *
 * ── 怎么用 ──
 *
 * 在独立 Electron 入口脚本的第一行 import：
 *
 *     import './lib/stdio-guard.mjs'
 *
 * ⚠️ 主进程（`src/main/index.ts`）**不用这个文件**：桌面应用被关掉终端后要继续
 * 服务用户，不能因为日志管道断了就退出；它用的是 `src/main/stdio-guard.ts`
 *（只吞 EPIPE + 把非 EPIPE 记进 UI 日志抽屉，绝不退出）。
 */
let brokenPipe = false
let otherErrorReported = false
let exiting = false

/** 日志管道是否已经断开（读端没了）。脚本可据此跳过后续的输出。 */
export function stdioPipeBroken() {
  return brokenPipe
}

/* ------------------------------------------------------------------ 预期内的 handler 噪声 */

const missingHandlerCounts = new Map()
let muted = false

/*
 * Electron 会把每次失败调用打成一整段三行 chunk：
 *
 *     Error occurred in handler for 'yan:getState': Error: No handler registered ...\n
 *         at Session.<anonymous> (node:electron/js2c/browser_init:2:123930)\n
 *         at Session.emit (node:events:514:28)\n
 *
 * 截图脚本（visual-matrix / shots / shot / live-preview / measure-design）**故意**不注册
 * 一批「拉取型」IPC —— 给它们返回空值会把 `shot-fixture.js` 注入的 store 覆盖掉
 *（settings 变成 null 时 React 直接卸载整棵树，截出来的是空壳）。所以这些报错都是
 * **预期行为**，但它们有两个真实代价：
 *
 *   ① 它们是本次 EPIPE 事故里被淹没的“原始错误”（用户看到的就是这段堆栈）；
 *   ② 每次 reload 都刷几十行，真错误（比如断言失败、fixture 注入失败）反而看不见。
 *
 * ── 为什么挂在 `process.stderr.write` 而不是 `console.error`（实测）──
 *
 * 用探针（`out/scratch/noise-probe.mjs`）量过：这类消息 **console.error 命中 0 次**，
 * Electron 在内部持有自己的控制台引用（或直接写流），patch 全局 console 没用。
 * 而每个错误恰好是**一个自成一块的 chunk**（约 211 字符 / 3 行，开头就是那句话），
 * 所以按「chunk 开头精确匹配」过滤既准又不会误伤 —— 真正的 console.error 输出
 * 最终也走同一个流，照样能被拦到。
 *
 * 但是必须由调用方**显式**开启；其余 stderr 内容一律原样透传（真错误不许吞）。
 * 结尾用 `missingHandlerSummary()` 打一行汇总，让“为什么这块界面没数据”有处可查。
 */
export function muteMissingHandlerNoise() {
  if (muted) return
  muted = true

  const pattern = /^Error occurred in handler for '([^']+)': Error: No handler registered/
  const original = process.stderr.write.bind(process.stderr)

  process.stderr.write = (chunk, encoding, callback) => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    const hit = text ? pattern.exec(text) : null
    if (hit) {
      missingHandlerCounts.set(hit[1], (missingHandlerCounts.get(hit[1]) ?? 0) + 1)
      /* 丢掉的写入也要回回调：调用方可能靠它推进下一段输出 */
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') done()
      return true
    }
    return original(chunk, encoding, callback)
  }
}

/** 静音掉的「未注册 handler」汇总（脚本结尾打一行，别让它们真的消失）。 */
export function missingHandlerSummary() {
  let total = 0
  for (const n of missingHandlerCounts.values()) total += n
  if (!total) return null
  const names = [...missingHandlerCounts.keys()].sort()
  return { total, names, counts: new Map(missingHandlerCounts) }
}

/** best-effort 写一行到 stderr：它自己可能也断了，所以全部包在 try 里。 */
function warnOnce(text) {
  if (otherErrorReported) return
  otherErrorReported = true
  try {
    process.stderr.write(text + '\n')
  } catch {
    /* stderr 也断了：没有别的出口了，不抛 */
  }
}

function streamHandler(kind) {
  return (error) => {
    const code = error && error.code
    if (code === 'EPIPE') {
      /* 读端没了：正常（终端关闭 / 父进程退出）。后续日志会丢，但脚本该继续跑完。 */
      brokenPipe = true
      return
    }
    /*
     * 其它错误（EIO、EBADF…）：说一次就好。
     * 关键：**不 rethrow** —— 抛出去会变成 uncaughtException，
     * 在 Electron 里就是那个模态框（见文件头 ③④）。
     */
    warnOnce(`[stdio-guard] ${kind} 写入失败：${code || String(error)}（后续日志可能丢失）`)
  }
}

function fatal(kind, err) {
  if (exiting) return
  exiting = true
  const detail = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
  warnOnce(`[stdio-guard] ${kind}：\n${detail}`)
  /*
   * 以非 0 退出：脚本的“失败”必须让上层看得见（父进程读退出码，不看日志）。
   * 用 exitCode + process.exit 而不是 throw —— 不能再回到 uncaughtException。
   */
  process.exitCode = 1
  process.exit(1)
}

/**
 * 装上护栏。默认在 import 时就调用（见文件末），
 * 重复调用是幂等的。
 */
let installed = false
export function installStdioGuard() {
  if (installed) return
  installed = true

  process.stdout.on('error', streamHandler('stdout'))
  process.stderr.on('error', streamHandler('stderr'))

  process.on('uncaughtException', (err) => fatal('uncaughtException', err))
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason))
}

installStdioGuard()
