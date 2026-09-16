/**
 * 主进程的 **stdio 护栏**：日志管道断了不能把桌面应用弄崩。
 *
 * ── 为什么单独一个模块 ──
 *
 * 这段逻辑原来是 `index.ts` 顶部的十行内联代码，但它有个隐藏的坏习惯：
 * 监听器里对非 EPIPE **`throw`**。从 `'error'` 监听里抛出来会变成
 * `uncaughtException`，而 Electron 主进程的默认处理是弹一个**模态**框
 *（标题「Error」）—— 弹框挡住事件循环之后，进程既不退也不再继续干活。
 * 2026-09-16 的实测事故就是这条链路（详见 `scripts/lib/stdio-guard.mjs`
 * 的文件头：终端里跑了几小时不结束、进程表留一串 Electron、反复 EPIPE）。
 *
 * 所以这里定死三件事：
 *   ① EPIPE 只记录、**不报错**（用户关终端是正常操作，不是应用故障）；
 *   ② 其它错误码最多报 N 次，且**绝不 rethrow** —— 报错通路本身不许再制造异常；
 *   ③ `onError` 自己抛也不能逃出去（否则等于绕回 uncaughtException）。
 *
 * 与脚本侧的区别：`scripts/lib/stdio-guard.mjs` 会把 uncaughtException 变成
 * “打印 + 退出码 1”（脚本要快点失败）；桌面应用**不能退出**，它把这行日志
 * 推进右栏日志抽屉，然后继续服务用户。
 */

/** 只用到 `on`，所以可以拿假对象单测（不依赖 Electron / 真实管道）。 */
export interface GuardedStream {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

export interface StdioGuardOptions {
  /** 非 EPIPE 的写入错误：记到哪里（主进程是右栏日志抽屉） */
  onError?: (stream: 'stdout' | 'stderr', error: NodeJS.ErrnoException) => void
  /** 每条流最多报几次（默认 1：同一个坏管道会连着触发，不刷屏） */
  maxReportsPerStream?: number
}

export interface StdioGuard {
  /** 该流的读端是否已经没了（正常场景：终端/启动器先退出） */
  brokenPipe: (stream: 'stdout' | 'stderr') => boolean
  /** 非 EPIPE 错误被报出来的次数（测试与诊断用） */
  reported: (stream: 'stdout' | 'stderr') => number
}

export function installStdioGuard(
  streams: { stdout: GuardedStream; stderr: GuardedStream },
  options: StdioGuardOptions = {}
): StdioGuard {
  const limit = options.maxReportsPerStream ?? 1
  const state: Record<'stdout' | 'stderr', { broken: boolean; reports: number }> = {
    stdout: { broken: false, reports: 0 },
    stderr: { broken: false, reports: 0 }
  }

  for (const name of ['stdout', 'stderr'] as const) {
    streams[name].on('error', (error) => {
      /*
       * EPIPE = 读端已关闭。用户关掉终端 / 启动器退出后，Node 仍可能写日志：
       * 那是“日志丢了”，不是“应用坏了” —— 记下来，不报错。
       */
      if (error?.code === 'EPIPE') {
        state[name].broken = true
        return
      }
      if (state[name].reports >= limit) return
      state[name].reports += 1
      try {
        options.onError?.(name, error)
      } catch {
        /*
         * 上报通路自己出问题（例如日志抽屉已销毁、push 抛错）：
         * 这里必须咽下 —— 抛出去就是 uncaughtException，也就是本次事故那个模态框。
         */
      }
    })
  }

  return {
    brokenPipe: (stream) => state[stream].broken,
    reported: (stream) => state[stream].reports
  }
}
