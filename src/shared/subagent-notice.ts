import type { SubagentRun } from './ipc'
import { subagentOutcome, type SubagentOutcomeKey } from './subagent-outcome'

export const SUBAGENT_NOTICE_TAG = 'subagent-notification'

const HEADLINE_TASK_MAX = 80
const SUMMARY_MAX = 800

export interface ParsedSubagentNotice {
  id: string
  status: string
  headline: string
  body: string
}

function clip(text: string, max: number): string {
  const points = [...text.replace(/\s+/g, ' ').trim()]
  return points.length > max ? `${points.slice(0, max).join('')}…` : points.join('')
}

function headlineWord(key: SubagentOutcomeKey, status: string): string {
  if (key === 'timeout') return status === 'done' ? '超时后已收尾（结论可能不完整）' : '超时被停止（结论可能不完整）'
  if (key === 'budget') return status === 'done' ? '调用次数用完后已收尾（结论可能不完整）' : '调用次数用完被停止（结论可能不完整）'
  if (key === 'failed') return '失败'
  if (key === 'stopped') return '已停止'
  return '已完成'
}

export function buildSubagentNotice(
  run: Pick<SubagentRun, 'id' | 'task' | 'status' | 'isolation' | 'model' | 'diff' | 'review' | 'error' | 'result'> &
    Partial<Pick<SubagentRun, 'endReason' | 'resultPath' | 'resumable'>>
): string {
  const status = run.status === 'done' || run.status === 'error' || run.status === 'cancelled' ? run.status : 'done'
  const mode = run.isolation === 'controlled-cwd' ? '只读' : '可修改'
  const outcome = subagentOutcome({ status, review: 'none', endReason: run.endReason })
  const lines = [`子代理 ${run.id}（${mode}）${headlineWord(outcome.key, status)}：${clip(run.task, HEADLINE_TASK_MAX)}`]
  if (run.model) lines.push(`模型：${run.model}`)
  const summary = run.result?.summary || run.error
  if (summary) lines.push(`${run.result?.summaryFrom === 'error' || (!run.result?.summary && status === 'error') ? '错误' : '摘要'}：${clip(summary, SUMMARY_MAX)}`)
  if (status === 'error' && run.error && run.result?.summaryFrom === 'last-message') lines.push(`原因：${clip(run.error, 200)}`)
  if (outcome.partial) lines.push('这是到点收尾或被停止时的部分结论：关键事实先自己核对，缺的部分决定是重派、缩小范围还是自己补。')
  if (run.diff && run.diff.files > 0) {
    const review =
      run.review === 'pending' || run.review === 'conflict'
        ? '，尚未合并，由你处置'
        : run.review === 'archived'
          ? '，已归档为补丁'
          : ''
    lines.push(`改动：${run.diff.files} 个文件 +${run.diff.additions}/-${run.diff.deletions}${review}`)
    if ((run.review === 'pending' || run.review === 'conflict') && run.resultPath) lines.push(`工作区：${run.resultPath}`)
    if (run.review === 'pending' || run.review === 'conflict') lines.push(`处置：合并 yan subagent merge --id ${run.id}；放弃 yan subagent discard --id ${run.id}；要它继续改或解决冲突用 yan subagent send --id ${run.id}`)
  }
  lines.push(`完整过程：yan subagent get --id ${run.id}`)
  if (run.resumable?.ok) lines.push(`可续派：yan subagent send --id ${run.id} --message <追加任务>（保留它之前的全部上下文，比重新派更省）`)
  else if (run.resumable?.reason) lines.push(`不可续派：${clip(run.resumable.reason, 120)}`)
  lines.push('这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。')
  return `<${SUBAGENT_NOTICE_TAG} id="${run.id}" status="${status}">\n${lines.join('\n')}\n</${SUBAGENT_NOTICE_TAG}>`
}

const NOTICE_RE = new RegExp(`^<${SUBAGENT_NOTICE_TAG} id="([^"]+)" status="([^"]+)">\\n([\\s\\S]*?)\\n</${SUBAGENT_NOTICE_TAG}>$`)

export function parseSubagentNotice(text: string): ParsedSubagentNotice | null {
  const match = NOTICE_RE.exec(text.trim())
  if (!match) return null
  const body = match[3]
  return { id: match[1], status: match[2], headline: body.split('\n')[0] ?? '', body }
}

export function isSubagentNotice(text: string): boolean {
  return parseSubagentNotice(text) !== null ||
    /^<subagent-notification id="[^"]+" status="(?:done|error|cancelled)">\n[\s\S]*这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。\s*$/.test(text.trim())
}
