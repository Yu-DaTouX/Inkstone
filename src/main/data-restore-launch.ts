import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

export function restoredDataEnvironment(root: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'home', 'userprofile', 'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)', 'lang', 'lc_all', 'display', 'wayland_display', 'xdg_runtime_dir', 'dbus_session_bus_address'])
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => keep.has(key.toLowerCase())))
  return {
    ...env,
    YAN_PI_DIR: join(root, 'pi-agent'),
    YAN_SESSIONS_DIR: join(root, 'pi-agent', 'sessions'),
    YAN_DATA_DIR: join(root, 'pi-agent', 'yan'),
    YAN_USER_DATA: join(root, 'electron'),
    YAN_DOWNLOADS_DIR: join(root, 'downloads')
  }
}

export async function launchRestoredData(root: string, executable: string, appPath?: string): Promise<void> {
  for (const parts of [[], ['pi-agent'], ['pi-agent', 'sessions'], ['pi-agent', 'yan'], ['electron'], ['downloads']]) {
    const info = await lstat(join(root, ...parts))
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Restored data contains an invalid directory')
  }
  const marker = await lstat(join(root, 'restored.json'))
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Restored data is incomplete')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, appPath ? [appPath] : [], { cwd: root, env: restoredDataEnvironment(root), detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
