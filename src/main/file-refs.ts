/**
 * 用户**显式引用**的文件（拖入 / 文件树加入上下文）。
 *
 * 为什么单独一个模块（方案 5.1）：
 *   · 渲染端拿到的是 `File` 对象，它可以是工作区外的任何文件；
 *   · 普通文本里出现的绝对路径**不能**因此获得相同权限 ——
 *     授权必须来自一次明确的用户动作（拖入 / 点击加入）；
 *   · 所以：渲染端只负责把 File 换成路径（webUtils），
 *     校验、登记、读取全部在主进程完成，并且只认**已登记**的路径。
 *
 * 授权范围：本次进程运行期（`granted` 表），不落盘。
 * 会话删除 / 重启都会自然失效，不会留下长期可读任意文件的通道。
 *
 * 安全校验（逐条都必要）：
 *   · 必须是绝对路径
 *   · `realpath` 解析后再判断（防符号链接 / junction 逃逸）
 *   · 必须是**普通文件**（拒绝目录、设备、FIFO）
 *   · 大小上限：文本 2MB / 图片 20MB
 *   · 读取只认 `granted` 里的 realpath
 */
import { open, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { FilePreview, FileRefInfo, FileRefKind, FileTextResult } from '../shared/ipc'

/** 单文件文本上限（方案 5.3 建议预览 2MB；超限截断，**不**因此拒绝引用） */
const MAX_TEXT = 2 * 1024 * 1024
/**
 * 大文件窗口化阈值（H-4）：超过这么多行就不把全文铺给界面。
 * 与界面一次渲染上限（`MAX_RENDER_LINES`）保持一致，
 * 否则会出现「界面只画前 2000 行、目标在第 4000 行」这种无法定位的组合。
 */
const WINDOW_TRIGGER_LINES = 2000
/** 窗口在目标行前 / 后各留多少行（上下文够用，又不会把窗口变成全文） */
const WINDOW_BEFORE = 200
const WINDOW_AFTER = 400
/** 图片上限（方案 5.1 建议 20MB） */
const MAX_IMAGE = 20 * 1024 * 1024
/** 其它文件的上限（防呆：不要把整个磁盘镜像拖进来） */
const MAX_FILE = 100 * 1024 * 1024

/** 已知的文本扩展名 → MIME。没列到的当二进制，只引用不读内容 */
const TEXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.json5': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'text/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/css',
  '.less': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.vue': 'text/plain',
  '.svelte': 'text/plain',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.cc': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
  '.bat': 'text/plain',
  '.cmd': 'text/plain',
  '.sql': 'text/x-sql',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.gitignore': 'text/plain',
  '.editorconfig': 'text/plain'
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/** 已登记的引用文件：realpath → 元信息 */
const granted = new Map<string, { size: number; mime: string; kind: FileRefKind; name: string; at: number }>()

function classify(name: string): { mime: string; kind: FileRefKind } {
  const ext = extname(name).toLowerCase()
  if (IMAGE_MIME[ext]) return { mime: IMAGE_MIME[ext], kind: 'image' }
  if (ext === '.pdf') return { mime: 'application/pdf', kind: 'pdf' }
  if (TEXT_MIME[ext]) return { mime: TEXT_MIME[ext], kind: 'text' }
  /* 没有扩展名的小文件（Makefile / Dockerfile / LICENSE…）也当文本 */
  if (!ext) return { mime: 'text/plain', kind: 'text' }
  return { mime: 'application/octet-stream', kind: 'binary' }
}

function fail(input: string, error: string): FileRefInfo {
  return { ok: false, input, path: '', name: basename(input) || input, size: 0, mimeType: '', kind: 'other', error }
}

/**
 * 校验一个用户拖入的路径并登记授权。
 * 返回的 `path` 是 **realpath**，后续读取一律用这个值。
 */
export async function grantFile(input: string): Promise<FileRefInfo> {
  if (typeof input !== 'string' || !input.trim()) return fail(String(input ?? ''), '路径为空')
  if (!isAbsolute(input)) return fail(input, '只接受绝对路径')
  if (input.includes('\0')) return fail(input, '路径非法')

  let real: string
  try {
    real = await realpath(input)
  } catch {
    return fail(input, '文件不存在')
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return fail(input, '无法读取文件信息')
  }
  if (st.isDirectory()) return fail(input, '这是文件夹，暂不支持递归引用')
  if (!st.isFile()) return fail(input, '不是普通文件')

  const name = basename(real)
  const { mime, kind } = classify(name)
  const limit = kind === 'image' ? MAX_IMAGE : MAX_FILE
  if (st.size > limit) {
    return fail(input, `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，上限 ${limit / 1024 / 1024}MB）`)
  }

  granted.set(real, { size: st.size, mime, kind, name, at: Date.now() })
  return { ok: true, input, path: real, name, size: st.size, mimeType: mime, kind }
}

/** 批量登记（IPC 用）。上限与渲染端一致：一次最多 20 个 */
export async function grantFiles(inputs: unknown): Promise<FileRefInfo[]> {
  const list = Array.isArray(inputs) ? inputs.slice(0, 20) : []
  const out: FileRefInfo[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    out.push(await grantFile(raw))
  }
  return out
}

/** 这个路径是不是用户显式引用过的 */
export function isGranted(real: string): boolean {
  return granted.has(real)
}

/**
 * 读已登记文件的文本（文件预览 / 附件按需读取）。
 *
 * 只认 `granted` 里的 realpath —— 普通文本里写一个绝对路径**不会**因此可读。
 */
export async function readGrantedText(input: string): Promise<FileTextResult> {
  if (typeof input !== 'string' || !isAbsolute(input)) return { ok: false, error: '路径非法' }
  let real: string
  try {
    real = await realpath(input)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  const meta = granted.get(real)
  if (!meta) return { ok: false, error: '这个文件没有加入上下文，不能在预览里读取' }
  if (meta.kind === 'pdf') {
    return { ok: false, error: 'PDF 暂不支持文本预览，可以先用外部程序打开', size: meta.size }
  }
  if (meta.kind !== 'text') {
    return { ok: false, error: '二进制文件不支持文本预览', size: meta.size }
  }

  let buf: Buffer
  try {
    /*
     * 只读前 MAX_TEXT 字节（不是「读整份再截断」）——
     * 否则一个几百 MB 的日志会把主进程内存吃满。
     */
    const size = Math.min(meta.size, MAX_TEXT)
    const fh = await open(real, 'r')
    try {
      buf = Buffer.alloc(size)
      await fh.read(buf, 0, size, 0)
    } finally {
      await fh.close()
    }
  } catch {
    return { ok: false, error: '读取失败（可能没有权限）' }
  }
  const truncated = meta.size > MAX_TEXT
  return { ok: true, text: buf.toString('utf8'), truncated, size: meta.size }
}

/**
 * 解析一个预览目标：越界 / 不存在 / 不是普通文件都在这里拦下。
 *
 * 抽出来是为了让「读内容」与「只查变化」（`statPreview`）共用同一条校验链 ——
 * 两条路径各写一份，迟早会出现一边能读到工作区外的文件。
 */
async function resolvePreviewTarget(
  rawPath: string,
  cwd: string
): Promise<
  | { ok: true; real: string; st: Stats }
  | { ok: false; error: string; dir?: string }
> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, error: '路径为空' }
  if (rawPath.includes('\0')) return { ok: false, error: '路径非法' }

  const absolute = isAbsolute(rawPath)
  const target = absolute ? rawPath : join(cwd || process.cwd(), rawPath.split('/').join(sep))

  /* 相对路径先做一次字符串级检查（早退，少一次系统调用） */
  if (!absolute && rawPath.replace(/\\/g, '/').split('/').includes('..')) {
    /* 越界不告诉界面父目录：那等于把工作区外的路径当导航目标泄露出去 */
    return { ok: false, error: '路径越界' }
  }

  let real: string
  try {
    real = await realpath(target)
  } catch {
    /*
     * 文件不在了也要能“去它的目录看看”（H-4 出口 7）：
     * 这里给的是**请求路径解析后**的父目录，不是工作区外的任意位置。
     */
    return { ok: false, error: '文件不存在', dir: dirname(target) }
  }

  if (!absolute) {
    const root = await realpath(cwd || process.cwd()).catch(() => resolve(cwd || process.cwd()))
    if (real !== root && !real.startsWith(root + sep)) return { ok: false, error: '路径越界' }
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, error: '无法读取文件信息', dir: dirname(real) }
  }
  if (st.isDirectory()) return { ok: false, error: '这是文件夹', dir: dirname(real) }
  if (!st.isFile()) return { ok: false, error: '不是普通文件', dir: dirname(real) }
  return { ok: true, real, st }
}

