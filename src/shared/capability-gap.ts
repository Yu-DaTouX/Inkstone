/**
 * 按需获取能力（capability gap）的**契约层 + 纯逻辑**（实施-25 P17）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解决什么
 * ══════════════════════════════════════════════════════════════════
 * 「缺什么能力时，agent 直接说清『缺什么、怎么接』，不用背工具包名」（P17 的用户得到）。
 *
 * ── 两条边界 ──
 *  ① **只给路径，不替用户装**。这里输出的是一段**可执行的接入步骤**
 *     （先 `capabilities search`、再 `prepare` → `acquire`、都没有就装 skill / MCP），
 *     安装本身仍然走已授权的那条链（P17 的 W1「复用现有发现/激活流程」）。
 *  ② **认不出就不编**（`matchGap` 返回 `null`）。宁可给一段通用的三步路径，
 *     也不要凭一个词就断定「你要装 X 包」—— 那会把用户引到错的能力上。
 *
 * 另外一条：`gapStillMissing(gap, available)` 允许调用方把「当前可用能力」
 * 传进来 —— 已经有了的能力不该被当成缺口（那正是「无需背工具包名」的另一面：
 * 模型不必先记住自己有什么才能回答）。
 *
 * 它不碰 electron / pi / 文件系统，主进程与单测共用同一份规则。
 */

/** 这类能力通常怎么来。 */
export const GAP_ROUTES = ['builtin', 'skill', 'mcp', 'browser', 'model'] as const
export type GapRoute = (typeof GAP_ROUTES)[number]

export const GAP_ROUTE_LABELS: Record<GapRoute, string> = {
  builtin: '砚内置或随包命令',
  skill: '技能包（skill）',
  mcp: '外部工具服务（MCP）',
  browser: '内置浏览器',
  model: '模型本身就能做'
}

/** 一步接入动作。`command` 为空表示这是一句说明而不是可跑的命令。 */
export interface GapPathStep {
  step: string
  command?: string
}

export interface CapabilityGap {
  id: string
  /** 用户会怎么描述这件事（给模型与用户看）。 */
  need: string
  /** 匹配用语（用户的话里出现这些词就算命中）。 */
  keywords: readonly string[]
  /** 缺的能力是什么（一句话）。 */
  missing: string
  /** 这类能力通常怎么来。 */
  via: GapRoute
  /** 接入路径（按可执行顺序）。 */
  paths: readonly GapPathStep[]
}

/** 共用的三步（每个场景的路径都从这里开始）。 */
const SEARCH_STEP: GapPathStep = {
  step: '先看有没有现成的候选（已装 / 已加载范围内的都列得出来）',
  command: 'yan capabilities search --query-text "<你要做的事>"'
}
const ACQUIRE_STEPS: readonly GapPathStep[] = [
  { step: '有候选就先准备再接入（prepare 只做校验，acquire 才真正装）', command: 'yan capabilities prepare --candidate <候选ID>' },
  { step: '准备通过后再接入', command: 'yan capabilities acquire --candidate <候选ID>' }
]
const DISCOVER_STEP: GapPathStep = {
  step: '本地没有候选时联网找一次（会给出可选的技能包 / MCP 服务）',
  command: 'yan capabilities discover --query-text "<你要做的事>"'
}

/**
 * 首批场景。
 *
 * 这些是「用户用自然语言提出来、但当前能力目录里可能没有」的常见几类。
 * 清单不是穷举 —— 认不出的走通用路径，而不是硬塞进某一类。
 */
