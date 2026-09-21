/**
 * 会话「来源」的持久化资源引用（方案 §8 的 S1）。
 *
 * ── 为什么必须新写这一层（核查结论，见 PROJECT §2.18）──
 * 现有附件链**不持久化**：`Attachment` 是渲染端 store 的临时状态 —— 图片是内存里的
 * base64（关掉应用就没了），文件引用只存 path（没有内容也没有指纹）。方案对此有
 * 明确要求：「不能只保存会被清理的临时路径」。
 *
 * ── 这一层做什么 ──
 *   · 图片：**把字节写到数据目录**（`<数据目录>/sources/<会话>/<sha256 前 32>.<ext>`），
 *     返回引用 + 内容指纹。指纹就是文件名本身 —— 内容一变文件名就变，缓存与
 *     「这份东西还是原来那份吗」都不需要额外记账。
 *   · 文件引用：**不复制**（用户的大文件不该被我们抄一份）。登记绝对路径 +
 *     `size:mtime` 指纹，用于判断「还在不在、有没有被改过」。
 *   · 移除引用**只删我们自己存的那份副本**，绝不碰用户原文件。
 *
 * ── 状态三态（方案 §8）──
 * 「已关联」= 登记在案；「已读取」需要 pi 真的读过它；「本轮已参与上下文」由
 * 渲染端按本轮发送的附件判断。**证据不足时前两态之外的一律不显示** —— 所以这里
 * 只负责「已关联」与「资源还在不在」，不去猜别的。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { YAN_DIR } from './paths'

export type SourceKind = 'image' | 'file' | 'web'

export interface SourceRef {
  /** 稳定 id：图片用内容指纹，文件用路径指纹，网页由渲染端给 */
  sourceId: string
  sessionId: string
  kind: SourceKind
  /** 展示名（图片是文件名、文件是文件名、网页是标题） */
  title: string
  /**
   * 持久化资源引用：
   *   · 图片 → 我们存的那份副本的绝对路径
   *   · 文件 → 用户原文件的绝对路径（**不复制**）
   *   · 网页 → URL
   */
  ref: string
  /** 内容指纹（图片 = sha256 前 32；文件 = size:mtime；网页 = url） */
  fingerprint: string
  /** 原始定位信息：文件是路径，网页是 URL，图片是来源文件名 */
  origin: string
  addedAt: number
  /** 资源当前还在不在（文件被删/被改名时要如实显示，不是静默消失） */
  available: boolean
  /** 不可用时的原因（方案要求「获取失败可以重试并保留原因」） */
  error?: string
}

/**
 * 数据根目录。默认是砚自己的数据目录（`YAN_DATA_DIR`）；
 * **可注入**是为了测试能隔离 —— 单测绝不能写进用户真实的数据目录。
 */
let baseDir: string | null = null

export function configureSources(next: { dir: string }): void {
  baseDir = next.dir
}

/** 一个会话的来源目录 */
export function sourcesDir(sessionId: string): string {
  /*
   * ⚠️ 会话 id 来自 pi，而它会被当成**目录名**拼进路径 —— 所以只取安全字符。
   * 这一条挡的是路径穿越（`../../x`），不是洁癖。
   */
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'default'
  return join(baseDir ?? YAN_DIR, 'sources', safe)
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

/** 图片扩展名：优先看 mime，其次看原文件名 */
function imageExt(mimeType: string, name: string): string {
  const byMime = IMAGE_EXT[String(mimeType ?? '').toLowerCase()]
  if (byMime) return byMime
  const byName = extname(String(name ?? '')).toLowerCase()
  return byName && byName.length <= 5 ? byName : '.bin'
}

/**
 * 存一张图片（base64，不带 `data:` 前缀）。
 *
 * 幂等：同一份字节内容 → 同一个文件名 → 同一个 sourceId。重复粘贴同一张图不会
 * 在磁盘上堆第二份。
 */
export function saveImage(params: {
  sessionId: string
  name: string
  mimeType: string
  base64: string
}): SourceRef | null {
  const data = Buffer.from(String(params.base64 ?? ''), 'base64')
  if (data.length === 0) return null
  const fingerprint = createHash('sha256').update(data).digest('hex').slice(0, 32)
  const dir = sourcesDir(params.sessionId)
  const file = join(dir, fingerprint + imageExt(params.mimeType, params.name))
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (!existsSync(file)) writeFileSync(file, data)
    return {
      sourceId: `image:${fingerprint}`,
      sessionId: params.sessionId,
      kind: 'image',
      title: String(params.name ?? '') || '图片',
      ref: file,
      fingerprint,
      origin: String(params.name ?? ''),
      addedAt: Date.now(),
      available: true
    }
  } catch {
    return null
  }
}

