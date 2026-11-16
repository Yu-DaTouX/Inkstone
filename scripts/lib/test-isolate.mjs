import { rmSync } from 'node:fs'
import { applyTestEnv, isIsolatedTestEnv } from './test-env.mjs'
import { installRealDataGuard } from './test-real-data-guard.mjs'

installRealDataGuard()

if (!isIsolatedTestEnv()) {
  const sandbox = applyTestEnv()
  process.on('exit', () => {
    try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  })
}