/**
 * 只读查一下文件变没变（H-4 的「内容已更新」提示）。
 *
 * 只 `stat`，**不读内容**：轮询时不能为了看一眼 mtime 就把 2MB 再读一遍。
 * 与 `readPreview` 同一条校验链，所以工作区外的相对路径一样会被拦。
 */
export async function statPreview(
  rawPath: string,
  cwd: string
): Promise<{ ok: boolean; abs: string; mtimeMs: number; size: number; error?: string }> {
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) return { ok: false, abs: '', mtimeMs: 0, size: 0, error: resolved.error }
  return { ok: true, abs: resolved.real, mtimeMs: resolved.st.mtimeMs, size: resolved.st.size }
}

/**
 * 只读预览一个链接指向的文件（方案 5.2）。
 *
 * 与附件授权的区别（很重要，别合并）：
 *   · 附件 = 把路径交给**模型**读 → 必须来自显式动作（拖入），只认授权表；
 *   · 预览 = 用户**自己**在本地点开看 → 允许消息里的绝对路径，
 *     但仍然要 realpath 校验、只读、有大小上限、二进制不给内容。
 *
 * 相对路径按**会话 cwd** 解析，并且解析后必须落在 cwd 内 ——
 * 否则 `[点我](../../../../etc/passwd)` 这种写法就成了任意文件读取。
 */
