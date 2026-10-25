export const RESTORED_READONLY_ENV = 'YAN_RESTORED_READONLY'
export const RESTORED_READONLY_MESSAGE = '这是从备份恢复出的数据，只能查看，不能发消息或运行任务；要继续工作请回到主窗口。'

export function isRestoredReadonly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RESTORED_READONLY_ENV] === '1'
}
