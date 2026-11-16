import { execFile } from 'node:child_process'
import { join } from 'node:path'

export const PROCESS_SCAN_TIMEOUT_MS = 8000
export const PROCESS_SCAN_CACHE_MS = 1500
export const PI_TREE_SCAN_DELAYS_MS: readonly number[] = [0, 3000, 10_000]
export const PI_TREE_SCAN_INTERVAL_MS = 60_000
export const PI_TREE_SNAPSHOT_CAP_MS = 4000
export const PI_TREE_FRESH_MS = 60_000
const CREATED_SLACK_MS = 2000
const ROOT_EARLY_SLACK_MS = 1000
const ROOT_LATE_WINDOW_MS = 10_000
const COMMAND_LINE_KEEP = 4000

export interface TreeProcess {
  pid: number
  ppid: number
  created: number
  name?: string
  commandLine?: string
}

export interface ListProcessesOptions {
  since?: number
}

export type ListProcesses = (options?: ListProcessesOptions) => Promise<TreeProcess[]>

export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

export function killProcessOnly(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve())
  })
}

const PROCESS_SCAN_SCRIPT = [
  'function B($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) }',
  `Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | Where-Object { $_.CreationDate } | ForEach-Object { $c = [string]$_.CommandLine; if ($c.Length -gt ${COMMAND_LINE_KEEP}) { $c = $c.Substring(0, ${COMMAND_LINE_KEEP}) }; '{0},{1},{2},{3},{4}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), (B $_.Name), (B $c) }`
].join('; ')

function decodeBase64(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

export function parseProcessScan(output: string): TreeProcess[] {
  const rows: TreeProcess[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d+)(?:,([A-Za-z0-9+/=]*),([A-Za-z0-9+/=]*))?$/.exec(line.trim())
    if (!match) continue
    const name = decodeBase64(match[4])
    const commandLine = decodeBase64(match[5])
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      created: Number(match[3]),
      ...(name ? { name } : {}),
      ...(commandLine ? { commandLine } : {})
    })
  }
  return rows
}

interface ScanRecord {
  startedAt: number
  rows: Promise<TreeProcess[]>
}

let latestScan: ScanRecord | null = null

export function listWindowsProcesses(options: ListProcessesOptions = {}): Promise<TreeProcess[]> {
  const now = Date.now()
  const need = options.since ?? now - PROCESS_SCAN_CACHE_MS
  if (latestScan && latestScan.startedAt >= need) return latestScan.rows
  const record: ScanRecord = { startedAt: now, rows: runProcessScan() }
  latestScan = record
  record.rows.catch(() => {
    if (latestScan === record) latestScan = null
  })
  return record.rows
}

function runProcessScan(): Promise<TreeProcess[]> {
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(PROCESS_SCAN_SCRIPT, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: PROCESS_SCAN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(parseProcessScan(String(stdout))))
    )
  })
}

export interface DescendOptions {
  keep?: (row: TreeProcess) => boolean
  skipped?: TreeProcess[]
}

export function descendantsOf(
  rows: readonly TreeProcess[],
  seeds: readonly TreeProcess[],
  notBefore: number,
  notAfter = Number.POSITIVE_INFINITY,
  options: DescendOptions = {}
): TreeProcess[] {
  const found: TreeProcess[] = []
  const seen = new Set<number>(seeds.map((seed) => seed.pid))
  const queue = [...seeds]
  while (queue.length) {
    const parent = queue.shift()!
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || row.created < notBefore || row.created > notAfter) continue
      if (row.created < parent.created) continue
      if (options.keep && !options.keep(row)) {
        options.skipped?.push(row)
        continue
      }
      seen.add(row.pid)
      found.push(row)
      queue.push(row)
    }
  }
  return found
}

