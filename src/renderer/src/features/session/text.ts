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
  | 'subagentReviewPending'
  | 'subagentResize'
  | 'subagentSources'
  | 'subagentArtifacts'
  | 'subagentCount'
  | 'subagentLiveCount'
  | 'subagentDoneCount'
  | 'subagentFailedCount'
  | 'subagentDeckHint'
  | 'subagentDeckLabel'
  | 'subagentDeckJump'
  | 'subagentDeckGo'
  | 'subagentShowLess'
  | 'subagentRetried'
  | 'subagentResumed'
  | 'subagentNotRetried'
  | 'subagentRunningTasks'
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
  | 'turnForkTip'
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
  subagentReviewPending: '待审查',
  subagentResize: '调整大小',
  subagentSources: '来源',
  subagentArtifacts: '成果',
  subagentCount: '{n} 个子 Agent',
  subagentLiveCount: '{n} 进行中',
  subagentDoneCount: '{n} 完成',
  subagentFailedCount: '{n} 失败',
  subagentDeckHint: '滚轮 · ↑↓ 翻张',
  subagentDeckLabel: '子 Agent 卡片，聚焦后用上下方向键翻张',
  subagentDeckJump: '翻到这一张',
  subagentDeckGo: '第 {n} 个',
  subagentShowLess: '收起',
  subagentRetried: '已自动重试 {n} 次',
  subagentResumed: '已自动续跑 1 次',
  subagentNotRetried: '未自动重试',
  subagentRunningTasks: '{n} 个任务正在运行',
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
  turnForkTip: '从这里分叉：新会话保留到这一轮为止的历史',
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
  questionAnswer: '回答'
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
  subagentReviewPending: 'Awaiting review',
  subagentResize: 'Resize',
  subagentSources: 'Sources',
  subagentArtifacts: 'Outputs',
  subagentCount: '{n} subagents',
  subagentLiveCount: '{n} in progress',
  subagentDoneCount: '{n} done',
  subagentFailedCount: '{n} failed',
  subagentDeckHint: 'Wheel · ↑↓ to flip',
  subagentDeckLabel: 'Subagent cards, use the up and down arrow keys to flip when focused',
  subagentDeckJump: 'Flip to this one',
  subagentDeckGo: 'No. {n}',
  subagentShowLess: 'Show less',
  subagentRetried: 'Retried {n} times',
  subagentResumed: 'Auto-continued once',
  subagentNotRetried: 'Not retried',
  subagentRunningTasks: '{n} running',
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
  workStopping: 'Stopping…',
  workWaiting: 'Waiting on you',
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
  turnForkTip: 'Fork from here: a new session keeps the history up to this turn',
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
  questionAnswer: 'Answer'
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
