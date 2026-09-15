/**
 * `@` 文件引用的光标范围。
 *
 * 这个范围只覆盖 `@` 后面的 token，不覆盖 `@` 本身：这样替换时可以
 * 保留用户写在前面的正文，同时可以把带空格的路径包回引号。
 */
export interface AtQueryRange {
  query: string
  start: number
  end: number
  quoted: boolean
  /** 原文使用单引号时，替换候选也沿用单引号。 */
  quote?: '"' | "'"
}

/**
 * 找到光标前最后一个文件引用 token。
 *
 * 不用 `\\w` 限制字符：Windows 路径、中文、空格、括号都是合法的文件名。
 * `@` 仍需出现在一个自然的 token 边界后，避免把邮箱或普通单词里的
 * `foo@bar` 误判成文件引用。扫描只看光标左侧，所以一句话中多个引用、
 * 以及光标回移到中间编辑都不会误取末尾的另一段文字。
 */
export function findAtQuery(value: string, cursor: number = value.length): AtQueryRange | null {
  const end = Math.max(0, Math.min(cursor, value.length))
  const isBoundary = (char: string | undefined): boolean =>
    !char || /[\s([{<'"：:;,，]/.test(char)
  const isEscaped = (at: number): boolean => {
    let slashes = 0
    for (let i = at - 1; i >= 0 && value[i] === '\\'; i -= 1) slashes += 1
    return slashes % 2 === 1
  }

  /* 从光标向左找最后一个合法的 @，因此多个引用和句中光标都可用。 */
  let at = -1
  for (let i = end - 1; i >= 0; i -= 1) {
    if (value[i] !== '@' || isEscaped(i) || !isBoundary(value[i - 1])) continue
    at = i
    break
  }
  if (at < 0) return null

  const tokenStart = at + 1
  const first = value[tokenStart]
  if (first === '"' || first === "'") {
    /* 引号路径允许空格；光标在闭引号后时把整对引号纳入替换范围。 */
    for (let i = tokenStart + 1; i < end; i += 1) {
      if (value[i] !== first || isEscaped(i)) continue
      const after = value.slice(i + 1, end)
      if (!after || /^[\s)\]}>,.;:!?，。！？]*$/.test(after)) {
        return {
          query: value.slice(tokenStart + 1, i),
          start: tokenStart,
          end: i + 1,
          quoted: true,
          quote: first
        }
      }
    }
    return {
      query: value.slice(tokenStart + 1, end),
      start: tokenStart,
      end,
      quoted: true,
      quote: first
    }
  }

  /*
   * 不用 \\w 限制字符：中文、空格、括号、点号和 Windows 分隔符都是合法
   * 文件名。空格路径在没有引号时也先保留（兼容用户逐字输入），替换时
   * 会自动加双引号；正式发送前仍由 pi 的文件引用语义决定是否读取。
   */
  return { query: value.slice(tokenStart, end), start: tokenStart, end, quoted: false }
}

/** 用候选路径替换范围，并返回适合继续输入的下一个光标位置。 */
export function replaceAtQuery(value: string, range: AtQueryRange, path: string): { value: string; cursor: number } {
  const quote = range.quoted || /\s/.test(path)
  const quoteChar = range.quote ?? '"'
  const replacement = quote ? `${quoteChar}${path}${quoteChar}` : path
  const nextValue = `${value.slice(0, range.start)}${replacement}${value.slice(range.end)}`
  return { value: nextValue, cursor: range.start + replacement.length }
}
