import type { SearchStep } from './model'

export interface SearchExpansionKeys {
  stable: string
  tagged: string
}

export function searchExpansionKeys(callId: string, step: Pick<SearchStep, 'operationId'>): SearchExpansionKeys {
  const stable = `web:${callId}`
  return { stable, tagged: step.operationId ? `web:${callId}:${step.operationId}` : stable }
}

export function searchExpansionOpen(manual: boolean | undefined): boolean {
  return manual ?? true
}
