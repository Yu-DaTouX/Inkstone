/**
 * 工具卡「来源」判定（`src/shared/tool-origin.ts`）的纯测试。
 *
 * 为什么值得单测：这段逻辑的全部风险都在**边界**上 ——
 * 一条命令是不是真的调了 `yan tasks apply`，决定了界面上会不会出现
 * 「任务计划 · 砚内置」这个归属标签。判太松会把用户自己写的
 * `yarn tasks apply` 认成内置能力，判太紧则是迁移看起来没生效。
 *
 * ⚠️ 有一条**故意的**已知边界（见正例 6）：命令文本里只要出现
 *    这一串就会被标记。这是设计取舍：卡片仍然可展开看原文、
 *    写入是否真的发生由宿主权威决定，所以标签不是安全边界。
 */
export function runToolOriginTests(ok, origin) {
  const { taskPlanCommand, summarizeTaskPlanCommand } = origin

  console.log('\n--- 工具来源判定（任务计划）---')

  const bash = (command) => taskPlanCommand('bash', { command })

  /* ── 正例：真实会出现的写法 ── */
  ok(bash('yan tasks apply --request-file task-update.json') !== null, '标准写法被认出')
  ok(bash('yan.cmd tasks apply --request-file x.json') !== null, 'Windows 启动器 yan.cmd')
  ok(bash('yan.exe tasks apply') !== null, 'yan.exe 也算')
  ok(
    bash('"C:\\Users\\me\\AppData\\Local\\yan\\bin\\yan.cmd" tasks apply --request-file x.json') !== null,
    '带引号的绝对路径（打包态真实形态）'
  )
  ok(bash('/usr/local/bin/yan tasks apply --request-file x.json') !== null, 'POSIX 绝对路径')
  ok(bash('cd /repo && yan tasks apply --request-file x.json') !== null, '前面还有别的命令（&& 之后）')
  ok(bash('yan   tasks   apply') !== null, '多余空白不影响')
  ok(bash('YAN TASKS APPLY') !== null, '大小写不敏感')

  /* ── 反例：不能误报 ── */
  ok(bash('yarn tasks apply') === null, 'yarn 不是 yan（前置词必须整体以 yan 结尾）')
  ok(bash('yammer tasks apply') === null, 'yammer 不是 yan')
  ok(bash('yan tasks list') === null, '别的任务子命令不算')
  ok(bash('yan capabilities search --query-file q.json') === null, '能力查询不算任务计划')
  ok(bash('yan --help') === null, '看帮助不算')
  ok(bash('echo "tasks apply"') === null, '没有 yan 就不算')
  ok(taskPlanCommand('read', { path: 'yan tasks apply' }) === null, 'read 工具不是 bash（不看路径参数）')
  ok(taskPlanCommand('bash', {}) === null, '没有命令文本时不算')
  ok(taskPlanCommand('bash', null) === null, '参数为 null 时不算')
  ok(taskPlanCommand(undefined, { command: 'yan tasks apply' }) === null, '工具名缺失时不算')
  ok(bash('yan tasks applying') === null, 'apply 后面接别的词不算（词边界）')
  ok(bash('git commit -m "yan tasks apply"') !== null, '⚠️ 已知边界：文本里含这串就会被标记')

  /* ── 兼容写法：不同工具名 ── */
  ok(taskPlanCommand('shell', { command: 'yan tasks apply' }) !== null, 'shell 别名')
  ok(taskPlanCommand('run', { cmd: 'yan tasks apply' }) !== null, 'cmd 参数名')
  ok(taskPlanCommand('exec', { script: 'yan tasks apply' }) !== null, 'script 参数名')

  /* ── 摘要：一行、限长，完整原文留给展开详情 ── */
  ok(summarizeTaskPlanCommand('yan tasks\n  apply') === 'yan tasks apply', '换行折叠成空格')
  const long = `yan tasks apply --request-file ${'a'.repeat(300)}.json`
  const sum = summarizeTaskPlanCommand(long)
  ok(sum.length === 120, `超长截断到 120 字符（实际 ${sum.length}）`)
  ok(sum.endsWith('…'), '截断有明确省略号（不是静默切掉）')
  ok(summarizeTaskPlanCommand('  ') === '', '全空白→空串（卡片会退回「无参数」）')
}
