import { execFile, type ChildProcess } from 'node:child_process'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'

export const STDIO_TREE_KILL_AFTER_MS = 1800

export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
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
    if (this.platform === 'win32' && child?.pid && running(child)) {
      const pid = child.pid
      let timer: ReturnType<typeof setTimeout> | undefined
      const exit = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)))
      child.stdin?.end()
      const exited = await Promise.race([
        exit,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.treeKillAfterMs)
        })
      ])
      if (timer) clearTimeout(timer)
      if (!exited && running(child)) await this.killTree(pid)
    }
    await super.close()
  }
}
