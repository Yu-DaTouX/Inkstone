const TASKBAR_REFRESH_MS = 200

export function createTaskbarThrottle(apply: (force: boolean) => void, intervalMs = TASKBAR_REFRESH_MS): (force?: boolean) => void {
  let taskbarTimer: ReturnType<typeof setTimeout> | null = null
  let taskbarAt = 0

  const refreshTaskbar = (force = false): void => {
    const wait = taskbarAt + intervalMs - Date.now()
    if (!force && wait > 0) {
      taskbarTimer ??= setTimeout(() => {
        taskbarTimer = null
        refreshTaskbar()
      }, wait)
      return
    }
    if (taskbarTimer) clearTimeout(taskbarTimer)
    taskbarTimer = null
    taskbarAt = Date.now()
    apply(force)
  }

  return refreshTaskbar
}
