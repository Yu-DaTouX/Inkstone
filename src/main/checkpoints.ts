import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { YAN_DIR } from './paths'
import { gitRun } from './git-service'
import { createGitDeadline, type GitDeadline } from './git-run-policy'
import {
  textFingerprint,
  type CheckpointChange,
  type CheckpointPreview,
  type CheckpointRecord,
  type CheckpointRestoreResult,
  type WorkspaceFit
} from '../shared/checkpoints'

const ROOT = join(YAN_DIR, 'checkpoints')
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RECORDS = 400
const MAX_FILES = 30_000
const MAX_LISTED_CHANGES = 200
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const STALE_TEMP_MS = 10 * 60 * 1000
const STAT_BATCH = 64
const ASSESS_TIMEOUT_MS = 8_000
const EXTRA_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.gradle/', '.next/', '.cache/', '.turbo/']

interface StoredRecord extends CheckpointRecord {
  sha: string
}

interface Index {
  version: 1
  cwd: string
  records: StoredRecord[]
  lastTree?: string
  lastSha?: string
  lastGcAt?: number
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd).replace(/[\\/]+$/, '').toLowerCase()
}

function projectDir(cwd: string): string {
  const hash = createHash('sha1').update(normalizeCwd(cwd)).digest('hex').slice(0, 16)
  return join(ROOT, hash)
}

export function isCheckpointableDir(cwd: string): boolean {
  if (!cwd) return false
  const abs = resolve(cwd)
  const root = parse(abs).root
  if (abs === root || normalizeCwd(abs) === normalizeCwd(homedir())) return false
  return existsSync(abs)
}

const locks = new Map<string, Promise<unknown>>()
const GC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  locks.set(key, next)
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key) }).catch(() => undefined)
  return next
}

async function readIndex(dir: string, cwd: string): Promise<Index> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as Partial<Index>
    if (parsed?.version === 1 && Array.isArray(parsed.records)) {
      return { version: 1, cwd: cwd || (typeof parsed.cwd === 'string' ? parsed.cwd : ''), records: parsed.records, lastTree: parsed.lastTree, lastSha: parsed.lastSha, lastGcAt: parsed.lastGcAt }
    }
  } catch {
  }
  return { version: 1, cwd, records: [] }
}

