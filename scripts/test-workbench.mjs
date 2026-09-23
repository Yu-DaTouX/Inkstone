/** 工作窗口状态模型测试（实施-11 H-3a：布局与资源契约）。 */
export async function runWorkbenchTests(ok) {
  const {
    activateWorkbenchTab,
    activeWorkbenchView,
    closeWorkbenchTab,
    defaultWorkbenchState,
    isCurrentWorkbenchOpen,
    isFixedView,
    newWorkbenchOpenRequest,
    normalizeWorkbenchState,
    pickWorkbenchState,
    reconcileWorkbench,
    resourceTabId,
    viewFromWorkbench,
    workbenchSessionKey
  } = await import('../out/test/workbench.mjs')

  console.log('\n--- H-3a 工作窗口状态模型 ---')
  const initial = defaultWorkbenchState()
  ok(initial.version === 2, '默认状态是当前版本 2')
  ok(initial.activeTabId === 'start', '新会话从开始页起')
  ok(initial.tabs.some((t) => t.id === 'start') && initial.tabs.some((t) => t.id === 'tools'), '开始/工具是固定导航页')
  ok(workbenchSessionKey('C:/a/session.jsonl', 'sid') === 'C:/a/session.jsonl', '优先使用稳定会话文件作为布局身份')
  ok(workbenchSessionKey(undefined, 'sid') === 'sid', '没有文件时回退到 sessionId')
  ok(workbenchSessionKey(undefined, undefined) === 'pending', '都没有时用临时身份 pending')

  /* ---- 资源身份与 kind 分离 ---- */
  const browser = activateWorkbenchTab(initial, 'browser')
  const file = activateWorkbenchTab(browser, 'file', 'C:/a/README.md')
  ok(file.activeTabId === 'file:C:/a/README.md', '文件资源生成稳定标签 id')
  ok(file.tabs.length === 4, '开始 / 工具 / 浏览器 / 文件标签可并存')
  ok(activeWorkbenchView(file) === 'file', '活动渲染 kind 由活动标签决定')
  ok(resourceTabId('file', 'C:/x/README.md') !== resourceTabId('file', 'C:/y/README.md'), '同名不同根文件不会撞 id')
  const agent1 = activateWorkbenchTab(file, 'subagent', 'run-1')
  const agent2 = activateWorkbenchTab(agent1, 'subagent', 'run-2')
  ok(agent2.tabs.filter((t) => t.kind === 'subagent').length === 2, '两个子代理是两个不同资源')
  ok(agent2.activeTabId === 'subagent:run-2', '激活第二个子代理只改活动标签')
  ok(isFixedView('tools') && isFixedView('start') && !isFixedView('file'), '固定导航页不可当资源关闭')

  ok(viewFromWorkbench(file, new Set(['tools', 'browser', 'file'])) === 'file', '可用资源恢复活动页')
  ok(viewFromWorkbench(file, new Set(['tools'])) === 'tools', '资源未恢复时回退工具而不伪造页面')

  /* ---- 关闭活动 / 非活动标签 ---- */
  const closeInactive = closeWorkbenchTab(agent2, 'file:C:/a/README.md')
  ok(closeInactive.activeTabId === 'subagent:run-2', '关闭非活动标签不动活动页')
  ok(!closeInactive.tabs.some((t) => t.id === 'file:C:/a/README.md'), '关闭非活动标签只释放自身')
  const closeActive = closeWorkbenchTab(agent2, 'subagent:run-2')
  ok(closeActive.activeTabId === 'subagent:run-1', '关闭活动标签回到顺序里的前一个资源')
  const closeOnly = closeWorkbenchTab(activateWorkbenchTab(initial, 'browser'), 'browser')
  ok(closeOnly.activeTabId === 'start', '关闭最后一个资源回到开始页')
  const closeFixed = closeWorkbenchTab(initial, 'tools')
  ok(closeFixed.tabs.length === 2 && closeFixed.activeTabId === 'start', '关闭固定页是 no-op（不动固定导航）')

  /* ---- 版本迁移：只认 1 / 2，未知版本保留宽度/展开、资源回固定页 ---- */
  const v1 = normalizeWorkbenchState({
    version: 1,
    activeTabId: 'browser',
    tabs: [{ id: 'tools', kind: 'tools' }, { id: 'browser', kind: 'browser' }],
    width: 420,
    expanded: false
  })
  ok(v1.version === 2 && v1.activeTabId === 'browser' && v1.width === 420 && v1.expanded === false, 'v1 可恢复资源与宽度/展开并升级到 v2')

  const future = normalizeWorkbenchState({ version: 99, activeTabId: 'gone', tabs: [{ id: 'unknown', kind: 'nope' }, { id: 'tools', kind: 'tools' }], width: -1 })
  ok(future.version === 2 && future.activeTabId === 'start' && future.tabs.length === 2, '未来版本只保留两个固定页，读不懂的资源丢弃')
  ok(future.width === 0, '非法宽度不进入布局状态')
  const futureKeep = normalizeWorkbenchState({ version: 8, width: 300, expanded: false, tabs: [{ id: 'x', kind: 'browser' }] })
  ok(futureKeep.width === 300 && futureKeep.expanded === false && futureKeep.activeTabId === 'start', '未知版本保留宽度/展开但不保留资源')

  const dup = normalizeWorkbenchState({ version: 2, activeTabId: 'a', tabs: [{ id: 'a', kind: 'browser' }, { id: 'a', kind: 'browser' }] })
  ok(dup.tabs.filter((t) => t.id === 'a').length === 1, '重复 id 只保留一份')

  /* ---- 临时会话布局只被一个真实会话采用一次 ---- */
  const pendingMap = { pending: { version: 2, activeTabId: 'browser', tabs: [{ id: 'tools', kind: 'tools' }, { id: 'browser', kind: 'browser' }], width: 500, expanded: true } }
  const firstUse = pickWorkbenchState(pendingMap, 'C:/a/session.jsonl')
  ok(firstUse.consumedPending && firstUse.state.activeTabId === 'browser', '第一个真实会话采用临时布局')
  const ownSaved = pickWorkbenchState({ ...pendingMap, 'C:/a/session.jsonl': { version: 2, activeTabId: 'tools', tabs: [{ id: 'tools', kind: 'tools' }], width: 100 } }, 'C:/a/session.jsonl')
  ok(!ownSaved.consumedPending && ownSaved.state.width === 100, '已有自己布局的会话不进临时布局')
  const secondUse = pickWorkbenchState(pendingMap, 'C:/b/session.jsonl')
  ok(secondUse.consumedPending, '第二个会话也只会看到同一份临时布局（由调用方消费后删除）')

  /* ---- 异步打开守卫 ---- */
  const req = newWorkbenchOpenRequest('C:/a/session.jsonl', 4)
  ok(req.requestId === 5 && req.sessionKey === 'C:/a/session.jsonl', '打开请求带序号与会话身份')
  ok(isCurrentWorkbenchOpen(req, 'C:/a/session.jsonl', 5), '身份与序号都当前时允许写状态')
  ok(!isCurrentWorkbenchOpen(req, 'C:/b/session.jsonl', 5), '切了会话后迟到返回不写状态')
  ok(!isCurrentWorkbenchOpen(req, 'C:/a/session.jsonl', 6), '又发了新请求后旧返回作废')
  ok(!isCurrentWorkbenchOpen(null, 'C:/a/session.jsonl', 5), '没有在途请求时不写')

  /* ---- 载入时对不可用资源逃逸 ---- */
  const reconciled = reconcileWorkbench(agent2, new Set(['tools']))
  ok(reconciled.activeTabId === 'tools', '载入时活动资源不可用且开始页不可用时对到工具页')
  const reconciledHome = reconcileWorkbench(agent2, new Set(['start', 'tools']))
  ok(reconciledHome.activeTabId === 'start', '载入时活动资源不可用优先回开始页')
  const kept = reconcileWorkbench(file, new Set(['tools', 'file']))
  ok(kept.activeTabId === 'file:C:/a/README.md', '活动资源可用时保持不动')
}
