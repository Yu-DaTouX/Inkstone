import { useI18n } from '../../../i18n'

export type WebSearchTextKey =
  | 'searching'
  | 'fetching'
  | 'searched'
  | 'searchedAny'
  | 'fetched'
  | 'sources'
  | 'expand'
  | 'collapse'
  | 'citationAria'
  | 'citationOpenHint'
  | 'openSource'
  | 'empty'
  | 'moreSources'
  | 'showLess'

const ZH: Record<WebSearchTextKey, string> = {
  searching: '搜索中',
  fetching: '读取中',
  searched: '已搜索 {n} 个网站',
  searchedAny: '已搜索',
  fetched: '已读取网页',
  sources: '来源',
  expand: '展开来源',
  collapse: '收起来源',
  citationAria: '引用来源：{site} 第 {n} 条',
  citationOpenHint: '单击在砚里打开，双击用系统浏览器打开',
  openSource: '打开来源：{title}',
  empty: '没有可显示的来源',
  moreSources: '{n} 个更多来源',
  showLess: '显示更少'
}

const EN: Record<WebSearchTextKey, string> = {
  searching: 'Searching',
  fetching: 'Reading',
  searched: 'Searched {n} sites',
  searchedAny: 'Searched',
  fetched: 'Read page',
  sources: 'Sources',
  expand: 'Show sources',
  collapse: 'Hide sources',
  citationAria: 'Citation {n} from {site}',
  citationOpenHint: 'Click to open in Inkstone, double-click for the system browser',
  openSource: 'Open source: {title}',
  empty: 'No sources to show',
  moreSources: '{n} more sources',
  showLess: 'Show less'
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
