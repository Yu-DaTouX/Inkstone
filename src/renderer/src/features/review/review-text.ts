export interface ReviewUiText {
  title: string
  refresh: string
  loading: string
  loadFailed: (message: string) => string
  notGit: string
  noChanges: string
  truncatedList: string
  fileCount: (count: number) => string
  selectFile: string
  selectFileHint: string
  binary: string
  stale: string
  sourceLabel: string
  sourceSession: string
  sourceBranch: string
  sourceWorktree: string
  sourceUncommitted: string
  sourceUnavailable: string
  sessionShareNote: string
  worktreePathLabel: string
  baseLabel: string
  basePlaceholder: string
  branchRefLabel: string
  branchRefPlaceholder: string
  activeHint: string
  annotations: (count: number) => string
  annotationTitle: string
  annotationEmpty: string
  annotationBodyLabel: string
  annotationBodyPlaceholder: string
  sideLabel: string
  sideNew: string
  sideOld: string
  sideFile: string
  lineStartLabel: string
  lineEndLabel: string
  annotationSave: string
  annotationUpdate: string
  annotationCancel: string
  annotationRemove: string
  annotationClear: string
  annotationStale: string
  annotationSaved: string
  annotationError: (message: string) => string
  annotationGone: string
  newAnnotation: string
  editAnnotation: string
  diffTitle: string
  diffUnavailable: string
  findingsTitle: string
  findingsEmpty: string
  findingsUnavailable: string
  findingsLoading: string
  findingsError: (message: string) => string
  findingsCount: (count: number) => string
  severityHigh: string
  severityMedium: string
  severityLow: string
  suggestion: string
  runModelLabel: string
  runModelDefault: string
  startReview: string
  startReviewHint: string
  runStarting: string
  runStarted: (code: string) => string
  runNotRegistered: string
  runWiring: string
  runFailed: (message: string) => string
  makeAnnotationTask: string
  taskBuilding: string
  taskTitle: string
  taskHint: string
  taskCopy: string
  taskCopied: string
  taskNone: string
  taskFailed: (message: string) => string
  taskCount: (count: number) => string
  gitBarLabel: string
  commitMessageLabel: string
  commitMessagePlaceholder: string
  suggestCommitMessage: string
  commit: string
  push: string
  createPr: string
  gitNeedsRepo: string
  commitConfirmTitle: string
  commitConfirmBody: string
  pushConfirmTitle: string
  pushConfirmBody: string
  prConfirmTitle: string
  prConfirmBody: string
  remoteLabel: string
  remoteDefault: string
  branchLabel: string
  pushUpstream: string
  prTitleLabel: string
  prBaseLabel: string
  prHeadLabel: string
  prBodyLabel: string
  prDraft: string
  confirm: string
  cancel: string
  ghChecking: string
  ghMissing: string
  ghUnauthenticated: string
  ghUnknown: string
  actionRunning: string
  actionOk: string
  actionFailed: (message: string) => string
  actionRecoverable: string
  targetCwd: string
  copy: string
  copied: string
}

