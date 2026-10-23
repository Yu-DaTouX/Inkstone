export interface ChangesText {
  title: string
  refresh: string
  loading: string
  notRepo: string
  gitMissing: string
  gitError: (message: string) => string
  inactiveHint: string
  clean: string
  changed: string
  staged: string
  unstaged: string
  untracked: string
  detached: string
  noBranch: string
  unborn: string
  entriesLimited: string
  entriesFailed: (message: string) => string
  noDiffChannel: string
  selectFile: string
  back: string
  patchLoading: string
  patchError: (message: string) => string
  patchTruncated: string
  scopeLabel: string
  scopeWorking: string
  scopeBranch: string
  scopeCommit: string
  compareWith: (label: string) => string
  totalLines: (added: number, removed: number) => string
  shaLabel: string
  shaPlaceholder: string
  shaApply: string
  shaInvalid: string
  shaNeeded: string
  scopeEmpty: string
  subdirScope: (path: string) => string
  subdirClean: (path: string, count: number) => string
  patchBinary: string
  patchTooLarge: string
  imageBefore: string
  imageAfter: string
  imageMissing: string
  imageTooLarge: string
  imageEmpty: string
  filesTitle: string
  showFileList: string
  hideFileList: string
  resizeFileList: string
  collapseAll: string
  expandAll: string
  layoutUnified: string
  layoutSplit: string
  splitNeedsWidth: string
  largeDiffBanner: string
  retry: string
  fileNew: string
  fileDeleted: string
  fileRenamed: (path: string) => string
  fileBinary: string
  commitMessage: string
  commitPlaceholder: string
  stageAll: string
  commitAction: string
  commitBusy: string
  commitDone: (summary: string) => string
  commitFailed: (message: string) => string
  commitClean: string
}

