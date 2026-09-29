/**
 * 子代理的「结局」说法与相关护栏：
 *   · 状态词：超时 / 调用用完 / 报错 / 停止 / 待合并要能分开，别都压成「失败」；
 *   · 结束通知：如实写结局，超时收尾的部分结论要提醒模型核对；
 *   · 任务输入的时间与调用预算：夹到范围内，不是数字就报错；
 *   · 别 sleep 轮询子代理：只认命令形状。
 */
export function runSubagentOutcomeTests(ok, { outcome, notice, brief, repeatGuard }) {
  const { subagentOutcome } = outcome
  const key = (run) => subagentOutcome({ review: 'none', ...run }).key

  ok(key({ status: 'starting' }) === 'starting' && subagentOutcome({ status: 'starting', review: 'none' }).live, '启动中算运行中一类')
  ok(key({ status: 'running' }) === 'running', '运行中')
  ok(key({ status: 'running', wrapUp: { reason: 'timeout', since: 1 } }) === 'wrapUp', '到点后正在收尾单独一个词')
  ok(key({ status: 'done', endReason: 'completed' }) === 'done', '正常完成')
  ok(key({ status: 'done', endReason: 'timeout' }) === 'timeout', '超时后收尾出结论：仍标超时，不冒充正常完成')
  ok(key({ status: 'error', endReason: 'timeout' }) === 'timeout', '超时被硬停：标超时而不是「失败」')
  ok(key({ status: 'error', endReason: 'budget' }) === 'budget', '调用用完被停：标调用用完')
  ok(key({ status: 'error', endReason: 'model-error' }) === 'failed', '模型报错：出错')
  ok(key({ status: 'error' }) === 'failed', '旧记录没有结束原因：按出错')
  ok(key({ status: 'cancelled', endReason: 'stopped' }) === 'stopped', '用户停止')
  ok(key({ status: 'done', review: 'pending' }) === 'review' && key({ status: 'done', review: 'conflict' }) === 'conflict', '有待处理的改动：待合并 / 冲突')
  ok(key({ status: 'done', endReason: 'timeout', review: 'pending' }) === 'review', '待合并优先于「超时」这个词（改动更需要人处理）')
  ok(subagentOutcome({ status: 'done', endReason: 'timeout', review: 'pending' }).partial, '但仍标出结论可能不完整')

  const rank = (run) => subagentOutcome({ review: 'none', ...run }).rank
  ok(rank({ status: 'running' }) < rank({ status: 'error' }) && rank({ status: 'error' }) < rank({ status: 'done' }), '排序：运行中 → 需要处理 → 已完成')
  ok(subagentOutcome({ status: 'done', review: 'none' }).attention === false, '顺利完成不占用注意力')

  /* ---- 结束通知 ---- */
  const base = { id: 'sub-1', task: '审查 IPC', isolation: 'controlled-cwd', review: 'none' }
  const text = (run) => notice.buildSubagentNotice({ ...base, ...run })
  const timedOutDone = text({ status: 'done', endReason: 'timeout', result: { summary: '已确认 A；B 没核实', summaryFrom: 'last-message' } })
  ok(/超时后已收尾/.test(timedOutDone) && /结论可能不完整/.test(timedOutDone), '通知写清是超时后收尾的')
  ok(/关键事实先自己核对/.test(timedOutDone), '部分结论提醒模型先核对')
  const hardStop = text({ status: 'error', endReason: 'timeout', error: '运行超时（超过 30 分钟）', result: { summary: '查了一半的发现', summaryFrom: 'last-message' } })
  ok(/超时被停止/.test(hardStop), '硬停的通知说超时被停止')
  ok(/摘要：查了一半的发现/.test(hardStop) && /原因：运行超时/.test(hardStop), '已产出的内容与原因分开写，不把中间结论标成「错误」')
  ok(!/失败：/.test(hardStop), '超时不写成「失败」')
  const failed = text({ status: 'error', endReason: 'model-error', error: '模型返回错误', result: { summary: '模型返回错误', summaryFrom: 'error' } })
  ok(/失败/.test(failed) && /错误：模型返回错误/.test(failed) && !/原因：/.test(failed), '纯错误只写一次')
  ok(/已完成/.test(text({ status: 'done', endReason: 'completed', result: { summary: '好了', summaryFrom: 'last-message' } })), '正常完成写已完成')
  const parsed = notice.parseSubagentNotice(timedOutDone)
  ok(parsed?.id === 'sub-1' && parsed.status === 'done', '通知格式仍可被解析（界面靠它显示成一行）')

  /* ---- 任务输入的限额 ---- */
  const parse = (raw) => brief.parseSubagentBrief(raw, '任务')
  const limited = parse({ goal: 'g', maxToolCalls: 1, timeoutMinutes: 999 })
  ok(limited.ok && limited.brief.maxToolCalls === brief.SUBAGENT_BRIEF_LIMITS.minToolCalls, '调用预算夹到下限')
  ok(limited.ok && limited.brief.timeoutMinutes === brief.SUBAGENT_BRIEF_LIMITS.maxTimeoutMinutes, '时长夹到上限')
  const fine = parse({ goal: 'g', maxToolCalls: '40', timeoutMinutes: 10 })
  ok(fine.ok && fine.brief.maxToolCalls === 40 && fine.brief.timeoutMinutes === 10, '数字字符串也接受（命令行传参是字符串）')
  ok(!('maxToolCalls' in parse({ goal: 'g' }).brief) && !('timeoutMinutes' in parse({ goal: 'g' }).brief), '不给就没有，不替调用方编')
  ok(parse({ goal: 'g', maxToolCalls: 'many' }).ok === false && parse({ goal: 'g', timeoutMinutes: -3 }).ok === false, '不是正数就报错')
  ok(/最多 40 次工具调用/.test(brief.briefPrompt(fine.brief, '任务')), '预算写进给子代理的提示')

  /* ---- 别 sleep 轮询 ---- */
  const { isSubagentPollLoop } = repeatGuard
  const poll = (command) => isSubagentPollLoop('bash', { command })
  ok(poll('for i in 1 2 3; do sleep 60; yan subagent list --json; done'), '拦：sleep 加 yan subagent list 的轮询')
  ok(poll('sleep 30 && yan subagent get --id sub-1'), '拦：sleep 后取转录')
  ok(poll('Start-Sleep -Seconds 30; yan subagent list'), '拦：PowerShell 的 Start-Sleep')
  ok(!poll('yan subagent list'), '单次查看不拦')
  ok(!poll('sleep 5 && npm test'), '与子代理无关的 sleep 不拦')
  ok(!isSubagentPollLoop('read', { command: 'sleep 5; yan subagent list' }), '只看 bash')
}
