import type { ChildProcess } from 'node:child_process'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { redactSecretText } from '../../shared/redact-diagnostic'
import { decodeProcessOutput } from './stderr-decode'
import { killProcessTree, ProcessTreeWatch, type ListProcesses } from '../process-tree'

export { killProcessTree }

export const STDIO_TREE_KILL_AFTER_MS = 1800
export const STDIO_STDERR_TAIL_CHARS = 4096
export const STDIO_TREE_SCAN_CAP_MS = 2500
const STDERR_RAW_KEEP_BYTES = STDIO_STDERR_TAIL_CHARS * 4

export interface StdioTreeOptions {
  listProcesses?: ListProcesses
  isAlive?: (pid: number) => boolean
  scanCapMs?: number
  secretValues?: readonly string[]
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

export class StdioTreeClientTransport extends StdioClientTransport {
  private watch: ProcessTreeWatch | null = null
  private stderrRaw: Buffer = Buffer.alloc(0)
  private stderrTruncated = false
  private readonly listProcesses: ListProcesses | undefined
  private readonly isAlive: ((pid: number) => boolean) | undefined
  private readonly secretValues: string[]
  private readonly scanCapMs: number

  constructor(
    params: StdioServerParameters,
    private readonly killTree: (pid: number) => Promise<void> = killProcessTree,
    private readonly treeKillAfterMs = STDIO_TREE_KILL_AFTER_MS,
    private readonly platform: NodeJS.Platform = process.platform,
    options: StdioTreeOptions = {}
  ) {
    super({ ...params, stderr: 'pipe' })
    this.listProcesses = options.listProcesses
    this.isAlive = options.isAlive
    this.scanCapMs = options.scanCapMs ?? STDIO_TREE_SCAN_CAP_MS
    this.secretValues = (options.secretValues ?? []).filter((value) => value.length >= 6)
    this.stderr?.on('data', (chunk: Buffer | string) => {
      const joined = Buffer.concat([this.stderrRaw, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (joined.length > STDERR_RAW_KEEP_BYTES) {
        this.stderrTruncated = true
        this.stderrRaw = joined.subarray(joined.length - STDERR_RAW_KEEP_BYTES)
      } else {
        this.stderrRaw = joined
      }
    })
  }

  stderrTail(): string {
    let text = decodeProcessOutput(this.stderrRaw, this.stderrTruncated)
    for (const secret of this.secretValues) text = text.split(secret).join('[redacted]')
    text = redactSecretText(text)
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim()
    return text.length > STDIO_STDERR_TAIL_CHARS ? `…${text.slice(-STDIO_STDERR_TAIL_CHARS)}` : text
  }

  override async start(): Promise<void> {
    await super.start()
    const rootPid = this.pid
    if (this.platform === 'win32' && rootPid) {
      const watch = new ProcessTreeWatch(rootPid, {
        ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}),
        kill: this.killTree,
        ...(this.isAlive ? { isAlive: this.isAlive } : {})
      })
      this.watch = watch
      const child = (this as unknown as { _process?: ChildProcess })._process
      child?.once('exit', () => watch.markExited(Date.now()))
      void watch.snapshot()
    }
  }

  override async close(): Promise<void> {
    const child = (this as unknown as { _process?: ChildProcess })._process
    const watch = this.watch
    this.watch = null
    if (!watch) {
      await super.close()
      return
    }
    let capTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      watch.snapshot(),
      new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, this.scanCapMs)
      })
    ])
    if (capTimer) clearTimeout(capTimer)
    if (child?.pid && running(child)) {
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
      if (!exited && running(child)) await this.killTree(child.pid)
    }
    await super.close()
    await watch.sweep(undefined, { cheap: true })
  }
}
