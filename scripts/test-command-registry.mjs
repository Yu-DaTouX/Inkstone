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

  /*
   * pi 终端内置命令必须被登记：RPC 的 get_commands 不报内置命令，
   * 漏登记的名字会被当成普通消息发给模型。
   */
  for (const name of ['settings', 'thinking', 'export', 'copy', 'name', 'session', 'clone']) {
    const command = local.find((item) => item.name === name)
    ok(command?.source === 'yan' && command.executable === true, `/${name} 在桌面端可执行`)
  }
  /*
   * pi 原生会话命令（`native-session-host.ts` 的动作）已从「仅兼容显示」升级为
   * **正式可执行的 yan 命令**：由主进程绑定当前会话后调用 pi 原生能力，不再
   * 只是给一句说明。这里按各自实际入口精确断言（含参数），不允许
   * 「native / compatibility 任意一条都行」的宽泛放行。
   *
   * 保留的安全边界：
   *   · 六条都先命中桌面端原生会话宿主（`nativeSession`），由宿主把请求绑定到
   *     当前会话并校验空闲/归属；
   *   · `/tree` 只做分支导航（桥侧 `navigateTree` 固定 `summarize:false`，不偷偷
   *     发起模型摘要）；`/import` 必须带路径参数；`/share` 上传前需人工确认；
   *   · `/scoped-models` `/trust` 只写 pi 官方格式文件；`/reload` 以完成后回执为准。
   * 每条都不得同时保留一条 compatibility 同名项，否则手打可能命中只给说明的那条。
   */
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

  /* 桌面端没有对应界面的终端命令仍是兼容项，必须说明真实入口。 */
  for (const name of ['fork', 'resume', 'logout', 'hotkeys', 'changelog', 'bug', 'quit']) {
    const command = local.find((item) => item.name === name)
    ok(
      command?.source === 'compatibility' && command.executable === false && !!command.availability,
      `/${name} 登记为兼容项并说明桌面端入口`
    )
  }

  /*
   * 宿主桥内部命令不能出现在用户命令表里：它不是给用户执行的入口，
   * runtime 侧报上来也要被过滤（宿主归属保护）。否则手打会绕过
   * `agent.ts` 对 `/__inkstone_native` 的发送拦截。
   */
  const withInternal = registry.mergeCommandDescriptors([
    { name: '__inkstone_native', source: 'extension', module: 'native-session-bridge', executable: true }
  ])
  ok(
    !withInternal.some((command) => command.name === '__inkstone_native'),
    '宿主桥内部命令被注册表过滤（不暴露给用户）'
  )
}
