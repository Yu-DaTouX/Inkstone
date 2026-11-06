import { pick } from '../shared/ui-lang'
export const RESTORED_READONLY_ENV = 'YAN_RESTORED_READONLY'
export const restoredReadonlyMessage = (): string => pick('这是从备份恢复出的数据，只能查看，不能发消息或运行任务；要继续工作请回到主窗口。', 'This is data restored from a backup. It is view-only; go back to the main window to keep working.')

export function isRestoredReadonly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RESTORED_READONLY_ENV] === '1'
}
