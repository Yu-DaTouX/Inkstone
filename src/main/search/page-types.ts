import { isLinkLocalHost, isPrivateHost } from '../browser/network-boundary'

export const READ_PAGE_MAX_CHARS_DEFAULT = 12_000
export const READ_PAGE_MAX_CHARS_MAX = 40_000
export const PAGE_SNAPSHOT_MAX_CHARS = 2_000_000

export interface ReadPageResult {
  url: string
  finalUrl: string
  title: string
  text: string
  truncated: boolean
  totalChars: number
  fetchedAt?: string
  contentType?: string
  format?: 'markdown' | 'text'
  extraction?: 'html' | 'browser' | 'pdf' | 'text' | 'remote'
  publishedAt?: string
  modifiedAt?: string
  links?: Array<{ title: string; url: string }>
  pages?: Array<{ page: number; offset: number; endOffset: number }>
  pageCount?: number
}

export class ReadPageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export function normalizeReadUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ReadPageError('bad_url', '不是合法的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ReadPageError('bad_url', '只支持 http(s) 网页')
  if (url.username || url.password) throw new ReadPageError('bad_url', '网址不能包含用户名或密码')
  if (isPrivateHost(url.hostname) || isLinkLocalHost(url.hostname)) {
    throw new ReadPageError('private_host', '不读取本机或内网地址（本机预览请用 yan browser）')
  }
  return url.toString()
}

export function assertReadablePage(page: ReadPageResult): ReadPageResult {
  if (!page.text.trim()) throw new ReadPageError('empty_content', '网页没有可读取的正文')
  const title = page.title.trim()
  if (
    /^(?:just a moment\.*|attention required!?(?:\s*\|\s*cloudflare)?|access denied|403 forbidden|429 too many requests|verify (?:you are|you're) human|访问被拒绝|安全验证|人机验证|请完成安全验证)$/i.test(title) &&
    /captcha|cloudflare|verify|verification|denied|forbidden|security|checking your browser|验证|访问被拒绝|权限不足/i.test(page.text.slice(0, 2000))
  ) throw new ReadPageError('access_blocked', '网页返回了验证或访问拒绝页面，未取得正文')
  return page
}
