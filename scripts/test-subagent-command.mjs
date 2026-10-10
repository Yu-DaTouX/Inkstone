/** `/subagent` 参数路由的纯测试，不启动 Electron、不启动 pi。 */
export function runSubagentCommandTests(ok, parseSubagentCommand) {
  const current = parseSubagentCommand('/subagent 检查项目')
  ok(current?.task === '检查项目' && current.isolation === 'shared-cwd', '普通子代理任务默认在当前文件夹执行')

  const prefix = parseSubagentCommand('/subagent --read-only 检查项目')
  ok(prefix?.task === '检查项目' && prefix.isolation === 'controlled-cwd', '前置 --read-only 进入受控只读目录')

  const suffix = parseSubagentCommand('/subagent 检查项目 --read-only')
  ok(suffix?.task === '检查项目' && suffix.isolation === 'controlled-cwd', '文案约定的尾置 --read-only 进入受控只读目录')

  const middle = parseSubagentCommand('/subagent 检查项目 --READ-ONLY 然后汇总')
  ok(
    middle?.task === '检查项目 然后汇总' && middle.isolation === 'controlled-cwd',
    '只读开关大小写不敏感且不会吞掉任务其它内容'
  )

  const empty = parseSubagentCommand('/subagent --read-only')
  ok(empty?.task === '' && empty.isolation === 'controlled-cwd', '只有只读开关时返回空任务而不启动进程')

  ok(parseSubagentCommand('/subagentish 检查项目') === null, '相似命令名不会误路由到子代理')
}