export function changesText(lang: string): ChangesText {
  if (String(lang).toLowerCase().startsWith('en')) {
    return {
      title: 'Changes',
      refresh: 'Refresh',
      loading: 'Reading Git status…',
      notRepo: 'This folder is not inside a Git repository.',
      gitMissing: 'Git is not available on this machine. Install it yourself; Inkstone will not install it for you.',
      gitError: (message) => `Git query failed: ${message}`,
      inactiveHint: 'This session is not active — viewing only.',
      clean: 'Working tree is clean.',
      changed: 'Changed',
      staged: 'Staged',
      unstaged: 'Unstaged',
      untracked: 'Untracked',
      detached: 'detached HEAD',
      noBranch: 'no branch',
      unborn: 'no commits yet',
      entriesLimited: 'Per-file status is not exposed by the host yet; only untracked files are listed.',
      entriesFailed: (message) => `Failed to read the changed-file list: ${message}`,
      noDiffChannel: 'Diff content is not wired to the host yet.',
      selectFile: 'Select a file to view its diff.',
      back: 'Back to list',
      patchLoading: 'Loading diff…',
      patchError: (message) => `Failed to load diff: ${message}`,
      patchTruncated: 'This diff is truncated (not the complete content).',
      scopeLabel: 'Compare scope',
      scopeWorking: 'Working tree',
      scopeBranch: 'Branch (vs merge-base)',
      scopeCommit: 'Single commit',
      compareWith: (label) => `Compared with ${label}`,
      totalLines: (added, removed) => `+${added} −${removed}`,
      shaLabel: 'Commit',
      shaPlaceholder: 'Commit sha (4–64 hex digits)',
      shaApply: 'View',
      shaInvalid: 'Enter 4–64 hexadecimal characters.',
      shaNeeded: 'Enter a commit sha to view its changes.',
      scopeEmpty: 'No changes in this scope.',
      subdirScope: (path) => `Only changes under ${path} are listed; Stage all and Commit act on the whole repository.`,
      subdirClean: (path, count) => `No changes under ${path}. The repository has ${count} other changed ${count === 1 ? 'file' : 'files'}; Stage all and Commit act on all of them.`,
      patchBinary: 'Binary file — no text diff.',
      patchTooLarge: 'This file is too large to show a diff.',
      imageBefore: 'Before',
      imageAfter: 'After',
      imageMissing: 'Does not exist',
      imageTooLarge: 'Too large to preview',
      imageEmpty: 'No image content to compare.',
      filesTitle: 'Changed files',
      showFileList: 'Show files',
      hideFileList: 'Hide files',
      resizeFileList: 'Resize file list',
      collapseAll: 'Collapse all files',
      expandAll: 'Expand all files',
      layoutUnified: 'Unified',
      layoutSplit: 'Side by side',
      splitNeedsWidth: 'Needs a wider pane',
      largeDiffBanner: 'Files are collapsed for large diffs. Select a file to expand it.',
      retry: 'Retry',
      fileNew: 'New file',
      fileDeleted: 'Deleted file',
      fileRenamed: (path) => `Renamed from ${path}`,
      fileBinary: 'Binary file',
      commitMessage: 'Commit message',
      commitPlaceholder: 'Describe this change',
      stageAll: 'Stage all',
      commitAction: 'Commit',
      commitBusy: 'Running Git…',
      commitDone: (summary) => `Committed ${summary}`,
      commitFailed: (message) => `Git action failed: ${message}`,
      commitClean: 'Nothing to commit.'
    }
  }
  return {
    title: '更改',
    refresh: '刷新',
    loading: '正在读取 Git 状态…',
    notRepo: '这个目录不在 Git 仓库里。',
    gitMissing: '本机没有可用的 Git。请自行安装；砚不会自动安装。',
    gitError: (message) => `Git 查询失败：${message}`,
    inactiveHint: '这个会话未激活，仅只读查看。',
    clean: '工作区干净。',
    changed: '改动',
    staged: '已暂存',
    unstaged: '未暂存',
    untracked: '未跟踪',
    detached: '游离 HEAD',
    noBranch: '无分支',
    unborn: '尚无提交',
    entriesLimited: '宿主还没有暴露逐文件状态，这里只列出未跟踪文件。',
    entriesFailed: (message) => `逐文件改动读取失败：${message}`,
    noDiffChannel: '宿主尚未接入 diff 内容通道。',
    selectFile: '选择一个文件查看 diff。',
    back: '返回列表',
    patchLoading: '正在加载 diff…',
    patchError: (message) => `diff 加载失败：${message}`,
    patchTruncated: '这个 diff 已被截断，不是完整内容。',
    scopeLabel: '对比范围',
    scopeWorking: '工作区',
    scopeBranch: '分支（对 merge-base）',
    scopeCommit: '单个提交',
    compareWith: (label) => `对比 ${label}`,
    totalLines: (added, removed) => `+${added} −${removed}`,
    shaLabel: '提交',
    shaPlaceholder: '提交 sha（4–64 位十六进制）',
    shaApply: '查看',
    shaInvalid: '请输入 4–64 位十六进制字符。',
    shaNeeded: '输入提交 sha 查看该提交的更改。',
    scopeEmpty: '这个范围内没有更改。',
    subdirScope: (path) => `只列出 ${path} 下的改动；「全部暂存」和「提交」作用于整个仓库。`,
    subdirClean: (path, count) => `${path} 下没有改动。仓库其他位置还有 ${count} 处改动，「全部暂存」和「提交」会包含它们。`,
    patchBinary: '二进制文件，没有文本 diff。',
    patchTooLarge: '文件过大，不显示 diff。',
    imageBefore: '之前',
    imageAfter: '之后',
    imageMissing: '不存在',
    imageTooLarge: '过大',
    imageEmpty: '没有可对比的图片内容。',
    filesTitle: '更改的文件',
    showFileList: '显示文件列表',
    hideFileList: '隐藏文件列表',
    resizeFileList: '调整文件列表宽度',
    collapseAll: '折叠全部文件',
    expandAll: '展开全部文件',
    layoutUnified: '统一',
    layoutSplit: '并排',
    splitNeedsWidth: '面板更宽才能并排',
    largeDiffBanner: '改动较大，文件已全部折叠。选择文件展开查看。',
    retry: '重试',
    fileNew: '新增文件',
    fileDeleted: '已删除',
    fileRenamed: (path) => `重命名自 ${path}`,
    fileBinary: '二进制文件',
    commitMessage: '提交说明',
    commitPlaceholder: '描述这次改动',
    stageAll: '全部暂存',
    commitAction: '提交',
    commitBusy: '正在执行 Git…',
    commitDone: (summary) => `已提交 ${summary}`,
    commitFailed: (message) => `Git 操作失败：${message}`,
    commitClean: '没有可提交的改动。'
  }
}
