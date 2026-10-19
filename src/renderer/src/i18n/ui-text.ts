import { translate } from './index'
import type { Lang, MessageKey, TVars } from './index'

function documentLang(): Lang {
  return typeof document !== 'undefined' && document.documentElement?.lang === 'en-US' ? 'en-US' : 'zh-CN'
}

export function uiText(key: MessageKey, vars?: TVars): string {
  return translate(documentLang(), key, vars)
}
