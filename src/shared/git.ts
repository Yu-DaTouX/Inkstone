/** Git repository state, porcelain parsing and hosted comparison URLs. No IO. */

/**
 * 把 git remote 的地址转成**托管网页**地址（方案 §7 的「托管网页比较」）。
 *
 * 支持三种写法，其余一律返回 null（宁可不给链接，也不要拼一个打不开的）：
 *   · `https://host/owner/repo.git`
 *   · `git@host:owner/repo.git`（ssh 最常见的写法）
 *   · `ssh://git@host/owner/repo.git`
 *
 * 只认已知的托管站（github / gitlab / bitbucket）—— 自建服务的网页路径各不相同，
 * 猜一个等于给用户一个 404。
 */
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
    /* 排除 Windows 盘符（C:\foo 长得和 scp 写法一样） */
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

/** 托管网页的 compare 页（GitHub / GitLab / Bitbucket 的路径不同） */
export function compareWebUrl(webUrl: string, base: string, target: string): string | null {
  const b = String(base ?? '').trim()
  const t = String(target ?? '').trim()
  if (!webUrl || !b || !t || b === t) return null
  if (/bitbucket\.org$/.test(new URL(webUrl).host)) {
    /* Bitbucket 的写法是 /branches/compare/<新>..<旧> —— 顺序与我们相反 */
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
  /** 工作树根目录的规范化路径（渲染端只用来显示与分组，不做拼接） */
  root: string
  name: string
  /** 仓库身份（git 的 common dir）+ 工作树身份，两者分开：worktree 共享前者 */
  repoId: string
  worktreeId: string
  branch: string | null
  detached: boolean
  unborn: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** 当前分支是否被**别的**工作树占用（切换分支前的提示来源） */
  busyBranches: string[]
  /** 变更文件总数（**去重**：同一文件既有暂存又有未暂存只算一个） */
  changedCount: number
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  /** 未推送到 upstream 的提交数；没有 upstream 时为 null */
  unpushedCount: number | null
  hasCommit: boolean
}

/* ── git status --porcelain=v2 -z 解析 ──────────────────── */

export interface GitStatusEntry {
  /** 两位 XY：index 位 + 工作区位（`.` 表示无变化） */
  x: string
  y: string
  path: string
  /** rename / copy 的旧路径 */
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

/**
 * 解析 `git status --porcelain=v2 -z --branch --untracked-files=all`。
 *
 * `-z` 的坑：路径是**原样**输出（不转义、不加引号），所以带空格 / 中文 /
 * 换行的路径都安全；代价是分段要用 NUL，而且 rename 条目**多占一段**
 * （`R` 条目的新路径与旧路径是两段）。
 *
 * 头部行（`# branch.*`）在 `-z` 下同样以 NUL 结尾，所以能和其他条目
 * 一样按段处理 —— 这一点和 `--porcelain=v1` 不同，别照抄旧代码。
 */
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
      /*
       * 固定字段计数切分（path 里可能有空格，不能最后再 join 猜）：
       *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>            → 8 段
       *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> → 9 段
       */
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
        /* 旧路径在**下一段**（-z 专有的排列） */
        const orig = segs[i + 1] ?? ''
        if (orig) entry.origPath = orig
        i++
      }
      out.entries.push(entry)
      continue
    }
    if (code === 'u') {
      /* u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> → 10 段 */
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
