import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const modelPath = fileURLToPath(
  new URL('../src/renderer/src/features/settings/capabilities/model.ts', import.meta.url)
)

const result = await build({
  entryPoints: [modelPath],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const {
  SKILL_ORIGIN_ORDER,
  WINDOWS_MCP_SERVER_ID,
  canImportMcp,
  groupSkills,
  marketRange,
  mcpStatusTone,
  promptCommands,
  skillOriginOf,
  verificationTone
} = mod

assert.deepEqual(SKILL_ORIGIN_ORDER, ['session', 'user', 'pi', 'other'])
assert.equal(skillOriginOf('session'), 'session')
assert.equal(skillOriginOf('user'), 'user')
assert.equal(skillOriginOf('pi'), 'pi')
assert.equal(skillOriginOf('bundled'), 'bundled')
assert.equal(skillOriginOf('other'), 'other')
assert.equal(skillOriginOf(undefined), 'other', '老快照缺 origin 归 other')
assert.equal(skillOriginOf('mystery'), 'other', '未知来源归 other，不假装随包')

const skill = (id, origin) => ({ id, title: id, description: '', origin })
const grouped = groupSkills([
  skill('a', 'other'),
  skill('b', 'session'),
  skill('c', 'bundled'),
  skill('d', 'session'),
  skill('e', 'user'),
  skill('f', 'pi')
])
assert.deepEqual(
  grouped.map((g) => g.origin),
  ['session', 'user', 'pi', 'other'],
  '分组顺序固定，随包技能不列出'
)
assert.deepEqual(grouped[0].skills.map((s) => s.id), ['b', 'd'], '组内保持输入顺序')
assert.deepEqual(groupSkills([]).length, 0, '全空不返回空组')
assert.deepEqual(groupSkills([skill('x', 'user')]).map((g) => g.origin), ['user'], '只出现非空组')

const command = (name, source, extra = {}) => ({ name, source, executable: true, ...extra })
const prompts = promptCommands([
  command('a', 'pi'),
  command('b', 'prompt'),
  command('c', 'prompt', { hiddenInMenu: true }),
  command('d', 'skill'),
  command('e', 'yan')
])
assert.deepEqual(prompts.map((p) => p.name), ['b', 'c'])
assert.deepEqual(promptCommands([]), [])

const server = (over = {}) => ({
  id: 'srv',
  title: 'srv',
  transport: 'stdio',
  enabled: true,
  effect: 'read',
  projectScoped: false,
  status: 'disconnected',
  toolCount: null,
  ...over
})
assert.equal(canImportMcp(server()), true)
assert.equal(canImportMcp(server({ migratedToNative: { at: 'x', targetPath: 'y' } })), false, '已迁移不重复导入')
assert.equal(canImportMcp(server({ enabled: false })), false, '停用不导入')
assert.equal(canImportMcp(server({ id: WINDOWS_MCP_SERVER_ID })), false, 'windows-mcp 保留在砚里')
assert.equal(canImportMcp(server({ ownedBy: 'inkstone' })), false, '砚托管服务改用「切换」流程，不直接导入')
assert.equal(canImportMcp(server({ ownedBy: 'pi' })), true, 'pi 原生服务仍可导入')
assert.equal(WINDOWS_MCP_SERVER_ID, 'windows-mcp')

assert.equal(mcpStatusTone('ready'), 'run')
assert.equal(mcpStatusTone('connecting'), 'accent')
assert.equal(mcpStatusTone('needs-auth'), 'ask')
assert.equal(mcpStatusTone('error'), 'fail')
assert.equal(mcpStatusTone('disconnected'), 'neutral', '未连接不是失败')

assert.equal(verificationTone('ready'), 'run')
assert.equal(verificationTone('connecting'), 'accent')
assert.equal(verificationTone('error'), 'fail')
assert.equal(verificationTone('cancelled'), 'neutral')
assert.equal(verificationTone('stale'), 'neutral', 'stale 既非成功也非失败')

assert.deepEqual(marketRange(0, 0), { from: 0, to: 0, safeOffset: 0 }, '空目录不显示 1–0')
assert.deepEqual(marketRange(10, 0, 24), { from: 1, to: 10, safeOffset: 0 })
assert.deepEqual(marketRange(100, 24, 24), { from: 25, to: 48, safeOffset: 24 })
assert.deepEqual(marketRange(100, 999, 24), { from: 97, to: 100, safeOffset: 96 }, 'offset 越界夹住')
assert.deepEqual(marketRange(-3, -5), { from: 0, to: 0, safeOffset: 0 }, '负数归零')

const componentSource = readFileSync(
  fileURLToPath(
    new URL('../src/renderer/src/features/settings/capabilities/CapabilitiesSettings.tsx', import.meta.url)
  ),
  'utf8'
)
assert.match(
  componentSource,
  /export function CapabilitiesSettings\(\{ tab, onTabChange \}: CapabilitiesSettingsProps\): ReactElement/,
  'CapabilitiesSettings 导出签名：子页由导航受控'
)

const barrelSource = readFileSync(
  fileURLToPath(
    new URL('../src/renderer/src/features/settings/capabilities/index.ts', import.meta.url)
  ),
  'utf8'
)
assert.match(barrelSource, /CapabilitiesSettings/, 'capabilities/index.ts re-export')

const marketSource = readFileSync(
  fileURLToPath(
    new URL('../src/renderer/src/features/settings/capabilities/MarketSection.tsx', import.meta.url)
  ),
  'utf8'
)
assert.doesNotMatch(marketSource, /browser\.open\(/, '插件市场不用应用内浏览器：设置弹层会挡住它')
assert.match(marketSource, /browser\.openExternal\('https:\/\/pi\.dev\/packages'\)/, '「目录」走系统外链打开')

console.log('test-v3-capability-settings: ok')
