export type ContinuationReason = 'loop' | 'model-error'
export type ContinuationAudience = 'session' | 'subagent'

const SESSION_HEADS: Record<ContinuationReason, string> = {
  loop: '[循环恢复 · 自动继续 1/1]',
  'model-error': '[模型错误恢复 · 自动继续 1/1]'
}

const SESSION_CAUSES: Record<ContinuationReason, string> = {
  loop: '上一轮因输出重复被安全中止。',
  'model-error': '上一轮模型请求因暂时性错误（超时、连接中断或服务过载）中断，且没有自动重试。'
}

const SESSION_LOOP_EXTRA = '也不复述循环内容；回收的排队消息不在本次续跑范围内。'

const SUBAGENT_CAUSES: Record<ContinuationReason, string> = {
  loop: 'The previous turn was stopped because its output started repeating. Do not repeat the looping content.',
  'model-error': 'The previous model request failed with a temporary error (timeout, dropped connection or overload) and was not retried.'
}

export function continuationPrompt(reason: ContinuationReason, audience: ContinuationAudience = 'session'): string {
  if (audience === 'subagent') {
    return `[Auto-continue 1/1] ${SUBAGENT_CAUSES[reason]} Check the tool results so far and finish the delegated task without repeating completed steps. If you cannot continue safely, stop and say why at the start of your report.`
  }
  const extra = reason === 'loop' ? SESSION_LOOP_EXTRA : ''
  return `${SESSION_HEADS[reason]}\n${SESSION_CAUSES[reason]}在当前会话继续：核对已完成的工具结果，接着做没完成的部分，不重复已做的操作，${extra || '也不重新开始。'}原任务已完成或需要用户决定时，简短说明并结束。`
}
