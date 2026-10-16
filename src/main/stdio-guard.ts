export interface GuardedStream {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

export interface StdioGuardOptions {
  onError?: (stream: 'stdout' | 'stderr', error: NodeJS.ErrnoException) => void
  maxReportsPerStream?: number
}

export interface StdioGuard {
  brokenPipe: (stream: 'stdout' | 'stderr') => boolean
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
      if (error?.code === 'EPIPE') {
        state[name].broken = true
        return
      }
      if (state[name].reports >= limit) return
      state[name].reports += 1
      try {
        options.onError?.(name, error)
      } catch {
      }
    })
  }

  return {
    brokenPipe: (stream) => state[stream].broken,
    reported: (stream) => state[stream].reports
  }
}
