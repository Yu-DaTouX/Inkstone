import assert from 'node:assert/strict'
import { allowedCommands, subagentCapabilityGuide } from '../resources/pi-extensions/subagent-guide.js'
import subagentGuideExtension from '../resources/pi-extensions/subagent-guide.js'
import { environmentGuide } from '../resources/pi-extensions/capability-guide.js'

assert.deepEqual(allowedCommands({ YAN_SUBAGENT_COMMANDS: 'danger.confirm, search.query,artifact.preview' }), ['danger.confirm', 'search.query', 'artifact.preview'], '读取宿主开放的命令清单')
assert.deepEqual(allowedCommands({}), [], '没有清单时为空')

const full = subagentCapabilityGuide(['danger.confirm', 'danger.prefs', 'search.query', 'search.fetch', 'search.docs', 'artifact.preview'])
assert.match(full, /yan search query/, '开放搜索时列出 search 用法')
assert.match(full, /yan artifact preview --path/, '开放预览时列出 artifact preview 用法')
assert.match(full, /browser, subagent, office/, '说明其他命令组在子代理里不可用')
assert.match(full, /resultFile/, '说明结果文件的读法')
const searchOnly = subagentCapabilityGuide(['danger.confirm', 'search.query', 'search.fetch', 'search.docs'])
assert.doesNotMatch(searchOnly, /artifact/, '没开放预览就不提预览')
assert.equal(subagentCapabilityGuide(['danger.confirm', 'danger.prefs']), '', '只有审批通道时不注入命令指南')

const day = new Date(2026, 10, 4)
assert.match(environmentGuide(day, 'win32', undefined, true), /run `pwsh`/, '装了 pwsh 时提示用 pwsh')
assert.doesNotMatch(environmentGuide(day, 'win32', undefined, false), /pwsh/, '没装 pwsh 时不提')
assert.doesNotMatch(environmentGuide(day, 'win32', 'powershell', true), /pwsh/, 'PowerShell 回退模式不追加 bash 下的 pwsh 提示')
assert.doesNotMatch(environmentGuide(day, 'darwin', undefined, true), /pwsh/, '非 Windows 不提')

const saved = process.env.YAN_SUBAGENT_COMMANDS
process.env.YAN_SUBAGENT_COMMANDS = 'danger.confirm,search.query,search.fetch,search.docs'
try {
  const handlers = {}
  subagentGuideExtension({ on: (name, fn) => { handlers[name] = fn } })
  const sections = {}
  assert.equal(handlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: { sections } }), undefined, '有分段时写入分段')
  assert.match(sections.inkstone_capabilities, /yan search/, '分段里有命令指南')
  assert.match(sections.inkstone_environment, /Today: \d{4}-\d{2}-\d{2}/, '分段里有环境说明')
  const appended = handlers.before_agent_start({ systemPrompt: 'base' })
  assert.ok(appended.systemPrompt.startsWith('base\n\n') && /yan search/.test(appended.systemPrompt) && /Today:/.test(appended.systemPrompt), '没有分段时追加到系统提示末尾')
} finally {
  if (saved === undefined) delete process.env.YAN_SUBAGENT_COMMANDS
  else process.env.YAN_SUBAGENT_COMMANDS = saved
}
console.log('subagent-guide: ok')
