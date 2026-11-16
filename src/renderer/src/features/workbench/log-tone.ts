const STAMP = String.raw`\[[^\]]*\]|\(node:\d+\)|[✘▲✖⚠]|\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`
const PREFIX = String.raw`^\s*(?:(?:${STAMP})\s*)*`
const FAIL_LINE = new RegExp(`${PREFIX}(?:\\[(?:error|错误)\\]|npm ERR!|Traceback \\(most recent|(?:\\w*error(?:\\s*\\[[^\\]]*\\])?|fatal|错误)\\s*[:：])`, 'i')
const WARN_LINE = new RegExp(`${PREFIX}(?:\\[(?:warn|warning|警告)\\]|npm WARN\\b|\\w*warning\\b|(?:warn|警告)\\s*[:：])`, 'i')
const MARK_FAIL = /^\s*[✘✖]/
const MARK_WARN = /^\s*[▲⚠]/

export type LogTone = 'fail' | 'warn' | undefined

export function logLineTone(text: string): LogTone {
  if (FAIL_LINE.test(text)) return 'fail'
  if (WARN_LINE.test(text)) return 'warn'
  if (MARK_FAIL.test(text)) return 'fail'
  if (MARK_WARN.test(text)) return 'warn'
  return undefined
}
