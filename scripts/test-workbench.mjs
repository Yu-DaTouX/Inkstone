/** 工作窗口状态模型测试（实施-11 H-3）。 */
export async function runWorkbenchTests(ok) {
  const {
    activateWorkbenchTab,
    closeWorkbenchTab,
    defaultWorkbenchState,
    normalizeWorkbenchState,
    viewFromWorkbench,
    workbenchSessionKey
  } = await import('../out/test/workbench.mjs')

  console.log('\n--- H-3 工作窗口状态模型 ---')
  const initial = defaultWorkbenchState()
  ok(initial.version === 1, '默认状态带版本号')
  ok(initial.activeTabId === 'tools', '默认活动页是工具')
  ok(workbenchSessionKey('C:/a/session.jsonl', 'sid') === 'C:/a/session.jsonl', '优先使用稳定会话文件作为布局身份')
  ok(workbenchSessionKey(undefined, 'sid') === 'sid', '没有文件时回退到 sessionId')

  const browser = activateWorkbenchTab(initial, 'browser')
  const file = activateWorkbenchTab(browser, 'file', 'C:/a/README.md')
  ok(file.activeTabId === 'file:C:/a/README.md', '文件资源生成稳定标签 id')
  ok(file.tabs.length === 3, '工具 / 浏览器 / 文件标签可并存')
  ok(viewFromWorkbench(file, new Set(['tools', 'browser', 'file'])) === 'file', '可用资源恢复活动页')
  ok(viewFromWorkbench(file, new Set(['tools'])) === 'tools', '资源未恢复时回退工具而不伪造页面')

  const closed = closeWorkbenchTab(file, 'file:C:/a/README.md')
  ok(closed.activeTabId === 'browser', '关闭活动文档回到上一个可用标签')
  ok(closed.tabs.every((tab) => tab.id !== 'file:C:/a/README.md'), '关闭文档只释放自身标签')

  const migrated = normalizeWorkbenchState({ version: 99, activeTabId: 'gone', tabs: [{ id: 'unknown', kind: 'nope' }, { id: 'tools', kind: 'tools' }], width: -1 })
  ok(migrated.version === 1 && migrated.activeTabId === 'tools', '未知版本 / 标签安全回退')
  ok(migrated.width === 0, '非法宽度不进入布局状态')
}
