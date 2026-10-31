import type { Lang } from '../../i18n'

export interface GithubChannelText {
  title: string
  refresh: string
  loading: string
  needLocal: string
  needLogin: string
  missingGh: string
  loadFailed: string
  empty: string
  sourcePeer: string
  sourceGithub: string
  owner: string
  unknownOwner: string
  prLabel: string
  prDraft: string
  openPr: string
  checkoutPr: string
  checkedOut: string
  checkoutFailed: string
  publish: string
  needFetch: string
  publishTitle: string
  publishLead: string
  branchLabel: string
  baseLabel: string
  titleLabel: string
  bodyLabel: string
  draftLabel: string
  confirm: string
  cancel: string
  published: string
  publishFailed: string
  partial: string
  namingHint: string
  accountLabel: string
  accountHint: string
  accountSave: string
  accountClear: string
  accountInvalid: string
  accountSaved: string
  manualTag: string
  inferredTag: string
}

const ZH: GithubChannelText = {
  title: '点对点与 GitHub',
  refresh: '刷新 GitHub',
  loading: '正在读取 GitHub 分支与 PR…',
  needLocal: '先把这个项目关联到一个本地仓库，才能显示它在 GitHub 上的分支与 PR。',
  needLogin: 'GitHub 未登录：请在终端运行 gh auth login，点对点分支不受影响。',
  missingGh: '没有检测到 GitHub CLI（gh），只显示点对点分支。',
  loadFailed: '读取 GitHub 失败：{error}',
  empty: '没有可显示的分支。',
  sourcePeer: '点对点',
  sourceGithub: 'GitHub',
  owner: '@{login}',
  unknownOwner: '未关联 GitHub 账号',
  prLabel: 'PR #{n}',
  prDraft: '草稿',
  openPr: '打开 PR',
  checkoutPr: '检出 PR',
  checkedOut: '已检出 PR #{n}',
  checkoutFailed: '检出 PR 失败：{error}',
  publish: '推到 GitHub 并开 PR',
  needFetch: '先取回这个分支',
  publishTitle: '推送到 GitHub 并创建 PR',
  publishLead: '这会向 GitHub 仓库 {repo} 推送新分支并创建 PR，对外可见。确认后才会执行。',
  branchLabel: '远端分支名（用户名/主题）',
  baseLabel: '合并到',
  titleLabel: 'PR 标题',
  bodyLabel: 'PR 说明',
  draftLabel: '创建为草稿',
  confirm: '确认推送并创建',
  cancel: '取消',
  published: '已创建 PR #{n}',
  publishFailed: '发布失败：{error}',
  partial: '分支已推送，但 PR 没有创建成功：{error}',
  namingHint: '分支名必须以 {login}/ 开头',
  accountLabel: '对方的 GitHub 账号',
  accountHint: '留空则按分支和 PR 自动推断；手动填写后优先使用，并长期记住。',
  accountSave: '保存',
  accountClear: '清除',
  accountInvalid: '不是有效的 GitHub 用户名',
  accountSaved: '已记住 {computer} 的 GitHub 账号',
  manualTag: '手动',
  inferredTag: '推断'
}

const EN: GithubChannelText = {
  title: 'Peer-to-peer and GitHub',
  refresh: 'Refresh GitHub',
  loading: 'Reading GitHub branches and PRs…',
  needLocal: 'Link this project to a local repository to see its GitHub branches and PRs.',
  needLogin: 'GitHub is not signed in: run gh auth login in a terminal. Peer branches are unaffected.',
  missingGh: 'GitHub CLI (gh) was not found; only peer branches are shown.',
  loadFailed: 'Could not read GitHub: {error}',
  empty: 'No branches to show.',
  sourcePeer: 'Peer',
  sourceGithub: 'GitHub',
  owner: '@{login}',
  unknownOwner: 'No GitHub account linked',
  prLabel: 'PR #{n}',
  prDraft: 'Draft',
  openPr: 'Open PR',
  checkoutPr: 'Check out PR',
  checkedOut: 'Checked out PR #{n}',
  checkoutFailed: 'Could not check out the PR: {error}',
  publish: 'Push to GitHub and open PR',
  needFetch: 'Fetch this branch first',
  publishTitle: 'Push to GitHub and create a PR',
  publishLead: 'This pushes a new branch to {repo} on GitHub and opens a PR, visible to others. Nothing runs until you confirm.',
  branchLabel: 'Remote branch name (user/topic)',
  baseLabel: 'Merge into',
  titleLabel: 'PR title',
  bodyLabel: 'PR description',
  draftLabel: 'Create as draft',
  confirm: 'Confirm push and create',
  cancel: 'Cancel',
  published: 'Created PR #{n}',
  publishFailed: 'Publish failed: {error}',
  partial: 'The branch was pushed but the PR was not created: {error}',
  namingHint: 'The branch name must start with {login}/',
  accountLabel: 'Their GitHub account',
  accountHint: 'Leave empty to infer from branches and PRs; a value you enter wins and is remembered.',
  accountSave: 'Save',
  accountClear: 'Clear',
  accountInvalid: 'Not a valid GitHub username',
  accountSaved: 'Remembered the GitHub account for {computer}',
  manualTag: 'manual',
  inferredTag: 'inferred'
}

export function githubChannelText(lang: Lang): GithubChannelText {
  return lang === 'en-US' ? EN : ZH
}
