/**
 * 没有 Git Bash 时 bash 工具换成 PowerShell（resources/pi-extensions/shell-fallback.js），
 * 以及计划档对 powershell 的放行形状（work-mode.js 只认宿主 CLI，其余一律挡）。
 */
import assert from 'node:assert/strict'
import shellFallback from '../resources/pi-extensions/shell-fallback.js'

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

/* 没设环境变量：什么都不做，不碰工具表 */
delete process.env.YAN_SHELL
const idle = fakePi(['read', 'bash', 'edit', 'write'])
shellFallback(idle)
assert.equal(idle.hasHandler('before_agent_start'), false, '有 bash 时不注册任何钩子')

/* 设了：bash 换成 powershell，其余保持顺序 */
process.env.YAN_SHELL = 'powershell'
const pi = fakePi(['read', 'bash', 'edit', 'write'])
shellFallback(pi)
pi.fire('before_agent_start')
assert.deepEqual(pi.applied, ['read', 'edit', 'write', 'powershell'])

/* 已经是 powershell：不重复设置 */
const done = fakePi(['read', 'edit', 'write', 'powershell'])
shellFallback(done)
done.fire('before_agent_start')
assert.equal(done.applied, null)

/* 对象形态的工具名也认 */
const objects = fakePi([{ name: 'read' }, { name: 'bash' }])
shellFallback(objects)
objects.fire('before_agent_start')
assert.deepEqual(objects.applied, ['read', 'powershell'])

delete process.env.YAN_SHELL
console.log('shell-fallback: ok')
