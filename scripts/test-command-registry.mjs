/** N18 命令注册表的纯测试，不启动 Electron、不连接 pi。 */
export function runCommandRegistryTests(ok, registry) {
  const local = registry.localCommandDescriptors()
  ok(local.some((command) => command.name === 'new' && command.source === 'yan' && command.executable), 'Yan 本地 /new 始终注册')
  ok(local.some((command) => command.name === 'browser' && command.source === 'yan'), 'Yan 本地 /browser 始终注册')

  /*
   * 实施-02 S4：`/panel` 从补全里隐藏，但**不能从注册表里删掉**。
   * 删了之后，若 pi（用户扩展）也报了同名命令，手打 `/panel` 就会命中
   * 那条可执行的，消息被当成命令发出去 —— 这是本片明确要防的倒退。
   */
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

  /*
   * 同名 runtime 命令（S4）：用户扩展也注册了 `panel` 时，
   * 兼容项必须还在、且仍然 hiddenInMenu —— 界面的兼容分支靠 source 判定，
   * 所以「补全里看不到那条不可执行的」与「实际执行的那条不是它」两者不冲突。
   */
  const withRuntimePanel = registry.mergeCommandDescriptors([
    { name: 'panel', source: 'extension', module: 'user-ext', executable: true }
  ])
  const panels = withRuntimePanel.filter((command) => command.name === 'panel')
  ok(panels.length === 2, `同名 panel 两条并存（实际 ${panels.length}）`)
  const compatPanel = panels.find((command) => command.source === 'compatibility')
  ok(!!compatPanel && compatPanel.hiddenInMenu === true, '兼容那条仍被隐藏（补全里看不到）')
  ok(!!compatPanel && compatPanel.executable === false, '兼容那条永远不可执行（手打走到它就给反馈）')
}

