import { translate, useI18n } from '../../../i18n'

export type WebSearchTextKey =
  | 'searching'
  | 'fetching'
  | 'searched'
  | 'results'
  | 'sourcesUnavailable'
  | 'fetched'
  | 'fetchBlocked'
  | 'blocked'
  | 'sources'
  | 'expand'
  | 'collapse'
  | 'replySources'
  | 'backToCitation'
  | 'backToCitationShort'
  | 'citationAria'
  | 'citationOpenHint'
  | 'openSource'
  | 'moreSources'
  | 'showLess'
  | 'read'
  | 'partial'
  | 'cached'
  | 'groupSearched'
  | 'groupFetched'

export function webSearchText(lang: string, key: WebSearchTextKey, vars?: Record<string, string | number>): string {
  return translate(lang === 'en-US' ? 'en-US' : 'zh-CN', `webSearch.${key}`, vars)
}

export function useWebSearchText(): (key: WebSearchTextKey, vars?: Record<string, string | number>) => string {
  const { lang } = useI18n()
  return (key, vars) => webSearchText(lang, key, vars)
}
