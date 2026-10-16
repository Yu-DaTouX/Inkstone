export function runCommandRegistryTests(ok, registry) {
  const local = registry.localCommandDescriptors()
  ok(local.some((command) => command.name === 'new' && command.source === 'yan' && command.executable), 'Yan 本地 /new 始终注册')
  ok(local.some((command) => command.name === 'browser' && command.source === 'yan'), 'Yan 本地 /browser 始终注册')

  const panel = local.find((command) => command.name === 'panel')
  ok(!!panel, '/panel 仍在注册表里（不能删）')
  ok(panel?.source === 'compatibility' && panel?.executable === false, '/panel 仍是兼容项且不可执行')
  ok(panel?.hiddenInMenu === true, '/panel 在补全里被隐藏（S4）')
  ok(panel?.availability?.includes('任务计划'), '/panel 的说明指向内置任务计划（替用户说清为什么没动作）')
  ok(
    local.some((command) => command.name === 'footer' && command.source === 'compatibility'),
    '/footer 保留（本主题不迁移它，只统一失败反馈）'
  )

  const merged = registry.mergeCommandDescriptors([
    { name: '/skill:review', source: 'skill', description: 'review code', location: 'skills/review.md' },
    { name: 'hello', source: 'extension', module: 'demo-ext', executable: true },
    { name: 'footer', source: 'compatibility', executable: true }
  ])
  const skill = merged.find((command) => command.name === 'skill:review')
  const extension = merged.find((command) => command.name === 'hello')
  const footer = merged.find((command) => command.name === 'footer')
  ok(skill?.source === 'skill' && skill.executable && skill.module === 'skills/review.md', '技能命令保留来源与模块')
  ok(extension?.source === 'extension' && extension.executable, '扩展命令可执行')
  ok(footer?.source === 'compatibility' && footer.executable === false, '兼容命令强制标为不可执行')

  const duplicate = registry.mergeCommandDescriptors([{ name: 'new', source: 'yan', executable: true }])
  ok(duplicate.filter((command) => command.name === 'new').length === 1, '完全相同的本地重复命令只保留一条')
  const sameName = registry.mergeCommandDescriptors([{ name: 'new', source: 'pi', module: 'pi-core' }])
  ok(sameName.filter((command) => command.name === 'new').length === 2, '同名不同来源命令不被静默覆盖')

  const withRuntimePanel = registry.mergeCommandDescriptors([
    { name: 'panel', source: 'extension', module: 'user-ext', executable: true }
  ])
  const panels = withRuntimePanel.filter((command) => command.name === 'panel')
  ok(panels.length === 2, `同名 panel 两条并存（实际 ${panels.length}）`)
  const compatPanel = panels.find((command) => command.source === 'compatibility')
  ok(!!compatPanel && compatPanel.hiddenInMenu === true, '兼容那条仍被隐藏（补全里看不到）')
  ok(!!compatPanel && compatPanel.executable === false, '兼容那条永远不可执行（手打走到它就给反馈）')

  for (const name of ['settings', 'thinking', 'export', 'copy', 'name', 'session', 'clone']) {
    const command = local.find((item) => item.name === name)
    ok(command?.source === 'yan' && command.executable === true, `/${name} 在桌面端可执行`)
  }
  const nativeEntries = [
    ['tree', '/tree'],
    ['import', '/import <路径>'],
    ['reload', '/reload'],
    ['scoped-models', '/scoped-models'],
    ['trust', '/trust'],
    ['share', '/share']
  ]
  for (const [name, usage] of nativeEntries) {
    const command = local.find((item) => item.name === name)
    ok(command?.source === 'yan' && command.executable === true, `/${name} 是可执行的 yan 原生命令`)
    ok(command?.usage === usage, `/${name} 用法精确为 ${usage}`)
    ok(!!command?.description, `/${name} 有说明`)
    ok(
      !local.some((item) => item.name === name && item.source === 'compatibility'),
      `/${name} 不存在同名兼容项`
    )
  }

  for (const name of ['fork', 'resume', 'logout', 'hotkeys', 'changelog', 'bug', 'quit']) {
    const command = local.find((item) => item.name === name)
    ok(
      command?.source === 'compatibility' && command.executable === false && !!command.availability,
      `/${name} 登记为兼容项并说明桌面端入口`
    )
  }

  const withInternal = registry.mergeCommandDescriptors([
    { name: '__inkstone_native', source: 'extension', module: 'native-session-bridge', executable: true }
  ])
  ok(
    !withInternal.some((command) => command.name === '__inkstone_native'),
    '宿主桥内部命令被注册表过滤（不暴露给用户）'
  )
}
