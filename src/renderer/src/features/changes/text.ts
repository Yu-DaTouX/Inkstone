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
  readOnly: string
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
      readOnly: 'Read-only'
    }
  }
  return {
    title: '改动',
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
    readOnly: '只读'
  }
}
