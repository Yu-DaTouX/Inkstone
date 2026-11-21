import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { antigravityPreferencePath } from './antigravity-preferences'
import { isSafeSessionId } from './session-id'
import { trashSessionSources } from './sources'
import { taskPlanLogPath, TASK_PLAN_DIRNAME } from './task-plan-store'
import { timingKey, turnTimingFile } from './turn-timing-store'

export interface SessionSideDataDeps {
  yanDir: string
  trash: (path: string) => Promise<void>
  approvalLog: { forget(sessionId: string): boolean }
  questionLog: { forget(sessionId: string): boolean }
  forgetSessionCode: (sessionId: string) => Promise<unknown>
}

export interface SessionSideDataResult {
  removed: string[]
  errors: string[]
}

export async function purgeSessionSideData(deps: SessionSideDataDeps, input: { sessionId: string; fileName?: string }): Promise<SessionSideDataResult> {
  const result: SessionSideDataResult = { removed: [], errors: [] }
  const step = async (name: string, run: () => Promise<boolean> | boolean): Promise<void> => {
    try {
      if (await run()) result.removed.push(name)
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const trashIfPresent = async (path: string): Promise<boolean> => {
    if (!existsSync(path)) return false
    await deps.trash(path)
    return true
  }
  const bucket = timingKey(input.fileName)
  if (bucket) await step('turn-timing', () => trashIfPresent(turnTimingFile(deps.yanDir, bucket)))
  if (isSafeSessionId(input.sessionId)) {
    await step('task-plans', () => trashIfPresent(taskPlanLogPath(input.sessionId, join(deps.yanDir, TASK_PLAN_DIRNAME))))
    await step('antigravity-sessions', () => trashIfPresent(antigravityPreferencePath(deps.yanDir, input.sessionId)))
    await step('approval-log', () => deps.approvalLog.forget(input.sessionId))
    await step('question-log', () => deps.questionLog.forget(input.sessionId))
  }
  await step('sources', () => trashSessionSources(input.sessionId, deps.trash))
  await step('session-codes', async () => Boolean(await deps.forgetSessionCode(input.sessionId)))
  return result
}