export async function readPreview(
  rawPath: string,
  cwd: string,
  line?: number,
  lineEnd?: number
): Promise<FilePreview> {
  const bad = (error: string, dir?: string): FilePreview => ({
    ok: false,
    path: rawPath,
    abs: '',
    name: basename(rawPath) || rawPath,
    size: 0,
    kind: 'other',
    error,
    ...(dir ? { dir } : {})
  })

  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) return bad(resolved.error, resolved.dir)
  const { real, st } = resolved

  const name = basename(real)
  const { kind } = classify(name)
  const base: FilePreview = {
    ok: true,
    path: rawPath,
    abs: real,
    name,
    size: st.size,
    /* 变化提示（H-4）拿它比对：内容被外部改写时 mtime 会变 */
    mtimeMs: st.mtimeMs,
    kind,
    ...(line && Number.isFinite(line) ? { line } : {}),
    /* 范围高亮（H-4）：只在真的比 line 长时才带出去 */
    ...(line && lineEnd && Number.isFinite(lineEnd) && lineEnd > line ? { lineEnd } : {})
  }

  /* 只有文本给内容；图片/二进制/PDF 由界面显示元信息 + 打开位置 */
  if (kind !== 'text') return base

  try {
    const size = Math.min(st.size, MAX_TEXT)
    const fh = await open(real, 'r')
    try {
      const buf = Buffer.alloc(size)
      await fh.read(buf, 0, size, 0)
      const text = buf.toString('utf8')
      const truncated = st.size > MAX_TEXT
      const allLines = text.split('\n')
      /*
       * 大文件定位（H-4）：超过阈值就不把几万行全铺给界面 ——
       * 只围绕目标行给一段**真实切出来**的窗口，并说清“这是第几到第几行、共多少行”。
       * 不估算滚动位置：窗口的每行都是读出来的，行号也是真的。
       */
      const anchor = line && Number.isFinite(line) ? line : undefined
      if (anchor && anchor > WINDOW_TRIGGER_LINES) {
        const start = Math.max(1, anchor - WINDOW_BEFORE)
        const end = Math.min(
          allLines.length,
          Math.max(anchor, lineEnd ?? anchor) + WINDOW_AFTER
        )
        return {
          ...base,
          text: allLines.slice(start - 1, end).join('\n'),
          truncated,
          totalLines: allLines.length,
          ...(start > 1 ? { windowStart: start } : {}),
          windowEnd: end
        }
      }
      return { ...base, text, truncated, totalLines: allLines.length }
    } finally {
      await fh.close()
    }
  } catch {
    return { ...base, error: '读取失败（可能没有权限）' }
  }
}
