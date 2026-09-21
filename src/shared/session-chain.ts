/**
 * 会话「链」的契约与纯逻辑（实施-05 S5b）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 用户 2026-09-19 拍板：**后台确实切成两份（两个 JSONL），但砚的前端只显示一条会话。**
 * 侧栏一条、消息历史按段拼成一条连续时间线（**不插可见分界**）、发送永远发到当前活动段。
 *
 * 所以需要一份「哪几段属于同一条会话」的关系 —— 这就是链（chain）。
 * 它**不改写任何 JSONL**：pi 的一个会话文件就是一个上下文窗口的账本，交接正是因为
 * 「这段上下文该换了」；把两段并回一个文件既做不到（正在用的文件不能外部改，见 01 §5）、
 * 也会把两边的账弄坏。关系旁挂在 `YAN_DIR/session-chains.json`，拼接发生在**读侧**。
 *
 * ── 为什么纯逻辑放 shared ──
 *   侧栏（渲染端）要判断「这条会话是不是某条链的代表」，历史（主进程）要按段顺序取文件，
 *   两边必须用同一套规则 —— 否则会出现「侧栏一条、历史却按两条渲染」这类不一致。
 *
 * ── 代表段 ──
 *   「代表」= 链上**最后一段**（也就是当前活动段）：侧栏显示它、删除/标题/未读按它所在的链算。
 *   为什么不用首段：用户对标题/未读的直觉总是「现在的这条」；首段只是个历史起点。
 *
 * ── 名字里的 normalize ──
 *   `normalizeChainKey` 与 `main/work-mode-service.ts` 的 `normalizeSessionFileKey` 同语义
 *   （只归一化分隔符与尾斜杠，不做大小写折叠 —— Linux 上大小写是两回事）。
 *   两份实现由单测**交叉校验**：同一组输入必须得到同一个键。
 */

/** 链记录的文件名（放在 `YAN_DIR` 下）。 */
export const SESSION_CHAIN_FILE_NAME = 'session-chains.json'

/** 一个段 = 一个 pi 会话文件。 */
export interface SessionSegment {
  sessionFile: string
  startedAt: number
  /** 从前一段接续过来时的交接 id；首段为 `null`。 */
  handoffId: string | null
}

export interface SessionChain {
  /** 稳定 id：首段的规范化路径。 */
  chainId: string
  /** 按时间顺序的段；链上至少一段。 */
  segments: SessionSegment[]
  updatedAt: number
}

/**
 * 会话文件路径 → 稳定键（同 `main/work-mode-service.ts` 的语义）。
 *
 * 只归一化分隔符与尾斜杠；空串、控制字符、超长一律判为不可用（返回 `null`）。
 */
export function normalizeChainKey(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const trimmed = file.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!trimmed || trimmed.length > 400) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

export function createChain(segment: SessionSegment): SessionChain | null {
  const key = normalizeChainKey(segment?.sessionFile)
  if (!key) return null
  return {
    chainId: key,
    segments: [{ ...segment, sessionFile: key }],
    updatedAt: Number.isFinite(segment.startedAt) ? segment.startedAt : 0
  }
}

/**
 * 追加一段（交接提交时调用）。**幂等**：
 *   ① 同一段已经在链上 → 原样返回（重放 / 重启恢复只会有一次效果）；
 *   ② 新段就是链上的最后一段 → 也不动（同一次交接的两条腿都到达）。
 *
 * 不允许「插到中间」：交接是**向后延伸**的过程，历史不重排。
 */
export function appendSegment(chain: SessionChain, segment: SessionSegment): SessionChain {
  const key = normalizeChainKey(segment?.sessionFile)
  if (!key) return chain
  if (chain.segments.some((item) => normalizeChainKey(item.sessionFile) === key)) return chain
  const next: SessionSegment = { ...segment, sessionFile: key }
  return {
    ...chain,
    segments: [...chain.segments, next],
    updatedAt: Number.isFinite(segment.startedAt) ? segment.startedAt : chain.updatedAt
  }
}

