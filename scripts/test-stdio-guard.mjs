/**
 * 主进程 stdio 护栏（`src/main/stdio-guard.ts`）的单测。
 *
 * 为什么这块值得钉死：它就是这次 EPIPE 事故的修复点，而它的错误恰恰是
 * **测试里看不出来、生产里很难复现**的那种 —— 「监听器里 throw 会把
 * 不可捕获的流错误升级成 uncaughtException，在 Electron 里变成模态框」。
 * 用假流把三类输入（EPIPE / 非 EPIPE / 上报通路自己抛错）一次覆盖完。
 */

function fakeStream() {
  const listeners = []
  return {
    on(event, listener) {
      if (event === 'error') listeners.push(listener)
      return this
    },
    /** 模拟一次写入失败 */
    emitError(error) {
      for (const l of listeners) l(error)
    },
    listenerCount: () => listeners.length
  }
}

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
const eio = () => Object.assign(new Error('write EIO'), { code: 'EIO' })

export function runStdioGuardTests(ok, mod) {
  const { installStdioGuard } = mod

  const setup = (options) => {
    const stdout = fakeStream()
    const stderr = fakeStream()
    const guard = installStdioGuard({ stdout, stderr }, options)
    return { stdout, stderr, guard }
  }

  console.log('\n--- 主进程 stdio 护栏（EPIPE 事故的修复点） ---')

  /* ---- 1. EPIPE 只记录，不上报 ---- */
  {
    const calls = []
    const { stdout, guard } = setup({ onError: (s, e) => calls.push([s, e.code]) })
    ok(stdout.listenerCount() === 1, '给 stdout 装了 error 监听（否则 EPIPE 会变成 uncaughtException）')
    stdout.emitError(epipe())
    ok(calls.length === 0, 'EPIPE 不当作错误上报（用户关终端是正常操作）')
    ok(guard.brokenPipe('stdout') === true, 'EPIPE 被记进 brokenPipe')
    ok(guard.brokenPipe('stderr') === false, '另一条流不受影响')
  }

  /* ---- 2. 非 EPIPE 上报一次，且绝不 rethrow ---- */
  {
    const calls = []
    const { stdout, guard } = setup({ onError: (s, e) => calls.push([s, e.code]) })
    let threw = false
    try {
      stdout.emitError(eio())
      stdout.emitError(eio())
      stdout.emitError(eio())
    } catch {
      threw = true
    }
    ok(!threw, '监听器不抛（throw 会变成 uncaughtException → Electron 模态框）')
    ok(calls.length === 1, `非 EPIPE 默认只报一次（实际 ${calls.length}）`)
    ok(calls[0]?.[0] === 'stdout' && calls[0]?.[1] === 'EIO', '上报带上流名与错误码')
    ok(guard.reported('stdout') === 1, 'reported() 反映真实上报次数')
  }

  {
    const calls = []
    const { stdout, stderr } = setup({ onError: (s) => calls.push(s), maxReportsPerStream: 2 })
    stdout.emitError(eio())
    stdout.emitError(eio())
    stdout.emitError(eio())
    stderr.emitError(eio())
    ok(calls.filter((s) => s === 'stdout').length === 2, 'maxReportsPerStream 生效（stdout 报 2 次）')
    ok(calls.filter((s) => s === 'stderr').length === 1, '每条流各自计数（stderr 报 1 次）')
  }

  /* ---- 3. 上报通路自己抛错也不能逃出去 ---- */
  {
    const { stdout } = setup({
      onError: () => {
        throw new Error('日志抽屉已销毁')
      }
    })
    let threw = false
    try {
      stdout.emitError(eio())
    } catch {
      threw = true
    }
    ok(!threw, 'onError 自己抛错时被咽下（否则等于绕回 uncaughtException）')
  }

  /* ---- 4. 没有 onError 时不炸 ---- */
  {
    const { stdout, guard } = setup()
    let threw = false
    try {
      stdout.emitError(eio())
      stdout.emitError(epipe())
    } catch {
      threw = true
    }
    ok(!threw, '不给 onError 也能安全跑（上报是可选的）')
    ok(guard.brokenPipe('stdout') === true && guard.reported('stdout') === 1, '两种错误各自被正确处理')
  }
}
