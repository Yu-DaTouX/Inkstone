/**
 * 检查点：给项目目录在每一轮消息发出前存一份文件快照，可以把代码回退到那个时刻。
 *
 * ── 做法 ──
 * 每个项目一个**影子 git 仓库**（`YAN_DIR/checkpoints/<项目指纹>/repo.git`），工作树指向项目目录本身，
 * 与项目自己的 `.git` 互不相干：不会出现在项目的提交、分支或 stash 里，也不会改项目的 git 状态。
 *   · 快照 = `git add -A` 后取 tree，再 `commit-tree` 成一个无父提交，用 `refs/cp/<sha>` 保住它；
 *     相同内容的 tree 只存一份，所以没有改动的回合几乎不占空间；
 *   · 尊重项目的 `.gitignore`，另外固定排除 `node_modules`、虚拟环境等重目录；
 *   · 能抓到 shell 命令（sed、脚本、构建产物以外的写入）造成的改动，不止 edit / write 工具。
 *
 * ── 回退 ──
 * 先给「现在的样子」存一份 `restore` 快照（用来撤销），再把工作树和索引一并还原到目标快照：
 * 快照之后新建的文件会被删除，被改动或被删的会恢复；被 `.gitignore` 忽略的文件不动。
 * 会话本身不回滚——要连对话一起回到那里，用「分支」。
 *
 * ── 边界 ──
 *   · 只存在本机 `YAN_DIR` 下，不上传；快照里可能有你项目里的任何文本（包括密钥文件），
 *     所以只保留 30 天，且可以在设置里关闭；
 *   · 目录是家目录、盘根或文件数过多（> 30000）时不做，避免一次快照拖慢发送；
 *   · 找不到 git、仓库损坏、超时都不影响发消息：返回 null / 失败结果即可。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { YAN_DIR } from './paths'
import { gitRun } from './git-service'
import {
  textFingerprint,
  type CheckpointChange,
  type CheckpointPreview,
  type CheckpointRecord,
  type CheckpointRestoreResult
} from '../shared/checkpoints'

const ROOT = join(YAN_DIR, 'checkpoints')
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RECORDS = 400
const MAX_FILES = 30_000
const MAX_LISTED_CHANGES = 200
const EXTRA_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.gradle/', '.next/', '.cache/', '.turbo/']

/** 索引里的记录比界面看到的多一个快照提交 sha */
interface StoredRecord extends CheckpointRecord {
  sha: string
}

interface Index {
  version: 1
  cwd: string
  records: StoredRecord[]
  /** 最近一次取快照的 tree，没变化就复用同一个提交 */
  lastTree?: string
  lastSha?: string
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd).replace(/[\\/]+$/, '').toLowerCase()
}

function projectDir(cwd: string): string {
  const hash = createHash('sha1').update(normalizeCwd(cwd)).digest('hex').slice(0, 16)
  return join(ROOT, hash)
}

/** 家目录、盘根这类范围太大的目录不做快照 */
export function isCheckpointableDir(cwd: string): boolean {
  if (!cwd) return false
  const abs = resolve(cwd)
  const root = parse(abs).root
  if (abs === root || normalizeCwd(abs) === normalizeCwd(homedir())) return false
  return existsSync(abs)
}

/** 同一个项目的操作排队，避免两个 git 进程同时抢同一份索引 */
const locks = new Map<string, Promise<unknown>>()
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
      return { version: 1, cwd: cwd || (typeof parsed.cwd === 'string' ? parsed.cwd : ''), records: parsed.records, lastTree: parsed.lastTree, lastSha: parsed.lastSha }
    }
  } catch {
    /* 没有或损坏：从空开始（影子仓库里的快照对象仍在，只是界面上认不出来了） */
  }
  return { version: 1, cwd, records: [] }
}

