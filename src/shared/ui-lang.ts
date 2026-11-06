export type UiLang = 'zh-CN' | 'en-US'

let active: UiLang = 'zh-CN'
let resolver: (() => UiLang | undefined) | null = null

export function setLangResolver(next: (() => UiLang | undefined) | null): void {
  resolver = next
}

export function setUiLang(lang: string | undefined): void {
  active = lang === 'en-US' ? 'en-US' : 'zh-CN'
}

export function uiLang(): UiLang {
  return resolver?.() ?? active
}

const COUNTED_NOUNS: Record<string, string> = {
  turns: 'turn', steps: 'step', files: 'file', sessions: 'session', messages: 'message', items: 'item',
  tools: 'tool', projects: 'project', changes: 'change', branches: 'branch', commits: 'commit', lines: 'line',
  results: 'result', matches: 'match', servers: 'server', services: 'service', skills: 'skill', devices: 'device',
  images: 'image', attachments: 'attachment', comments: 'comment', days: 'day', hours: 'hour', minutes: 'minute',
  seconds: 'second', tokens: 'token', requests: 'request', calls: 'call', errors: 'error', artifacts: 'artifact',
  subagents: 'subagent', plugins: 'plugin', extensions: 'extension', models: 'model', keys: 'key', accounts: 'account',
  tabs: 'tab', rows: 'row', folders: 'folder', hits: 'hit', sources: 'source', entries: 'entry', checks: 'check',
  characters: 'character', pages: 'page', windows: 'window', repos: 'repo',
  sites: 'site', scripts: 'script', workspaces: 'workspace', reviews: 'review',
  replies: 'reply', mentions: 'mention', tasks: 'task', jobs: 'job', events: 'event', words: 'word'
}
const COUNTED_RE = new RegExp(`(?<![\\d.,])\\b1 (${Object.keys(COUNTED_NOUNS).join('|')})\\b`, 'g')

export function singularizeOne(text: string): string {
  return text.replace(COUNTED_RE, (_match, noun: string) => `1 ${COUNTED_NOUNS[noun]}`)
}

export function pick(zh: string, en: string): string {
  return uiLang() === 'en-US' ? singularizeOne(en) : zh
}
