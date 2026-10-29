import type { DeepLink } from './deeplink/protocol'

export type NoticeLang = 'zh' | 'en'

export interface AttentionNoticeInput {
  key: string
  title: string
  body?: string
  icon?: string
  link?: DeepLink
}

export interface NoticeHandle {
  on(event: 'click' | 'close', listener: () => void): unknown
  show(): void
  close(): void
}

export type NoticeFactory = (options: { title: string; body?: string; icon?: string; silent: boolean }) => NoticeHandle

export interface AttentionNotices {
  show(input: AttentionNoticeInput): void
}

export function createAttentionNotices(make: NoticeFactory, open: (link?: DeepLink) => void): AttentionNotices {
  const live = new Map<string, NoticeHandle>()
  return {
    show(input) {
      const previous = live.get(input.key)
      live.delete(input.key)
      previous?.close()
      const notice = make({
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.icon ? { icon: input.icon } : {}),
        silent: true
      })
      live.set(input.key, notice)
      notice.on('click', () => open(input.link))
      notice.on('close', () => {
        if (live.get(input.key) === notice) live.delete(input.key)
      })
      notice.show()
    }
  }
}

export function noticeLang(lang: string | undefined): NoticeLang {
  return lang === 'en-US' ? 'en' : 'zh'
}

export function withSubject(event: string, subject?: string): string {
  const clean = subject?.trim()
  return clean ? `${event} · ${clean}` : event
}

export function approvalNoticeTitle(lang: NoticeLang, subject?: string): string {
  return withSubject(lang === 'en' ? 'Needs your approval' : '需要你确认', subject)
}

export function terminalNoticeText(lang: NoticeLang, kind: string | undefined, title?: string): { title: string; body: string } {
  const event =
    kind === 'permission'
      ? lang === 'en' ? 'Terminal needs approval' : '终端在等你批准'
      : kind === 'question'
        ? lang === 'en' ? 'Terminal needs an answer' : '终端在等你回答'
        : kind === 'auth'
          ? lang === 'en' ? 'Terminal needs sign-in' : '终端在等你登录'
          : lang === 'en' ? 'Terminal is waiting' : '终端在等你'
  const body = title?.trim() || (lang === 'en' ? 'Switch to the terminal to continue' : '切到该终端查看')
  return { title: event, body }
}

export function collabNoticeText(lang: NoticeLang, peer: string, title: string, branch: string): { title: string; body: string } {
  const name = peer.replace(/^(?:砚|Inkstone)\s*·\s*/, '')
  return lang === 'en'
    ? { title: withSubject('Collaboration', 'Merge request'), body: `${name}: ${title} (${branch})` }
    : { title: withSubject('多人协作', '合并请求'), body: `${name}：${title}（${branch}）` }
}
