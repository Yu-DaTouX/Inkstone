/**
 * 文件树的数据源：列出 cwd 下的目录内容（懒加载，一层一次）。
 *
 * 安全边界与 `completePath`（@ 文件补全）完全一致 —— 这是同一条
 * 「渲染端只能看见 cwd 以内的东西」的约束：
 *   · 拒绝 `..`（不能跳出 cwd）
 *   · 拒绝绝对路径（Windows 的 `C:` / 类 Unix 的 `/`）
 *   · 结果一定在 resolve(cwd) 之内（再校验一次，防符号链接/拼接绕过）
 *
 * 与 completePath 的差别（所以没有合并成一个函数）：
 *   · completePath 是「按前缀过滤 + 只回 30 条」的补全场景
 *   · 这里是「列全一层 + 带类型/大小」的浏览场景，且要能区分
 *     「空目录」与「被忽略的目录」（`skipped`），否则用户会以为坏了
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import type {
  DirEntry,
  DirListing,
  FileListingStatus,
  FileRequestContext,
  FileSearchEntry,
  FileSearchRequest,
  FileSearchResult
} from '../shared/ipc'

/**
 * 永远**不展开**的目录（不是“隐藏”，是“太大没意义”）。
 *
 * ⚠️ 命名与文案的区别（用户特地纠正过）：
 *   · 代码里叫 OPAQUE —— 这些目录不是被“藏起来”了，而是列出来也没用
 *   · 界面上叫**已隐藏**（用户要求的措辞），并且旁边给一个**开关**：
 *     想看到它们时能打开（打开后仍然会标注「展开没有意义」）
 * 以前界面写「已跳过」，又没有开关，用户会以为文件树列不全。
 */
const OPAQUE = new Set(['node_modules', '.git', '.svn', '.hg'])

/** 名字以 . 开头的条目（.gitignore / .vscode 这些）—— 默认不显示，可开关 */
function isDotName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

/** 一层最多回多少条（超了截断并告诉界面「还有 N 项」） */
const MAX_ENTRIES = 400

/** 全项目搜索是文件名索引，不是内容搜索；即使用户传入更大的值也不能无限扫。 */
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_DIRS = 2000

