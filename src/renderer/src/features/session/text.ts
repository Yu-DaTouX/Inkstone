import { useI18n } from '../../i18n'

export type SessionTextKey =
  | 'visual'
  | 'imageProgress'
  | 'subagent'
  | 'toolDetail'
  | 'outputMore'
  | 'outputLess'
  | 'moreItems'
  | 'placeholder'
  | 'subagentOpen'
  | 'subagentDetails'
  | 'subagentScopeWorktree'
  | 'subagentScopeReadOnly'
  | 'subagentScopeShared'
  | 'subagentScopeFork'
  | 'subagentReviewPending'
  | 'subagentResize'
  | 'subagentSources'
  | 'subagentArtifacts'
  | 'subagentCount'
  | 'subagentLiveCount'
  | 'subagentDoneCount'
  | 'subagentFailedCount'
  | 'subagentStoppedCount'
  | 'subagentAllDone'
  | 'subagentListLabel'
  | 'subagentShowMore'
  | 'subagentShowLess'
  | 'subagentCalls'
  | 'subagentPrev'
  | 'subagentNext'
  | 'subagentRetried'
  | 'subagentResumed'
  | 'subagentNotRetried'
  | 'subagentOpenPane'
  | 'subagentBrief'
  | 'subagentGone'
  | 'compactionTitle'
  | 'branchFrom'
  | 'errorTitleRetryable'
  | 'errorTitleQuotaUsage'
  | 'errorTitleQuotaRate'
  | 'errorWaitQuota'
  | 'errorQuotaWindowFull'
  | 'errorTitleAuth'
  | 'errorTitleContext'
  | 'errorTitleAborted'
  | 'errorTitleRefused'
  | 'errorTitleRequest'
  | 'errorRetry'
  | 'errorModel'
  | 'errorCompact'
  | 'runRead1'
  | 'runRead'
  | 'runEdit1'
  | 'runEdit'
  | 'runCreate1'
  | 'runCreate'
  | 'runDelete1'
  | 'runDelete'
  | 'runSearch1'
  | 'runSearch'
  | 'runList1'
  | 'runList'
  | 'runFetch1'
  | 'runFetch'
  | 'runWeb1'
  | 'runWeb'
  | 'runCommand1'
  | 'runCommand'
  | 'runAgent1'
  | 'runAgent'
  | 'runTodo'
  | 'runOther1'
  | 'runOther'
  | 'runFileRead'
  | 'runFileEdit'
  | 'runFileCreate'
  | 'runFileDelete'
  | 'runFile'
  | 'runFileReads'
  | 'runAnd'
  | 'runSep'
  | 'runJoin'
  | 'runFailed'
  | 'runNeedsApproval'
  | 'runRepeat'
  | 'runChangedFiles'
  | 'stepRead'
  | 'stepReadRunning'
  | 'stepReadFailed'
  | 'stepRan'
  | 'stepRunning'
  | 'stepRunFailed'
  | 'stepEdited'
  | 'stepEditing'
  | 'stepEditFailed'
  | 'stepCreated'
  | 'stepCreating'
  | 'stepWriteFailed'
  | 'stepSearched'
  | 'stepSearching'
  | 'stepSearchFailed'
  | 'stepListed'
  | 'stepListing'
  | 'stepListFailed'
  | 'stepWebSearched'
  | 'stepWebSearching'
  | 'stepWebSearchFailed'
  | 'stepTodo'
  | 'stepTodoItems'
  | 'stepReadDenied'
  | 'stepRunDenied'
  | 'stepEditDenied'
  | 'stepWriteDenied'
  | 'stepSearchDenied'
  | 'stepListDenied'
  | 'stepWebSearchDenied'
  | 'errViewDetails'
  | 'errStatus'
  | 'errRecoveredStatus'
  | 'errCopyDetails'
  | 'workStopping'
  | 'workWaiting'
  | 'workRetry'
  | 'workRetryWait'
  | 'workSending'
  | 'workWorking'
  | 'workTool'
  | 'workResponding'
  | 'workThinking'
  | 'workActive'
  | 'workThought'
  | 'workTokens'
  | 'msgCopy'
  | 'msgCopied'
  | 'msgCopyFailed'
  | 'msgEdit'
  | 'msgEditTip'
  | 'msgRewind'
  | 'msgFork'
  | 'msgActions'
  | 'menuCode'
  | 'menuLink'
  | 'menuCopyCode'
  | 'menuInsertCode'
  | 'menuOpenLink'
  | 'menuOpenExternal'
  | 'menuCopyLink'
  | 'menuPreviewFile'
  | 'menuRevealFile'
  | 'menuCopyPath'
  | 'approvalCwd'
  | 'questionLabel'
  | 'questionPending'
  | 'questionSkipped'
  | 'questionFailed'
  | 'questionAnswered'
  | 'awaitAnswer'
  | 'awaitApproval'
  | 'awaitAction'
  | 'questionAnswer'
  | 'approvalAllowedOnce'
  | 'approvalAllowedSession'
  | 'approvalAllowedRemember'
  | 'approvalDenied'
  | 'approvalDeniedReason'
  | 'processThinking1'
  | 'processThinking'
  | 'processActions1'
  | 'processActions'
  | 'processCommands1'
  | 'processCommands'
  | 'processReads1'
  | 'processReads'
  | 'processEditFile'
  | 'processEdits'
  | 'processCreateFile'
  | 'processCreates'
  | 'processSearch1'
  | 'processSearch'
  | 'processList1'
  | 'processList'
  | 'processWeb1'
  | 'processWeb'
  | 'processFetch1'
  | 'processFetch'
  | 'processAgent1'
  | 'processAgent'
  | 'processOther1'
  | 'processOther'
  | 'processKindJoin'
  | 'processViewChanges'
  | 'turnOrdinal'
  | 'tallyCommand'
  | 'tallyRead'
  | 'tallyEdit'
  | 'tallyCreate'
  | 'tallyDelete'
  | 'tallySearch'
  | 'tallyList'
  | 'tallyFetch'
  | 'tallyWeb'
  | 'tallyAgent'
  | 'tallyTodo'
  | 'processEdits1'
  | 'processCreates1'
  | 'processMoreSteps'
  | 'decisionReplied'
  | 'decisionYourReply'
  | 'decisionOutcome'
  | 'decisionRunning'
  | 'decisionFailed'
  | 'decisionStopped'
  | 'questionChosen'
  | 'questionFreeAnswer'
  | 'questionMore'
  | 'thinkingEmptyRecord'
  | 'thinkingUnavailable'
  | 'asideStacked'
  | 'detailArgs'
  | 'stepRunningMark'
  | 'stepDoneMark'
  | 'testSummary'
  | 'stepOverwrote'
  | 'stepLines'
  | 'stepLinesFrom'
  | 'stepMcpServer'
  | 'stepFailedMark'
  | 'outputEarlier'
  | 'outputTruncated'
  | 'outputTruncatedPath'
  | 'outputLinesOf'
  | 'outputMoreInFile'
  | 'exitCode'
  | 'contentLines'
  | 'contentMore'
  | 'contentLess'
  | 'yanSearch'
  | 'yanSearchResults'
  | 'detailOutput'
  | 'wrapUpLabel'
  | 'wrapUpDismiss'
  | 'wrapUpDone'
  | 'wrapUpDecide'
  | 'browserHandoffTitle'
  | 'browserHandoffReason'
  | 'browserHandoffHint'
  | 'browserHandoffDone'
  | 'browserHandoffShow'
  | 'browserHandoffMessage'