async function writeIndex(dir: string, index: Index): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `index.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(index), 'utf8')
  await rename(tmp, join(dir, 'index.json'))
}

/** 影子仓库的 git 调用：工作树是项目目录，git 目录是影子仓库 */
function shadowGit(cwd: string, dir: string, args: string[], opts: { timeout?: number; allowFailure?: boolean } = {}) {
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
    { timeout: opts.timeout ?? 60_000, allowFailure: opts.allowFailure }
  )
}

async function ensureRepo(cwd: string, dir: string): Promise<boolean> {
  const repo = join(dir, 'repo.git')
  if (!existsSync(join(repo, 'HEAD'))) {
    await mkdir(dir, { recursive: true })
    const res = await gitRun(cwd, ['init', '--bare', '--quiet', repo], { allowFailure: true, timeout: 20_000 })
    if (!res.ok) return false
  }
  const exclude = join(repo, 'info', 'exclude')
  try {
    await mkdir(join(repo, 'info'), { recursive: true })
    await writeFile(exclude, `${EXTRA_EXCLUDES.join('\n')}\n`, 'utf8')
  } catch {
    /* 写不了排除清单也能继续，只是会多存一些目录 */
  }
  return true
}

/** 把工作树现在的样子并进影子索引，返回 tree；文件数过多或出错返回 null */
async function snapshotTree(cwd: string, dir: string): Promise<string | null> {
  const add = await shadowGit(cwd, dir, ['add', '-A', '--ignore-errors'], { allowFailure: true })
  /* add 在个别文件上失败（权限、被占用）不致命，其余文件照常入索引；其他失败才放弃 */
  if (!add.ok && !/permission denied|unable to index|Invalid argument|short read|failed to insert/i.test(add.stderr)) return null
  const count = await shadowGit(cwd, dir, ['ls-files', '--cached', '-z'], { allowFailure: true })
  if (count.ok && count.stdout.split('\0').length > MAX_FILES) return null
  const tree = await shadowGit(cwd, dir, ['write-tree'], { allowFailure: true })
  const sha = tree.stdout.trim()
  return tree.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

async function commitTree(cwd: string, dir: string, tree: string, message: string): Promise<string | null> {
  const res = await shadowGit(cwd, dir, ['commit-tree', tree, '-m', message.slice(0, 200)], { allowFailure: true })
  const sha = res.stdout.trim()
  if (!res.ok || !/^[0-9a-f]{40}$/.test(sha)) return null
  await shadowGit(cwd, dir, ['update-ref', `refs/cp/${sha}`, sha], { allowFailure: true })
  return sha
}

/**
 * 发消息之前存一份快照。`budgetMs` 内没完成就先放行（首次给大项目建快照可能要几秒），
 * 快照仍会在后台继续完成；返回 null 表示这一轮没有检查点。
 */
/** 上一轮超时后还在后台跑的快照：同一项目不再叠加新的，否则每轮都排在慢快照后面 */
const inflight = new Set<string>()

export function captureCheckpoint(cwd: string, sessionKey: string, text: string, budgetMs = 10_000): Promise<CheckpointRecord | null> {
  if (!isCheckpointableDir(cwd) || !sessionKey) return Promise.resolve(null)
  const key = normalizeCwd(cwd)
  if (inflight.has(key)) return Promise.resolve(null)
  inflight.add(key)
  const work = serialized(key, () => takeSnapshot(cwd, sessionKey, text, 'turn')).catch(() => null)
  void work.finally(() => inflight.delete(key))
  const timeout = new Promise<null>((done) => setTimeout(() => done(null), budgetMs).unref?.())
  return Promise.race([work, timeout])
}

async function takeSnapshot(cwd: string, sessionKey: string, text: string, kind: CheckpointRecord['kind']): Promise<CheckpointRecord | null> {
  const dir = projectDir(cwd)
  if (!(await ensureRepo(cwd, dir))) return null
  const tree = await snapshotTree(cwd, dir)
  if (!tree) return null
  const index = await readIndex(dir, cwd)
  let sha = index.lastTree === tree ? index.lastSha : undefined
  if (!sha) {
    sha = (await commitTree(cwd, dir, tree, `${kind} ${new Date().toISOString()}`)) ?? undefined
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

/** 一个会话在这个项目里的全部检查点（新的在后） */
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
    /* diff 的方向是「快照 → 现在」：现在多出来的（A）回退后会被删，现在没有的（D）回退后会被恢复 */
    const status = match[1] === 'A' ? 'A' : match[1] === 'D' ? 'D' : 'M'
    changes.push({ path: match[2], status })
  }
  return { changes, total }
}

/** 回退到这个检查点会改哪些文件（不动任何文件） */
export function previewCheckpoint(cwd: string, recordId: string): Promise<CheckpointPreview> {
  return serialized(normalizeCwd(cwd), async () => {
    const dir = projectDir(cwd)
    const index = await readIndex(dir, cwd)
    const sha = shaOf(index.records.find((r) => r.id === recordId))
    if (!sha) return { ok: false, error: '找不到这个检查点（可能已过期被清理）', changes: [], total: 0 }
    if (!(await snapshotTree(cwd, dir))) return { ok: false, error: '没能读取项目文件当前的状态', changes: [], total: 0 }
    const diff = await shadowGit(cwd, dir, ['diff-index', '--cached', '--name-status', '--no-renames', sha], { allowFailure: true })
    if (!diff.ok) return { ok: false, error: diff.error ?? '比较失败', changes: [], total: 0 }
    return { ok: true, ...parseChanges(diff.stdout) }
  })
}

/** 把项目文件恢复成这个检查点的样子；先自动存一份「回退前」，方便撤销 */
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
    const reset = await shadowGit(cwd, dir, ['read-tree', '-u', '--reset', sha], { allowFailure: true })
    if (!reset.ok) return { ok: false, error: reset.error ?? '恢复失败', undoId: before.id, restored: 0 }
    const changed = beforeSha ? await shadowGit(cwd, dir, ['diff-tree', '-r', '--name-only', '--no-renames', beforeSha, sha], { allowFailure: true }) : null
    const restored = changed?.ok ? changed.stdout.split('\n').filter(Boolean).length : 0
    return { ok: true, undoId: before.id, restored }
  })
}

/** 删掉过期的检查点与长期不用的影子仓库；应用启动后空闲时调用 */
export async function pruneCheckpoints(now = Date.now()): Promise<void> {
  let dirs: string[]
  try {
    dirs = await readdir(ROOT)
  } catch {
    return
  }
  for (const name of dirs) {
    const dir = join(ROOT, name)
    try {
      const st = await stat(dir)
      if (!st.isDirectory()) continue
      const index = await readIndex(dir, '')
      const kept = index.records.filter((r) => now - r.at < KEEP_MS)
      if (!kept.length) {
        await rm(dir, { recursive: true, force: true })
        continue
      }
      if (kept.length === index.records.length) continue
      const alive = new Set(kept.map((r) => shaOf(r)).filter((s): s is string => !!s))
      const dropped = new Set(index.records.map((r) => shaOf(r)).filter((s): s is string => !!s && !alive.has(s)))
      const cwd = index.cwd
      if (cwd && existsSync(cwd)) {
        for (const sha of dropped) await shadowGit(cwd, dir, ['update-ref', '-d', `refs/cp/${sha}`], { allowFailure: true })
        await shadowGit(cwd, dir, ['gc', '--prune=now', '--quiet'], { allowFailure: true, timeout: 120_000 })
      }
      await writeIndex(dir, { ...index, records: kept })
    } catch {
      /* 某个项目的清理失败不影响其他项目 */
    }
  }
}
