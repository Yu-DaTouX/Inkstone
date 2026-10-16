/**
 * v3 设置「快捷键」分区（WP-25b 余项）的局部检查。
 *
 * 只做不启动 Electron / 不读用户设置 / 不调模型的事：
 *   1. 用 esbuild 编译纯逻辑（改绑 / 冲突 / 恢复默认 / 清洗 / 覆盖应用），在 Node 里断言；
 *   2. 静态检查分区源码仍复用注册表的纯函数、能录制与恢复、没有引入 v2 旧设置组件。
 *
 * 可独立执行：node scripts/test-v3-settings-shortcuts.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))

async function loadTs(rel) {
  const result = await build({
    entryPoints: [here(rel)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

/* ── 1. 改绑纯逻辑（复用 app/shortcuts.ts 的签名判定） ───────── */
const bindings = await loadTs('../src/renderer/src/features/settings/shortcuts/bindings.ts')
const shortcuts = await loadTs('../src/renderer/src/app/shortcuts.ts')
const {
  EMPTY_SHORTCUT_OVERRIDES,
  applyShortcutOverrides,
  bindingFromKeyStroke,
  clearShortcutOverrides,
  effectiveKeys,
  rebindShortcut
} = bindings
const { SHORTCUTS, findShortcutConflicts, sanitizeShortcutOverrides, shortcutOverridesFromSettings } = shortcuts

const stroke = (over = {}) => ({ key: 'a', ctrl: false, meta: false, alt: false, shift: false, ...over })

assert.deepEqual(bindingFromKeyStroke(stroke({ key: 'b', ctrl: true, alt: true })), ['Ctrl', 'Alt', 'B'])
assert.deepEqual(bindingFromKeyStroke(stroke({ key: 'B', meta: true })), ['Ctrl', 'B'], 'Cmd 归一为 Ctrl（对齐注册表）')
assert.deepEqual(bindingFromKeyStroke(stroke({ key: '/', ctrl: true })), ['Ctrl', '/'])
assert.deepEqual(bindingFromKeyStroke(stroke({ key: 'ArrowLeft', alt: true })), ['Alt', '←'], '方向键用显示记号')
assert.deepEqual(bindingFromKeyStroke(stroke({ key: ' ' })), ['Space'], '空格收成 Space 记号')
assert.deepEqual(bindingFromKeyStroke(stroke({ key: 'F8' })), ['F8'], '功能键不带修饰的也算一个键位')
assert.equal(bindingFromKeyStroke(stroke({ key: 'Control', ctrl: true })), null, '只按修饰键不算键位')
assert.equal(bindingFromKeyStroke(stroke({ key: 'k', ctrl: true, composing: true })), null, 'IME 组字中不收键')
assert.equal(bindingFromKeyStroke(stroke({ key: 'k', ctrl: true, altGraph: true })), null, 'AltGr 不收键')

/* ── 2. 可改项集合：终端让键保持固定，其余可改 ─────────────── */
const rebindable = SHORTCUTS.filter((def) => def.rebindable).map((def) => def.id)
assert.deepEqual(
  rebindable,
  ['newSession', 'toggleWorkspace', 'openSettings', 'shortcutSheet', 'goBack', 'stopRun', 'openTerminal',
    'workspaceTab1', 'workspaceTab2', 'workspaceTab3', 'workspaceTab4', 'workspaceTab5', 'workspaceTab6'],
  '非终端让键、未由宿主注册的项可改'
)
for (const def of SHORTCUTS.filter((def) => def.terminalsYield)) {
  assert.equal(def.rebindable, false, `${def.id} 是终端让键，保持固定`)
}

assert.deepEqual(applyShortcutOverrides(EMPTY_SHORTCUT_OVERRIDES).map((def) => def.id), SHORTCUTS.map((def) => def.id))
assert.deepEqual(
  effectiveKeys(SHORTCUTS.find((def) => def.id === 'openRuns'), EMPTY_SHORTCUT_OVERRIDES),
  ['Ctrl', 'J'],
  '无覆盖时用注册表默认'
)
const overridden = applyShortcutOverrides({ openRuns: ['Ctrl', 'Alt', 'J'] })
assert.deepEqual(
  effectiveKeys(overridden.find((def) => def.id === 'openRuns'), { openRuns: ['Ctrl', 'Alt', 'J'] }),
  ['Ctrl', 'Alt', 'J'],
  '有覆盖时用覆盖'
)
assert.deepEqual(
  SHORTCUTS.find((def) => def.id === 'openRuns').keys,
  ['Ctrl', 'J'],
  'applyShortcutOverrides 不改动原注册表'
)

/* ── 3. 改绑校验：空 / 固定 / 缺修饰 / 冲突 ─────────────────── */
assert.deepEqual(rebindShortcut('newSession', [], {}), { ok: false, reason: 'empty' }, '空键位拒绝')
assert.deepEqual(
  rebindShortcut('toggleSidebar', ['Ctrl', 'Alt', 'Y'], {}),
  { ok: false, reason: 'fixed' },
  '终端让键不可改'
)
assert.deepEqual(rebindShortcut('newSession', ['A'], {}), { ok: false, reason: 'unmodified' }, '单字母缺修饰键拒绝')
assert.deepEqual(rebindShortcut('newSession', ['←'], {}), { ok: false, reason: 'unmodified' }, '单方向键缺修饰键拒绝')
const functionKey = rebindShortcut('newSession', ['F8'], {})
assert.equal(functionKey.ok, true, 'F8 这类功能键允许单独绑定')

