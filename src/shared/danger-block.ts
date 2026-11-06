export const DANGER_BLOCK_PREFIX = 'High-risk operation not confirmed by the user: '
export const DANGER_BLOCK_DENIED_MARK = 'The user declined this operation'
export const DANGER_BLOCK_NO_ANSWER_MARK = 'No answer from the user'
export const DANGER_BLOCK_HOST_FAILURE_MARK = "Could not get the user's confirmation"

const LEGACY_DANGER_BLOCK = {
  prefix: '高危操作未获用户确认：',
  denied: '用户拒绝了这次操作',
  noAnswer: '没有得到用户确认',
  hostFailure: '没能取得用户确认'
}

export type DangerBlockKind = 'denied' | 'no-answer' | 'host-failure'

export function dangerBlockKind(text: string | null | undefined): DangerBlockKind | null {
  if (typeof text !== 'string') return null
  const marks = text.startsWith(DANGER_BLOCK_PREFIX)
    ? { noAnswer: DANGER_BLOCK_NO_ANSWER_MARK, denied: DANGER_BLOCK_DENIED_MARK, hostFailure: DANGER_BLOCK_HOST_FAILURE_MARK }
    : text.startsWith(LEGACY_DANGER_BLOCK.prefix)
      ? LEGACY_DANGER_BLOCK
      : null
  if (!marks) return null
  if (text.includes(marks.noAnswer)) return 'no-answer'
  if (text.includes(marks.denied)) return 'denied'
  if (text.includes(marks.hostFailure)) return 'host-failure'
  return null
}

export function isDangerDenial(text: string | null | undefined): boolean {
  const kind = dangerBlockKind(text)
  return kind === 'denied' || kind === 'no-answer'
}
