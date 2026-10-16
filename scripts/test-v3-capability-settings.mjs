/**
 * v3「能力与插件」设置（S2）的局部检查。
 *
 * 只编译 `src/renderer/src/features/settings/capabilities/model.ts`（纯函数，
 * 无 React / store / DOM 依赖），在 Node 里跑；不启动 Electron、不碰 pi、不写用户
 * 数据、不联网、不调用模型。
 *
 * 另外做两项静态检查：组件确实导出 `CapabilitiesSettings`，且 `capabilities/index.ts`
 * 把它 re-export 出去（S0 按此懒加载挂载）。
 *
 *   node scripts/test-v3-capability-settings.mjs
 */
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

/* ── 技能来源归一 ───────────────────────────────────────────── */
assert.deepEqual(SKILL_ORIGIN_ORDER, ['session', 'user', 'bundled', 'other'])
assert.equal(skillOriginOf('session'), 'session')
assert.equal(skillOriginOf('user'), 'user')
assert.equal(skillOriginOf('bundled'), 'bundled')
assert.equal(skillOriginOf('other'), 'other')
assert.equal(skillOriginOf(undefined), 'other', '老快照缺 origin 归 other')
assert.equal(skillOriginOf('mystery'), 'other', '未知来源归 other，不假装随包')

/* ── 技能分组：固定顺序、去空组、组内保序 ───────────────────── */
const skill = (id, origin) => ({ id, title: id, description: '', origin })
const grouped = groupSkills([
  skill('a', 'other'),
  skill('b', 'session'),
  skill('c', 'bundled'),
  skill('d', 'session'),
  skill('e', 'user')
])
assert.deepEqual(
  grouped.map((g) => g.origin),
  ['session', 'user', 'bundled', 'other'],
  '分组顺序固定'
)
assert.deepEqual(grouped[0].skills.map((s) => s.id), ['b', 'd'], '组内保持输入顺序')
assert.deepEqual(groupSkills([]).length, 0, '全空不返回空组')
assert.deepEqual(groupSkills([skill('x', 'user')]).map((g) => g.origin), ['user'], '只出现非空组')

/* ── 提示词：只取 prompt 来源，hiddenInMenu 照留 ────────────── */
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

/* ── MCP 导入资格 ───────────────────────────────────────────── */
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
assert.equal(WINDOWS_MCP_SERVER_ID, 'windows-mcp')

/* ── MCP 状态色映射 ─────────────────────────────────────────── */
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

/* ── 市场分页区间 ───────────────────────────────────────────── */
assert.deepEqual(marketRange(0, 0), { from: 0, to: 0, safeOffset: 0 }, '空目录不显示 1–0')
assert.deepEqual(marketRange(10, 0, 24), { from: 1, to: 10, safeOffset: 0 })
assert.deepEqual(marketRange(100, 24, 24), { from: 25, to: 48, safeOffset: 24 })
assert.deepEqual(marketRange(100, 999, 24), { from: 97, to: 100, safeOffset: 96 }, 'offset 越界夹住')
assert.deepEqual(marketRange(-3, -5), { from: 0, to: 0, safeOffset: 0 }, '负数归零')

/* ── 静态出口检查：S0 能按约定挂载 ──────────────────────────── */
const componentSource = readFileSync(
  fileURLToPath(
    new URL('../src/renderer/src/features/settings/capabilities/CapabilitiesSettings.tsx', import.meta.url)
  ),
  'utf8'
)
assert.match(componentSource, /export function CapabilitiesSettings\(\): ReactElement/, 'CapabilitiesSettings 导出签名')

const barrelSource = readFileSync(
  fileURLToPath(
    new URL('../src/renderer/src/features/settings/capabilities/index.ts', import.meta.url)
  ),
  'utf8'
)
assert.match(barrelSource, /CapabilitiesSettings/, 'capabilities/index.ts re-export')

console.log('test-v3-capability-settings: ok')
