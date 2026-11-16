import { execFile, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { redactSecretText } from '../../shared/redact-diagnostic'

export const STDIO_TREE_KILL_AFTER_MS = 1800
export const STDIO_STDERR_TAIL_CHARS = 4096
const STDERR_RAW_KEEP_CHARS = STDIO_STDERR_TAIL_CHARS * 2
const PROCESS_SCAN_TIMEOUT_MS = 8000
const CREATED_SLACK_MS = 2000

export interface TreeProcess {
  pid: number
  ppid: number
  created: number
}

export type ListProcesses = () => Promise<TreeProcess[]>

export interface StdioTreeOptions {
  listProcesses?: ListProcesses
  isAlive?: (pid: number) => boolean
  secretValues?: readonly string[]
}

export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

const PROCESS_SCAN_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"

export function parseProcessScan(output: string): TreeProcess[] {
  const rows: TreeProcess[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d+)$/.exec(line.trim())
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), created: Number(match[3]) })
  }
  return rows
}

let scanInFlight: Promise<TreeProcess[]> | null = null

export function listWindowsProcesses(): Promise<TreeProcess[]> {
  if (scanInFlight) return scanInFlight
  const scan = runProcessScan()
  scanInFlight = scan
  const clear = (): void => {
    if (scanInFlight === scan) scanInFlight = null
  }
  scan.then(clear, clear)
  return scan
}

function runProcessScan(): Promise<TreeProcess[]> {
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(PROCESS_SCAN_SCRIPT, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: PROCESS_SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(parseProcessScan(String(stdout))))
    )
  })
}

export function descendantProcesses(rows: readonly TreeProcess[], rootPid: number, notBefore: number): TreeProcess[] {
  const found: TreeProcess[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const parent = queue.shift()!
    for (const row of rows) {
      if (row.ppid !== parent || seen.has(row.pid) || row.created < notBefore) continue
      seen.add(row.pid)
      found.push(row)
      queue.push(row.pid)
    }
  }
  return found
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

export class StdioTreeClientTransport extends StdioClientTransport {
  private rootPid: number | null = null
  private startedAt = 0
  private stderrRaw = ''
  private readonly listProcesses: ListProcesses
  private readonly isAlive: (pid: number) => boolean
  private readonly secretValues: string[]

  constructor(
    params: StdioServerParameters,
    private readonly killTree: (pid: number) => Promise<void> = killProcessTree,
    private readonly treeKillAfterMs = STDIO_TREE_KILL_AFTER_MS,
    private readonly platform: NodeJS.Platform = process.platform,
    options: StdioTreeOptions = {}
  ) {
    super({ ...params, stderr: 'pipe' })
    this.listProcesses = options.listProcesses ?? listWindowsProcesses
    this.isAlive = options.isAlive ?? pidAlive
    this.secretValues = (options.secretValues ?? []).filter((value) => value.length >= 6)
    this.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrRaw = (this.stderrRaw + chunk.toString()).slice(-STDERR_RAW_KEEP_CHARS)
    })
  }

  stderrTail(): string {
    let text = this.stderrRaw
    for (const secret of this.secretValues) text = text.split(secret).join('[redacted]')
    text = redactSecretText(text)
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim()
    return text.length > STDIO_STDERR_TAIL_CHARS ? `…${text.slice(-STDIO_STDERR_TAIL_CHARS)}` : text
  }

  override async start(): Promise<void> {
    this.startedAt = Date.now()
    await super.start()
    this.rootPid = this.pid
  }

  private scanTree(rootPid: number): Promise<TreeProcess[]> {
    const notBefore = this.startedAt - CREATED_SLACK_MS
    return this.listProcesses().then(
      (rows) => descendantProcesses(rows, rootPid, notBefore),
      () => []
    )
  }

  override async close(): Promise<void> {
    const child = (this as unknown as { _process?: ChildProcess })._process
    const rootPid = child?.pid ?? this.rootPid
    this.rootPid = null
    if (this.platform !== 'win32' || !rootPid) {
      await super.close()
      return
    }
    const tracked = await this.scanTree(rootPid)
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
    const survivors = tracked.filter((entry) => this.isAlive(entry.pid))
    const alive = new Set(survivors.map((entry) => entry.pid))
    const tops = survivors.filter((entry) => !alive.has(entry.ppid))
    await Promise.all(tops.map((entry) => this.killTree(entry.pid)))
  }
}
