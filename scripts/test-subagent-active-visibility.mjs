import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else delete globalThis[name]
}

function installRealConsumers(target, opened) {
  target.addEventListener('inkstone-agent-open', (event) => {
    const id = event.detail
    if (typeof id === 'string' && /^(hub|subagent):[A-Za-z0-9-]+$/.test(id)) opened.push(id)
  })
  target.addEventListener('inkstone-workspace-launch', (event) => {
    if (event.detail === 'agents') opened.push('agents')
  })
}

export async function runSubagentActiveVisibilityTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (condition, label) => { if (!condition) throw new Error(`✗ ${label}`) }

  const realReact = Object.getOwnPropertyDescriptor(globalThis, 'React')
  const realActiveStore = Object.getOwnPropertyDescriptor(globalThis, '__activeStore')
  const realActiveButton = Object.getOwnPropertyDescriptor(globalThis, '__activeButton')
  const realPanelStore = Object.getOwnPropertyDescriptor(globalThis, '__panelStore')
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

  const run = (id, extra = {}) => ({
    id,
    task: `task-${id}`,
    cwd: '/tmp/fixture',
    isolation: 'worktree',
    status: 'running',
    startedAt: 1,
    transcript: [],
    review: 'none',
    ...extra
  })

  const selectorDir = await mkdtemp(join(tmpdir(), 'yan-active-subagents-'))
  await mkdir('.tmp/subagent-active-visibility', { recursive: true })
  const componentDir = await mkdtemp(resolve('.tmp/subagent-active-visibility/run-'))
  try {
    const selectorOut = join(selectorDir, 'subagent-view.mjs')
    await build({
      entryPoints: ['src/renderer/src/state/subagent-view.ts'],
      outfile: selectorOut,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    })
    const { activeSubagentRuns, selectSubagentRuns, subagentScopeForView } = await import(pathToFileURL(selectorOut).href)

    const now = Date.now()
    const fixture = [
      run('live', { parentSessionId: 'S' }),
      run('starting', { parentSessionId: 'S', status: 'starting' }),
      run('wrapping', { parentSessionId: 'S', wrapUp: { reason: 'timeout', since: now } }),
      run('failed', { parentSessionId: 'S', status: 'error', review: 'none' }),
      run('timeout', { parentSessionId: 'S', status: 'error', endReason: 'timeout' }),
      run('budget', { parentSessionId: 'S', status: 'done', endReason: 'budget' }),
      run('review', { parentSessionId: 'S', status: 'done', review: 'pending', endedAt: now }),
      run('conflict', { parentSessionId: 'S', status: 'done', review: 'conflict', endedAt: now }),
      run('finished', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: now }),
      run('merged', { parentSessionId: 'S', status: 'done', review: 'merged', endedAt: now }),
      run('discarded', { parentSessionId: 'S', status: 'done', review: 'discarded', endedAt: now }),
      run('cancelled', { parentSessionId: 'S', status: 'cancelled', review: 'none', endedAt: now }),
      run('foreign', { parentSessionId: 'OTHER' }),
      run('orphan')
    ]
    const ids = activeSubagentRuns(fixture, { sessionIds: ['S'] }).map((r) => r.id)
    const has = (id) => ids.includes(id)

    check(has('live') && has('starting') && has('wrapping'), '运行中 / 启动中 / 收尾中的常驻')
    check(has('failed') && has('timeout') && has('budget') && has('review') && has('conflict'), '出错 / 超时 / 调用用完 / 待审阅 / 冲突的常驻')
    check(!has('finished') && !has('merged') && !has('discarded') && !has('cancelled'), '完成无需处理 / 已合并 / 已放弃 / 被停止的撤下')
    check(!has('foreign'), '别的会话的子代理不串进当前会话')
    check(!has('orphan'), '没有归属字段且不属于当前视图的旧记录不猜当前会话')

    const fallback = activeSubagentRuns(
      [run('legacy', { parentRunId: 'R1' }), run('other-run', { parentRunId: 'R2' })],
      { sessionIds: ['S'], runIds: ['R1'] }
    ).map((r) => r.id)
    check(fallback.includes('legacy'), '没有 parentSessionId 但 parentRunId 命中当前视图的运行实例 → 仍留下')
    check(!fallback.includes('other-run'), '挂在别的运行实例下的旧记录仍不猜当前视图')
    const sessionWins = selectSubagentRuns(
      [run('contradict', { parentSessionId: 'OTHER', parentRunId: 'R1' })],
      { sessionIds: ['S'], runIds: ['R1'] }
    )
    check(sessionWins.foreign.length === 1 && sessionWins.all.length === 0, '有 parentSessionId 时以它为准，parentRunId 兜底不改判')

    const deduped = activeSubagentRuns([
      run('dup', { parentSessionId: 'S', status: 'running' }),
      run('dup', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: now })
    ], { sessionIds: ['S'] })
    check(deduped.length === 0, '同一 runId 重复推送时以最后一次为准（已完成无需处理就撤下）')
    const revived = activeSubagentRuns([
      run('dup', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: now }),
      run('dup', { parentSessionId: 'S', status: 'running' })
    ], { sessionIds: ['S'] })
    check(revived.length === 1 && revived[0].status === 'running', '同一 runId 以最后一次（运行中）为准')

    const empty = activeSubagentRuns([], { sessionIds: ['S'] })
    check(empty.length === 0, '没有任务时选择器返回空数组')

    const chain = activeSubagentRuns([run('child', { parentSessionId: 'CHILD' })], { sessionIds: ['S', 'CHILD'] })
    check(chain.length === 1, '显式会话链里的任务算当前会话')

    const runnersAB = [
      { id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'C:\\proj\\a.jsonl' },
      { id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'c:/PROJ/b.jsonl' }
    ]
    const scopeB = subagentScopeForView({
      peekedSessionId: 'B',
      peekedPath: null,
      session: { sessionId: 'A', sessionFile: 'C:\\proj\\a.jsonl', conversationId: 'A-conv' },
      runners: runnersAB
    })
    check(scopeB.sessionIds.length === 1 && scopeB.sessionIds[0] === 'B', '后台查看 B 时归属只认 B，不并入活动 A 的 conversationId')
    check(scopeB.runIds?.length === 1 && scopeB.runIds[0] === 'rB', '旧记录的兜底实例取 B 的 runner，不是 active 的 A')

    const runsAB = [
      run('b-sid', { parentSessionId: 'B' }),
      run('b-legacy', { parentRunId: 'rB' }),
      run('a-sid', { parentSessionId: 'A' }),
      run('a-legacy', { parentRunId: 'rA' }),
      run('foreign', { parentSessionId: 'OTHER', parentRunId: 'rB' })
    ]
    const pickedB = selectSubagentRuns(runsAB, scopeB).all.map((r) => r.id)
    check(pickedB.includes('b-sid') && pickedB.includes('b-legacy'), 'B 的有 sid 与仅 parentRunId 的任务都归到当前视图')
    check(!pickedB.includes('a-sid') && !pickedB.includes('a-legacy'), 'A 的任务（含 legacy）不串进 B 视图')
    check(!pickedB.includes('foreign'), '有明确 parentSessionId 的 foreign 不会被 parentRunId 兜底拉进来')

    const scopeA = subagentScopeForView({ peekedSessionId: null, peekedPath: null, session: { sessionId: 'A', conversationId: 'A-conv' }, runners: runnersAB })
    check(scopeA.sessionIds.includes('A-conv'), '显示的就是当前会话时才并入 conversationId（同一显示 view）')

    const scopePath = subagentScopeForView({
      peekedSessionId: null,
      peekedPath: null,
      session: { sessionId: 'X', sessionFile: 'C:\\Proj\\B.jsonl\\' },
      runners: runnersAB
    })
    check(scopePath.runIds?.[0] === 'rB', '稳定路径命中视图实例（分隔符 / 大小写 / 尾斜杠不敏感）')

    const scopePending = subagentScopeForView({ peekedSessionId: null, peekedPath: 'C:/PROJ/B.jsonl', session: null, runners: runnersAB })
    check(scopePending.sessionIds.length === 0 && scopePending.runIds?.[0] === 'rB', '按路径预览（pending）时仍按路径找到视图实例')

    globalThis.React = { createElement, Fragment: undefined }
    globalThis.__activeStore = { subagents: [], session: null, runners: [] }
    globalThis.__activeButton = null

    const componentOut = join(componentDir, 'active-subagents.mjs')
    const stubs = {
      store: `export const useStore = (selector) => selector(globalThis.__activeStore);`,
      i18n: `export const useT = () => (key, vars) => { let s = 'T:' + key; if (vars && vars.n !== undefined) s += ':' + vars.n; return s; };`,
      ui: `const h = (...a) => globalThis.React.createElement(...a);
export const Button = ({ variant, size, children, ...rest }) => { globalThis.__activeButton = { ...rest, children }; return h('button', rest, children); };`
    }
    await build({
      entryPoints: ['src/renderer/src/components/chat/ActiveSubagents.tsx'],
      outfile: componentOut,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
      plugins: [{
        name: 'active-subagents-fixtures',
        setup(b) {
          const fixtures = [[/state\/store$/, 'store'], [/(^|\/)i18n$/, 'i18n'], [/(^|\/)ui$/, 'ui']]
          for (const [filter, name] of fixtures) b.onResolve({ filter }, () => ({ path: name, namespace: 'fixture' }))
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
        }
      }]
    })
    const { ActiveSubagents } = await import(pathToFileURL(componentOut).href)

    const panelOut = join(componentDir, 'subagent-panel.mjs')
    const panelStubs = {
      'subagent-pi-launch': `export const subagentModelError = () => '';`,
      'model-selection': `export const modelKey = (m) => m.provider + '/' + m.id;`,
      'turn-model-display': `export const resolveSubagentModelDisplay = () => ({ label: 'M' });`,
      ModelCatalog: `export const ModelCatalog = () => null;`,
      modalLayer: `export const useFocusTrap = () => {}; export const useModalLayer = () => ({ isTop: true });`,
      i18n: `export const useT = () => (key) => 'T:' + key;`,
      store: `export const useStore = (selector) => selector(globalThis.__panelStore);\nuseStore.getState = () => globalThis.__panelStore;`,
      AgentMessageStream: `const h = (...a) => globalThis.React.createElement(...a);\nexport const AgentMessageStream = ({ run }) => h('div', { 'data-run': run.id });`,
      SubagentPlan: `const h = (...a) => globalThis.React.createElement(...a);\nexport const SubagentPlan = ({ runs }) => h('div', { 'data-runs': runs.map((r) => r.id).join(',') });`,
      ui: `const h = (...a) => globalThis.React.createElement(...a);
export const Button = ({ children, ...rest }) => h('button', rest, children);
export const EmptyState = ({ title, children, ...rest }) => h('div', { ...rest, 'data-empty': title }, children);
export const Field = ({ children, ...rest }) => h('div', rest, children);
export const Select = ({ children, ...rest }) => h('select', rest, children);
export const Textarea = ({ children, ...rest }) => h('textarea', rest, children);`
    }
    await build({
      entryPoints: ['src/renderer/src/components/workbench/SubagentPanel.tsx'],
      outfile: panelOut,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
      plugins: [{
        name: 'subagent-panel-fixtures',
        setup(b) {
          const fixtures = [
            [/shared\/subagent-pi-launch$/, 'subagent-pi-launch'],
            [/shared\/model-selection$/, 'model-selection'],
            [/chat\/turn-model-display$/, 'turn-model-display'],
            [/(^|\/)ModelCatalog$/, 'ModelCatalog'],
            [/lib\/modalLayer$/, 'modalLayer'],
            [/(^|\/)i18n$/, 'i18n'],
            [/state\/store$/, 'store'],
            [/chat\/AgentMessageStream$/, 'AgentMessageStream'],
            [/(^|\/)SubagentPlan$/, 'SubagentPlan'],
            [/(^|\/)ui$/, 'ui']
          ]
          for (const [filter, name] of fixtures) b.onResolve({ filter }, () => ({ path: name, namespace: 'fixture' }))
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: panelStubs[args.path], loader: 'js' }))
        }
      }]
    })
    const { SubagentPanel } = await import(pathToFileURL(panelOut).href)

    const renderPanel = (store, initialRun) => {
      globalThis.__panelStore = {
        subagents: [], session: { sessionId: 'A', cwd: '/tmp' }, runners: [], models: [], settings: {},
        loadSubagents: () => {}, patchSettings: async () => {},
        ...store
      }
      const realError = console.error
      console.error = (...args) => { if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect')) return; realError(...args) }
      try {
        return renderToStaticMarkup(createElement(SubagentPanel, initialRun ? { initialRun } : {}))
      } finally {
        console.error = realError
      }
    }

    const render = (store) => {
      globalThis.__activeStore = { subagents: [], session: { sessionId: 'S' }, runners: [], ...store }
      globalThis.__activeButton = null
      return renderToStaticMarkup(createElement(ActiveSubagents))
    }

    for (const n of [0, 1, 3, 10]) {
      const runs = Array.from({ length: n }, (_, i) => run(`r${i}`, { parentSessionId: 'S' }))
      const html = render({ subagents: runs })
      check(!html.includes('subagent-group') && !html.includes('sg-card') && !html.includes('subagent-note-'), `${n} 个任务 DOM 里没有 SubagentGroup / 卡片`)
      if (n === 0) check(html === '', '没有任务时不占位')
      else check(html.includes('data-testid="active-subagents"') && html.includes('data-testid="active-subagents-view"'), `${n} 个任务仍只渲染一行概览与查看入口`)
    }

    const html = render({ subagents: fixture })
    check(html.includes('data-testid="active-subagents-summary"'), '出口带一行概览')
    check(html.includes('T:sa.tag') && html.includes('T:sa.viewInWorkspace'), '概览与查看入口复用既有翻译键，不写死中英文')
    check(html.includes('T:sa.group.live:3') && html.includes('T:sa.group.attention:5'), '概览计数来自选择器（3 运行中 · 5 需处理）')
    check(!html.includes('data-testid="active-subagents-toggle"') && !html.includes('hub.expand'), '不再有展开/收起卡片的旧入口')

    const foreign = render({ subagents: [run('foreign', { parentSessionId: 'OTHER' })] })
    check(foreign === '', '只有别的会话任务时不渲染常驻入口')
    const noSession = render({ subagents: [run('orphan')], session: null })
    check(noSession === '', '没有会话归属时不猜当前会话，不渲染')

    const deferred = render({
      peekedSessionId: 'V',
      peekedPath: null,
      session: { sessionId: 'S' },
      subagents: [run('old', { parentSessionId: 'S' }), run('viewed', { parentSessionId: 'V' })]
    })
    check(deferred.includes('data-testid="active-subagents"'), 'deferred 查看另一条会话时仍显示该视图的运行中任务')
    check(deferred.includes('T:sa.group.live:1'), '只统计正在显示的会话，不含原活动会话')
    const onlyOld = render({
      peekedSessionId: 'V',
      peekedPath: null,
      session: { sessionId: 'S' },
      subagents: [run('old', { parentSessionId: 'S' })]
    })
    check(onlyOld === '', 'peek 的视图没有任务时，原活动会话的任务不串进来')

    const legacyView = render({
      peekedSessionId: 'V',
      peekedPath: null,
      session: { sessionId: 'V' },
      runners: [{ id: 'rV', runId: 'rV', sessionId: 'V', generation: 1, cwd: '/tmp', running: true, waiting: false, failed: false, conn: 'ready', createdAt: 1, lastActiveAt: 1, isActive: true }],
      subagents: [run('legacy', { parentRunId: 'rV' })]
    })
    check(legacyView.includes('data-testid="active-subagents"'), '旧记录缺归属但挂在当前视图运行实例下 → 仍显示，不漏在跑任务')

    const runningNow = render({ subagents: [run('job', { parentSessionId: 'S' })] })
    check(runningNow.includes('data-testid="active-subagents"'), '运行中占位')
    const doneAfter = render({ subagents: [run('job', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: Date.now() })] })
    check(doneAfter === '', '运行中 → done（无需处理）后撤下')

    const target = new EventTarget()
    const opened = []
    installRealConsumers(target, opened)
    globalThis.window = target

    render({ subagents: [run('solo', { parentSessionId: 'S' })] })
    check(typeof globalThis.__activeButton?.onClick === 'function', '查看入口是可点击按钮')
    globalThis.__activeButton.onClick()
    check(opened.length === 1 && opened[0] === 'subagent:solo', '单一任务点击 → inkstone-agent-open 的 subagent:<id> 被真实消费方接收')

    opened.length = 0
    render({ subagents: [run('a', { parentSessionId: 'S' }), run('b', { parentSessionId: 'S' })] })
    globalThis.__activeButton.onClick()
    check(opened.length === 1 && opened[0] === 'agents', '多任务点击 → inkstone-workspace-launch 的 agents 打开既有面板总览')

    const runsViewB = [
      run('b-sid', { parentSessionId: 'B' }),
      run('b-legacy', { parentRunId: 'rB' }),
      run('a-sid', { parentSessionId: 'A' }),
      run('a-legacy', { parentRunId: 'rA' })
    ]
    const viewBStore = {
      peekedSessionId: 'B',
      peekedPath: null,
      session: { sessionId: 'A', conversationId: 'A-conv', cwd: '/tmp' },
      runners: runnersAB,
      subagents: runsViewB
    }
    const panelList = renderPanel(viewBStore)
    check(panelList.includes('data-runs="b-sid,b-legacy"'), '右侧面板列表：B 有 sid 与仅 parentRunId 的任务都列出')
    check(!panelList.includes('a-sid') && !panelList.includes('a-legacy'), '右侧面板列表：A 的任务（含 legacy）不串入')

    const panelDedup = renderPanel({
      peekedSessionId: 'B', peekedPath: null, session: null, runners: runnersAB,
      subagents: [
        run('b-dup', { parentSessionId: 'B' }),
        run('b-dup', { parentSessionId: 'B', status: 'done', review: 'none', endedAt: 2 }),
        run('b-legacy', { parentRunId: 'rB' })
      ]
    })
    check(panelDedup.includes('data-runs="b-dup,b-legacy"'), '面板对同一 runId 只列去重后的一份（不叠加旧列表两套状态）')

    const detailB = renderPanel(viewBStore, 'subagent:b-legacy')
    check(detailB.includes('data-run="b-legacy"') && !detailB.includes('data-empty'), '单行点击传入的 initialRun 在 B 视图面板里定位到详情')
    const detailMissing = renderPanel(viewBStore, 'subagent:a-legacy')
    check(detailMissing.includes('data-empty'), 'A 的旧任务在 B 视图面板里解析为缺失，不串入')

    const pendingPanel = renderPanel({
      peekedSessionId: null,
      peekedPath: 'C:/PROJ/B.jsonl',
      session: null,
      runners: runnersAB,
      subagents: [run('b-legacy', { parentRunId: 'rB' }), run('a-legacy', { parentRunId: 'rA' })]
    })
    check(pendingPanel.includes('data-runs="b-legacy"'), '按路径预览时面板仍按路径找到 B 实例并列出其旧记录')

    const eventStore = {
      peekedSessionId: 'B',
      peekedPath: null,
      session: { sessionId: 'A', conversationId: 'A-conv' },
      runners: runnersAB,
      subagents: [run('solo-b', { parentSessionId: 'B' })]
    }
    render(eventStore)
    opened.length = 0
    globalThis.__activeButton.onClick()
    check(opened[0] === 'subagent:solo-b', 'B 视图单一任务点击派发 subagent:<id>')
    check(renderPanel(eventStore, opened[0]).includes('data-run="solo-b"'), '派发的 run 在面板同一归属推导下能定位到详情')

    const multiViewStore = {
      peekedSessionId: 'B',
      peekedPath: null,
      session: { sessionId: 'A', conversationId: 'A-conv' },
      runners: runnersAB,
      subagents: [run('b1', { parentSessionId: 'B' }), run('b2', { parentSessionId: 'B' })]
    }
    render(multiViewStore)
    opened.length = 0
    globalThis.__activeButton.onClick()
    check(opened[0] === 'agents', 'B 视图多任务点击打开面板总览')
    check(renderPanel(multiViewStore).includes('data-runs="b1,b2"'), '多任务总览列出与常驻概览相同的本视图任务')
  } finally {
    restoreGlobal('React', realReact)
    restoreGlobal('__activeStore', realActiveStore)
    restoreGlobal('__activeButton', realActiveButton)
    restoreGlobal('__panelStore', realPanelStore)
    restoreGlobal('window', realWindow)
    await rm(selectorDir, { recursive: true, force: true })
    await rm(componentDir, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let passed = 0
  let failed = 0
  try {
    await runSubagentActiveVisibilityTests((condition, label) => {
      if (condition) {
        passed++
        console.log(`  ok  ${label}`)
      } else {
        failed++
        console.log(`  ✗ ${label}`)
      }
    })
    console.log(failed ? `\n✗ 常驻子代理区：失败 ${failed} 项` : `\n✓ 常驻子代理区：${passed} 项通过`)
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