export const CAPABILITY_GAPS: readonly CapabilityGap[] = [
  {
    id: 'pdf-tables',
    need: '从 PDF / 文档里取出表格和结构化内容',
    keywords: ['pdf', '表格', 'excel', 'word', '文档解析', 'ocr', '扫描'],
    missing: '结构化解析能力（现在只能按纯文本读，表格会散成一行行文字）',
    via: 'skill',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      DISCOVER_STEP,
      { step: '都没有的话：装一个提供该能力的技能包，再用 capabilities search 找一次' },
      { step: '退路（不需要装东西）：把文档转成文本或用内置浏览器打开页面后按正文读', command: 'yan browser open --url <地址>' }
    ]
  },
  {
    id: 'spreadsheet',
    need: '统计一张表格里的数据（求和 / 分组 / 画图）',
    keywords: ['csv', '统计', '求和', '分组', '画图', '图表', '数据'],
    missing: '数据统计与画图能力（现在只能在文本里算，画不了图）',
    via: 'skill',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      { step: '不想装东西时：表格先用文本方式读进来，统计用随包命令算，图交给生图能力', command: 'yan image generate --request-file image.json' }
    ]
  },
  {
    id: 'web-page',
    need: '打开一个网页并把正文读出来',
    keywords: ['网页', '网站', 'url', '抓取', '爬', '浏览器'],
    missing: '网页打开与正文提取（这个能力砚自带，不需要额外安装）',
    via: 'browser',
    paths: [
      { step: '直接用内置浏览器打开（导航与正文提取都在这一族命令里）', command: 'yan browser open --url <地址>' },
      { step: '只看当前页面状态时', command: 'yan browser state' }
    ]
  },
  {
    id: 'audio',
    need: '把录音转成文字 / 把文字读出来',
    keywords: ['录音', '语音', '转写', '朗读', '音频', '听写', 'tts'],
    missing: '音频转写与朗读能力（模型只能处理文本）',
    via: 'mcp',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      { step: '接一个提供转写 / 朗读的 MCP 服务，接进来后用 mcp describe 看它有哪些工具', command: 'yan mcp describe --id <服务ID>' },
      { step: '退路：先把音频转成文本（本机工具或在线服务），再把文本交给砚处理' }
    ]
  },
  {
    id: 'screenshot',
    need: '看一张图片里写了什么',
    keywords: ['图片', '截图', '看图', '识别', '照片'],
    missing: '图片理解（取决于当前模型是否支持看图；不支持时这一条会一直缺）',
    via: 'model',
    paths: [
      { step: '先把图片加进资料库（资料库支持图片），再在当前会话里引用它', command: 'yan context recall --ref <ctx://…>' },
      { step: '如果模型不支持看图：换一个支持视觉的模型，或先用 OCR 转成文本' }
    ]
  },
  {
    id: 'database',
    need: '连数据库查数',
    keywords: ['数据库', 'sql', 'mysql', 'postgres', 'sqlite', '查询'],
    missing: '数据库连接能力（砚不含内置数据库客户端）',
    via: 'mcp',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      { step: '接一个数据库 MCP 服务（连接串与凭证由你在服务配置里给，砚不代管）' },
      { step: '退路：用本机命令行导出成 csv，再按表格的方式读进来' }
    ]
  },
  {
    id: 'code-search',
    need: '在整个代码库里按语义找代码',
    keywords: ['代码库', '语义搜索', '索引', '重构', '找代码'],
    missing: '索引式代码检索（现在只能按 read / grep / find 逐个文件看）',
    via: 'skill',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      { step: '退路（现在就能用）：先 grep 定位再用 read 精读', command: 'yan read --path <文件>' }
    ]
  },
  {
    id: 'send-message',
    need: '把结果发到某个地方（邮件 / 群 / 工单）',
    keywords: ['发消息', '邮件', '通知', '群', '工单', '推送'],
    missing: '对外发送的通道（砚**不内置**发送能力，也不代管你的凭证）',
    via: 'mcp',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      { step: '接一个提供发送能力的 MCP 服务；发送前由你确认，砚不会自己发' },
      { step: '退路：把内容写成一份成果，再由你复制出去', command: 'yan artifact attach --request-file artifact.json' }
    ]
  },
  {
    id: 'long-video',
    need: '把一段长视频 / 长音频做成笔记',
    keywords: ['视频', '字幕', '转录', '笔记'],
    missing: '视频 / 音频转写（砚只能处理文本与图片）',
    via: 'mcp',
    paths: [
      SEARCH_STEP,
      ...ACQUIRE_STEPS,
      { step: '先把字幕 / 文稿拿到（本机工具或在线服务），再按长材料分段处理' },
      { step: '分段并行读时可以用子代理（它只交回摘要）', command: 'yan subagent start --task "<要读的那一段>"' }
    ]
  },
  {
    id: 'scheduled',
    need: '让它每隔一段时间自己看一眼',
    keywords: ['定时', '周期', '后台', '自动', '一直盯着', '每隔'],
    missing: '后台定时任务（砚**故意不做**：应用没开就不跟进）',
    via: 'builtin',
    paths: [
      { step: '用「持续关注」代替定时任务：到点了在空间概览里提醒，点一下再把该看的填进输入框' },
      { step: '建一个关注', command: 'yan follow save --request-file watch.json' },
      { step: '谁到点了', command: 'yan follow due' }
    ]
  }
]

/** 命中结果：命中了哪些词。 */
export interface GapMatch {
  gap: CapabilityGap
  matched: string[]
}

/**
 * 按关键词找最像的场景。
 *
 * **匹配不到返回 `null`**（调用方给通用路径，不硬塞）。
 * 多个场景同时命中时取「命中词更多」的那个；同分时按清单顺序（先列的更常见）。
 */
