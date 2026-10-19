export type ExitChoice = 'cancel' | 'save' | 'interrupt'

export type QuitReason = 'sessions' | 'subagents' | 'terminal' | 'unsaved'

export interface QuitActivity {
  sessionsBusy: boolean
  runningSubagents: number
  terminalWorking: boolean
  unsavedFiles?: number
}

export function quitReasons(activity: QuitActivity): QuitReason[] {
  const reasons: QuitReason[] = []
  if (activity.sessionsBusy) reasons.push('sessions')
  if (activity.runningSubagents > 0) reasons.push('subagents')
  if (activity.terminalWorking) reasons.push('terminal')
  if ((activity.unsavedFiles ?? 0) > 0) reasons.push('unsaved')
  return reasons
}

const REASON_TEXT: Record<QuitReason, (activity: QuitActivity) => string> = {
  sessions: () => '有会话正在运行',
  subagents: (activity) => `${activity.runningSubagents} 个子代理正在运行`,
  terminal: () => '终端里有命令正在执行',
  unsaved: (activity) => `${activity.unsavedFiles ?? 0} 个文件有未保存的修改`
}

export interface QuitPrompt {
  message: string
  detail: string
  buttons: [string, string, string]
}

export function quitPrompt(activity: QuitActivity, reasons = quitReasons(activity)): QuitPrompt {
  const lines = reasons.map((reason) => REASON_TEXT[reason](activity))
  return {
    message: `${lines.join('；')}。请选择退出方式。`,
    detail: '保存并退出会记录运行实例快照；中断退出会立即停止当前任务。取消会继续把窗口留在托盘。',
    buttons: ['取消', '保存并退出', '中断退出']
  }
}

export function choiceFromResponse(index: number): ExitChoice {
  return index === 2 ? 'interrupt' : index === 1 ? 'save' : 'cancel'
}

export function parseProbeChoice(value: string | undefined): ExitChoice | undefined {
  return value === 'cancel' || value === 'save' || value === 'interrupt' ? value : undefined
}

export function needsQuitConfirm(options: { quitting: boolean; reasons: QuitReason[]; hasWindow: boolean }): boolean {
  return !options.quitting && options.hasWindow && options.reasons.length > 0
}