/** 登记一个**文件引用**（不复制内容）。路径必须真实存在，否则不登记。 */
export function registerFile(params: { sessionId: string; path: string; name?: string }): SourceRef | null {
  const path = resolve(String(params.path ?? ''))
  if (!path) return null
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    const fingerprint = `${st.size}:${Math.round(st.mtimeMs)}`
    return {
      sourceId: `file:${createHash('sha256').update(`${path}|${fingerprint}`).digest('hex').slice(0, 24)}`,
      sessionId: params.sessionId,
      kind: 'file',
      title: String(params.name ?? '') || path.split(/[\\/]/).pop() || path,
      /* 文件引用指向**用户的原文件** —— 我们不复制大文件，也绝不删它 */
      ref: path,
      fingerprint,
      origin: path,
      addedAt: Date.now(),
      available: true
    }
  } catch {
    return null
  }
}

/** 图片的来源清单从目录推出来（文件名就是指纹，不需要另外记账） */
function listImages(sessionId: string): SourceRef[] {
  const dir = sourcesDir(sessionId)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif|bmp|bin)$/i.test(f))
      .map((f) => {
        const fingerprint = f.replace(/\.[^.]+$/, '')
        const file = join(dir, f)
        let size = 0
        try {
          size = statSync(file).size
        } catch {
          /* 读不到大小不影响列表 */
        }
        return {
          sourceId: `image:${fingerprint}`,
          sessionId,
          kind: 'image' as const,
          title: `${fingerprint.slice(0, 8)}${extname(f)}`,
          ref: file,
          fingerprint,
          origin: '',
          /* mtime 当"添加时间"：文件就是这份来源在磁盘上的样子 */
          addedAt: statSync(file).mtimeMs,
          available: true,
          size
        }
      })
      .sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  }
}

/**
 * 文件引用**没法从目录推**（我们不存副本），所以由渲染端随会话一起记在
 * localStorage 里，这里只负责**复核**：还在不在、有没有被改过。
 */
export function verifyFiles(sessionId: string, entries: { path: string; name?: string; addedAt?: number }[]): SourceRef[] {
  return entries
    .map((e) => {
      const ref = registerFile({ sessionId, path: e.path, name: e.name })
      if (!ref) {
        return {
          sourceId: `file:${createHash('sha256').update(String(e.path)).digest('hex').slice(0, 24)}`,
          sessionId,
          kind: 'file' as const,
          title: String(e.name ?? '') || String(e.path).split(/[\\/]/).pop() || String(e.path),
          ref: String(e.path),
          fingerprint: '',
          origin: String(e.path),
          addedAt: e.addedAt ?? Date.now(),
          available: false,
          error: '文件不在了（被删除或改名）'
        }
      }
      return { ...ref, addedAt: e.addedAt ?? ref.addedAt }
    })
    .filter(Boolean) as SourceRef[]
}

export interface SourceListing {
  ok: boolean
  images: SourceRef[]
  /** 目录总数（方案要求「目录仅授予可浏览范围」，所以这里只报数，不列内容） */
  imageCount: number
  dir: string
  /** 「来源 ↔ 消息」的关联（同一份数据也由 listLinks 单独读） */
  links: SourceLink[]
  error?: string
}

