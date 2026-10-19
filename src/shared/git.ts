export function remoteWebUrl(remote: string): string | null {
  const raw = String(remote ?? '').trim()
  if (!raw) return null
  let host = ''
  let path = ''
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(raw)
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw)
  const http = /^https?:\/\/([^/]+)\/(.+)$/.exec(raw)
  if (http) {
    host = http[1]
    path = http[2]
  } else if (ssh) {
    host = ssh[1]
    path = ssh[2]
  } else if (scp && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    host = scp[1]
    path = scp[2]
  } else {
    return null
  }
  const clean = path.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!clean) return null
  const known = ['github.com', 'gitlab.com', 'bitbucket.org']
  if (!known.some((h) => host === h || host.endsWith('.' + h))) return null
  return `https://${host}/${clean}`
}

export function compareWebUrl(webUrl: string, base: string, target: string): string | null {
  const b = String(base ?? '').trim()
  const t = String(target ?? '').trim()
  if (!webUrl || !b || !t || b === t) return null
  if (/bitbucket\.org$/.test(new URL(webUrl).host)) {
    return `${webUrl}/branches/compare/${encodeURIComponent(t)}..${encodeURIComponent(b)}`
  }
  if (/gitlab\.com$/.test(new URL(webUrl).host)) {
    return `${webUrl}/-/compare/${encodeURIComponent(b)}...${encodeURIComponent(t)}`
  }
  return `${webUrl}/compare/${encodeURIComponent(b)}...${encodeURIComponent(t)}`
}

export interface GitRefOption {
  ref: string
  label: string
  kind: 'local' | 'remote' | 'tag' | 'head'
  current: boolean
}

export interface GitRepoState {
  root: string
  name: string
  repoId: string
  worktreeId: string
  branch: string | null
  detached: boolean
  unborn: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  busyBranches: string[]
  changedCount: number
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  unpushedCount: number | null
  hasCommit: boolean
}

export interface GitStatusEntry {
  x: string
  y: string
  path: string
  origPath?: string
  untracked: boolean
  ignored: boolean
  unmerged: boolean
}

export interface GitStatusParse {
  entries: GitStatusEntry[]
  branch: string | null
  detached: boolean
  unborn: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export function parseStatusV2(stdout: string): GitStatusParse {
  const out: GitStatusParse = {
    entries: [],
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0
  }
  const segs = stdout.split('\0')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg) continue
    if (seg.startsWith('# ')) {
      const rest = seg.slice(2)
      if (rest.startsWith('branch.oid ')) {
        const oid = rest.slice('branch.oid '.length).trim()
        if (oid === '(initial)') out.unborn = true
        else if (oid) out.head = oid
      } else if (rest.startsWith('branch.head ')) {
        const name = rest.slice('branch.head '.length).trim()
        if (name === '(detached)') out.detached = true
        else if (name) out.branch = name
      } else if (rest.startsWith('branch.upstream ')) {
        out.upstream = rest.slice('branch.upstream '.length).trim() || null
      } else if (rest.startsWith('branch.ab ')) {
        const m = /^\+(-?\d+)\s+-(-?\d+)$/.exec(rest.slice('branch.ab '.length).trim())
        if (m) {
          out.ahead = Number(m[1])
          out.behind = Number(m[2])
        }
      }
      continue
    }
    const code = seg[0]
    if (code === '1' || code === '2') {
      const fields = code === '1' ? 8 : 9
      const parts = seg.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(fields).join(' ')
      const entry: GitStatusEntry = {
        x: xy[0] ?? '.',
        y: xy[1] ?? '.',
        path,
        untracked: false,
        ignored: false,
        unmerged: false
      }
      if (code === '2') {
        const orig = segs[i + 1] ?? ''
        if (orig) entry.origPath = orig
        i++
      }
      out.entries.push(entry)
      continue
    }
    if (code === 'u') {
      const parts = seg.split(' ')
      const xy = parts[1] ?? 'UU'
      out.entries.push({
        x: xy[0] ?? 'U',
        y: xy[1] ?? 'U',
        path: parts.slice(10).join(' '),
        untracked: false,
        ignored: false,
        unmerged: true
      })
      continue
    }
    if (code === '?' || code === '!') {
      const path = seg.slice(2)
      if (!path) continue
      out.entries.push({
        x: code,
        y: code,
        path,
        untracked: code === '?',
        ignored: code === '!',
        unmerged: false
      })
      continue
    }
  }
  return out
}

export interface GitChangeEntry extends GitStatusEntry {
  staged: boolean
  unstaged: boolean
  added?: number
  removed?: number
}

export interface GitChangesResult {
  ok: boolean
  root: string | null
  scope: string
  branch: string | null
  detached: boolean
  unborn: boolean
  head: string | null
  files: GitChangeEntry[]
  truncated: boolean
  added?: number
  removed?: number
  error?: string
}

export interface GitDiffResult {
  ok: boolean
  path: string
  patch: string
  truncated: boolean
  binary: boolean
  staged: boolean
  unstaged: boolean
  untracked: boolean
  bytes: number
  error?: string
}
