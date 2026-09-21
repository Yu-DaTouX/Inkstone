/**
 * 工作树 Fork 的路径重绑定（实施-07 S2b-3）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 源会话开在主仓库目录，新会话开在**工作树**目录 —— 同一仓库的另一份检出，
 * 文件可能根本不在（分支不同、未 merge）。源会话里出现的**文件引用**
 * （`@src/foo.ts`、交接包的 `files`）在新目录里必须**重新解析**：
 * 拼到工作树的仓库根上，再验证它到底还在不在。
 *
 * ══════════════════════════════════════════════════════════
 * 硬规则（形态决策 §3 定的，不是这里想出来的）
 * ══════════════════════════════════════════════════════════
 * · 一律用**仓库相对路径**表达；**不做**「绝对路径前缀替换」
 *   （`text.replace("C:\\repo\\", "C:\\repo-worktree\\")` 是被点名的反模式）。
 * · `..`、以及仓库**外**的绝对路径 → `outside`：不迁移，但如实告诉用户「这个带不过去」。
 *   `outside` 与 `missing` 必须分开 —— 前者是**设计上不迁**，后者是**迁了但对不上**。
 * · 这一层是**纯函数**：文件系统查询由调用方以 `stat` 注入，Windows 大小写与分隔符差异
 *   在比较时归一，返回的路径保留原样拼写。
 */

/** 引用在目标仓库根下的解析结果。 */
export type ForkRefState = 'resolved' | 'missing' | 'type-mismatch' | 'outside'

export interface ForkRefResolution {
  /** 原始引用（绝对路径会被换成相对路径后放进这里） */
  ref: string
  state: ForkRefState
  /** 解析到的绝对路径；`outside` 时为 null */
  abs: string | null
  /** 实际类型（`outside` / `missing` 时为 null） */
  kind: 'file' | 'dir' | null
}

export interface ForkRefSummary {
  total: number
  resolved: number
  missing: number
  mismatch: number
  outside: number
  /** 需要用户看的那些（missing / mismatch / outside），保持输入顺序 */
  problems: ForkRefResolution[]
}

/** `\` → `/`，去掉尾部分隔符（`C:\` → `C:`；比较时两边都过一遍） */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\+/g, '/').replace(/\/+$/, '')
}

const lower = (p: string): string => normalizeSlashes(p).toLowerCase()

/** 盘符绝对路径（`C:/x`）或 POSIX 绝对路径（`/x`） */
export function isAbsolutePath(p: string): boolean {
  const n = normalizeSlashes(p)
  return /^[a-zA-Z]:\//.test(n) || n.startsWith('/')
}

/** 任何一段是 `..` 就算逃逸（`a/../b` 也拒 —— 归一化越界路径不值得，直接问用户要相对路径） */
export function hasDotDot(ref: string): boolean {
  return normalizeSlashes(ref)
    .split('/')
    .some((seg) => seg === '..')
}

/**
 * 绝对路径 → 仓库相对路径；不在仓库内（或就是仓库根）时返回 `null`。
 *
 * 比较大小写不敏感（Windows），返回的拼写取自 `abs`。
 */
export function toRepoRelative(repoRoot: string, abs: string): string | null {
  const root = normalizeSlashes(repoRoot)
  const target = normalizeSlashes(abs)
  const r = lower(root)
  const t = lower(target)
  if (t === r) return null
  if (!t.startsWith(r + '/')) return null
  return target.slice(root.length + 1)
}

/**
 * 用目标仓库根解析一批引用。`stat` 返回 `'file' | 'dir' | null`（null = 不存在）。
 *
 * 引用的**期望类型**从写法上看：以 `/` 结尾表示要目录 —— 如果那里实际是文件，
 * 报 `type-mismatch` 而不是 `resolved`（把「目录换成了同名文件」当成对上会误导用户）。
 */
export function resolveForkRefs(
  repoRoot: string,
  refs: readonly string[],
  stat: (abs: string) => 'file' | 'dir' | null
): ForkRefResolution[] {
  const base = normalizeSlashes(repoRoot)
  const seen = new Set<string>()
  const out: ForkRefResolution[] = []
  for (const item of refs) {
    const raw = String(item ?? '').trim().replace(/^\.\//, '')
    if (!raw) continue
    const wantDir = /[\\/]$/.test(raw)
    let ref = normalizeSlashes(raw)
    if (isAbsolutePath(raw)) {
      const converted = toRepoRelative(base, raw)
      if (!converted) {
        out.push({ ref: normalizeSlashes(raw), state: 'outside', abs: null, kind: null })
        continue
      }
      ref = converted
    } else if (hasDotDot(raw)) {
      out.push({ ref: normalizeSlashes(raw), state: 'outside', abs: null, kind: null })
      continue
    }
    if (seen.has(ref.toLowerCase())) continue
    seen.add(ref.toLowerCase())
    const abs = `${base}/${ref}`
    const kind = stat(abs)
    if (!kind) {
      out.push({ ref, state: 'missing', abs, kind: null })
      continue
    }
    out.push({ ref, state: wantDir && kind === 'file' ? 'type-mismatch' : 'resolved', abs, kind })
  }
  return out
}

/** 汇总（界面拿到的是「N 个对上 / M 个对不上」，不是一长串状态名）。 */
export function summarizeForkRefs(list: readonly ForkRefResolution[]): ForkRefSummary {
  const summary: ForkRefSummary = { total: list.length, resolved: 0, missing: 0, mismatch: 0, outside: 0, problems: [] }
  for (const item of list) {
    if (item.state === 'resolved') summary.resolved += 1
    else if (item.state === 'missing') {
      summary.missing += 1
      summary.problems.push(item)
    } else if (item.state === 'type-mismatch') {
      summary.mismatch += 1
      summary.problems.push(item)
    } else {
      summary.outside += 1
      summary.problems.push(item)
    }
  }
  return summary
}

/*
 * `@` 引用提取用的模式。
 *
 * 为什么要限定「前面是空白 / 左括号」：消息里 `foo@bar.com`、`@scope/pkg`
 * 也会命中裸 `@`，而它们不是文件引用。允许中文全角括号与项目自己用的方括号 ——
 * 用户在中文里吐槽时常常写成「（@src/a.ts）」。
 */
const AT_REF = /(?:^|[\s(（【[])[@＠]([^\s@＠,，。；;、)）\]】'"]+)/g

/**
 * 从会话文本里捞「看起来是文件引用」的 token。
 *
 * `isRepoFile` 由调用方注入（通常是「源仓库里存在这个相对路径」）——
 * 不做这个过滤的话，`@某人` 这种也会被当成路径。
 */
export function extractRefsFromTexts(
  texts: readonly string[],
  isRepoFile: (rel: string) => boolean
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue
    AT_REF.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = AT_REF.exec(text))) {
      /* 尾部标点不算路径的一部分（`@src/a.ts,` / `@src/a.ts。`） */
      const ref = m[1].replace(/[.,;:]+$/, '')
      if (!ref || isAbsolutePath(ref) || hasDotDot(ref)) continue
      if (/^https?:/i.test(ref)) continue
      if (!isRepoFile(ref)) continue
      const key = ref.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
  }
  return out
}