const ZH: Record<SessionTextKey, string> = {
  visual: '结构化图块（{lang}）暂不支持在这里渲染。',
  imageProgress: '生图进度暂不支持在这里显示。',
  subagent: '子 Agent 卡片暂不支持在这里显示。',
  toolDetail: '差异与终端详情将在右侧面板打开；这里先显示已记录的命令与输出。',
  outputMore: '展开全部输出（{n} 行）',
  outputLess: '收起输出',
  moreItems: '另外 {n} 项',
  placeholder: '此内容暂未在 v3 渲染。',
  subagentOpen: '并排打开（未迁移）',
  subagentDetails: '摘要',
  subagentScopeWorktree: '工作树',
  subagentScopeReadOnly: '只读',
  subagentScopeShared: '共享目录',
  subagentScopeFork: 'fork · 继承当前对话',
  subagentReviewPending: '待审查',
  subagentResize: '调整大小',
  subagentSources: '来源',
  subagentArtifacts: '成果',
  subagentCount: '{n} 个子 Agent',
  subagentLiveCount: '{n} 进行中',
  subagentDoneCount: '{n} 完成',
  subagentFailedCount: '{n} 失败',
  subagentStoppedCount: '{n} 已停止',
  subagentAllDone: '全部完成',
  subagentListLabel: '子 Agent 列表',
  subagentShowMore: '再显示 {n} 个',
  subagentShowLess: '收起',
  subagentCalls: '{n} 次',
  subagentPrev: '上一个子 Agent',
  subagentNext: '下一个子 Agent',
  subagentRetried: '已自动重试 {n} 次',
  subagentResumed: '已自动续跑 1 次',
  subagentNotRetried: '未自动重试',
  subagentOpenPane: '在工作区打开转录',
  subagentBrief: '简报',
  subagentGone: '任务已经结束，无需停止',
  compactionTitle: '上下文已压缩',
  branchFrom: '从「{text}」分出去',
  errorTitleRetryable: '模型侧错误',
  errorTitleQuotaUsage: '额度已用完',
  errorTitleQuotaRate: '请求被限流',
  errorWaitQuota: '恢复后自动续跑',
  errorQuotaWindowFull: '用量面板显示额度窗口已满，这次限流来自额度用尽，不是请求太快。',
  errorTitleAuth: '认证或权限失败',
  errorTitleContext: '上下文超限',
  errorTitleAborted: '本轮已取消',
  errorTitleRefused: '服务商拦截',
  errorTitleRequest: '模型或参数不受支持',
  errorRetry: '重试',
  errorModel: '换模型',
  errorCompact: '压缩上下文',
  runRead1: '读取 1 个文件',
  runRead: '读取 {n} 个文件',
  runEdit1: '编辑 1 个文件',
  runEdit: '编辑 {n} 个文件',
  runCreate1: '新建 1 个文件',
  runCreate: '新建 {n} 个文件',
  runDelete1: '删除 1 个文件',
  runDelete: '删除 {n} 个文件',
  runSearch1: '搜索 1 次',
  runSearch: '搜索 {n} 次',
  runList1: '查看 1 个目录',
  runList: '查看 {n} 个目录',
  runFetch1: '打开 1 个网页',
  runFetch: '打开 {n} 个网页',
  runWeb1: '联网搜索 1 次',
  runWeb: '联网搜索 {n} 次',
  runCommand1: '运行 1 条命令',
  runCommand: '运行 {n} 条命令',
  runAgent1: '派出 1 个子 Agent',
  runAgent: '派出 {n} 个子 Agent',
  runTodo: '更新待办',
  runOther1: '调用 {name}',
  runOther: '调用 {name} {n} 次',
  runFileRead: '读取',
  runFileEdit: '编辑',
  runFileCreate: '新建',
  runFileDelete: '删除',
  runFile: '{verbs} {file}',
  runFileReads: '{verbs} {file}（{n} 次）',
  runAnd: '{a}并{b}',
  runSep: '、',
  runJoin: '，',
  runFailed: '（{n} 个失败）',
  runNeedsApproval: '需要审批',
  runRepeat: '×{n}',
  runChangedFiles: '改动 {n} 个文件',
  stepRead: '读取',
  stepReadRunning: '正在读取',
  stepReadFailed: '读取失败',
  stepRan: '运行',
  stepRunning: '正在运行',
  stepRunFailed: '运行失败',
  stepEdited: '编辑',
  stepEditing: '正在编辑',
  stepEditFailed: '编辑失败',
  stepCreated: '新建',
  stepCreating: '正在写入',
  stepWriteFailed: '写入失败',
  stepSearched: '搜索',
  stepSearching: '正在搜索',
  stepSearchFailed: '搜索失败',
  stepListed: '列出',
  stepListing: '正在列出',
  stepListFailed: '列出失败',
  stepWebSearched: '联网搜索',
  stepWebSearching: '正在联网搜索',
  stepWebSearchFailed: '联网搜索失败',
  stepTodo: '更新待办',
  stepTodoItems: '{n} 项',
  stepReadDenied: '已拒绝读取',
  stepRunDenied: '已拒绝运行',
  stepEditDenied: '已拒绝编辑',
  stepWriteDenied: '已拒绝写入',
  stepSearchDenied: '已拒绝搜索',
  stepListDenied: '已拒绝列出',
  stepWebSearchDenied: '已拒绝联网搜索',
  errViewDetails: '查看详情',
  errStatus: '出错',
  errRecoveredStatus: '已恢复',
  errCopyDetails: '复制详情',
  workStopping: '正在停止…',
  workWaiting: '等你处理',
  workRetry: '重试中（{n}/{m}）',
  workRetryWait: '{s} 秒后重试（{n}/{m}）',
  workSending: '正在发送…',
  workWorking: '处理中…',
  workTool: '正在执行工具…',
  workResponding: '正在作答…',
  workThinking: '思考中…',
  workActive: '进行中',
  workThought: '已思考 {n} 秒',
  workTokens: '{n} token',
  msgCopy: '复制',
  msgCopied: '已复制',
  msgCopyFailed: '复制失败',
  msgEdit: '编辑',
  msgEditTip: '把这条消息放回输入框修改后再发',
  msgRewind: '回退',
  msgFork: '分叉',
  msgActions: '消息操作',
  menuCode: '代码块',
  menuLink: '链接',
  menuCopyCode: '复制代码',
  menuInsertCode: '插入到输入框',
  menuOpenLink: '打开链接',
  menuOpenExternal: '在系统浏览器打开',
  menuCopyLink: '复制链接',
  menuPreviewFile: '预览文件',
  menuRevealFile: '在文件夹中显示',
  menuCopyPath: '复制路径',
  approvalCwd: '工作目录：{cwd}',
  questionLabel: '提问',
  questionPending: '等待回答',
  questionSkipped: '未回答',
  questionFailed: '未完成',
  questionAnswered: '已回答',
  awaitAnswer: '等你回答',
  awaitApproval: '等你确认',
  awaitAction: '等你操作',
  questionAnswer: '回答',
  approvalAllowedOnce: '已允许一次',
  approvalAllowedSession: '本会话内允许',
  approvalAllowedRemember: '已允许并记住目录',
  approvalDenied: '已拒绝',
  approvalDeniedReason: '理由：{reason}',
  processThinking1: '1 段思考',
  processThinking: '{n} 段思考',
  processActions1: '1 次操作',
  processActions: '{n} 次操作',
  processCommands1: '运行 1 条命令',
  processCommands: '运行 {n} 条命令',
  processReads1: '读取 1 个文件',
  processReads: '读取 {n} 个文件',
  processEditFile: '编辑 {file}',
  processEdits: '编辑 {n} 个文件',
  processCreateFile: '新建 {file}',
  processCreates: '新建 {n} 个文件',
  processSearch1: '搜索 1 次',
  processSearch: '搜索 {n} 次',
  processList1: '查看 1 个目录',
  processList: '查看 {n} 个目录',
  processWeb1: '联网搜索 1 次',
  processWeb: '联网搜索 {n} 次',
  processFetch1: '打开 1 个网页',
  processFetch: '打开 {n} 个网页',
  processAgent1: '派出 1 个子 Agent',
  processAgent: '派出 {n} 个子 Agent',
  processOther1: '调用 1 次工具',
  processOther: '调用 {n} 次工具',
  processKindJoin: '、',
  processViewChanges: '查看更改',
  turnOrdinal: '第 {n} 轮',
  tallyCommand: '命令',
  tallyRead: '读取',
  tallyEdit: '编辑',
  tallyCreate: '新建',
  tallyDelete: '删除',
  tallySearch: '搜索',
  tallyList: '查看目录',
  tallyFetch: '打开网页',
  tallyWeb: '联网搜索',
  tallyAgent: '子 Agent',
  tallyTodo: '待办',
  processEdits1: '编辑 1 个文件',
  processCreates1: '新建 1 个文件',
  processMoreSteps: '等 {n} 步',
  decisionReplied: '已回复',
  decisionYourReply: '你的回复',
  decisionOutcome: '结果',
  decisionRunning: '正在处理',
  decisionFailed: '没有完成',
  decisionStopped: '已中止',
  questionChosen: '已选',
  questionFreeAnswer: '回答：{answer}',
  questionMore: '等 {n} 题',
  thinkingEmptyRecord: '这一轮的思考没有留下文字记录',
  thinkingUnavailable: '{model} 不提供思考文字',
  asideStacked: '窗口不够宽，推理暂时放在正文上方',
  detailArgs: '参数',
  stepRunningMark: '运行中',
  stepDoneMark: '完成',
  testSummary: '{p} 通过 / {f} 失败',
  stepOverwrote: '覆盖',
  stepLines: '{a}–{b} 行',
  stepLinesFrom: '{a} 行起',
  stepMcpServer: 'MCP 服务：{server}',
  stepFailedMark: '失败',
  outputEarlier: '更早的 {n} 行输出未显示',
  outputTruncated: '输出过长，已截断',
  outputTruncatedPath: '输出过长，已截断 · 完整输出：{path}',
  outputLinesOf: '显示第 {a}–{b} 行，共 {n} 行',
  outputMoreInFile: '文件后面还有 {n} 行',
  exitCode: '退出码 {n}',
  contentLines: '共 {n} 行',
  contentMore: '展开全部内容（{n} 行）',
  contentLess: '收起内容',
  yanSearch: '联网搜索',
  yanSearchResults: '联网搜索 · {n} 条结果',
  detailOutput: '输出',
  wrapUpLabel: '下一步建议',
  wrapUpDismiss: '关闭建议',
  wrapUpDone: '本轮小结',
  wrapUpDecide: '等你决定',
  browserHandoffTitle: '浏览器交给你了',
  browserHandoffReason: '需要你在浏览器里亲自完成一步操作，比如登录、验证码或支付。',
  browserHandoffHint: '这期间 Agent 不会操作浏览器。做完后点「我做好了」，或直接发消息告诉它。',
  browserHandoffDone: '我做好了',
  browserHandoffShow: '查看浏览器',
  browserHandoffMessage: '浏览器里的操作我已经做完了，请继续。'
}

