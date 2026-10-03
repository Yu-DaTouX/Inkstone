/**
 * 联网搜索的共享契约（实施-27 S1）。
 *
 * 边界（与本文件相关的那部分）：
 *   · 这里只有**类型与常量**，没有 Electron、没有 DOM、没有子进程 ——
 *     主进程与 CLI 都用它，渲染端将来要展示结果也用它；
 *   · 「来源」是**固定的白名单**，不是任意字符串：后端命令名要拼进 spawn 的
 *     参数数组，不能由调用方自由指定（否则等于开放任意命令执行）。
 *
 * 与 `web-search.ts` 的区别（别合并）：
 *   · `web-search.ts` 回答的是「这台机器上有没有一个已接入的搜索能力」
 *     （MCP / Skill），用来决定来源菜单那个入口要不要出现；
 *   · 本文件是**真正的搜索后端契约**（OpenCLI 适配器 → SearchItem），
 *     由 `yan search` 驱动。两者可以共存：前者是别人的搜索，后者是砚自己的。
 */

/** 首批来源：三个都是 HTTP 直连（不依赖浏览器扩展），见 S0 实测 */
export type SearchSourceId = 'wikipedia' | 'arxiv' | 'hackernews' | 'brave' | 'tavily' | 'bing' | 'ddg' | 'so360'

export interface SearchSource {
  id: SearchSourceId
  /** OpenCLI 的适配器名（`opencli <app> <subcommand> <query>`） */
  app: string
  subcommand: string
  /** 给人看的名字 */
  label: string
  /** 是否需要浏览器扩展（首批都是 false；留着是为了 `doctor` 能说清依赖） */
  needsBrowser: boolean
  /** 结果的 URL 是完整链接，还是要按 id 拼出来 */
  urlKind: 'direct' | 'hackernews'
  /** 需要用户自己的 API key：没配置时不进默认来源，也不算后端故障 */
  needsKey?: boolean
  /** 不经 OpenCLI，由宿主直接取结果（HTTP API 或隐藏窗口）；不进默认来源，由 `yan search` 按配置挑选 */
  direct?: boolean
}

export const SEARCH_SOURCES: readonly SearchSource[] = [
  { id: 'wikipedia', app: 'wikipedia', subcommand: 'search', label: '维基百科', needsBrowser: false, urlKind: 'direct' },
  { id: 'arxiv', app: 'arxiv', subcommand: 'search', label: 'arXiv', needsBrowser: false, urlKind: 'direct' },
  { id: 'hackernews', app: 'hackernews', subcommand: 'search', label: 'Hacker News', needsBrowser: false, urlKind: 'hackernews' },
  { id: 'brave', app: '', subcommand: '', label: 'Brave 搜索', needsBrowser: false, urlKind: 'direct', needsKey: true, direct: true },
  { id: 'tavily', app: '', subcommand: '', label: 'Tavily 搜索', needsBrowser: false, urlKind: 'direct', needsKey: true, direct: true },
  { id: 'bing', app: '', subcommand: '', label: 'Bing 网页', needsBrowser: false, urlKind: 'direct', direct: true },
  { id: 'ddg', app: '', subcommand: '', label: 'DuckDuckGo', needsBrowser: false, urlKind: 'direct', direct: true },
  { id: 'so360', app: '', subcommand: '', label: '360 搜索', needsBrowser: false, urlKind: 'direct', direct: true }
]

/** 默认只查这三个；要加来源先在这里登记，再在白名单校验里放行 */
export const DEFAULT_SEARCH_SOURCES: readonly SearchSourceId[] = SEARCH_SOURCES.filter((s) => !s.direct).map((s) => s.id)

export const SEARCH_LIMIT_PER_SOURCE_DEFAULT = 6
export const SEARCH_LIMIT_PER_SOURCE_MAX = 20
export const SEARCH_LIMIT_TOTAL_DEFAULT = 12
export const SEARCH_LIMIT_TOTAL_MAX = 40
export const SEARCH_TIMEOUT_MS_DEFAULT = 20_000
export const SEARCH_TIMEOUT_MS_MAX = 60_000
/** 单次调用 stdout 上限（超出按截断处理，不把几百 KB 灌进上下文） */
export const SEARCH_OUTPUT_MAX_BYTES = 512 * 1024
/** 正文摘要上限（各来源的 snippet 长短不一，统一截到这里） */
export const SEARCH_SNIPPET_MAX = 280
/** 查询词上限 */
export const SEARCH_QUERY_MAX = 200

export interface SearchQuery {
  text: string
  /** 省略 = 默认三个；空数组 = 调用方明确不要来源，直接拒 */
  sources?: SearchSourceId[]
  limitPerSource?: number
  limitTotal?: number
  timeoutMs?: number
}

export interface SearchItem {
  title: string
  url: string
  snippet?: string
  source: SearchSourceId
  /** 各来源自己的时间字段（arXiv 的 published 等），没有就不带 */
  published?: string
  /** 其余有用的原始字段（score / authors），只放短字符串 */
  meta?: Record<string, string | number>
}