const clash = rebindShortcut('newSession', ['Ctrl', 'K'], {})
assert.equal(clash.ok, false)
assert.equal(clash.reason, 'conflict')
assert.equal(clash.conflictId, 'commandPalette', '与已有 Ctrl+K 冲突并指出冲突项')
const clashByOrder = rebindShortcut('newSession', ['Alt', 'Ctrl', 'B'], {})
assert.equal(clashByOrder.conflictId, 'toggleWorkspace', '修饰键顺序不同也算同一键位')
const conflictWithOverride = rebindShortcut('newSession', ['Ctrl', 'Alt', 'N'], { openRuns: ['Alt', 'Ctrl', 'N'] })
assert.equal(conflictWithOverride.ok, false)
assert.equal(conflictWithOverride.conflictId, 'openRuns', '改绑要对照其它项的覆盖值')

const free = rebindShortcut('newSession', ['Ctrl', 'Alt', 'N'], {})
assert.equal(free.ok, true)
assert.deepEqual(free.overrides, { newSession: ['Ctrl', 'Alt', 'N'] })

/* ── 4. 清洗：只收已知可改项、非空字符串数组 ───────────────── */
assert.deepEqual(sanitizeShortcutOverrides(undefined), {})
assert.deepEqual(sanitizeShortcutOverrides('nope'), {})
assert.deepEqual(
  sanitizeShortcutOverrides({
    newSession: ['Ctrl', 'Alt', 'N'],
    toggleSidebar: ['Ctrl', 'Alt', 'T'],
    bogus: ['X'],
    goBack: [],
    openSettings: ['Ctrl', ',', 7]
  }),
  { newSession: ['Ctrl', 'Alt', 'N'] },
  '固定项 / 未知项 / 空或含脏值的都丢掉'
)
assert.deepEqual(
  shortcutOverridesFromSettings({ shortcutOverrides: { newSession: ['Ctrl', 'Alt', 'N'] } }),
  { newSession: ['Ctrl', 'Alt', 'N'] },
  '从设置形状读取覆盖'
)
assert.deepEqual(shortcutOverridesFromSettings(null), {}, '拿不到设置时是空覆盖')

/* ── 5. 恢复默认 ───────────────────────────────────────────── */
assert.deepEqual(clearShortcutOverrides({}, 'openRuns'), {}, '没有覆盖时保持原样')
assert.deepEqual(clearShortcutOverrides({ openRuns: ['Ctrl', 'Alt', 'J'] }, 'openRuns'), {}, '只清一项')
assert.deepEqual(clearShortcutOverrides({ openRuns: ['Ctrl', 'Alt', 'J'] }), {}, '不传 id 清全部')

assert.deepEqual(findShortcutConflicts(SHORTCUTS), [], '默认注册表没有重复键位')
assert.equal(findShortcutConflicts(applyShortcutOverrides({ newSession: ['Ctrl', 'K'] })).length, 1, '覆盖造成的重复能被抓出')

/* ── 6. 文案两语齐全且占位符一致 ───────────────────────────── */
const shortcutsTextMod = await loadTs('../src/renderer/src/features/settings/shortcuts/shortcuts-text.ts')
const zh = shortcutsTextMod.shortcutsText('zh-CN')
const en = shortcutsTextMod.shortcutsText('en-US')
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英文案键一一对应')
for (const key of ['note', 'recording', 'restoreDefault', 'restoreAll', 'conflictWith', 'needModifier']) {
  assert.ok(zh[key] && en[key], `文案键 ${key} 中英都有值`)
}
assert.ok(zh.conflictWith.includes('{name}') && en.conflictWith.includes('{name}'), '冲突文案保留 {name} 占位符')
assert.ok(zh.conflictFound.includes('{list}') && en.conflictFound.includes('{list}'), '总冲突文案保留 {list} 占位符')

/* ── 7. 分区源码契约（静态） ───────────────────────────────── */
const section = readFileSync(here('../src/renderer/src/features/settings/shortcuts/ShortcutsSettings.tsx'), 'utf8')
assert.ok(section.includes('shortcutOverridesFromSettings'), '分区从设置读取并清洗覆盖')
assert.ok(section.includes('applyShortcutOverrides'), '分区经改绑纯函数取生效键位')
assert.ok(section.includes('findShortcutConflicts'), '分区复用注册表的冲突检测纯函数')
assert.ok(section.includes('bindingFromKeyStroke') && section.includes('rebindShortcut'), '分区用纯函数录制与校验')
assert.ok(section.includes('clearShortcutOverrides'), '分区能恢复默认')
assert.ok(section.includes('patchSettings'), '分区把覆盖写回设置')
assert.ok(section.includes('v3-shortcuts-settings'), '分区有稳定测试 id')
assert.ok(section.includes('v3-shortcut-record-') && section.includes('v3-shortcut-reset-all'), '分区有录制与全部重置入口')
assert.ok(section.includes("from '../../../ui'") && section.includes('Kbd') && section.includes('Button'), '键位与操作都用 ui/ 控件')
assert.ok(!section.includes('components/settings'), '分区不引入 v2 旧设置组件')

const types = readFileSync(here('../src/renderer/src/features/settings/types.ts'), 'utf8')
assert.ok(types.includes("'shortcuts'"), '分区 id 加入 SettingsSectionId')
assert.ok(types.includes("id: 'shortcuts'"), '分区加入导航清单')

const root = readFileSync(here('../src/renderer/src/features/settings/root/SettingsPage.tsx'), 'utf8')
assert.ok(root.includes('ShortcutsSettings'), '根页挂载快捷键分区')
assert.ok(root.includes('v3-settings-nav-${entry.id}'), '导航仍用统一测试 id')

console.log('v3 设置快捷键分区：改绑 / 冲突 / 清洗 / 恢复默认 / 可改集合 / 文案 / 源码契约检查通过')
