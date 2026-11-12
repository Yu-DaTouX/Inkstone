import { execFile, type ChildProcess } from 'node:child_process'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'

export const STDIO_TREE_KILL_AFTER_MS = 1800

export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

export class StdioTreeClientTransport extends StdioClientTransport {
  constructor(
    params: StdioServerParameters,
    private readonly killTree: (pid: number) => Promise<void> = killProcessTree,
    private readonly treeKillAfterMs = STDIO_TREE_KILL_AFTER_MS,
    private readonly platform: NodeJS.Platform = process.platform
  ) {
    super(params)
  }

  override async close(): Promise<void> {
    const child = (this as unknown as { _process?: ChildProcess })._process
    let timer: ReturnType<typeof setTimeout> | undefined
    if (this.platform === 'win32' && child?.pid) {
      const pid = child.pid
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) void this.killTree(pid)
      }, this.treeKillAfterMs)
      timer.unref?.()
    }
    try {
      await super.close()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
