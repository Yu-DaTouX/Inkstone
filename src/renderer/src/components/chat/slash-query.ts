/**
 * `/` 命令补全的光标范围。
 *
 * 命令只在输入的第一个非空白 token 中触发：普通正文里的斜杠、URL、
 * 参数中的斜杠都不会打开命令菜单。范围只覆盖命令名，不覆盖前面的 `/`
 * 或后面的参数，这样接受候选时不会抹掉用户已经写好的内容。
 */
export interface SlashQueryRange {
  query: string
  start: number
  end: number
}

export function findSlashQuery(value: string, cursor: number = value.length): SlashQueryRange | null {
  const end = Math.max(0, Math.min(cursor, value.length))
  const before = value.slice(0, end)
  const match = /^[ \t]*\/([^\s]*)/.exec(before)
  if (!match) return null

  const query = match[1] ?? ''
  const slashOffset = (match[0].indexOf('/') >= 0 ? match[0].indexOf('/') : 0)
  const start = slashOffset + 1
  const tokenEnd = start + query.length

  /* 光标进入参数区后不再把参数误当作命令名。 */
  if (end > tokenEnd) return null
  return { query, start, end: tokenEnd }
}

/**
 * 替换命令名并保留前后正文/参数。
 * 没有后文时补一个空格，方便用户继续输入参数；已有参数时不插入第二个空格。
 */
export function replaceSlashQuery(
  value: string,
  range: SlashQueryRange,
  name: string
): { value: string; cursor: number } {
  const suffix = value.slice(range.end)
  const tail = suffix.length === 0 ? ' ' : ''
  const nextValue = `${value.slice(0, range.start)}${name}${tail}${suffix}`
  return { value: nextValue, cursor: range.start + name.length + tail.length }
}