function zh(): ReviewUiText {
  return {
    title: '代码审查',
    refresh: '刷新',
    loading: '正在读取改动…',
    loadFailed: (message) => `读取失败：${message}`,
    notGit: '这个目录不在 Git 仓库里，没有可审查的改动',
    noChanges: '这个范围里没有改动',
    truncatedList: '改动文件太多，这里只列出了前面一部分',
    fileCount: (count) => `${count} 个文件`,
    selectFile: '从文件清单里选一个文件查看差异',
    selectFileHint: '选中文件后这里显示真实补丁，可在下方按真实行号添加批注',
    binary: '二进制文件，无法逐行显示差异',
    stale: '代码已变化',
    sourceLabel: '改动集来源',
    sourceSession: '本会话改动',
    sourceBranch: '分支相对主分支',
    sourceWorktree: '某个 worktree',
    sourceUncommitted: '未提交改动',
    sourceUnavailable: '当前目录不可用',
    sessionShareNote: '说明：后端实现里「本会话改动」读的仍是该目录的未提交改动，和「未提交改动」同源、只是归属键不同；砚没有「本会话精确改过哪些文件」的台账，不宣称精确归因。',
    worktreePathLabel: 'worktree 目录',
    baseLabel: '比较基准',
    basePlaceholder: '缺省 main / master / upstream',
    branchRefLabel: '目标分支',
    branchRefPlaceholder: '缺省当前分支',
    activeHint: '当前会话还没在 Agent 侧激活；只读审查可用，写操作请先回到活动会话。',
    annotations: (count) => `${count} 条批注`,
    annotationTitle: '批注',
    annotationEmpty: '还没有批注。选中真实行号后可以添加一条行范围批注。',
    annotationBodyLabel: '批注内容',
    annotationBodyPlaceholder: '这里是用户对代码的旁注，不是发给模型的指令',
    sideLabel: '锚定',
    sideNew: '改动后',
    sideOld: '改动前',
    sideFile: '整个文件',
    lineStartLabel: '起始行',
    lineEndLabel: '结束行',
    annotationSave: '添加批注',
    annotationUpdate: '保存修改',
    annotationCancel: '取消',
    annotationRemove: '删除',
    annotationClear: '清空本改动集批注',
    annotationStale: '写这条批注后代码已变化，请复核',
    annotationSaved: '已保存',
    annotationError: (message) => `批注操作失败：${message}`,
    annotationGone: '这条批注已不存在，列表已刷新',
    newAnnotation: '新建批注',
    editAnnotation: '编辑批注',
    diffTitle: '差异',
    diffUnavailable: '宿主没有提供 diff 通道',
    findingsTitle: '审查意见',
    findingsEmpty: '还没有审查意见。启动只读审查后，意见会显示在这里。',
    findingsUnavailable: '审查运行的进度事件尚未并入运行注册表（R 事件 producer 待后续接线）；当前只返回 R 编号，不能当作审查已完成。',
    findingsLoading: '正在读取审查意见…',
    findingsError: (message) => `审查意见读取失败：${message}`,
    findingsCount: (count) => `${count} 条意见`,
    severityHigh: '高',
    severityMedium: '中',
    severityLow: '低',
    suggestion: '建议',
    runModelLabel: '审查模型',
    runModelDefault: '沿用默认模型',
    startReview: '请 Agent 审查',
    startReviewHint: '启动一次只读审查子运行；不修改文件、不执行仓库命令。',
    runStarting: '正在启动…',
    runStarted: (code) => `已登记审查运行 ${code}（只读）`,
    runNotRegistered: 'R 编号已分配，但审查事件尚未登记为运行；不把编号当作运行已完成。',
    runWiring: '还差接线：',
    runFailed: (message) => `启动审查失败：${message}`,
    makeAnnotationTask: '让 Agent 按批注修改',
    taskBuilding: '正在整理…',
    taskTitle: '按批注修改的指令',
    taskHint: '这是整理好的结构化消息，不会自动发送。把它交给会话输入（插话 / 排队）后才会进入 Agent。',
    taskCopy: '复制',
    taskCopied: '已复制',
    taskNone: '没有可处理的批注',
    taskFailed: (message) => `整理失败：${message}`,
    taskCount: (count) => `共 ${count} 条批注`,
    gitBarLabel: 'Git 操作',
    commitMessageLabel: '提交信息',
    commitMessagePlaceholder: '写明这次提交做了什么',
    suggestCommitMessage: '生成提交信息',
    commit: '提交',
    push: '推送',
    createPr: '创建 PR',
    gitNeedsRepo: '目标目录不是 Git 仓库，不能提交、推送或创建 PR',
    commitConfirmTitle: '确认提交',
    commitConfirmBody: '将在这个仓库执行一次提交，提交信息如下：',
    pushConfirmTitle: '确认推送',
    pushConfirmBody: '将把当前分支推送到远端。请确认目标：',
    prConfirmTitle: '确认创建 Pull Request',
    prConfirmBody: '将经 gh 创建 PR。请确认目标、分支、标题与正文：',
    remoteLabel: '远端',
    remoteDefault: '（沿用仓库默认）',
    branchLabel: '分支',
    pushUpstream: '同时设置上游分支',
    prTitleLabel: '标题',
    prBaseLabel: '目标分支',
    prHeadLabel: '源分支',
    prBodyLabel: '正文',
    prDraft: '创建为草稿',
    confirm: '确认',
    cancel: '取消',
    ghChecking: '正在检测 gh…',
    ghMissing: '未检测到 gh，无法创建 PR；安装 GitHub CLI 后重试。',
    ghUnauthenticated: 'gh 未登录；运行 gh auth login 后重试。',
    ghUnknown: 'gh 状态未知，暂不能创建 PR。',
    actionRunning: '正在执行…',
    actionOk: '操作完成',
    actionFailed: (message) => `操作失败：${message}`,
    actionRecoverable: '可修复后重试',
    targetCwd: '目标目录',
    copy: '复制',
    copied: '已复制'
  }
}