export function listImagesForSession(sessionId: string): SourceListing {
  try {
    const images = listImages(sessionId)
    return { ok: true, images, imageCount: images.length, dir: sourcesDir(sessionId), links: listLinks(sessionId) }
  } catch (error) {
    return {
      ok: false,
      images: [],
      imageCount: 0,
      dir: sourcesDir(sessionId),
      links: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 来源与消息的关联（方案 §8 的 S1「定位消息」）。
 *
 * ── 为什么得单独存 ──
 * 「这条来源参与了哪条消息」在现有数据里**不存在**：图片只知道字节哈希、
 * 文件只知道路径指纹、网页只有 URL，而消息 id 属于会话 JSONL。两边没有交集，
 * 所以这里记一张小表（每会话一个 `links.json`，与图片副本同目录、同生命周期）。
 *
 * ── 为什么不写进会话 JSONL ──
 * 会话文件是 pi 的资产（我们要能从磁盘重放历史），往里面塞宿主自己的字段会把
 * 「pi 写的文件」和「砚补的字段」混在一起 —— 与任务日志不进 JSONL 是同一条理由。
 */
export interface SourceLink {
  sourceId: string
  messageId: string
  /** 建立关联的时间（界面上按它排序、也用于淘汰最旧记录） */
  at: number
}

const LINKS_FILE = 'links.json'
/** 每个会话最多记这么多条关联（超出丢最旧）—— 防的是无上限增长，不是正常使用 */
const MAX_LINKS = 500

function linksFile(sessionId: string): string {
  return join(sourcesDir(sessionId), LINKS_FILE)
}

/** 读关联表。文件坏了/不存在都当空表 —— 「跳不过去」比「菜单打不开」轻得多 */
function readLinks(sessionId: string): SourceLink[] {
  try {
    const raw = readFileSync(linksFile(sessionId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is SourceLink =>
        !!x &&
        typeof (x as SourceLink).sourceId === 'string' &&
        typeof (x as SourceLink).messageId === 'string'
    )
  } catch {
    return []
  }
}

/** 形状校验：sourceId 必须带类前缀，messageId 只收安全字符（它们会被拼进查询选择器） */
function safeSourceId(value: string): string | null {
  const raw = String(value ?? '')
  return /^(image|file|web):[A-Za-z0-9._-]{1,96}$/.test(raw) ? raw : null
}

function safeMessageId(value: string): string | null {
  const raw = String(value ?? '')
  /* pi 的消息 id 形如 uuid / entryId；这里只放行可安全放进 `[data-msg-id="…"]` 的字符 */
  return /^[A-Za-z0-9._:-]{1,160}$/.test(raw) ? raw : null
}

/** 列出这个会话的全部关联 */
export function listLinks(sessionId: string): SourceLink[] {
  return readLinks(sessionId)
}

/**
 * 建立「这几份来源参与了这条消息」的关联。
 *
 * 幂等：同一对 `(sourceId, messageId)` 重复登记不会堆第二条。
 * 形状不对的 sourceId 直接丢掉（**不**报错）—— 一条对不上不该让整批失败，
 * 但也不会被静默当成成功：`added` 与 `skipped` 如实报数。
 */
export function linkSources(params: {
  sessionId: string
  sourceIds: string[]
  messageId: string
}): { ok: boolean; added: number; skipped: number; error?: string } {
  const messageId = safeMessageId(params.messageId)
  if (!messageId) return { ok: false, added: 0, skipped: 0, error: '消息 id 形状不对' }
  const ids = [...new Set((params.sourceIds ?? []).map((x) => safeSourceId(String(x))))].filter(
    (x): x is string => !!x
  )
  const skipped = (params.sourceIds ?? []).length - ids.length
  if (ids.length === 0) return { ok: true, added: 0, skipped }

  const existing = readLinks(params.sessionId)
  const key = (x: { sourceId: string; messageId: string }): string => `${x.sourceId}\u0000${x.messageId}`
  const seen = new Set(existing.map(key))
  const now = Date.now()
  const fresh: SourceLink[] = []
  for (const sourceId of ids) {
    const item = { sourceId, messageId, at: now }
    if (seen.has(key(item))) continue
    seen.add(key(item))
    fresh.push(item)
  }
  if (fresh.length === 0) return { ok: true, added: 0, skipped }

  const next = [...existing, ...fresh].slice(-MAX_LINKS)
  try {
    const dir = sourcesDir(params.sessionId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(linksFile(params.sessionId), JSON.stringify(next, null, 2))
  } catch (error) {
    return { ok: false, added: 0, skipped, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, added: fresh.length, skipped }
}

/**
 * 移除一份**我们存的副本**。
 *
 * ⚠️ 只允许删 `<YAN_DIR>/sources/` 下的文件。文件引用（`kind === 'file'`）**永远
 * 不删** —— 那是用户的原文件，方案 §8 写得很清楚：「移除引用不删除用户原文件」。
 * 这个检查放在这里而不是调用方，因为这是**唯一**能保证它不被绕过的位置。
 */
export function removeImage(sessionId: string, sourceId: string): { ok: boolean; error?: string } {
  const dir = resolve(sourcesDir(sessionId))
  const fingerprint = String(sourceId ?? '').replace(/^image:/, '')
  if (!/^[a-f0-9]{8,64}$/i.test(fingerprint)) return { ok: false, error: '来源 id 形状不对' }
  let removed = false
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(fingerprint)) continue
      const full = resolve(join(dir, f))
      /* 双保险：拼出来的路径必须还在 sources 目录里 */
      if (!full.startsWith(dir)) continue
      rmSync(full, { force: true })
      removed = true
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return removed ? { ok: true } : { ok: false, error: '没有这份副本' }
}

/** 读回图片字节（缩略图用）。返回 base64（不带 `data:` 前缀）。 */
export function readImage(sessionId: string, sourceId: string): { ok: boolean; base64?: string; mime?: string; error?: string } {
  const dir = resolve(sourcesDir(sessionId))
  const fingerprint = String(sourceId ?? '').replace(/^image:/, '')
  if (!/^[a-f0-9]{8,64}$/i.test(fingerprint)) return { ok: false, error: '来源 id 形状不对' }
  try {
    const hit = readdirSync(dir).find((f) => f.startsWith(fingerprint))
    if (!hit) return { ok: false, error: '没有这份副本' }
    const full = resolve(join(dir, hit))
    if (!full.startsWith(dir)) return { ok: false, error: '路径越界' }
    const ext = extname(hit).toLowerCase()
    const mime =
      ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : 'application/octet-stream'
    return { ok: true, base64: readFileSync(full).toString('base64'), mime }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 会话结束时清掉它的图片副本（会话都删了，留着只是占地方） */
export function dropSession(sessionId: string): void {
  try {
    rmSync(sourcesDir(sessionId), { recursive: true, force: true })
  } catch {
    /* 清不掉不影响主流程 */
  }
}
