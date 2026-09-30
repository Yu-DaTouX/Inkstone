import { execFile, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** 只停止本次创建的执行进程及其子树，并等待控制进程退出后才冻结成果。 */
export async function stopHubChild(child: ChildProcess | null | undefined): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  const exited = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => { child.removeListener('exit', done); resolve(false) }, 5000)
    const done = () => { clearTimeout(timeout); resolve(true) }
    child.once('exit', done)
  })
  if (process.platform === 'win32' && child.pid) {
    try { await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }) }
    catch { child.kill() }
  } else child.kill()
  return exited
}