function en(): ReviewUiText {
  return {
    title: 'Code review',
    refresh: 'Refresh',
    loading: 'Loading changes…',
    loadFailed: (message) => `Failed to load: ${message}`,
    notGit: 'This folder is not a Git repository, so there is nothing to review',
    noChanges: 'No changes in this scope',
    truncatedList: 'Too many changed files — only the first batch is listed',
    fileCount: (count) => `${count} file${count === 1 ? '' : 's'}`,
    selectFile: 'Pick a file from the list to see its diff',
    selectFileHint: 'The real patch shows here; add a line-range annotation against real lines below',
    binary: 'Binary file — cannot show a line diff',
    stale: 'Code has changed',
    sourceLabel: 'Change set source',
    sourceSession: 'This session',
    sourceBranch: 'Branch vs base',
    sourceWorktree: 'A worktree',
    sourceUncommitted: 'Uncommitted changes',
    sourceUnavailable: 'Unavailable for this folder',
    sessionShareNote: 'Note: on the backend, "This session" still reads the folder\'s uncommitted changes — the same origin as "Uncommitted changes", only a different scope key. Inkstone has no per-session change ledger, so no exact attribution is claimed.',
    worktreePathLabel: 'Worktree folder',
    baseLabel: 'Base',
    basePlaceholder: 'Defaults to main / master / upstream',
    branchRefLabel: 'Branch ref',
    branchRefPlaceholder: 'Defaults to the current branch',
    activeHint: 'This session is not active on the Agent side; read-only review works, finish writes after returning to an active session.',
    annotations: (count) => `${count} annotation${count === 1 ? '' : 's'}`,
    annotationTitle: 'Annotations',
    annotationEmpty: 'No annotations yet. Select real line numbers to add a line-range note.',
    annotationBodyLabel: 'Note',
    annotationBodyPlaceholder: 'A user note about the code, not an instruction to the model',
    sideLabel: 'Anchor',
    sideNew: 'After',
    sideOld: 'Before',
    sideFile: 'Whole file',
    lineStartLabel: 'Start line',
    lineEndLabel: 'End line',
    annotationSave: 'Add note',
    annotationUpdate: 'Save changes',
    annotationCancel: 'Cancel',
    annotationRemove: 'Delete',
    annotationClear: 'Clear annotations for this change set',
    annotationStale: 'The code changed after this note was written — re-check it',
    annotationSaved: 'Saved',
    annotationError: (message) => `Annotation failed: ${message}`,
    annotationGone: 'That annotation no longer exists; the list was refreshed',
    newAnnotation: 'New annotation',
    editAnnotation: 'Edit annotation',
    diffTitle: 'Diff',
    diffUnavailable: 'The host does not provide a diff channel',
    findingsTitle: 'Review findings',
    findingsEmpty: 'No findings yet. Start a read-only review and they will appear here.',
    findingsUnavailable: 'Review run events are not wired into the run registry yet (R event producer pending). Only the R code is returned; do not treat it as a completed review.',
    findingsLoading: 'Loading findings…',
    findingsError: (message) => `Failed to load findings: ${message}`,
    findingsCount: (count) => `${count} finding${count === 1 ? '' : 's'}`,
    severityHigh: 'High',
    severityMedium: 'Medium',
    severityLow: 'Low',
    suggestion: 'Suggestion',
    runModelLabel: 'Review model',
    runModelDefault: 'Use the default model',
    startReview: 'Ask the Agent to review',
    startReviewHint: 'Starts a read-only review subrun; it does not modify files or run repo commands.',
    runStarting: 'Starting…',
    runStarted: (code) => `Registered read-only review run ${code}`,
    runNotRegistered: 'An R code was assigned, but the review events are not registered as a run yet; the code alone is not a finished review.',
    runWiring: 'Missing wiring: ',
    runFailed: (message) => `Failed to start review: ${message}`,
    makeAnnotationTask: 'Have the Agent apply annotations',
    taskBuilding: 'Preparing…',
    taskTitle: 'Annotation instruction',
    taskHint: 'This is the assembled structured message; it is not sent automatically. Deliver it through the session input (steer / queue) to reach the Agent.',
    taskCopy: 'Copy',
    taskCopied: 'Copied',
    taskNone: 'No annotations to apply',
    taskFailed: (message) => `Failed to prepare: ${message}`,
    taskCount: (count) => `${count} annotation${count === 1 ? '' : 's'}`,
    gitBarLabel: 'Git actions',
    commitMessageLabel: 'Commit message',
    commitMessagePlaceholder: 'Describe what this commit does',
    suggestCommitMessage: 'Suggest message',
    commit: 'Commit',
    push: 'Push',
    createPr: 'Create PR',
    gitNeedsRepo: 'The target folder is not a Git repository, so commit, push and PR are unavailable',
    commitConfirmTitle: 'Confirm commit',
    commitConfirmBody: 'A commit will run in this repository with the message below:',
    pushConfirmTitle: 'Confirm push',
    pushConfirmBody: 'The branch will be pushed to the remote. Confirm the target:',
    prConfirmTitle: 'Confirm pull request',
    prConfirmBody: 'A PR will be created via gh. Confirm target, branches, title and body:',
    remoteLabel: 'Remote',
    remoteDefault: '(repository default)',
    branchLabel: 'Branch',
    pushUpstream: 'Set upstream branch',
    prTitleLabel: 'Title',
    prBaseLabel: 'Base branch',
    prHeadLabel: 'Head branch',
    prBodyLabel: 'Body',
    prDraft: 'Create as draft',
    confirm: 'Confirm',
    cancel: 'Cancel',
    ghChecking: 'Checking gh…',
    ghMissing: 'gh was not found, so no PR can be created; install GitHub CLI and retry.',
    ghUnauthenticated: 'gh is not authenticated; run gh auth login and retry.',
    ghUnknown: 'gh status is unknown; PR creation is unavailable.',
    actionRunning: 'Running…',
    actionOk: 'Done',
    actionFailed: (message) => `Failed: ${message}`,
    actionRecoverable: 'Fix and retry',
    targetCwd: 'Target folder',
    copy: 'Copy',
    copied: 'Copied'
  }
}

export function reviewText(lang: string): ReviewUiText {
  return lang === 'en-US' ? en() : zh()
}
