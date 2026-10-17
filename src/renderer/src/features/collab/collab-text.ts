import type { Lang } from '../../i18n'
import type { CollabRequestStatus } from '../../../../shared/collab'
import type { PeerOperation } from '../../../../shared/peer-protocol'

export interface CollabAgentPromptInput {
  project: string
  cwd: string
  source: string | null
  branch: string | null
  files: string[]
}

export interface CollabText {
  title: string
  nav: string
  lede: string
  bridgeMissing: string
  refresh: string
  loading: string
  loadFailed: string
  dismiss: string
  cancel: string
  local: string
  remote: string
  peersTitle: string
  peersHint: string
  peersEmpty: string
  peerMissing: string
  pairTitle: string
  pairHint: string
  address: string
  addressPlaceholder: string
  code: string
  codePlaceholder: string
  pair: string
  paired: string
  pairFailed: string
  pairLinkParsed: string
  pairInviteReceived: string
  inviteTitle: string
  inviteHint: string
  inviteStart: string
  inviteCancel: string
  inviteCopy: string
  inviteCopied: string
  inviteCode: string
  inviteExpires: string
  inviteStopped: string
  inviteLoopback: string
  inviteOpenDevices: string
  inviteQrLabel: string
  stateIdle: string
  stateWaiting: string
  stateConnected: string
  stateFailed: string
  failedReason: string
  requestOps: string
  note: string
  connect: string
  waiting: string
  connected: string
  connectFailed: string
  disconnect: string
  disconnected: string
  remove: string
  removeTitle: string
  removeBody: string
  removed: string
  removeFailed: string
  grantLine: string
  grantNone: string
  needOps: string
  ops: Record<PeerOperation, string>
  projectsTitle: string
  projectsEmpty: string
  grantNoProjects: string
  projectLoading: string
  projectFailed: string
  retry: string
  localProject: string
  localProjectPlaceholder: string
  localNone: string
  notRepo: string
  suggested: string
  linked: string
  unlinked: string
  linkFailed: string
  needLocal: string
  localNotRepo: string
  currentBranch: string
  detached: string
  branchesTitle: string
  branchesEmpty: string
  sessions: string
  sessionsNone: string
  remoteCurrent: string
  stateNotFetched: string
  stateUpToDate: string
  stateIncoming: string
  stateOutgoing: string
  stateStale: string
  fetch: string
  fetched: string
  fetchUpToDate: string
  fetchCounts: string
  fetchImported: string
  fetchImportErrors: string
  fetchFailed: string
  compare: string
  compareHide: string
  compareLoading: string
  compareFailed: string
  compareBase: string
  compareCommits: string
  compareFiles: string
  compareNoCommits: string
  compareNoFiles: string
  diffLoading: string
  diffFailed: string
  diffEmpty: string
  diffOf: string
  diffHide: string
  merge: string
  mergeTitle: string
  mergeBody: string
  mergeHint: string
  mergeConfirm: string
  merged: string
  mergeNoop: string
  mergeFailed: string
  mergeConflicts: string
  continue: string
  continueHint: string
  continueFailed: string
  continueDone: string
  sessionFailed: string
  needFetch: string
  noPull: string
  pushTitle: string
  pushHint: string
  pushBranch: string
  pushBranchPlaceholder: string
  pushRequest: string
  requestTitle: string
  requestNote: string
  push: string
  pushed: string
  pushedWithRequest: string
  pushFailed: string
  noPush: string
  needTitle: string
  needBranch: string
  requestsTitle: string
  incoming: string
  outgoing: string
  requestsEmptyIn: string
  requestsEmptyOut: string
  requestFrom: string
  requestTo: string
  requestStatus: Record<CollabRequestStatus, string>
  requestNoLocal: string
  closeRequest: string
  closed: string
  closeFailed: string
  mergePending: string
  mergePendingOf: string
  conflictFiles: string
  conflictUnknown: string
  resolveWithAgent: string
  abortMerge: string
  abortTitle: string
  abortBody: string
  aborted: string
  abortFailed: string
  agentStarted: string
  agentPrompt: (input: CollabAgentPromptInput) => string
}

