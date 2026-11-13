import { stripIpcErrorPrefix } from '../../../../shared/ipc-error'
import type { Notice, Store } from '../store'

export interface SliceContext {
  set: (partial: Partial<Store>) => void
  get: () => Store
}

const MAX_NOTICES = 3

export function pushNotice(
  list: Notice[],
  type: Notice['type'],
  text: string,
  id?: string
): Notice[] {
  if (!text.trim()) return list
  if (list.some((n) => n.text === text && Date.now() - (n.at ?? 0) < 8000)) return list
  const next = [...list, { id: id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, text, at: Date.now() }]
  return next.slice(-MAX_NOTICES)
}

export async function piCall<T extends { ok: boolean; error?: string }>(
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const error = stripIpcErrorPrefix(raw)
    return { ok: false, error } as T
  }
}