/**
 * 来源级状态（逐来源都要给一个，不能只汇报成功的）。
 *
 * `empty` 与 `error` / `timeout` / `unavailable` 必须能分开：
 * 「这个来源没有结果」与「这个来源没取到」是两个不同结论，
 * 合并了就会把失败显示成「没有」。
 */
export type SourceStatusKind = 'ok' | 'empty' | 'error' | 'timeout' | 'unavailable'

export interface PerSourceStatus {
  source: SearchSourceId
  status: SourceStatusKind
  /** 最终被收录进 items 的条数（受 limitPerSource / limitTotal 影响） */
  count: number
  /**
   * 因为**总数上限**（`limitTotal`）而没被处理的候选行数。
   *
   * 有它才能把「被上限挤掉」与「这个来源本来就没结果」（`empty`）分开 ——
   * 否则 `count: 0` 会被读成「世上没有」。值是中断点之后的候选行数
   * （可能含重复 / 结构不认识的行，是个上界）。
   */
  droppedByLimit?: number
  /** 后端错误码（doctor / BROWSER_CONNECT / COMMAND_EXEC …），只在非 ok 时有 */
  code?: string
  message?: string
  elapsedMs: number
}

export interface SearchOutcome {
  query: string
  items: SearchItem[]
  sources: PerSourceStatus[]
  /** 是否因为条数 / 体积上限裁掉过内容 */
  truncated: boolean
  durationMs: number
  /**
   * 查询**根本没发出去**时的原因（空查询 / 词太长 / 没有可用来源）。
   * 有它时 `sources` 为空数组 —— 这与「发了但全都没取到」是两回事。
   */
  error?: { code: string; message: string }
  /**
   * 请求里写了、但不在白名单里被丢掉的来源名。
   *
   * 有它才能把「没查」与「查了没结果」分开：`--sources wikipedia,nosuch` 只查
   * wikipedia，回执必须说清 nosuch 被忽略 —— 否则会被读成「nosuch 没有结果」。
   */
  ignoredSources?: string[]
}

/** 后端可用性（`yan search doctor` 的返回体） */
export interface SearchBackendStatus {
  /** 后端能不能用：命令找得到，且探针（doctor）能跑完 —— 参数错位 / 探针超时都算不可用 */
  available: boolean
  /** 版本号；取不到就是 null（不猜） */
  version: string | null
  /** 探针给出的原始可读输出（截断后的） */
  detail: string
  code?: string
  /**
   * 逐来源状态。
   *
   * ⚠️ 当前实现里 `ready` **等同于 `available`**（后端命令跑不起来时，单个来源也不报就绪），
   * 尚未按 `needsBrowser` 细分 —— 将来加了需要浏览器扩展的来源，要在这里补上
   * 「扩展没连 → 该来源未就绪」的判据，否则那个字段会名不副实。
   */
  sources: { id: SearchSourceId; label: string; needsBrowser: boolean; ready: boolean }[]
}

/**
 * 增强搜索的服务清单：凡是需要用户自己注册 key 的服务都登记在这里，
 * 设置页逐项列出，填了 key 才启用。`yan search` 仍是模型唯一的入口，
 * 这些服务只是它背后更好的来源。
 *   · brave / tavily：通用网页搜索，进 `query` 的来源链；
 *   · firecrawl：读网页的兜底（本地隐藏窗口读不出来时用），进 `fetch`；
 *   · context7：开发文档查询，对应 `docs` 动作；key 可选（有 key 额度更高）。
 */
export type SearchProviderId = 'brave' | 'tavily' | 'firecrawl' | 'context7'

export interface SearchProvider {
  id: SearchProviderId
  label: string
  /** 申请 key 的页面 */
  keyUrl: string
  /** 环境变量名；文件里的 key 优先于它 */
  envName: string
  /** 不填 key 也能用（只是限额低）；设置页据此写「可选」 */
  keyOptional?: boolean
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  { id: 'tavily', label: 'Tavily', keyUrl: 'https://app.tavily.com/', envName: 'TAVILY_API_KEY' },
  { id: 'brave', label: 'Brave Search', keyUrl: 'https://brave.com/search/api/', envName: 'BRAVE_API_KEY' },
  { id: 'firecrawl', label: 'Firecrawl', keyUrl: 'https://www.firecrawl.dev/app/api-keys', envName: 'FIRECRAWL_API_KEY' },
  { id: 'context7', label: 'Context7', keyUrl: 'https://context7.com/dashboard', envName: 'CONTEXT7_API_KEY', keyOptional: true }
]

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return SEARCH_PROVIDERS.some((provider) => provider.id === value)
}

export interface SearchProviderState {
  configured: boolean
  /** 密钥来自哪里：本机配置文件 / 环境变量 */
  source?: 'file' | 'env'
}

/** 搜索 API 的配置状态（设置页与提醒用；密钥本身不出主进程） */
export interface SearchApiConfigView {
  /** 任一「通用网页搜索」key（Brave / Tavily）已配置——决定要不要提醒去配置 */
  configured: boolean
  /** 用户点过「不再提示」 */
  hintDismissed: boolean
  providers: Record<SearchProviderId, SearchProviderState>
}
