import { create } from 'zustand'
import { antigravityQuotaFailure, type AntigravityQuotaSnapshot } from '../../../shared/antigravity'
import { pick } from '../../../shared/ui-lang'

interface AntigravityQuotaState {
  snapshot?: AntigravityQuotaSnapshot
  loading: boolean
}

export const useAntigravityQuotaStore = create<AntigravityQuotaState>(() => ({ loading: false }))

let pending: Promise<AntigravityQuotaSnapshot | undefined> | undefined

export function refreshAntigravityQuota(force = false): Promise<AntigravityQuotaSnapshot | undefined> {
  if (pending) return pending
  const read = window.yan?.antigravity?.quota
  if (!read) return Promise.resolve(useAntigravityQuotaStore.getState().snapshot)
  useAntigravityQuotaStore.setState({ loading: true })
  const request = Promise.resolve()
    .then(() => read(force))
    .then(
      (snapshot) => {
        useAntigravityQuotaStore.setState({ snapshot })
        return snapshot
      },
      () => {
        const checkedAt = Date.now()
        const error = pick('无法刷新 Antigravity 额度。请重试。', 'Could not refresh Antigravity allowance. Try again.')
        const next = antigravityQuotaFailure(useAntigravityQuotaStore.getState().snapshot, checkedAt, error)
        useAntigravityQuotaStore.setState({ snapshot: next })
        return next
      }
    )
    .finally(() => {
      pending = undefined
      useAntigravityQuotaStore.setState({ loading: false })
    })
  pending = request
  return request
}
