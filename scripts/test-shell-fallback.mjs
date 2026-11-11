import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import shellFallback, { registerPowerShellEnvFix } from '../resources/pi-extensions/shell-fallback.js'

function fakePi(active) {
  const handlers = {}
  let applied = null
  return {
    on: (event, fn) => { handlers[event] = fn },
    getActiveTools: () => active,
    setActiveTools: (names) => { applied = names },
    fire: (event) => handlers[event]?.(),
    get applied() { return applied },
    hasHandler: (event) => !!handlers[event]
  }
}

delete process.env.YAN_SHELL
const idle = fakePi(['read', 'bash', 'edit', 'write'])
shellFallback(idle)
assert.equal(idle.hasHandler('before_agent_start'), false, '有 bash 时不注册任何钩子')

process.env.YAN_SHELL = 'powershell'
const pi = fakePi(['read', 'bash', 'edit', 'write'])
shellFallback(pi)
pi.fire('before_agent_start')
assert.deepEqual(pi.applied, ['read', 'edit', 'write', 'powershell'])

const done = fakePi(['read', 'edit', 'write', 'powershell'])
shellFallback(done)
done.fire('before_agent_start')
assert.equal(done.applied, null)

const objects = fakePi([{ name: 'read' }, { name: 'bash' }])
shellFallback(objects)
objects.fire('before_agent_start')
assert.deepEqual(objects.applied, ['read', 'powershell'])

const registered = []
const spawned = []
const core = {
  createPowerShellToolDefinition: (cwd, options) => ({
    name: 'powershell',
    execute: async () => { spawned.push({ cwd, ...options?.spawnHook?.({ command: 'x', cwd, env: { PATH: 'a' } }) }); return 'ok' }
  })
}
registerPowerShellEnvFix({ registerTool: (tool) => registered.push(tool) }, core, { fixEnv: (env) => ({ ...env, FIXED: '1' }) })
assert.equal(registered.length, 1)
assert.equal(registered[0].name, 'powershell')
await registered[0].execute('id', {}, undefined, undefined, { cwd: 'C:/work' })
assert.equal(spawned[0].cwd, 'C:/work')
assert.equal(spawned[0].env.FIXED, '1')

delete process.env.YAN_SHELL
if (process.platform === 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'yan-shell-fallback-pwsh-'))
  const previousPath = process.env.PATH
  try {
    process.env.PATH = dir
    writeFileSync(join(dir, 'pwsh.exe'), '')
    const guarded = fakePi([])
    guarded.on = (event, fn) => { guarded[event] = fn }
    await shellFallback(guarded)
    const legacy = { toolName: 'bash', input: { command: 'powershell -NoProfile -File a.ps1' } }
    assert.equal(guarded.tool_call(legacy)?.block, true, 'pwsh 存在时拦截 PowerShell 5.1')
    unlinkSync(join(dir, 'pwsh.exe'))
    assert.equal(guarded.tool_call(legacy), undefined, '缓存仍说有 pwsh，但硬拒绝前强制重查发现已不存在，不再误拦')
  } finally {
    process.env.PATH = previousPath
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('shell-fallback: ok')
