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
  | 'stepReadDenied'
  | 'stepRunDenied'
  | 'stepEditDenied'
  | 'stepWriteDenied'
  | 'stepSearchDenied'
  | 'stepListDenied'
  | 'stepWebSearchDenied'
  | 'errViewDetails'
  | 'errRecovered'
  | 'errCopyDetails'
  | 'workStopping'
  | 'workWaiting'
  | 'workRetry'
  | 'workRetryWait'
  | 'workSending'
  | 'workWorking'
  | 'workTool'
  | 'workResponding'
  | 'workThink0'
  | 'workThink15'
  | 'workThink30'
  | 'workThink45'
  | 'workThink60'
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
  | 'questionAnswer'
  | 'wrapUpLabel'
  | 'wrapUpDismiss'
  | 'wrapUpDone'
  | 'wrapUpDecide'

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
  errorTitleQuotaRate: '请求过于频繁',
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
  stepCreated: '写入',
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
  stepReadDenied: '已拒绝读取',
  stepRunDenied: '已拒绝运行',
  stepEditDenied: '已拒绝编辑',
  stepWriteDenied: '已拒绝写入',
  stepSearchDenied: '已拒绝搜索',
  stepListDenied: '已拒绝列出',
  stepWebSearchDenied: '已拒绝联网搜索',
  errViewDetails: '查看详情',
  errRecovered: '{title}，已自动恢复',
  errCopyDetails: '复制详情',
  workStopping: '正在停止…',
  workWaiting: '等你处理',
  workRetry: '重试中（{n}/{m}）',
  workRetryWait: '{s} 秒后重试（{n}/{m}）',
  workSending: '正在发送…',
  workWorking: '处理中…',
  workTool: '正在执行工具…',
  workResponding: '正在作答…',
  workThink0: '思考中…',
  workThink15: '仍在思考…',
  workThink30: '正在细想…',
  workThink45: '正在权衡细节…',
  workThink60: '思路快理清了…',
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
  questionFailed: '提问未完成',
  questionAnswer: '回答',
  wrapUpLabel: '下一步建议',
  wrapUpDismiss: '关闭建议',
  wrapUpDone: '本轮小结',
  wrapUpDecide: '等你决定'
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
  stepReadDenied: 'Denied',
  stepRunDenied: 'Denied',
  stepEditDenied: 'Denied',
  stepWriteDenied: 'Denied',
  stepSearchDenied: 'Denied',
  stepListDenied: 'Denied',
  stepWebSearchDenied: 'Denied',
  errViewDetails: 'View details',
  errRecovered: '{title}, recovered automatically',
  errCopyDetails: 'Copy details',
  workStopping: 'Stopping…',
  workWaiting: 'Needs your input',
  workRetry: 'Retrying ({n}/{m})',
  workRetryWait: 'Retrying in {s}s ({n}/{m})',
  workSending: 'Sending…',
  workWorking: 'Working…',
  workTool: 'Running tools…',
  workResponding: 'Writing the reply…',
  workThink0: 'Thinking…',
  workThink15: 'Still on it…',
  workThink30: 'Thinking it through…',
  workThink45: 'Weighing the details…',
  workThink60: 'Nearly worked out…',
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
  questionFailed: 'Question not completed',
  questionAnswer: 'Answer',
  wrapUpLabel: 'Next step',
  wrapUpDismiss: 'Dismiss suggestion',
  wrapUpDone: 'Turn recap',
  wrapUpDecide: 'Your call'
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