function pathKey(value: string): string {
  const normalized = value.replace(/[\\/]+/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, candidate: string): boolean {
  const r = pathKey(root).replace(/\/$/, '')
  const c = pathKey(candidate).replace(/\/$/, '')
  return c === r || c.startsWith(r + '/')
}

function statusForError(error: unknown): FileListingStatus {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  return 'error'
}

function nameSort(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

/**
 * 把渲染端传来的相对路径解析成安全绝对路径。
 *
 * 返回 null = 越界或非法（调用方一律当「空目录」处理，不抛异常 ——
 * 文件树是辅助视图，不能因为一个坏路径让界面报错）。
 */
function safeJoin(cwd: string, rel: string): string | null {
  const root = resolve(cwd)
  const cleaned = (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.split('/').includes('..')) return null
  if (/^[A-Za-z]:/.test(cleaned)) return null
  const abs = resolve(join(root, cleaned))
  // 再确认一次（resolve 之后的边界判断，防拼接绕过）
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

/** 缓存 home 目录，避免每条都算 */
const HOME = homedir()

/** 路径太长时中间省略（只用于展示） */
function displayPath(abs: string): string {
  if (abs.startsWith(HOME)) return '~' + abs.slice(HOME.length).replace(/\\/g, '/')
  return abs.replace(/\\/g, '/')
}

/**
 * 列一层目录。
 *
 * 排序：目录优先 → 名字不区分大小写升序。目录优先是因为
 * 「进下一层」是文件树里最高频的动作，把目录混在文件里要一行行找。
 *
 * ── 性能（这里曾经很慢，被探针的丢按键暴露出来）──
 *   `readdir(withFileTypes)` 已经免费给了「是不是目录」，所以**不要**
 *   为了拿目录标志而 stat。大小只对**要显示的那部分**文件取 ——
 *   上一版对**每个**条目 stat（为了拿 size），然后才截断到 400 条：
 *   家目录上千条 = 上千次系统调用，主进程被拖住（表现为快捷键丢事件）。
 *   现在先排序、再截断、**最后**只为那 ≤400 个文件取 size。
 */
export async function listDir(
  cwd: string,
  rel = '',
  showHidden = false,
  request?: FileRequestContext
): Promise<DirListing> {
  const root = await realpath(cwd).catch(() => resolve(cwd))
  const abs = safeJoin(root, rel)
  const empty: DirListing = {
    path: rel ?? '',
    abs: '',
    entries: [],
    skipped: [],
    truncated: false,
    status: 'invalid',
    ...(request ? { request } : {})
  }
  if (!abs || !isWithin(root, abs)) return empty

  /* 不跟随用户手写的符号链接 / junction；每次展开只做一次真实路径校验。 */
  let realDir: string
  try {
    realDir = await realpath(abs)
  } catch (error) {
    const status = statusForError(error)
    return {
      ...empty,
      abs: displayPath(abs),
      status,
      error: status === 'permission' ? 'permission' : status === 'missing' ? 'missing' : 'error'
    }
  }
  if (!isWithin(root, realDir) || pathKey(realDir) !== pathKey(abs)) {
    return { ...empty, status: 'invalid', error: 'invalid' }
  }

  let dirents: Dirent[]
  try {
    dirents = await readdir(realDir, { withFileTypes: true })
  } catch (error) {
    const status = statusForError(error)
    return {
      ...empty,
      abs: displayPath(realDir),
      status,
      error: status === 'permission' ? 'permission' : status === 'missing' ? 'missing' : 'error'
    }
  }

  const skipped: string[] = []
  // 先只用 Dirent 的信息（零系统调用）分成目录/文件两组
  const dirs: { name: string; dir: true }[] = []
  const files: { name: string; dir: false }[] = []
  for (const d of dirents) {
    /* 符号链接 / junction 不进入文件树，避免点击或展开时绕过 cwd 边界。 */
    if (d.isSymbolicLink()) {
      skipped.push(d.name)
      continue
    }
    /*
     * 三类过滤，语义不同（用户要求把「隐藏」单独拉出来给个开关）：
     *   ① OPAQUE（node_modules/.git…）—— showHidden 打开时才列出，
     *      并且仍然不可展开（列出来只是想让你看见它存在）
     *   ② 点名文件（.gitignore/.vscode…）—— 默认不列，showHidden 打开时列
     *   ③ 其余 —— 照常列
     */
    const isDir = d.isDirectory()
    const opaque = isDir && OPAQUE.has(d.name)
    const dotted = isDotName(d.name)
    if (!showHidden && (opaque || dotted)) {
      skipped.push(d.name)
      continue
    }
    if (isDir) dirs.push({ name: d.name, dir: true })
    else files.push({ name: d.name, dir: false })
  }

  dirs.sort(nameSort)
  files.sort(nameSort)

  const all = [...dirs, ...files]
  const truncated = all.length > MAX_ENTRIES
  const kept = truncated ? all.slice(0, MAX_ENTRIES) : all

  /*
   * 只为留下来的**文件**取 size（目录不需要）。
   * 并发跑：
   *   · 串行 await 会让 400 个文件变成 400 个往返，慢得能看出来
   *   · 不限并发地 Promise.all 会瞬间开 400 个 fs 请求
   * 所以分块（一次 64 个）。失败的单个条目不丢 —— size 就是 undefined，
   * 界面上少一个尺寸比少一个文件好。
   */
  const sizes = new Map<string, number>()
  const CHUNK = 64
  for (let i = 0; i < kept.length; i += CHUNK) {
    const slice = kept.slice(i, i + CHUNK).filter((e) => !e.dir)
    await Promise.all(
      slice.map(async (e) => {
        try {
          const st = await stat(join(realDir, e.name))
          sizes.set(e.name, st.size)
        } catch {
          /* 断掉的符号链接 / 权限不足：不显示尺寸 */
        }
      })
    )
  }

  const entries: DirEntry[] = kept.map((e) => {
    const size = e.dir ? undefined : sizes.get(e.name)
    return { name: e.name, dir: e.dir, ...(size !== undefined ? { size } : {}) }
  })

  return {
    path: rel ?? '',
    abs: displayPath(realDir),
    entries,
    skipped: skipped.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })),
    truncated,
    status: entries.length ? 'ok' : 'empty',
    totalEntries: all.length,
    ...(request ? { request } : {}),
    ...(rel ? {} : { rootName: basename(realDir) || realDir })
  }
}

