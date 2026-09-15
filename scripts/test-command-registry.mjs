/** N18 命令注册表的纯测试，不启动 Electron、不连接 pi。 */
export function runCommandRegistryTests(ok, registry) {
  const local = registry.localCommandDescriptors()
  ok(local.some((command) => command.name === 'new' && command.source === 'yan' && command.executable), 'Yan 本地 /new 始终注册')
  ok(local.some((command) => command.name === 'browser' && command.source === 'yan'), 'Yan 本地 /browser 始终注册')

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
}

