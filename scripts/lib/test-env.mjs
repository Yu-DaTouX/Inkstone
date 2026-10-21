import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST_ENV = /^(YAN|PI)_|_API_KEY$|_TOKEN$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/

export function applyTestEnv() {
  for (const key of Object.keys(process.env)) {
    if (HOST_ENV.test(key)) delete process.env[key]
  }
  const root = mkdtempSync(join(tmpdir(), 'inkstone-test-'))
  const paths = {
    data: join(root, 'data'),
    pi: join(root, 'pi'),
    sessions: join(root, 'sessions'),
    userdata: join(root, 'userdata'),
    downloads: join(root, 'downloads')
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  Object.assign(process.env, {
    YAN_DATA_DIR: paths.data,
    YAN_PI_DIR: paths.pi,
    YAN_SESSIONS_DIR: paths.sessions,
    YAN_USER_DATA: paths.userdata,
    YAN_DOWNLOADS_DIR: paths.downloads,
    PI_CODING_AGENT_DIR: paths.pi
  })
  return root
}

export function isIsolatedTestEnv() {
  return /inkstone-test-/.test(process.env.YAN_DATA_DIR ?? '')
}
