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

delete process.env.YAN_SHELL
console.log('shell-fallback: ok')