export function matchGap(need: string): GapMatch | null {
  const text = String(need ?? '').toLowerCase()
  if (!text.trim()) return null
  let best: GapMatch | null = null
  for (const gap of CAPABILITY_GAPS) {
    const matched = gap.keywords.filter((word) => text.includes(word.toLowerCase()))
    if (matched.length === 0) continue
    if (!best || matched.length > best.matched.length) best = { gap, matched }
  }
  return best
}

/** 场景化说明（可直接发给用户 / 模型看）。 */
export function gapText(gap: CapabilityGap, matched: readonly string[] = []): string {
  const lines = [`你问的是：${gap.need}`, `缺的能力：${gap.missing}`, `这类能力通常来自：${GAP_ROUTE_LABELS[gap.via]}`]
  if (matched.length > 0) lines.push(`（匹配到的词：${matched.join('、')}）`)
  lines.push('可以这样接：')
  gap.paths.forEach((path, i) => {
    lines.push(`${i + 1}. ${path.step}${path.command ? `　→ ${path.command}` : ''}`)
  })
  lines.push('', '装东西会动你本机：要不要装由你决定；砚不会自己装、也不会自己发消息。')
  return lines.join('\n')
}

/**
 * 没匹配到已知场景时的通用路径。
 *
 * 刻意**不猜具体包名** —— 只给「怎么找、怎么装、怎么验证」那三步。
 */
export function unmatchedGapText(need: string): string {
  const text = String(need ?? '').trim()
  return [
    text ? `你要做的是：${text}` : '（没说清要做什么）',
    '这件事没有对应到已知的能力缺口清单，所以不猜该装什么。',
    '可以这样找：',
    `1. 先看本地已装 / 已加载的有什么　→ yan capabilities search --query-text "${text || '<你要做的事>'}"`,
    '2. 有候选就先准备再接入　→ yan capabilities prepare --candidate <候选ID> → yan capabilities acquire --candidate <候选ID>',
    '3. 本地没有就联网找一次　→ yan capabilities discover --query-text "<你要做的事>"',
    '',
    '如果发现是常见缺口，可以说一声，我们把它加进场景清单（那样下次就能直接给出路径）。'
  ].join('\n')
}

/**
 * 「目录里已经有这类能力」的识别片段。
 *
 * 为什么与 `keywords` 分开：`keywords` 匹配的是**用户说的话**（中文为主），
 * 而能力目录里出现的是**英文 id**（`builtin:browser.open`、`skill:pdf-tools`）。
 * 拿同一份词表去判「已经有了吗」会得出「浏览器能力还没有」这种错结论。
 */
const GAP_AVAILABLE_HINTS: Record<string, readonly string[]> = {
  'pdf-tables': ['pdf', 'document', 'parse', 'ocr'],
  spreadsheet: ['csv', 'sheet', 'spreadsheet', 'chart', 'data'],
  'web-page': ['browser', 'web', 'fetch', 'url'],
  audio: ['audio', 'speech', 'transcri', 'tts', 'voice'],
  screenshot: ['image', 'vision', 'ocr', 'screenshot'],
  database: ['sql', 'database', 'db', 'postgres', 'mysql'],
  'code-search': ['index', 'search', 'code', 'grep'],
  'send-message': ['mail', 'smtp', 'notify', 'send', 'message'],
  'long-video': ['video', 'subtitle', 'transcri'],
  scheduled: ['follow', 'schedule', 'watch']
}

/** 某个场景对应的「已有能力」识别片段（未登记时为空数组）。 */
export function availableHintsFor(gap: CapabilityGap): readonly string[] {
  return GAP_AVAILABLE_HINTS[gap.id] ?? []
}

/**
 * 这个缺口现在是不是「已经有能力了」。
 *
 * `available` 传当前可用能力名 / 命令名（`capabilities search` 的结果即可）。
 * 命中就说明不必再装 —— 回复里应当直接说「你已经有这个能力」。
 * 判据用 [availableHintsFor]（英文 id 片段）而不是 `keywords`（用户用词）。
 */
export function gapStillMissing(gap: CapabilityGap, available: readonly string[]): boolean {
  const hints = availableHintsFor(gap)
  const pool = available.map((item) => String(item ?? '').toLowerCase()).filter(Boolean)
  if (pool.length === 0 || hints.length === 0) return true
  return !hints.some((hint) => pool.some((item) => item.includes(hint.toLowerCase())))
}

/** 一句话总结（列表 / 摘要用）。 */
export function gapSummary(gap: CapabilityGap): string {
  return `${gap.need} → 缺：${gap.missing}（通常来自${GAP_ROUTE_LABELS[gap.via]}）`
}
