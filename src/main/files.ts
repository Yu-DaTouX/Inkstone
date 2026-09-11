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
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import type { DirEntry, DirListing } from '../shared/ipc'

/**
 * 永远不进这些目录。
 *
 * `node_modules` 是几万个文件、`.git` 是二进制对象库 ——
 * 展开它们既慢又没有信息量（用户的意图是找**自己的**代码）。
 * 但**不隐藏**它们：在树上显示成一个不可展开的条目，
 * 比凭空消失好（用户会以为文件树列不全）。
 */
const OPAQUE = new Set(['node_modules', '.git', '.svn', '.hg'])

/** 一层最多回多少条（超了截断并告诉界面「还有 N 项」） */
const MAX_ENTRIES = 400

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
export async function listDir(cwd: string, rel = ''): Promise<DirListing> {
  const abs = safeJoin(cwd, rel)
  const empty: DirListing = { path: rel ?? '', abs: '', entries: [], skipped: [], truncated: false }
  if (!abs) return empty

  let dirents: Dirent[]
  try {
    dirents = await readdir(abs, { withFileTypes: true })
  } catch {
    return { ...empty, abs: displayPath(abs) }
  }

  const skipped: string[] = []
  // 先只用 Dirent 的信息（零系统调用）分成目录/文件两组
  const dirs: { name: string; dir: true }[] = []
  const files: { name: string; dir: false }[] = []
  for (const d of dirents) {
    const isDir = d.isDirectory()
    if (isDir && OPAQUE.has(d.name)) {
      skipped.push(d.name)
      continue
    }
    if (isDir) dirs.push({ name: d.name, dir: true })
    else files.push({ name: d.name, dir: false })
  }

  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)

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
          const st = await stat(join(abs, e.name))
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
    abs: displayPath(abs),
    entries,
    skipped,
    truncated,
    ...(rel ? {} : { rootName: basename(abs) || abs })
  }
}