/**
 * 全项目文件名搜索。
 *
 * 这是和文件树完全不同的动作：它可以递归，但只递归目录名索引，
 * 不读文件内容；跳过 node_modules/.git 等大型依赖目录；每处理一层
 * 主动让出事件循环，并在每个边界检查 AbortSignal，避免搜索把桌面端卡住。
 */
export async function searchFiles(request: FileSearchRequest, signal?: AbortSignal): Promise<FileSearchResult> {
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(request.limit ?? MAX_SEARCH_RESULTS)))
  const query = String(request.query ?? '').trim().toLocaleLowerCase()
  const baseResult = (status: FileSearchResult['status'], entries: FileSearchEntry[] = [], truncated = false, scannedDirs = 0, skippedDirs = 0): FileSearchResult => ({
    request,
    entries,
    status,
    truncated,
    scannedDirs,
    skippedDirs
  })

  if (!query) return baseResult('empty')

  let root: string
  try {
    root = await realpath(request.cwd)
    if (!(await stat(root)).isDirectory()) return baseResult('invalid')
  } catch (error) {
    return baseResult(statusForError(error))
  }

  const entries: FileSearchEntry[] = []
  const queue: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  let scannedDirs = 0
  let skippedDirs = 0
  let hadReadError = false
  let truncated = false

  const matches = (name: string, rel: string): boolean =>
    name.toLocaleLowerCase().includes(query) || rel.toLocaleLowerCase().includes(query)

  while (queue.length) {
    if (signal?.aborted) return baseResult('cancelled', entries, truncated, scannedDirs, skippedDirs)
    if (scannedDirs >= MAX_SEARCH_DIRS) {
      truncated = true
      break
    }

    const current = queue.shift()!
    scannedDirs += 1
    let dirents: Dirent[]
    try {
      dirents = await readdir(current.abs, { withFileTypes: true })
    } catch (error) {
      hadReadError = true
      /* 根目录不可读要如实返回；子目录则保留已有结果并标为 partial。 */
      if (current.rel === '') return baseResult(statusForError(error), entries, truncated, scannedDirs, skippedDirs)
      continue
    }

    const dirs: Dirent[] = []
    const files: Dirent[] = []
    for (const entry of dirents) {
      if (signal?.aborted) return baseResult('cancelled', entries, truncated, scannedDirs, skippedDirs)
      if (entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (OPAQUE.has(entry.name)) {
          skippedDirs += 1
          continue
        }
        dirs.push(entry)
      } else {
        files.push(entry)
      }
    }
    dirs.sort(nameSort)
    files.sort(nameSort)

    for (const entry of [...dirs, ...files]) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      if (matches(entry.name, rel)) {
        entries.push({ path: rel, name: entry.name, dir: entry.isDirectory() })
        if (entries.length >= limit) {
          truncated = true
          break
        }
      }
      if (entry.isDirectory()) {
        /* 队列本身也要有界：单层目录里有很多子目录时不能先把它们全塞进内存。 */
        if (scannedDirs + queue.length >= MAX_SEARCH_DIRS) {
          truncated = true
          break
        }
        queue.push({ abs: join(current.abs, entry.name), rel })
      }
    }
    if (truncated) break

    /* 大型项目搜索不能连续占满主进程事件循环。 */
    await new Promise<void>((resolveNext) => setImmediate(resolveNext))
  }

  const status: FileSearchResult['status'] =
    signal?.aborted ? 'cancelled' : hadReadError ? (entries.length ? 'partial' : 'permission') : truncated ? 'partial' : entries.length ? 'ok' : 'empty'
  return baseResult(status, entries, truncated, scannedDirs, skippedDirs)
}
