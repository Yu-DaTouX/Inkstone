function fakeStream() {
  const listeners = []
  return {
    on(event, listener) {
      if (event === 'error') listeners.push(listener)
      return this
    },
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

  {
    const calls = []
    const { stdout, guard } = setup({ onError: (s, e) => calls.push([s, e.code]) })
    ok(stdout.listenerCount() === 1, '给 stdout 装了 error 监听（否则 EPIPE 会变成 uncaughtException）')
    stdout.emitError(epipe())
    ok(calls.length === 0, 'EPIPE 不当作错误上报（用户关终端是正常操作）')
    ok(guard.brokenPipe('stdout') === true, 'EPIPE 被记进 brokenPipe')
    ok(guard.brokenPipe('stderr') === false, '另一条流不受影响')
  }

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
