import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { createSidebarRunsSelector } = await load('src/renderer/src/features/sidebar/sidebar-runs.ts')
const select = createSidebarRunsSelector()
const run = { runId: 'r1', sessionId: 's1', sessionPath: 'a.jsonl', startedAt: 1, code: 'A1', model: { provider: 'fake', id: 'model', label: 'Fake' }, phase: { kind: 'running', since: 1 }, progress: { tools: 0 } }
let selected = select({ runs: [run] })
assert.equal(select({ runs: [{ ...run, phase: { ...run.phase }, model: { ...run.model }, progress: { tools: 40 } }] }), selected, '工具进度不使侧栏订阅失效')
let source = run
const change = (patch, label) => {
  source = { ...source, ...patch }
  const next = select({ runs: [source] })
  assert.notEqual(next, selected, label)
  selected = next
}
change({ phase: { kind: 'needs-you' } }, '审批状态要更新')
change({ phase: { kind: 'done', seen: false } }, '完成未读要更新')
change({ phase: { kind: 'done', seen: true } }, '已读要更新')
change({ sessionId: 's2' }, '归属会话要更新')
change({ sessionPath: 'b.jsonl' }, '文件归属要更新')
change({ code: 'B2' }, '编号要更新')
change({ model: { ...source.model, label: 'New' } }, '模型标签要更新')
change({ model: { ...source.model, provider: 'other' } }, '模型品牌要更新')
change({ startedAt: 2 }, '最新运行排序要更新')
assert.deepEqual(select({ runs: [] }), [], '删除运行不能留旧行状态')
assert.equal(select({ runs: [] }), select({ runs: [] }), '空列表引用稳定')
const two = select({ runs: [run, { ...run, runId: 'r2' }] })
const reordered = select({ runs: [{ ...run, runId: 'r2' }, run] })
assert.notEqual(two, reordered)
assert.equal(reordered[0], two[1], '重排序复用未变运行')

const read = (name) => readFileSync('src/renderer/src/' + name, 'utf8')
const sidebar = read('features/sidebar/Sidebar.tsx')
assert.ok(!sidebar.includes('useStore((s) => s.session)'))
assert.ok(!sidebar.includes('useRunsV3((s) => s.runs)'))
assert.ok(sidebar.includes('useRunsV3(selectRuns)'))
assert.ok(sidebar.includes('const openSession = useCallback('))
const row = read('features/sidebar/SidebarRow.tsx')
assert.ok(row.includes('memo(function SidebarRow('))
assert.ok(row.includes('onOpen(item)'))
for (const name of ['Sidebar.tsx', 'FlatSessions.tsx', 'ArchiveShelf.tsx', 'SnoozeShelf.tsx']) {
  assert.ok(!read('features/sidebar/' + name).includes('onOpen={() =>'), name + ' 不能重新创建行回调')
}
assert.ok(read('features/sidebar/FlatSessions.tsx').includes('card={card}'))
const menu = read('features/sidebar/SessionMenu.tsx')
assert.ok(menu.includes('{open ? <SessionMenuContent'))
assert.ok(menu.includes('const [confirmDelete, setConfirmDelete] = useState(false)'))
assert.ok(menu.includes('const [customSnooze, setCustomSnooze] = useState(false)'))
assert.ok(menu.indexOf('<CustomSnoozeDialog') > menu.indexOf(': null}'))
assert.ok(!menu.includes('formatSnoozeWake'))
assert.ok(menu.includes('open={customSnooze && dialogReady}'))
assert.ok(menu.includes('isOpen={confirmDelete && dialogReady}'))
assert.ok(menu.includes("document.querySelector('.ui-popover') ? 0 : idle + 1"), '对话框在旧菜单层级卸载后打开')
assert.ok(menu.includes("querySelector<HTMLElement>('.v3-row')?.focus()"), '对话框关闭回收至仍存在的行')
const shell = read('app/ShellV3.tsx')
assert.equal(shell.split('new ResizeObserver(() => measure.schedule())').length - 1, 2, '壳层两处布局测量都走帧合并')
const settings = read('app/SettingsPanelV3.tsx')
assert.ok(settings.includes('requestIdleCallback'))
assert.ok(settings.includes('lazy(loadSettings)'), '空闲预载与打开共用同一分块')
console.log('sidebar-motion: 通过（订阅稳定性、状态失效、挂载边界、焦点与懒加载契约）')