export function descendantProcesses(rows: readonly TreeProcess[], rootPid: number, notBefore: number): TreeProcess[] {
  return descendantsOf(rows, [{ pid: rootPid, ppid: 0, created: 0 }], notBefore)
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ProcessTreeWatchOptions {
  listProcesses?: ListProcesses
  kill?: (pid: number) => Promise<void>
  isAlive?: (pid: number) => boolean
  now?: () => number
  select?: (row: TreeProcess) => boolean
  keep?: (row: TreeProcess) => boolean
  onSkipped?: (rows: readonly TreeProcess[]) => void
  killEach?: (pid: number) => Promise<void>
}

export class ProcessTreeWatch {
  private root: TreeProcess | null = null
  private exitedAt: number | undefined
  private lastSnapshotAt = 0
  private readonly tracked = new Map<number, TreeProcess>()
  private readonly startedAt: number
  private readonly listProcesses: ListProcesses
  private readonly kill: (pid: number) => Promise<void>
  private readonly isAlive: (pid: number) => boolean
  private readonly select: ((row: TreeProcess) => boolean) | undefined
  private readonly keep: ((row: TreeProcess) => boolean) | undefined
  private readonly onSkipped: ((rows: readonly TreeProcess[]) => void) | undefined
  private readonly killEach: (pid: number) => Promise<void>
  private sweeping: Promise<number[]> | null = null

  constructor(
    readonly rootPid: number,
    options: ProcessTreeWatchOptions = {}
  ) {
    this.listProcesses = options.listProcesses ?? listWindowsProcesses
    this.kill = options.kill ?? killProcessTree
    this.isAlive = options.isAlive ?? pidAlive
    this.select = options.select
    this.keep = options.keep
    this.onSkipped = options.onSkipped
    this.killEach = options.killEach ?? killProcessOnly
    this.startedAt = (options.now ?? Date.now)()
  }

  trackedPids(): number[] {
    return [...this.tracked.keys()]
  }

  rootCreated(): number | null {
    return this.root?.created ?? null
  }

  snapshotAge(now = Date.now()): number {
    return this.lastSnapshotAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastSnapshotAt
  }

  markExited(at: number): void {
    this.exitedAt ??= at
  }

  private rootFloor(): number {
    return this.startedAt - ROOT_EARLY_SLACK_MS
  }

  private directChildren(rows: readonly TreeProcess[], seed: TreeProcess, bound: number): TreeProcess[] {
    const floor = Math.max(seed.created, this.rootFloor()) - CREATED_SLACK_MS
    return rows.filter((row) => row.ppid === seed.pid && row.pid !== seed.pid && row.created >= floor && row.created <= bound && row.created >= seed.created)
  }

  private discover(rows: readonly TreeProcess[], exitedAt?: number): TreeProcess[] {
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const rootRow = byPid.get(this.rootPid)
    if (!this.root && rootRow && rootRow.created >= this.rootFloor() && rootRow.created <= this.startedAt + ROOT_LATE_WINDOW_MS) this.root = rootRow
    const limit = exitedAt ?? this.exitedAt
    const bound = limit === undefined ? Number.POSITIVE_INFINITY : limit + CREATED_SLACK_MS
    const rootReused = rootRow !== undefined && (this.root ? rootRow.created !== this.root.created : true)
    const rootSeed = this.root ?? (rootRow ? null : { pid: this.rootPid, ppid: 0, created: this.rootFloor() })
    const skipped: TreeProcess[] = []
    const found: TreeProcess[] = []
    if (rootSeed && (!rootReused || limit !== undefined)) {
      const direct = this.directChildren(rows, rootSeed, bound)
      const tops: TreeProcess[] = []
      for (const row of direct) {
        if ((this.select && !this.select(row)) || (this.keep && !this.keep(row))) {
          if (!this.tracked.has(row.pid)) skipped.push(row)
          continue
        }
        tops.push(row)
      }
      found.push(...tops, ...descendantsOf(rows, tops, rootSeed.created - CREATED_SLACK_MS, bound, { keep: this.keep, skipped }))
    }
    const seeds: TreeProcess[] = []
    for (const entry of this.tracked.values()) {
      const live = byPid.get(entry.pid)
      if (live && live.created === entry.created) seeds.push(live)
    }
    if (seeds.length) found.push(...descendantsOf(rows, seeds, this.rootFloor() - CREATED_SLACK_MS, Number.POSITIVE_INFINITY, { keep: this.keep, skipped }))
    for (const entry of found) this.tracked.set(entry.pid, entry)
    return skipped
  }

  observe(rows: readonly TreeProcess[]): void {
    this.lastSnapshotAt = Date.now()
    this.discover(rows)
  }

  async snapshot(options: { fresh?: boolean } = {}): Promise<void> {
    const rows = await this.listProcesses({ since: options.fresh ? Date.now() : this.startedAt }).catch(() => null)
    if (rows) this.observe(rows)
  }

  async killNow(extraPids: readonly number[] = []): Promise<void> {
    const pids = new Set<number>(extraPids)
    for (const entry of this.tracked.values()) pids.add(entry.pid)
    this.tracked.clear()
    await Promise.all([...pids].map((pid) => this.killEach(pid)))
  }

  sweep(exitedAt?: number, options: { cheap?: boolean } = {}): Promise<number[]> {
    if (!this.sweeping) {
      const run = this.sweepNow(exitedAt, options.cheap === true)
      this.sweeping = run
      const clear = (): void => {
        if (this.sweeping === run) this.sweeping = null
      }
      run.then(clear, clear)
    }
    return this.sweeping
  }

  private async sweepNow(exitedAt: number | undefined, cheap: boolean): Promise<number[]> {
    if (cheap && !this.isAlive(this.rootPid) && ![...this.tracked.keys()].some((pid) => this.isAlive(pid))) {
      this.tracked.clear()
      return []
    }
    const since = exitedAt ?? this.exitedAt ?? Date.now()
    const rows = await this.listProcesses({ since }).catch(() => null)
    if (!rows) return []
    const skipped = this.discover(rows, exitedAt)
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const identical = (entry: TreeProcess): boolean => byPid.get(entry.pid)?.created === entry.created
    if (skipped.length && this.onSkipped) this.onSkipped(skipped.filter(identical))
    const alive = [...this.tracked.values()].filter(identical)
    if (this.select === undefined && this.root && identical(this.root)) alive.push(this.root)
    this.tracked.clear()
    if (this.keep) {
      await Promise.all(alive.map((entry) => this.killEach(entry.pid)))
      return alive.map((entry) => entry.pid)
    }
    const aliveIds = new Set(alive.map((entry) => entry.pid))
    const tops = alive.filter((entry) => !aliveIds.has(entry.ppid))
    await Promise.all(tops.map((entry) => this.kill(entry.pid)))
    return alive.map((entry) => entry.pid)
  }
}

export interface PiTreeRegistryOptions extends ProcessTreeWatchOptions {
  platform?: NodeJS.Platform
  scanDelaysMs?: readonly number[]
  intervalMs?: number
}

export class PiTreeRegistry {
  private readonly watches = new Set<ProcessTreeWatch>()
  private interval: ReturnType<typeof setInterval> | null = null
  private readonly listProcesses: ListProcesses
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: PiTreeRegistryOptions = {}) {
    this.listProcesses = options.listProcesses ?? listWindowsProcesses
    this.platform = options.platform ?? process.platform
  }

  get size(): number {
    return this.watches.size
  }

  watch(pid: number | undefined, extra: Pick<ProcessTreeWatchOptions, 'select' | 'onSkipped' | 'now'> = {}): ProcessTreeWatch | null {
    if (this.platform !== 'win32' || !pid) return null
    const watch = new ProcessTreeWatch(pid, { ...this.options, ...extra })
    this.watches.add(watch)
    for (const delay of this.options.scanDelaysMs ?? PI_TREE_SCAN_DELAYS_MS) {
      setTimeout(() => void this.scanAll(), delay).unref?.()
    }
    this.arm()
    return watch
  }

  release(watch: ProcessTreeWatch | null): void {
    if (!watch) return
    this.watches.delete(watch)
    if (this.watches.size === 0) this.disarm()
  }

  async scanAll(): Promise<void> {
    if (this.watches.size === 0) return
    const rows = await this.listProcesses().catch(() => null)
    if (!rows) return
    for (const watch of this.watches) watch.observe(rows)
  }

  async sweepAll(): Promise<void> {
    const all = [...this.watches]
    await Promise.all(all.map((watch) => watch.sweep().catch(() => [])))
  }

  private arm(): void {
    if (!this.interval) {
      this.interval = setInterval(() => void this.scanAll(), this.options.intervalMs ?? PI_TREE_SCAN_INTERVAL_MS)
      this.interval.unref?.()
    }
  }

  private disarm(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
  }
}

export const piTreeRegistry = new PiTreeRegistry()
