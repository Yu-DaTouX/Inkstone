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

const shell = read('features/sidebar/Sidebar.tsx')
assert.ok(shell.includes('T3SidebarShell'), '左栏外壳应挂载 T3 侧栏')
assert.ok(!shell.includes('useStore('), '左栏外壳不再自己订阅 store')
assert.ok(!shell.includes('useRunsV3('), '左栏外壳不再自己订阅运行态')

const sidebar = read('t3/shell/T3SidebarShell.tsx')
assert.ok(sidebar.includes('const renderRow = useCallback('), '行渲染回调保持稳定引用')
assert.ok(sidebar.includes('const rowView = useCallback('), '行视图组装保持稳定引用')
assert.ok(sidebar.replace(/\r\n/g, '\n').includes('settledRemaining === 0\n                  ? undefined'), '归档书架剩余为 0 时不渲染「更多」')
assert.ok(sidebar.includes('String(Math.min(settledRemaining, SHELF_PAGE_SIZE))'), '「更多」只报告一页的数量')
assert.ok(sidebar.includes('void sidebarActions.remove(ref)'), 'Delete 键删除走带撤销的删除')

const row = read('t3/components/sidebar/SidebarThreadRow.tsx')
assert.ok(row.includes('memo(function SidebarThreadRow('), '会话行保持 memo')
assert.ok(row.includes('event.key === "F2"'), 'F2 进入重命名')
assert.ok(row.includes('event.key === "Delete" && onDelete'), 'Delete 删除')
assert.ok(row.includes('event.key !== "Enter" && event.key !== " "'), 'Enter / 空格打开')

const tree = read('t3/lib/sidebarTree.ts')
for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight']) {
  assert.ok(tree.includes(key), `树键盘要处理 ${key}`)
}
assert.ok(tree.includes('setTabIndex(row, row === selected ? 0 : -1)'), '树只保留一个 Tab 停靠点')

const motion = read('t3/components/Sidebar.motion.ts')
assert.ok(motion.includes("duration: 150"), '位移动效 150ms')
assert.ok(motion.includes("easing: 'ease-out'"), '位移动效 ease-out')
assert.ok(motion.includes("document.documentElement.dataset.reduceMotion === 'true'"), '应用内减少动效要生效')
assert.ok(motion.includes("matchMedia('(prefers-reduced-motion: reduce)')"), '系统减少动效要生效')
assert.ok(motion.includes('!reduceMotionRequested(parent)'), '减少动效时不播位移')
assert.ok(motion.includes('MAX_FADED_ROWS_PER_UPDATE'), '单次更新限制淡入淡出数量')
assert.ok(motion.includes('cloneNode(true)'), '离开的行用克隆节点淡出')
assert.ok(motion.includes('opacity: 0, transform: `translateY(${travel}px)`'), '进入的行从下方淡入')

const list = read('t3/components/Sidebar.tsx')
assert.ok(list.includes('createSidebarListMotion('), '列表挂载进入离开动效')
assert.ok(list.includes('listMotionRef.current?.update(dragState === null)'), '拖拽期间暂停列表动效')
assert.ok(list.includes('listMotionRef.current?.release()'), '拖拽结束后补播位移')
assert.ok(list.includes('motion.dispose()'), '卸载时清理动效')

const menu = read('features/sidebar/SessionMenu.tsx')
assert.ok(menu.includes('{open ? <SessionMenuContent'))
assert.ok(menu.includes('const [confirmDelete, setConfirmDelete] = useState(false)'))
assert.ok(menu.includes('const [customSnooze, setCustomSnooze] = useState(false)'))
assert.ok(menu.indexOf('<CustomSnoozeDialog') > menu.indexOf(': null}'))
assert.ok(menu.includes('open={customSnooze && dialogReady}'))
assert.ok(menu.includes('isOpen={confirmDelete && dialogReady}'))
assert.ok(menu.includes("document.querySelector('.ui-popover') ? 0 : idle + 1"), '对话框在旧菜单层级卸载后打开')
assert.ok(menu.includes("querySelector<HTMLElement>('.v3-row')?.focus()"), '对话框关闭回收至仍存在的行')
const shellV3 = read('app/ShellV3.tsx')
assert.equal(shellV3.split('new ResizeObserver(() => measure.schedule())').length - 1, 2, '壳层两处布局测量都走帧合并')
const settings = read('app/SettingsPanelV3.tsx')
assert.ok(settings.includes('requestIdleCallback'))
assert.ok(settings.includes('lazy(loadSettings)'), '空闲预载与打开共用同一分块')
console.log('sidebar-motion: 通过（订阅稳定性、左栏外壳边界、行键盘、列表进入离开与减少动效、菜单与懒加载契约）')
