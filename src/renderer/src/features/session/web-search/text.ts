import { useI18n } from '../../../i18n'

export type WebSearchTextKey =
  | 'searching'
  | 'fetching'
  | 'searched'
  | 'results'
  | 'fetched'
  | 'fetchBlocked'
  | 'blocked'
  | 'sources'
  | 'expand'
  | 'collapse'
  | 'citationAria'
  | 'citationOpenHint'
  | 'openSource'
  | 'empty'
  | 'moreSources'
  | 'showLess'
  | 'read'
  | 'partial'
  | 'cached'

const ZH: Record<WebSearchTextKey, string> = {
  searching: '搜索中',
  fetching: '读取中',
  searched: '搜索',
  results: '{n} 条结果',
  fetched: '已读取网页',
  fetchBlocked: '网页被拦截',
  blocked: '被拦截',
  sources: '来源',
  expand: '展开来源',
  collapse: '收起来源',
  citationAria: '引用来源：{site} 第 {n} 条',
  citationOpenHint: '单击在砚里打开，双击用系统浏览器打开',
  openSource: '打开来源：{title}',
  empty: '没有可显示的来源',
  moreSources: '{n} 个更多来源',
  showLess: '显示更少',
  read: '已取原文',
  partial: '部分原文',
  cached: '缓存'
}

const EN: Record<WebSearchTextKey, string> = {
  searching: 'Searching',
  fetching: 'Reading',
  searched: 'Searched',
  results: '{n} results',
  fetched: 'Read page',
  fetchBlocked: 'Page blocked',
  blocked: 'Blocked',
  sources: 'Sources',
  expand: 'Show sources',
  collapse: 'Hide sources',
  citationAria: 'Citation {n} from {site}',
  citationOpenHint: 'Click to open in Inkstone, double-click for the system browser',
  openSource: 'Open source: {title}',
  empty: 'No sources to show',
  moreSources: '{n} more sources',
  showLess: 'Show less',
  read: 'Text fetched',
  partial: 'Partial text',
  cached: 'Cached'
}

export function webSearchText(lang: string, key: WebSearchTextKey, vars?: Record<string, string | number>): string {
  let text = (lang === 'en-US' ? EN : ZH)[key]
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
  return text
}

export function useWebSearchText(): (key: WebSearchTextKey, vars?: Record<string, string | number>) => string {
  const { lang } = useI18n()
  return (key, vars) => webSearchText(lang, key, vars)
}