const EN: Record<SessionTextKey, string> = {
  visual: "Structured block ({lang}) can't be rendered here yet.",
  imageProgress: "Image generation progress isn't shown here yet.",
  subagent: "Subagent cards aren't shown here yet.",
  toolDetail: 'Diffs and terminal details open in the side panel; recorded command and output are shown here.',
  outputMore: 'Show all output ({n} lines)',
  outputLess: 'Collapse output',
  moreItems: '{n} more',
  placeholder: 'This content is not rendered in v3 yet.',
  subagentOpen: 'Open side-by-side (not migrated)',
  subagentDetails: 'Summary',
  subagentScopeWorktree: 'Worktree',
  subagentScopeReadOnly: 'Read-only',
  subagentScopeShared: 'Shared folder',
  subagentScopeFork: 'fork · inherits this conversation',
  subagentReviewPending: 'Awaiting review',
  subagentResize: 'Resize',
  subagentSources: 'Sources',
  subagentArtifacts: 'Outputs',
  subagentCount: '{n} subagents',
  subagentLiveCount: '{n} in progress',
  subagentDoneCount: '{n} done',
  subagentFailedCount: '{n} failed',
  subagentStoppedCount: '{n} stopped',
  subagentAllDone: 'all done',
  subagentListLabel: 'Subagents',
  subagentShowMore: 'Show {n} more',
  subagentShowLess: 'Show less',
  subagentCalls: '{n} calls',
  subagentPrev: 'Previous subagent',
  subagentNext: 'Next subagent',
  subagentRetried: 'Retried {n} times',
  subagentResumed: 'Auto-continued once',
  subagentNotRetried: 'Not retried',
  subagentOpenPane: 'Open transcript in the workspace',
  subagentBrief: 'Brief',
  subagentGone: 'The task already ended; nothing to stop',
  compactionTitle: 'Context compacted',
  branchFrom: 'Branched from “{text}”',
  errorTitleRetryable: 'Model error',
  errorTitleQuotaUsage: 'Quota exhausted',
  errorTitleQuotaRate: 'Too many requests',
  errorWaitQuota: 'Auto-resume when quota resets',
  errorQuotaWindowFull: 'The usage panel shows a full quota window, so this limit comes from exhausted quota, not request speed.',
  errorTitleAuth: 'Authentication or permission failed',
  errorTitleContext: 'Context limit exceeded',
  errorTitleAborted: 'Turn cancelled',
  errorTitleRefused: 'Blocked by provider',
  errorTitleRequest: 'Model or request unsupported',
  errorRetry: 'Retry',
  errorModel: 'Switch model',
  errorCompact: 'Compact context',
  runRead1: 'read a file',
  runRead: 'read {n} files',
  runEdit1: 'edited a file',
  runEdit: 'edited {n} files',
  runCreate1: 'created a file',
  runCreate: 'created {n} files',
  runDelete1: 'deleted a file',
  runDelete: 'deleted {n} files',
  runSearch1: 'ran a search',
  runSearch: 'ran {n} searches',
  runList1: 'looked in a folder',
  runList: 'looked in {n} folders',
  runFetch1: 'opened a web page',
  runFetch: 'opened {n} web pages',
  runWeb1: 'searched online',
  runWeb: 'searched online {n} times',
  runCommand1: 'ran a command',
  runCommand: 'ran {n} commands',
  runAgent1: 'sent out a subagent',
  runAgent: 'sent out {n} subagents',
  runTodo: 'updated to-dos',
  runOther1: 'called {name}',
  runOther: 'called {name} {n} times',
  runFileRead: 'read',
  runFileEdit: 'edited',
  runFileCreate: 'created',
  runFileDelete: 'deleted',
  runFile: '{verbs} {file}',
  runFileReads: '{verbs} {file} ({n} times)',
  runAnd: '{a} and {b}',
  runSep: ', ',
  runJoin: ', ',
  runFailed: ' ({n} failed)',
  runNeedsApproval: 'Needs approval',
  runRepeat: '×{n}',
  runChangedFiles: '{n} files changed',
  stepRead: 'Read',
  stepReadRunning: 'Reading',
  stepReadFailed: 'Failed to read',
  stepRan: 'Ran',
  stepRunning: 'Running',
  stepRunFailed: 'Failed to run',
  stepEdited: 'Edited',
  stepEditing: 'Editing',
  stepEditFailed: 'Failed to edit',
  stepCreated: 'Created',
  stepCreating: 'Creating',
  stepWriteFailed: 'Failed to write',
  stepSearched: 'Searched',
  stepSearching: 'Searching',
  stepSearchFailed: 'Failed to search',
  stepListed: 'Listed',
  stepListing: 'Listing',
  stepListFailed: 'Failed to list',
  stepWebSearched: 'Searched the web',
  stepWebSearching: 'Searching the web',
  stepWebSearchFailed: 'Failed to search the web',
  stepTodo: 'Updated to-dos',
  stepTodoItems: '{n} items',
  stepReadDenied: 'Denied',
  stepRunDenied: 'Denied',
  stepEditDenied: 'Denied',
  stepWriteDenied: 'Denied',
  stepSearchDenied: 'Denied',
  stepListDenied: 'Denied',
  stepWebSearchDenied: 'Denied',
  errViewDetails: 'View details',
  errStatus: 'Error',
  errRecoveredStatus: 'Recovered',
  errCopyDetails: 'Copy details',
  workStopping: 'Stopping…',
  workWaiting: 'Needs your input',
  workRetry: 'Retrying ({n}/{m})',
  workRetryWait: 'Retrying in {s}s ({n}/{m})',
  workSending: 'Sending…',
  workWorking: 'Working…',
  workTool: 'Running tools…',
  workResponding: 'Writing the reply…',
  workThinking: 'Thinking…',
  workActive: 'In progress',
  workThought: 'Thought for {n}s',
  workTokens: '{n} tokens',
  msgCopy: 'Copy',
  msgCopied: 'Copied',
  msgCopyFailed: 'Copy failed',
  msgEdit: 'Edit',
  msgEditTip: 'Put this message back in the composer to edit and resend',
  msgRewind: 'Rewind',
  msgFork: 'Fork',
  msgActions: 'Message actions',
  menuCode: 'Code block',
  menuLink: 'Link',
  menuCopyCode: 'Copy code',
  menuInsertCode: 'Insert into composer',
  menuOpenLink: 'Open link',
  menuOpenExternal: 'Open in system browser',
  menuCopyLink: 'Copy link',
  menuPreviewFile: 'Preview file',
  menuRevealFile: 'Show in folder',
  menuCopyPath: 'Copy path',
  approvalCwd: 'Working directory: {cwd}',
  questionLabel: 'Question',
  questionPending: 'Waiting for an answer',
  questionSkipped: 'No answer',
  questionFailed: 'Not completed',
  questionAnswered: 'Answered',
  awaitAnswer: 'Needs your answer',
  awaitApproval: 'Needs approval',
  awaitAction: 'Your turn',
  questionAnswer: 'Answer',
  approvalAllowedOnce: 'Allowed once',
  approvalAllowedSession: 'Allowed for this session',
  approvalAllowedRemember: 'Allowed, folder remembered',
  approvalDenied: 'Denied',
  approvalDeniedReason: 'Reason: {reason}',
  processThinking1: '1 thought',
  processThinking: '{n} thoughts',
  processActions1: '1 action',
  processActions: '{n} actions',
  processCommands1: 'Ran 1 command',
  processCommands: 'Ran {n} commands',
  processReads1: 'Read 1 file',
  processReads: 'Read {n} files',
  processEditFile: 'Edited {file}',
  processEdits: 'Edited {n} files',
  processCreateFile: 'Created {file}',
  processCreates: 'Created {n} files',
  processSearch1: 'Searched once',
  processSearch: 'Searched {n} times',
  processList1: 'Listed 1 folder',
  processList: 'Listed {n} folders',
  processWeb1: 'Searched the web once',
  processWeb: 'Searched the web {n} times',
  processFetch1: 'Opened 1 web page',
  processFetch: 'Opened {n} web pages',
  processAgent1: 'Sent out 1 subagent',
  processAgent: 'Sent out {n} subagents',
  processOther1: 'Called 1 tool',
  processOther: 'Called {n} tools',
  processKindJoin: ', ',
  processViewChanges: 'View changes',
  turnOrdinal: 'Turn {n}',
  tallyCommand: 'command',
  tallyRead: 'read',
  tallyEdit: 'edit',
  tallyCreate: 'create',
  tallyDelete: 'delete',
  tallySearch: 'search',
  tallyList: 'list',
  tallyFetch: 'fetch',
  tallyWeb: 'web search',
  tallyAgent: 'subagent',
  tallyTodo: 'to-do',
  processEdits1: 'Edited 1 file',
  processCreates1: 'Created 1 file',
  processMoreSteps: ' and more ({n} steps)',
  decisionReplied: 'Replied',
  decisionYourReply: 'You replied',
  decisionOutcome: 'Outcome',
  decisionRunning: 'In progress',
  decisionFailed: 'Not completed',
  decisionStopped: 'Stopped',
  questionChosen: 'Chosen',
  questionFreeAnswer: 'Answer: {answer}',
  questionMore: '+{n} more',
  thinkingEmptyRecord: 'This turn left no reasoning text',
  thinkingUnavailable: '{model} does not return reasoning text',
  asideStacked: 'Not enough width; reasoning is shown above the reply for now',
  detailArgs: 'Arguments',
  stepRunningMark: 'Running',
  stepDoneMark: 'Done',
  testSummary: '{p} passed / {f} failed',
  stepOverwrote: 'Overwrote',
  stepLines: 'lines {a}–{b}',
  stepLinesFrom: 'from line {a}',
  stepMcpServer: 'MCP server: {server}',
  stepFailedMark: 'Failed',
  outputEarlier: '{n} earlier lines not shown',
  outputTruncated: 'Output was truncated',
  outputTruncatedPath: 'Output was truncated · full output: {path}',
  outputLinesOf: 'Showing lines {a}–{b} of {n}',
  outputMoreInFile: '{n} more lines in the file',
  exitCode: 'exit {n}',
  contentLines: '{n} lines',
  contentMore: 'Show all content ({n} lines)',
  contentLess: 'Collapse content',
  yanSearch: 'Web search',
  yanSearchResults: 'Web search · {n} results',
  detailOutput: 'Output',
  wrapUpLabel: 'Next step',
  wrapUpDismiss: 'Dismiss suggestion',
  wrapUpDone: 'Turn recap',
  wrapUpDecide: 'Your call',
  browserHandoffTitle: 'The browser is yours',
  browserHandoffReason: 'A step needs you in the browser, such as signing in, a captcha, or a payment.',
  browserHandoffHint: 'The agent will not touch the browser meanwhile. Press "Done" when finished, or just send a message.',
  browserHandoffDone: 'Done',
  browserHandoffShow: 'Show browser',
  browserHandoffMessage: 'I have finished the step in the browser. Please continue.'
}

export function sessionText(lang: string, key: SessionTextKey, vars?: Record<string, string | number>): string {
  let s = (lang === 'en-US' ? EN : ZH)[key]
  if (vars) for (const [n, v] of Object.entries(vars)) s = s.split(`{${n}}`).join(String(v))
  return s
}

export function useSessionText(): (key: SessionTextKey, vars?: Record<string, string | number>) => string {
  const { lang } = useI18n()
  return (key, vars) => sessionText(lang, key, vars)
}
