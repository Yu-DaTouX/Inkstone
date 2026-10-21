import { currentLang } from './lang'
import { translate } from './index'
import type { MessageKey, TVars } from './index'

export function uiText(key: MessageKey, vars?: TVars): string {
  return translate(currentLang(), key, vars)
}
