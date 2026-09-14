/**
 * 链接路由：判断一个链接该「在内部浏览器打开」「进文件预览」还是「拒绝」。
 *
 * 为什么独立成纯函数（方案 5.2）：
 *   · 这是**安全判断**（非法协议、路径穿越、可执行文件），必须有单测钉住；
 *   · 判断逻辑不依赖 DOM / Electron，放在 shared 层两边都能用。
 *
 * 作用范围：只处理**显式链接**（Markdown `[文字](目标)` 与 GFM 自动链接）。
 * 纯文本里出现的半截路径**不会**被自动改写 —— 代码块、流式输出里的
 * 半个路径因此不会被误判（方案 5.2 的要求）。
 */

export type LinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'invalid'; reason: 'empty' | 'protocol' }

/** 明确否决的协议：能在渲染端执行脚本或内联数据的一律不放行 */
const BLOCKED_SCHEMES = new Set(['javascript', 'vbscript', 'data', 'blob'])

/** 允许外部程序的普通链接协议（交系统处理，不进内部浏览器） */
const EXTERNAL_SCHEMES = new Set(['mailto', 'tel'])

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/** `路径:42` 或 `路径:42:7` —— 行号、列号 */
const LINE_RE = /^(.*?):(\d+)(?::(\d+))?$/

function isWindowsAbs(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p)
}
function isUncAbs(p: string): boolean {
  return /^\\\\[^\\]/.test(p)
}
function isUnixAbs(p: string): boolean {
  return p.startsWith('/')
}

/**
 * 拆出行号。
 *
 * ⚠️ 必须排除盘符：`C:\a\b.ts` 里的 `C:` 不是行号。
 *    `LINE_RE` 要求冒号后全是数字，所以 `C:\a` 不会匹配；
 *    但 `C:42`（相对盘符 + 数字）会被误读 —— 那种形式本来也不是合法文件链接。
 */
function splitLine(raw: string): { path: string; line?: number } {
  const m = LINE_RE.exec(raw)
  if (!m) return { path: raw }
  const base = m[1]
  if (!base) return { path: raw }
  /* base 是 `C` 这样的裸盘符时不当行号（`C:42` 不是文件路径） */
  if (/^[a-zA-Z]$/.test(base)) return { path: raw }
  const line = Number(m[2])
  return Number.isFinite(line) && line > 0 ? { path: base, line } : { path: raw }
}

/** `file:///C:/a/b.ts` → `C:/a/b.ts`；`file:///home/x` → `/home/x` */
function fileUrlToPath(raw: string): string {
  let rest = raw.slice('file://'.length)
  /* `/C:/…` 是 Windows 盘符形式，去掉多余的那个前导斜杠；类 Unix 路径保持不变 */
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1)
  try {
    return decodeURIComponent(rest)
  } catch {
    /* 编码坏了就按原样 */
    return rest
  }
}

/**
 * 分类一个链接目标。
 *
 * · `https://` / `http://`      → url（内部浏览器；菜单里另有外部浏览器）
 * · `file://…`、绝对路径、相对路径 → file（只读预览，行号一并带出去）
 * · `mailto:` / `tel:`           → url（交给系统处理，不算危险协议）
 * · `javascript:` / `data:` 等   → invalid（明确拒绝）
 */
export function classifyLink(href: string | undefined | null): LinkTarget {
  const raw = (href ?? '').trim()
  if (!raw) return { kind: 'invalid', reason: 'empty' }
  if (raw.includes('\0')) return { kind: 'invalid', reason: 'protocol' }

  /*
   * Windows 盘符要在 scheme 判断**之前**处理：
   * `C:/a/b.ts` 里的 `C:` 完全符合 `scheme:` 的写法，
   * 当成协议会被归为「未知协议」而拒绝。同理 UNC（\\server\share）。
   */
  if (isWindowsAbs(raw) || isUncAbs(raw)) {
    const { path, line } = splitLine(raw)
    return { kind: 'file', path, ...(line ? { line } : {}) }
  }

  const scheme = SCHEME_RE.exec(raw)?.[1]?.toLowerCase()
  if (scheme) {
    if (scheme === 'http' || scheme === 'https') return { kind: 'url', url: raw }
    if (scheme === 'file') {
      const { path, line } = splitLine(fileUrlToPath(raw))
      return { kind: 'file', path, ...(line ? { line } : {}) }
    }
    if (EXTERNAL_SCHEMES.has(scheme)) return { kind: 'url', url: raw }
    if (BLOCKED_SCHEMES.has(scheme)) return { kind: 'invalid', reason: 'protocol' }
    /* 其它自定义协议（vscode://、yan://…）一律拒绝，不做猜测 */
    return { kind: 'invalid', reason: 'protocol' }
  }

  /* 没有 scheme：当路径处理 */
  if (isUnixAbs(raw)) {
    const { path, line } = splitLine(raw)
    return { kind: 'file', path, ...(line ? { line } : {}) }
  }

  /*
   * 相对路径：Markdown 链接本来就写得像路径（`src/main/index.ts`、
   * `./docs/x.md`）才走这里。像 `foo` 这种没有分隔符也没有扩展名的
   * 短词不当路径 —— 它更可能是写错的锚点。
   */
  if (raw.includes('/') || raw.includes('\\') || /\.[a-zA-Z0-9]{1,8}$/.test(raw)) {
    const { path, line } = splitLine(raw)
    return { kind: 'file', path, ...(line ? { line } : {}) }
  }

  return { kind: 'invalid', reason: 'empty' }
}