/** 链上的代表段（最后一段）；空链返回 `null`。 */
export function chainRepresentative(chain: SessionChain | null | undefined): SessionSegment | null {
  const segments = chain?.segments ?? []
  return segments.length ? segments[segments.length - 1] : null
}

/** 按文件找它所属的链（不区分它是不是代表）。 */
export function chainForFile(chains: SessionChain[], sessionFile: string): SessionChain | null {
  const key = normalizeChainKey(sessionFile)
  if (!key) return null
  for (const chain of chains ?? []) {
    if (chain.segments.some((item) => normalizeChainKey(item.sessionFile) === key)) return chain
  }
  return null
}

/**
 * 这条会话文件在侧栏里**该不该显示**。
 *
 * 规则：只有**代表段**显示；链上的旧段一律不显示（用户看到的是同一条会话）。
 * 不在任何链上的孤立会话按「自己就是一条链」处理 → 显示。
 */
export function isRepresentative(chains: SessionChain[], sessionFile: string): boolean {
  const key = normalizeChainKey(sessionFile)
  if (!key) return false
  const chain = chainForFile(chains, key)
  if (!chain) return true
  return normalizeChainKey(chainRepresentative(chain)?.sessionFile) === key
}

/**
 * 读历史的取文件顺序（链上从旧到新）。
 *
 * 调用方按这个顺序读 JSONL 并依次拼接 —— **不做去重/裁剪**：
 * 链上的段本来就是互不重叠的两段账，重复只可能来自链记录被写坏，
 * 那种情况宁可把问题暴露出来（reads 侧能看到异常条目数），也不要静默丢段。
 */
export function planHistoryRead(chain: SessionChain | null | undefined): string[] {
  return (chain?.segments ?? [])
    .map((item) => normalizeChainKey(item.sessionFile))
    .filter((key): key is string => !!key)
}

/** 脏链记录一律丢掉（宁可少一条关系，也不要半条链把历史拼错）。 */
export function sanitizeSessionChain(raw: unknown): SessionChain | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<SessionChain>
  const segments: SessionSegment[] = []
  for (const seg of Array.isArray(item.segments) ? item.segments : []) {
    const key = normalizeChainKey((seg as Partial<SessionSegment>)?.sessionFile)
    if (!key) continue
    if (segments.some((existing) => existing.sessionFile === key)) continue
    const startedAt = Number.isFinite((seg as Partial<SessionSegment>)?.startedAt)
      ? Number((seg as Partial<SessionSegment>).startedAt)
      : 0
    const handoffId = typeof (seg as Partial<SessionSegment>)?.handoffId === 'string' ? (seg as SessionSegment).handoffId : null
    segments.push({ sessionFile: key, startedAt, handoffId })
  }
  if (!segments.length) return null
  const chainId = normalizeChainKey(item.chainId) ?? segments[0].sessionFile
  /* chainId 必须指向链上真实存在的段，否则从首段推 */
  const safeId = segments.some((seg) => seg.sessionFile === chainId) ? chainId : segments[0].sessionFile
  return {
    chainId: safeId,
    segments,
    updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : 0
  }
}

/** 脏文档整体降级（与其它 store 同一个立场：坏文件不能把应用弄起来不了）。 */
export function sanitizeSessionChains(raw: unknown): SessionChain[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { chains?: unknown } | null)?.chains)
      ? (raw as { chains: unknown[] }).chains
      : []
  const out: SessionChain[] = []
  for (const item of list) {
    const chain = sanitizeSessionChain(item)
    if (!chain) continue
    /* 同一段只能属于一条链：后来的跳过（不合并 —— 合并是猜测） */
    if (out.some((existing) => existing.segments.some((seg) => chain.segments.some((mine) => mine.sessionFile === seg.sessionFile)))) {
      continue
    }
    out.push(chain)
  }
  return out
}

/** 一行摘要（诊断 / 界面 tooltip）。 */
export function chainSummary(chain: SessionChain | null | undefined): string {
  const segments = chain?.segments ?? []
  if (segments.length <= 1) return '单段'
  return `${segments.length} 段（同一会话）`
}
