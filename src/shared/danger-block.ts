export const DANGER_BLOCK_PREFIX = '高危操作未获用户确认：'
export const DANGER_BLOCK_DENIED_MARK = '用户拒绝了这次操作'
export const DANGER_BLOCK_NO_ANSWER_MARK = '没有得到用户确认'
export const DANGER_BLOCK_HOST_FAILURE_MARK = '没能取得用户确认'

export type DangerBlockKind = 'denied' | 'no-answer' | 'host-failure'

export function dangerBlockKind(text: string | null | undefined): DangerBlockKind | null {
  if (typeof text !== 'string' || !text.startsWith(DANGER_BLOCK_PREFIX)) return null
  if (text.includes(DANGER_BLOCK_NO_ANSWER_MARK)) return 'no-answer'
  if (text.includes(DANGER_BLOCK_DENIED_MARK)) return 'denied'
  if (text.includes(DANGER_BLOCK_HOST_FAILURE_MARK)) return 'host-failure'
  return null
}

export function isDangerDenial(text: string | null | undefined): boolean {
  const kind = dangerBlockKind(text)
  return kind === 'denied' || kind === 'no-answer'
}