const ZH: CollabText = {
  title: '多人协作',
  nav: '多人协作',
  lede: '每台电脑各有一份代码，像 git 一样拉取、对比、合并对方的分支；对方批准后才能连接，推送只会落在对方的「你的名字/分支」下，不会改动对方已有的分支。',
  bridgeMissing: '当前构建还没有接入多人协作。',
  refresh: '刷新',
  loading: '正在读取…',
  loadFailed: '读取协作状态失败：{error}',
  dismiss: '关闭提示',
  cancel: '取消',
  local: '本机',
  remote: '远端 · {computer}',
  peersTitle: '协作者',
  peersHint: '已配对的砚。申请连接后，需要对方在自己的电脑上批准。',
  peersEmpty: '还没有配对的协作者。',
  peerMissing: '当前构建还没有接入砚互联，不能配对或连接。',
  pairTitle: '配对新的协作者',
  pairHint: '对方在「设置 › 设备与同步」点「生成配对码」后，填入那里显示的地址和 6 位配对码，或粘贴对方「复制链接」得到的链接。',
  address: '地址',
  addressPlaceholder: '100.101.102.103:37892 或 inkstone://pair?…',
  code: '配对码',
  codePlaceholder: '6 位数字',
  pair: '配对',
  paired: '已配对「{computer}」。',
  pairFailed: '配对失败：{error}',
  pairLinkParsed: '已从配对链接填入地址和配对码。',
  pairInviteReceived: '收到邀请链接，已填入地址和配对码，确认后点「配对」。',
  inviteTitle: '邀请协作者',
  inviteHint: '生成一次性配对码，把链接发给对方，或让对方扫二维码。对方在砚里打开链接会自动填好下面的配对表单。',
  inviteStart: '生成邀请',
  inviteCancel: '取消邀请',
  inviteCopy: '复制邀请链接',
  inviteCopied: '已复制',
  inviteCode: '配对码',
  inviteExpires: '{seconds} 秒后失效',
  inviteStopped: '先在「设置 › 设备与同步」开启接入，才能邀请别人。',
  inviteLoopback: '接入只监听本机地址，别的电脑连不上。请在「设置 › 设备与同步」改为局域网或 Tailscale。',
  inviteOpenDevices: '打开设备与同步',
  inviteQrLabel: '邀请链接二维码',
  stateIdle: '未连接',
  stateWaiting: '等待对方批准',
  stateConnected: '已连接',
  stateFailed: '失败',
  failedReason: '连接失败：{error}',
  requestOps: '申请的操作',
  note: '写给对方的说明（可选）',
  connect: '申请连接',
  waiting: '等待对方批准…',
  connected: '「{computer}」已批准连接。',
  connectFailed: '连接「{computer}」失败：{error}',
  disconnect: '结束连接',
  disconnected: '已结束与「{computer}」的连接。',
  remove: '移除',
  removeTitle: '移除协作者',
  removeBody: '移除「{computer}」后，需要重新配对才能再连接。已拉取的分支和会话副本会保留。',
  removed: '已移除「{computer}」。',
  removeFailed: '没能移除「{computer}」。',
  grantLine: '对方开放：{projects} · 允许：{ops}',
  grantNone: '无',
  needOps: '至少勾选一项操作。',
  ops: {
    read: '查看会话与成果',
    transfer: '复制会话与成果',
    send: '发消息、开任务',
    pull: '拉取代码与相关会话',
    push: '推送分支、发合并请求'
  },
  projectsTitle: '对方开放的项目',
  projectsEmpty: '连接协作者后，这里会列出对方开放的项目和分支。',
  grantNoProjects: '对方这次没有开放项目。',
  projectLoading: '正在读取对方的分支…',
  projectFailed: '读取对方项目失败：{error}',
  retry: '重试',
  localProject: '对应的本机项目',
  localProjectPlaceholder: '选择本机项目',
  localNone: '不关联',
  notRepo: '（不是 Git 仓库）',
  suggested: '按共同的首个提交推荐；第一次操作时会自动关联。',
  linked: '已把对方「{remote}」关联到本机「{project}」。',
  unlinked: '已取消对方「{remote}」的关联。',
  linkFailed: '关联本机项目失败：{error}',
  needLocal: '先选对应的本机项目，才能拉取、对比、合并或接着做。',
  localNotRepo: '本机「{project}」不是 Git 仓库，不能拉取或合并。',
  currentBranch: '当前分支 {branch}',
  detached: '没有检出分支',
  branchesTitle: '对方的分支',
  branchesEmpty: '对方这个项目没有可拉取的分支。',
  sessions: '{n} 个相关会话',
  sessionsNone: '没有相关会话',
  remoteCurrent: '对方当前分支',
  stateNotFetched: '未拉取',
  stateUpToDate: '已是最新',
  stateIncoming: '有 {n} 个新提交',
  stateOutgoing: '你领先 {n} 个',
  stateStale: '对方有更新，可重新拉取',
  fetch: '拉取',
  fetched: '已拉取 {ref}：{summary}',
  fetchUpToDate: '已是最新',
  fetchCounts: '有 {incoming} 个新提交，你领先 {outgoing} 个',
  fetchImported: '；取回 {n} 个会话副本',
  fetchImportErrors: '；{n} 个会话副本没有取回：{errors}',
  fetchFailed: '拉取失败：{error}',
  compare: '对比',
  compareHide: '收起对比',
  compareLoading: '正在对比…',
  compareFailed: '对比失败：{error}',
  compareBase: '共同祖先 {base}',
  compareCommits: '对方领先的提交（{n}）',
  compareFiles: '改动的文件（{n}）',
  compareNoCommits: '没有你还没有的提交。',
  compareNoFiles: '没有文件改动。',
  diffLoading: '正在读取改动…',
  diffFailed: '读取改动失败：{error}',
  diffEmpty: '这个文件没有可显示的文本改动。',
  diffOf: '{path} 的改动',
  diffHide: '收起改动',
  merge: '合并到当前分支',
  mergeTitle: '确认合并',
  mergeBody: '把 {source} 合并进本机「{project}」的 {branch}。',
  mergeHint: '合并前请先提交本机未提交的改动。有冲突时会停下来，由你或 Agent 解决。',
  mergeConfirm: '合并',
  merged: '已合并：{message}',
  mergeNoop: '已是最新，没有需要合并的提交。',
  mergeFailed: '合并失败：{error}',
  mergeConflicts: '合并有冲突，冲突文件列在本机「{project}」处。',
  continue: '接着做',
  continueHint: '在本机基于这个分支新建 worktree，并以对方的会话副本为上下文开新会话。',
  continueFailed: '没能接着做：{error}',
  continueDone: '已在 {worktree} 开了新会话，提示词已填好。',
  sessionFailed: '新建会话失败：{error}',
  needFetch: '先拉取这个分支。',
  noPull: '这次连接没有「拉取」权限，需要重新申请连接并勾选「拉取」。',
  pushTitle: '推送到 {computer}',
  pushHint: '推送只会落在对方的「你的名字/分支」下，不会改动对方已有的分支。',
  pushBranch: '本机分支',
  pushBranchPlaceholder: '选择要推送的分支',
  pushRequest: '同时发合并请求',
  requestTitle: '标题',
  requestNote: '说明',
  push: '推送',
  pushed: '已推送到 {computer}：{ref}',
  pushedWithRequest: '已推送到 {computer}：{ref}，合并请求已发出。',
  pushFailed: '推送失败：{error}',
  noPush: '这次连接没有「推送」权限，需要重新申请连接并勾选「推送」。',
  needTitle: '合并请求需要标题。',
  needBranch: '先选要推送的本机分支。',
  requestsTitle: '合并请求',
  incoming: '收到的',
  outgoing: '发出的',
  requestsEmptyIn: '没有收到合并请求。',
  requestsEmptyOut: '还没有发出合并请求。',
  requestFrom: '来自 {peer}',
  requestTo: '发给 {peer}',
  requestStatus: {
    open: '待处理',
    merged: '已合并',
    closed: '已关闭'
  },
  requestNoLocal: '找不到对应的本机项目。',
  closeRequest: '关闭',
  closed: '已关闭合并请求「{title}」。',
  closeFailed: '关闭合并请求失败：{error}',
  mergePending: '本机「{project}」有未完成的合并',
  mergePendingOf: '正在把 {source} 合并进 {branch}',
  conflictFiles: '冲突文件',
  conflictUnknown: '在项目目录运行 git status 可以看到冲突文件。',
  resolveWithAgent: '交给 Agent 解决',
  abortMerge: '放弃合并',
  abortTitle: '放弃合并',
  abortBody: '放弃后，本机「{project}」回到合并前的状态，已经手动解决的冲突也会丢掉。',
  aborted: '已放弃合并，本机「{project}」回到合并前的状态。',
  abortFailed: '放弃合并失败：{error}',
  agentStarted: '已在本机「{project}」开了新会话，解决冲突的提示词已填好。',
  agentPrompt: ({ project, cwd, source, branch, files }) => {
    const target = branch ? `「${project}」的 ${branch} 分支` : `「${project}」`
    const head = source
      ? `我正在把 ${source} 合并进本机项目${target}（目录 ${cwd}），出现了冲突。`
      : `本机项目${target}（目录 ${cwd}）有一次没有完成的 git 合并，出现了冲突。`
    const list = files.length ? `冲突文件：\n${files.map((file) => `- ${file}`).join('\n')}` : '冲突文件：请先运行 git status 查看。'
    return [
      head,
      list,
      '请逐个打开这些文件，理解双方的改动后解决冲突（保留两边都需要的内容，删掉冲突标记）。每个文件解决后执行 git add，全部解决后用 git commit 完成这次合并，不要用 git merge --abort。',
      '完成后简要说明每个文件是怎么处理的。'
    ].join('\n\n')
  }
}

