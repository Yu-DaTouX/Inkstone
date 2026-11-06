import { AsyncLocalStorage } from 'node:async_hooks'
import { setLangResolver } from '../shared/ui-lang'

const scope = new AsyncLocalStorage<true>()

setLangResolver(() => (scope.getStore() ? 'zh-CN' : undefined))

export function asModelText<T>(run: () => T): T {
  return scope.run(true, run)
}
