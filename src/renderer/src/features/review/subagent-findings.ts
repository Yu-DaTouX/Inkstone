import type { SubagentRun } from '../../../../shared/ipc'
import { useStore } from '../../state/store'
import type { ReviewFindingsLoader } from './ReviewPage'

const REVIEW_WAIT_MS = 30 * 60 * 1000

function settled(run: SubagentRun | undefined): run is SubagentRun {
  return !!run && run.status !== 'starting' && run.status !== 'running'
}

function finalAssistantText(run: SubagentRun): string {
  for (let i = run.transcript.length - 1; i >= 0; i -= 1) {
    const message = run.transcript[i]
    if (message.role === 'assistant' && message.text.trim()) return message.text
  }
  return run.result?.summary ?? ''
}

async function freshRun(runId: string): Promise<SubagentRun | undefined> {
  try {
    const runs = await window.yan.subagents.list()
    return runs.find((run) => run.id === runId)
  } catch {
    return undefined
  }
}

function waitForSettled(runId: string): Promise<SubagentRun | undefined> {
  const current = useStore.getState().subagents.find((run) => run.id === runId)
  if (settled(current)) return Promise.resolve(current)
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {}
    const timer = window.setTimeout(() => {
      unsubscribe()
      resolve(undefined)
    }, REVIEW_WAIT_MS)
    unsubscribe = useStore.subscribe((state) => {
      const run = state.subagents.find((item) => item.id === runId)
      if (!settled(run)) return
      window.clearTimeout(timer)
      unsubscribe()
      resolve(run)
    })
  })
}

export const loadSubagentReviewFindings: ReviewFindingsLoader = async (_changeSet, run) => {
  if (!run.runId) return { ok: false, error: '\u8bc4\u5ba1\u8fd0\u884c\u6ca1\u6709\u8fd4\u56de\u5b50 Agent \u7f16\u53f7' }
  const observed = await waitForSettled(run.runId)
  if (!observed) return { ok: false, error: '\u7b49\u5f85\u8bc4\u5ba1\u7ed3\u679c\u8d85\u65f6' }
  const finished = (await freshRun(run.runId)) ?? observed
  if (finished.status !== 'done') return { ok: false, error: finished.error ?? '\u8bc4\u5ba1\u8fd0\u884c\u672a\u6b63\u5e38\u5b8c\u6210' }
  const text = finalAssistantText(finished)
  return text ? { ok: true, text } : { ok: false, error: '\u8bc4\u5ba1\u7ed3\u679c\u4e3a\u7a7a' }
}