const EN: CollabText = {
  title: 'Collaboration',
  nav: 'Collaboration',
  lede: 'Each computer keeps its own copy of the code. Pull, compare and merge each other’s branches the way git does. Connections need the other side’s approval, and a push only lands under “your name/branch” on their side, never touching their existing branches.',
  bridgeMissing: 'Collaboration is not wired into this build yet.',
  refresh: 'Refresh',
  loading: 'Loading…',
  loadFailed: 'Could not read collaboration status: {error}',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  local: 'This computer',
  remote: 'Remote · {computer}',
  peersTitle: 'Collaborators',
  peersHint: 'Paired Inkstone computers. After you request a connection, the other person approves it on their computer.',
  peersEmpty: 'No paired collaborators yet.',
  peerMissing: 'Peer connections are not wired into this build, so pairing is unavailable.',
  pairTitle: 'Pair a new collaborator',
  pairHint: 'Have them click “Generate pairing code” in Settings › Devices & sync, then enter the address and 6-digit code shown there, or paste the link from their “Copy link”.',
  address: 'Address',
  addressPlaceholder: '100.101.102.103:37892 or inkstone://pair?…',
  code: 'Pairing code',
  codePlaceholder: '6 digits',
  pair: 'Pair',
  paired: 'Paired with “{computer}”.',
  pairFailed: 'Pairing failed: {error}',
  pairLinkParsed: 'Filled in the address and code from the pairing link.',
  pairInviteReceived: 'Invite link received. The address and code are filled in; press “Pair” to confirm.',
  inviteTitle: 'Invite a collaborator',
  inviteHint: 'Generate a one-time pairing code, then send the link or let them scan the QR code. Opening the link in Inkstone fills in the pairing form below for them.',
  inviteStart: 'Create invite',
  inviteCancel: 'Cancel invite',
  inviteCopy: 'Copy invite link',
  inviteCopied: 'Copied',
  inviteCode: 'Pairing code',
  inviteExpires: 'Expires in {seconds}s',
  inviteStopped: 'Turn on access in Settings › Devices & sync before inviting anyone.',
  inviteLoopback: 'Access only listens on this computer, so others cannot reach it. Switch to LAN or Tailscale in Settings › Devices & sync.',
  inviteOpenDevices: 'Open Devices & sync',
  inviteQrLabel: 'Invite link QR code',
  stateIdle: 'Not connected',
  stateWaiting: 'Waiting for approval',
  stateConnected: 'Connected',
  stateFailed: 'Failed',
  failedReason: 'Connection failed: {error}',
  requestOps: 'Requested access',
  note: 'Note to the other person (optional)',
  connect: 'Request connection',
  waiting: 'Waiting for approval…',
  connected: '“{computer}” approved the connection.',
  connectFailed: 'Could not connect to “{computer}”: {error}',
  disconnect: 'End connection',
  disconnected: 'Ended the connection with “{computer}”.',
  remove: 'Remove',
  removeTitle: 'Remove collaborator',
  removeBody: 'After removing “{computer}” you need to pair again to reconnect. Pulled branches and session copies are kept.',
  removed: 'Removed “{computer}”.',
  removeFailed: 'Could not remove “{computer}”.',
  grantLine: 'Shared: {projects} · Allowed: {ops}',
  grantNone: 'none',
  needOps: 'Pick at least one kind of access.',
  ops: {
    read: 'View sessions and outputs',
    transfer: 'Copy sessions and outputs',
    send: 'Send messages and start tasks',
    pull: 'Pull code and related sessions',
    push: 'Push branches and open merge requests'
  },
  projectsTitle: 'Shared projects',
  projectsEmpty: 'Once a collaborator is connected, the projects and branches they share appear here.',
  grantNoProjects: 'No projects were shared for this connection.',
  projectLoading: 'Reading their branches…',
  projectFailed: 'Could not read the remote project: {error}',
  retry: 'Retry',
  localProject: 'Matching local project',
  localProjectPlaceholder: 'Choose a local project',
  localNone: 'Not linked',
  notRepo: ' (not a Git repository)',
  suggested: 'Suggested because the first commits match; it is linked on your first action.',
  linked: 'Linked their “{remote}” to local “{project}”.',
  unlinked: 'Unlinked their “{remote}”.',
  linkFailed: 'Could not link the local project: {error}',
  needLocal: 'Choose the matching local project before pulling, comparing, merging or continuing.',
  localNotRepo: 'Local “{project}” is not a Git repository, so it cannot pull or merge.',
  currentBranch: 'On {branch}',
  detached: 'No branch checked out',
  branchesTitle: 'Their branches',
  branchesEmpty: 'This project has no branches to pull.',
  sessions: '{n} related sessions',
  sessionsNone: 'No related sessions',
  remoteCurrent: 'Their current branch',
  stateNotFetched: 'Not pulled',
  stateUpToDate: 'Up to date',
  stateIncoming: '{n} new commits',
  stateOutgoing: 'You are {n} ahead',
  stateStale: 'Updated on their side, pull again',
  fetch: 'Pull',
  fetched: 'Pulled {ref}: {summary}',
  fetchUpToDate: 'already up to date',
  fetchCounts: '{incoming} new commits, you are {outgoing} ahead',
  fetchImported: '; {n} session copies retrieved',
  fetchImportErrors: '; {n} session copies failed: {errors}',
  fetchFailed: 'Pull failed: {error}',
  compare: 'Compare',
  compareHide: 'Hide comparison',
  compareLoading: 'Comparing…',
  compareFailed: 'Compare failed: {error}',
  compareBase: 'Merge base {base}',
  compareCommits: 'Commits you do not have ({n})',
  compareFiles: 'Changed files ({n})',
  compareNoCommits: 'No commits you do not already have.',
  compareNoFiles: 'No file changes.',
  diffLoading: 'Reading changes…',
  diffFailed: 'Could not read changes: {error}',
  diffEmpty: 'No text changes to show for this file.',
  diffOf: 'Changes in {path}',
  diffHide: 'Hide changes',
  merge: 'Merge into current branch',
  mergeTitle: 'Confirm merge',
  mergeBody: 'Merge {source} into {branch} of local “{project}”.',
  mergeHint: 'Commit any local changes first. If there are conflicts the merge stops so you or an agent can resolve them.',
  mergeConfirm: 'Merge',
  merged: 'Merged: {message}',
  mergeNoop: 'Already up to date; nothing to merge.',
  mergeFailed: 'Merge failed: {error}',
  mergeConflicts: 'The merge has conflicts; they are listed under local “{project}”.',
  continue: 'Continue here',
  continueHint: 'Creates a local worktree from this branch and starts a new session with their session copy as context.',
  continueFailed: 'Could not continue: {error}',
  continueDone: 'Started a new session in {worktree} with the prompt filled in.',
  sessionFailed: 'Could not start a session: {error}',
  needFetch: 'Pull this branch first.',
  noPull: 'This connection does not allow pulling. Request a new connection with “Pull” checked.',
  pushTitle: 'Push to {computer}',
  pushHint: 'A push only lands under “your name/branch” on their side and never changes their existing branches.',
  pushBranch: 'Local branch',
  pushBranchPlaceholder: 'Choose a branch to push',
  pushRequest: 'Also open a merge request',
  requestTitle: 'Title',
  requestNote: 'Description',
  push: 'Push',
  pushed: 'Pushed to {computer}: {ref}',
  pushedWithRequest: 'Pushed to {computer}: {ref}, and opened a merge request.',
  pushFailed: 'Push failed: {error}',
  noPush: 'This connection does not allow pushing. Request a new connection with “Push” checked.',
  needTitle: 'A merge request needs a title.',
  needBranch: 'Choose a local branch to push.',
  requestsTitle: 'Merge requests',
  incoming: 'Received',
  outgoing: 'Sent',
  requestsEmptyIn: 'No merge requests received.',
  requestsEmptyOut: 'No merge requests sent yet.',
  requestFrom: 'From {peer}',
  requestTo: 'To {peer}',
  requestStatus: {
    open: 'Open',
    merged: 'Merged',
    closed: 'Closed'
  },
  requestNoLocal: 'The matching local project is missing.',
  closeRequest: 'Close',
  closed: 'Closed merge request “{title}”.',
  closeFailed: 'Could not close the merge request: {error}',
  mergePending: 'Local “{project}” has an unfinished merge',
  mergePendingOf: 'Merging {source} into {branch}',
  conflictFiles: 'Conflicting files',
  conflictUnknown: 'Run git status in the project folder to see the conflicting files.',
  resolveWithAgent: 'Let an agent resolve',
  abortMerge: 'Abort merge',
  abortTitle: 'Abort merge',
  abortBody: 'Local “{project}” goes back to its state before the merge, and any conflicts you already resolved are lost.',
  aborted: 'Aborted the merge; local “{project}” is back to its state before the merge.',
  abortFailed: 'Could not abort the merge: {error}',
  agentStarted: 'Started a new session in local “{project}” with a conflict-resolution prompt filled in.',
  agentPrompt: ({ project, cwd, source, branch, files }) => {
    const target = branch ? `branch ${branch} of local project “${project}”` : `local project “${project}”`
    const head = source
      ? `I am merging ${source} into ${target} (folder ${cwd}) and it has conflicts.`
      : `There is an unfinished git merge with conflicts in ${target} (folder ${cwd}).`
    const list = files.length ? `Conflicting files:\n${files.map((file) => `- ${file}`).join('\n')}` : 'Conflicting files: run git status to list them.'
    return [
      head,
      list,
      'Open each file, understand both sides, and resolve the conflict (keep what both sides need and remove the conflict markers). Run git add on each resolved file, then finish the merge with git commit. Do not run git merge --abort.',
      'When done, briefly explain how you handled each file.'
    ].join('\n\n')
  }
}

export function collabText(lang: Lang): CollabText {
  return lang === 'en-US' ? EN : ZH
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] !== undefined ? String(values[key]) : match))
}

export function formatCollabTime(ms: number | null | undefined, lang: Lang): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Date(ms).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return '—'
  }
}
