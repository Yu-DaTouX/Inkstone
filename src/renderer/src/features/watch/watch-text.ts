import type { Lang } from '../../i18n'
import type { WatchStatus } from '../../../../shared/session-watch'

export interface WatchText {
  menuShare: string
  paletteShare: string
  paletteJoin: string
  shareTitle: string
  shareLead: string
  shareStart: string
  shareStop: string
  shareStopped: string
  shareInviteLabel: string
  shareInviteHint: string
  copy: string
  copied: string
  viewers: string
  viewersEmpty: string
  removeViewer(name: string): string
  openDeviceSettings: string
  close: string
  joinTitle: string
  joinLead: string
  joinLabel: string
  joinPlaceholder: string
  join: string
  cancel: string
  leave: string
  readOnly: string
  host(name: string): string
  status: Record<WatchStatus, string>
  pending(n: number): string
  empty: string
  waiting: string
  noSession: string
}

const ZH: WatchText = {
  menuShare: '共享给别人旁观…',
  paletteShare: '共享当前会话给别人旁观',
  paletteJoin: '加入共享会话（旁观）',
  shareTitle: '共享会话',
  shareLead: '把邀请发给另一台装了砚的电脑，对方能实时看到这个会话的消息流，但不能发消息、不能操作。停止共享后邀请立即失效。',
  shareStart: '开始共享',
  shareStop: '停止共享',
  shareStopped: '已停止共享',
  shareInviteLabel: '邀请',
  shareInviteHint: '对方在命令面板里选「加入共享会话」，粘贴这段邀请即可。两台电脑需在同一个 Tailscale 或 Radmin 网络里。',
  copy: '复制邀请',
  copied: '已复制',
  viewers: '正在旁观',
  viewersEmpty: '还没有人加入',
  removeViewer: (name) => `移出 ${name}`,
  openDeviceSettings: '打开设备设置',
  close: '关闭',
  joinTitle: '加入共享会话',
  joinLead: '粘贴对方发来的邀请。旁观是只读的：能看到 AI 的消息流，不能发消息。',
  joinLabel: '邀请',
  joinPlaceholder: 'inkstone-watch:…',
  join: '加入旁观',
  cancel: '取消',
  leave: '退出旁观',
  readOnly: '只读旁观',
  host: (name) => `来自 ${name}`,
  status: { connecting: '正在连接', live: '实时', reconnecting: '正在重连', ended: '已结束', failed: '连接失败' },
  pending: (n) => (n > 1 ? `主机那边有 ${n} 个确认或提问待处理` : '主机那边有一个确认或提问待处理'),
  empty: '这个会话还没有消息',
  waiting: '正在读取会话…',
  noSession: '先打开一个会话再共享'
}

const EN: WatchText = {
  menuShare: 'Share for watching…',
  paletteShare: 'Share this session for watching',
  paletteJoin: 'Join a shared session (watch)',
  shareTitle: 'Share session',
  shareLead: 'Send the invite to another computer running Inkstone. They see this session’s message stream live, but cannot send messages or act. Stopping sharing voids the invite at once.',
  shareStart: 'Start sharing',
  shareStop: 'Stop sharing',
  shareStopped: 'Sharing stopped',
  shareInviteLabel: 'Invite',
  shareInviteHint: 'They choose “Join a shared session” in the command palette and paste this invite. Both computers must be on the same Tailscale or Radmin network.',
  copy: 'Copy invite',
  copied: 'Copied',
  viewers: 'Watching now',
  viewersEmpty: 'Nobody has joined yet',
  removeViewer: (name) => `Remove ${name}`,
  openDeviceSettings: 'Open device settings',
  close: 'Close',
  joinTitle: 'Join a shared session',
  joinLead: 'Paste the invite you received. Watching is read-only: you see the AI’s message stream and cannot send messages.',
  joinLabel: 'Invite',
  joinPlaceholder: 'inkstone-watch:…',
  join: 'Start watching',
  cancel: 'Cancel',
  leave: 'Stop watching',
  readOnly: 'Read-only',
  host: (name) => `From ${name}`,
  status: { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', ended: 'Ended', failed: 'Failed' },
  pending: (n) => (n > 1 ? `${n} confirmations or questions are waiting on the host` : 'A confirmation or question is waiting on the host'),
  empty: 'No messages in this session yet',
  waiting: 'Loading the session…',
  noSession: 'Open a session before sharing'
}

export function watchText(lang: Lang): WatchText {
  return lang === 'en-US' ? EN : ZH
}
