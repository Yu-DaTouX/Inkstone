import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const SUBAGENT_ID = /^sub-[0-9a-f]{8}$/

const KEPT_GIT_VARIABLES = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])
const NO_HOOKS = join(tmpdir(), `inkstone-debug-no-hooks-${process.pid}-absent`)

function gitEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key) || KEPT_GIT_VARIABLES.has(key.toUpperCase())) env[key] = value
  return { ...env, GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
}

function git(cwd, args) {
  const hardening = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'diff.external=', '-c', 'color.ui=false']
  const result = spawnSync('git', [...hardening, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: gitEnv() })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() }
}

function samePath(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function nativeReal(path) {
  try { return realpathSync.native(path) } catch { return null }
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export function worktreeGitdir(worktree) {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'))
    if (!match) return null
    const target = match[1].trim()
    return isAbsolute(target) ? resolve(target) : resolve(worktree, target)
  } catch { return null }
}

export function detachLinks(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`工作树路径本身是链接，不处理：${root}`)
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        try { unlinkSync(path) } catch { rmdirSync(path) }
      } else if (stat.isDirectory()) pending.push(path)
    }
  }
}

function registeredWorktrees(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain'])
  if (!out.ok) return null
  return out.stdout.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => resolve(line.slice(9).trim()))
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function checkSubagentWorktree({ id, worktreePath, repoRoot, containerPath }, { repoWithin, tempRoot = tmpdir() } = {}) {
  if (!SUBAGENT_ID.test(id ?? '')) return '记录 id 不合法'
  if (!worktreePath || !repoRoot) return '记录里没有工作树或仓库路径'
  const container = dirname(resolve(worktreePath))
  if (basename(worktreePath) !== 'worktree' || !basename(container).startsWith(`yan-subagent-${id}-`)) return '不是 yan-subagent-<id>-*/worktree 结构'
  const parent = nativeReal(dirname(container)) ?? resolve(dirname(container))
  const temp = nativeReal(tempRoot) ?? resolve(tempRoot)
  if (!samePath(parent, temp)) return '临时目录不在系统临时目录下'
  if (existsSync(container) && lstatSync(container).isSymbolicLink()) return '临时目录本身是链接'
  if (containerPath && !samePath(containerPath, container)) return '临时目录与工作树不对应'
  if (repoWithin && !inside(repoWithin, repoRoot)) return '仓库不在本次运行目录里'
  const commonDir = join(resolve(repoRoot), '.git', 'worktrees')
  if (existsSync(worktreePath)) {
    if (lstatSync(worktreePath).isSymbolicLink()) return '工作树路径本身是链接'
    const gitdir = worktreeGitdir(worktreePath)
    if (!gitdir || !inside(commonDir, gitdir)) return `gitdir 不指向该仓库（${gitdir ?? '读不到'}）`
  }
  return null
}

export function removeSubagentWorktree(entry) {
  const { worktreePath, repoRoot } = entry
  const container = dirname(resolve(worktreePath))
  if (!existsSync(worktreePath)) {
    if (!existsSync(container)) return { ok: true }
    if (readdirSync(container).length) return { ok: false, reason: '工作树已不在、临时目录里还有别的东西，不删' }
    rmdirSync(container)
    return { ok: true }
  }
  const registered = existsSync(join(repoRoot, '.git')) ? registeredWorktrees(repoRoot) : []
  if (registered === null) return { ok: false, reason: '读不到仓库的工作树登记' }
  const listed = registered.some((path) => samePath(path, worktreePath))
  if (!listed && existsSync(worktreePath) && existsSync(join(repoRoot, '.git'))) return { ok: false, reason: '工作树没有登记在该仓库里' }
  if (existsSync(worktreePath)) detachLinks(worktreePath)
  if (listed) {
    const removed = git(repoRoot, ['worktree', 'remove', '--force', worktreePath])
    if (!removed.ok && (registeredWorktrees(repoRoot) ?? []).some((path) => samePath(path, worktreePath))) return { ok: false, reason: `git worktree remove 失败：${removed.stderr}` }
  }
  for (let attempt = 0; attempt < 6 && existsSync(container); attempt += 1) {
    try { rmSync(container, { recursive: true, force: true }) } catch { pause(400) }
  }
  if (existsSync(join(repoRoot, '.git'))) git(repoRoot, ['worktree', 'prune'])
  return existsSync(container) ? { ok: false, reason: '临时目录删不掉（可能仍被占用）' } : { ok: true }
}

export function archivedWorktrees(archiveDir) {
  const entries = []
  let files = []
  try { files = readdirSync(archiveDir, { withFileTypes: true }) } catch { return entries }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(readFileSync(join(archiveDir, file.name), 'utf8'))
      const workspace = record?.resume?.workspace
      if (record?.isolation !== 'worktree' || !workspace?.worktreePath) continue
      entries.push({ id: record.id, worktreePath: resolve(workspace.worktreePath), repoRoot: workspace.repoRoot ? resolve(workspace.repoRoot) : undefined, containerPath: workspace.containerPath })
    } catch {}
  }
  return entries
}

export function cleanupInstanceWorktrees(runDir, archiveDir = join(runDir, 'yan', 'subagents'), options = {}) {
  const removed = []
  const skipped = []
  for (const entry of archivedWorktrees(archiveDir)) {
    const container = dirname(entry.worktreePath)
    if (!existsSync(container)) continue
    const problem = checkSubagentWorktree(entry, { repoWithin: runDir, ...options })
    if (problem) {
      skipped.push({ worktree: entry.worktreePath, reason: problem })
      continue
    }
    try {
      const result = removeSubagentWorktree(entry)
      if (result.ok) removed.push(entry.worktreePath)
      else skipped.push({ worktree: entry.worktreePath, reason: result.reason })
    } catch (error) {
      skipped.push({ worktree: entry.worktreePath, reason: String(error?.message ?? error) })
    }
  }
  return { removed, skipped }
}