async function writeIndex(dir: string, index: Index): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `index.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(index), 'utf8')
  await rename(tmp, join(dir, 'index.json'))
}

function shadowGit(cwd: string, dir: string, args: string[], opts: { timeout?: number; allowFailure?: boolean; stdin?: string; deadline?: GitDeadline } = {}) {
  return gitRun(
    cwd,
    [
      '--git-dir', join(dir, 'repo.git'),
      '--work-tree', cwd,
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true',
      '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false',
      '-c', 'user.name=Inkstone', '-c', 'user.email=checkpoint@inkstone.local',
      ...args
    ],
    { timeout: opts.timeout ?? 60_000, allowFailure: opts.allowFailure, stdin: opts.stdin, deadline: opts.deadline }
  )
}

async function removeStaleTemp(dir: string, now = Date.now(), deadline?: GitDeadline): Promise<void> {
  const repo = join(dir, 'repo.git')
  const candidates: string[] = [join(repo, 'index.lock')]
  for (const sub of [join(repo, 'objects', 'pack'), join(repo, 'objects')]) {
    if (deadline?.expired()) return
    try {
      for (const name of await readdir(sub)) {
        if (/^tmp_(pack|idx|obj|rev)_/.test(name) || /^\.tmp-/.test(name)) candidates.push(join(sub, name))
      }
    } catch {
    }
  }
  for (const path of candidates) {
    if (deadline?.expired()) return
    try {
      const st = await stat(path)
      if (st.isFile() && now - st.mtimeMs > STALE_TEMP_MS) await rm(path, { force: true })
    } catch {
    }
  }
}

async function ensureRepo(cwd: string, dir: string, deadline?: GitDeadline): Promise<boolean> {
  if (deadline?.expired()) return false
  await removeStaleTemp(dir, Date.now(), deadline)
  if (deadline?.expired()) return false
  const repo = join(dir, 'repo.git')
  if (!existsSync(join(repo, 'HEAD'))) {
    await mkdir(dir, { recursive: true })
    const res = await gitRun(cwd, ['init', '--bare', '--quiet', repo], { allowFailure: true, timeout: 20_000, deadline })
    if (!res.ok) return false
  }
  if (deadline?.expired()) return false
  const exclude = join(repo, 'info', 'exclude')
  try {
    await mkdir(join(repo, 'info'), { recursive: true })
    await writeFile(exclude, `${EXTRA_EXCLUDES.join('\n')}\n`, 'utf8')
  } catch {
  }
  return !deadline?.expired()
}

async function measureFiles(cwd: string, paths: string[], deadline?: GitDeadline): Promise<{ oversized: string[]; total: number; largest: { path: string; bytes: number } | null } | null> {
  const oversized: string[] = []
  let total = 0
  let largest: { path: string; bytes: number } | null = null
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    if (deadline?.expired()) return null
    const batch = paths.slice(i, i + STAT_BATCH)
    const sizes = await Promise.all(batch.map((p) => lstat(join(cwd, p)).then((st) => (st.isFile() ? st.size : 0), () => 0)))
    sizes.forEach((size, j) => {
      if (size > MAX_FILE_BYTES) oversized.push(batch[j])
      else total += size
      if (!largest || size > largest.bytes) largest = { path: batch[j], bytes: size }
    })
  }
  return deadline?.expired() ? null : { oversized, total, largest }
}

export function assessCheckpointFit(cwd: string): Promise<WorkspaceFit | null> {
  if (!isCheckpointableDir(cwd)) return Promise.resolve(null)
  return serialized(normalizeCwd(cwd), async () => {
    const dir = projectDir(cwd)
    if (!(await ensureRepo(cwd, dir))) return null
    const listing = await shadowGit(cwd, dir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { allowFailure: true, timeout: ASSESS_TIMEOUT_MS })
    if (listing.timedOut) return { files: MAX_FILES + 1, tooManyFiles: true, oversizedFiles: 0, largest: null, totalBytes: 0, tooLarge: false, fits: false }
    if (!listing.ok) return null
    const listed = [...new Set(listing.stdout.split('\0').filter(Boolean))]
    if (listed.length > MAX_FILES) return { files: listed.length, tooManyFiles: true, oversizedFiles: 0, largest: null, totalBytes: 0, tooLarge: false, fits: false }
    const measured = await measureFiles(cwd, listed)
    if (!measured) return null
    const { oversized, total, largest } = measured
    const tooLarge = total > MAX_TOTAL_BYTES
    return {
      files: listed.length,
      tooManyFiles: false,
      oversizedFiles: oversized.length,
      largest: oversized.length ? largest : null,
      totalBytes: total,
      tooLarge,
      fits: !oversized.length && !tooLarge
    }
  })
}

async function oversizedInWorktree(cwd: string, dir: string, sha: string): Promise<string[] | null> {
  const listed = await shadowGit(cwd, dir, ['ls-tree', '-r', '-z', '--name-only', sha], { allowFailure: true })
  if (!listed.ok) return null
  return (await measureFiles(cwd, listed.stdout.split('\0').filter(Boolean)))?.oversized ?? null
}

async function snapshotTree(cwd: string, dir: string, deadline?: GitDeadline): Promise<{ tree: string; oversized: string[] } | null> {
  const estimate = await shadowGit(cwd, dir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { allowFailure: true, deadline })
  if (!estimate.ok) return null
  const listed = [...new Set(estimate.stdout.split('\0').filter(Boolean))]
  if (listed.length > MAX_FILES) return null
  const measured = await measureFiles(cwd, listed, deadline)
  if (!measured || measured.total > MAX_TOTAL_BYTES) return null
  const { oversized } = measured
  if (oversized.length) {
    const drop = await shadowGit(cwd, dir, ['update-index', '--force-remove', '-z', '--stdin'], { allowFailure: true, stdin: `${oversized.join('\0')}\0`, deadline })
    if (!drop.ok) return null
  }
  const add = oversized.length
    ? await shadowGit(cwd, dir, ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        allowFailure: true,
        stdin: ['.', ...oversized.map((p) => `:(exclude,literal)${p}`)].join('\0') + '\0',
        deadline
      })
    : await shadowGit(cwd, dir, ['add', '-A', '--ignore-errors'], { allowFailure: true, deadline })
  if (deadline?.expired() || (!add.ok && !/permission denied|unable to index|Invalid argument|short read|failed to insert/i.test(add.stderr))) return null
  const count = await shadowGit(cwd, dir, ['ls-files', '--cached', '-z'], { allowFailure: true, deadline })
  if (count.ok && count.stdout.split('\0').length > MAX_FILES) return null
  const tree = await shadowGit(cwd, dir, ['write-tree'], { allowFailure: true, deadline })
  const sha = tree.stdout.trim()
  return tree.ok && /^[0-9a-f]{40}$/.test(sha) ? { tree: sha, oversized } : null
}

async function commitTree(cwd: string, dir: string, tree: string, message: string, deadline?: GitDeadline): Promise<string | null> {
  const res = await shadowGit(cwd, dir, ['commit-tree', tree, '-m', message.slice(0, 200)], { allowFailure: true, deadline })
  const sha = res.stdout.trim()
  if (!res.ok || !/^[0-9a-f]{40}$/.test(sha)) return null
  const ref = await shadowGit(cwd, dir, ['update-ref', `refs/cp/${sha}`, sha], { allowFailure: true, deadline })
  return ref.ok ? sha : null
}

export async function captureCheckpoint(cwd: string, sessionKey: string, text: string, budgetMs = 10_000): Promise<CheckpointRecord | null> {
  if (!isCheckpointableDir(cwd) || !sessionKey) return null
  const key = normalizeCwd(cwd)
  const deadline = createGitDeadline(budgetMs, () => performance.now())
  while (locks.has(key)) {
    if (deadline.expired()) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        locks.get(key)!.catch(() => undefined),
        new Promise<void>((done) => { timer = setTimeout(done, deadline.remaining()) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  return serialized(key, () => takeSnapshot(cwd, sessionKey, text, 'turn', deadline)).catch(() => null)
}

async function takeSnapshot(cwd: string, sessionKey: string, text: string, kind: CheckpointRecord['kind'], deadline?: GitDeadline): Promise<CheckpointRecord | null> {
  const dir = projectDir(cwd)
  if (deadline?.expired() || !(await ensureRepo(cwd, dir, deadline))) return null
  const snapshot = await snapshotTree(cwd, dir, deadline)
  if (!snapshot || deadline?.expired()) return null
  const tree = snapshot.tree
  const index = await readIndex(dir, cwd)
  if (deadline?.expired()) return null
  let sha = index.lastTree === tree ? index.lastSha : undefined
  if (!sha) {
    sha = (await commitTree(cwd, dir, tree, `${kind} ${new Date().toISOString()}`, deadline)) ?? undefined
    if (!sha) return null
  }
  const record: StoredRecord = {
    id: randomUUID(),
    sessionKey,
    at: Date.now(),
    textHash: textFingerprint(text),
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 80),
    kind,
    sha
  }
  if (deadline?.expired()) return null
  index.records.push(record)
  index.lastTree = tree
  index.lastSha = sha
  if (index.records.length > MAX_RECORDS) index.records.splice(0, index.records.length - MAX_RECORDS)
  await writeIndex(dir, index)
  return viewOf(record)
}

function viewOf({ id, sessionKey, at, textHash, preview, kind }: StoredRecord): CheckpointRecord {
  return { id, sessionKey, at, textHash, preview, kind }
}

function shaOf(record: StoredRecord | undefined): string | null {
  const sha = record?.sha
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

export async function listCheckpoints(cwd: string, sessionKey: string): Promise<CheckpointRecord[]> {
  if (!isCheckpointableDir(cwd) || !sessionKey) return []
  const index = await readIndex(projectDir(cwd), cwd)
  return index.records.filter((r) => r.sessionKey === sessionKey).map(viewOf)
}

function parseChanges(output: string): { changes: CheckpointChange[]; total: number } {
  const changes: CheckpointChange[] = []
  let total = 0
  for (const line of output.split('\n')) {
    const match = /^([MADTU])\t(.+)$/.exec(line.trim())
    if (!match) continue
    total += 1
    if (changes.length >= MAX_LISTED_CHANGES) continue
    const status = match[1] === 'A' ? 'A' : match[1] === 'D' ? 'D' : 'M'
    changes.push({ path: match[2], status })
  }
  return { changes, total }
}

export function previewCheckpoint(cwd: string, recordId: string): Promise<CheckpointPreview> {
  return serialized(normalizeCwd(cwd), async () => {
    const dir = projectDir(cwd)
    const index = await readIndex(dir, cwd)
    const sha = shaOf(index.records.find((r) => r.id === recordId))
    if (!sha) return { ok: false, error: '找不到这个检查点（可能已过期被清理）', changes: [], total: 0 }
    const snapshot = await snapshotTree(cwd, dir)
    if (!snapshot) return { ok: false, error: '没能读取项目文件当前的状态', changes: [], total: 0 }
    const diff = await shadowGit(cwd, dir, ['diff-index', '--cached', '--name-status', '--no-renames', sha], { allowFailure: true })
    if (!diff.ok) return { ok: false, error: diff.error ?? '比较失败', changes: [], total: 0 }
    const skip = new Set(snapshot.oversized)
    const lines = diff.stdout.split('\n').filter((line) => !skip.has(line.replace(/^[A-Z]\t/, '').trim()))
    return { ok: true, ...parseChanges(lines.join('\n')) }
  })
}

async function treeWithout(cwd: string, dir: string, sha: string, current: string, paths: string[]): Promise<string | null> {
  const load = await shadowGit(cwd, dir, ['read-tree', '--reset', sha], { allowFailure: true })
  const drop = load.ok
    ? await shadowGit(cwd, dir, ['update-index', '--force-remove', '-z', '--stdin'], { allowFailure: true, stdin: `${paths.join('\0')}\0` })
    : load
  const tree = drop.ok ? await shadowGit(cwd, dir, ['write-tree'], { allowFailure: true }) : drop
  const back = await shadowGit(cwd, dir, ['read-tree', '--reset', current], { allowFailure: true })
  const out = tree.stdout.trim()
  return tree.ok && back.ok && /^[0-9a-f]{40}$/.test(out) ? out : null
}

export function restoreCheckpoint(cwd: string, recordId: string, sessionKey: string): Promise<CheckpointRestoreResult> {
  return serialized(normalizeCwd(cwd), async () => {
    const dir = projectDir(cwd)
    const index = await readIndex(dir, cwd)
    const target = index.records.find((r) => r.id === recordId)
    const sha = shaOf(target)
    if (!target || !sha) return { ok: false, error: '找不到这个检查点（可能已过期被清理）', restored: 0 }
    const before = await takeSnapshot(cwd, sessionKey || target.sessionKey, `回退前：${target.preview}`, 'restore')
    if (!before) return { ok: false, error: '回退前没能存下现在的状态，已取消，文件没有改动', restored: 0 }
    const beforeSha = shaOf((await readIndex(dir, cwd)).records.find((r) => r.id === before.id))
    const kept = await oversizedInWorktree(cwd, dir, sha)
    if (!kept) return { ok: false, error: '读不到检查点内容，已取消，文件没有改动', undoId: before.id, restored: 0 }
    let restoreTree = sha
    if (kept.length) {
      const narrowed = beforeSha ? await treeWithout(cwd, dir, sha, beforeSha, kept) : null
      if (!narrowed) return { ok: false, error: '没能避开超大文件，已取消，文件没有改动', undoId: before.id, restored: 0 }
      restoreTree = narrowed
    }
    const reset = await shadowGit(cwd, dir, ['read-tree', '-u', '--reset', restoreTree], { allowFailure: true })
    if (!reset.ok) return {
      ok: false,
      error: `恢复失败，工作区可能已部分变更；可用撤销检查点 ${before.id} 恢复回退前状态。${reset.error ? ` ${reset.error}` : ''}`,
      undoId: before.id,
      restored: 0
    }
    const changed = beforeSha ? await shadowGit(cwd, dir, ['diff-tree', '-r', '--name-only', '--no-renames', beforeSha, restoreTree], { allowFailure: true }) : null
    const restored = changed?.ok ? changed.stdout.split('\n').filter(Boolean).length : 0
    return { ok: true, undoId: before.id, restored }
  })
}

export async function pruneCheckpoints(now = Date.now()): Promise<void> {
  let dirs: string[]
  try {
    dirs = await readdir(ROOT)
  } catch {
    return
  }
  for (const name of dirs) {
    const dir = join(ROOT, name)
    const initial = await readIndex(dir, '')
    const lockKey = initial.cwd ? normalizeCwd(initial.cwd) : `checkpoint-dir:${name}`
    await serialized(lockKey, async () => {
    try {
      const st = await stat(dir)
      if (!st.isDirectory()) return
      await removeStaleTemp(dir)
      const index = await readIndex(dir, '')
      const kept = index.records.filter((r) => now - r.at < KEEP_MS)
      if (!kept.length) {
        await rm(dir, { recursive: true, force: true })
        return
      }
      if (kept.length === index.records.length) return
      const alive = new Set(kept.map((r) => shaOf(r)).filter((s): s is string => !!s))
      const dropped = new Set(index.records.map((r) => shaOf(r)).filter((s): s is string => !!s && !alive.has(s)))
      const cwd = index.cwd
      let gcAt = index.lastGcAt
      if (cwd && existsSync(cwd)) {
        for (const sha of dropped) await shadowGit(cwd, dir, ['update-ref', '-d', `refs/cp/${sha}`], { allowFailure: true })
        if (now - (index.lastGcAt ?? 0) >= GC_INTERVAL_MS) {
          await shadowGit(cwd, dir, ['gc', '--prune=now', '--quiet'], { allowFailure: true, timeout: 120_000 })
          gcAt = now
        }
      }
      await writeIndex(dir, { ...index, records: kept, ...(gcAt ? { lastGcAt: gcAt } : {}) })
    } catch {
    }
    })
  }
}
