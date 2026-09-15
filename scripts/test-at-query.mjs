/** N19 @ 文件引用的光标范围与替换规则。 */
export function runAtQueryTests(ok, atQuery) {
  const { findAtQuery, replaceAtQuery } = atQuery

  const simpleText = '请看 @src/main'
  const simple = findAtQuery(simpleText, simpleText.length)
  ok(simple?.query === 'src/main', '路径补全支持普通斜杠路径')
  ok(simple?.start === 4 && simple?.end === simpleText.length, '范围只覆盖 @ 后面的 token')

  const bare = findAtQuery('@', 1)
  ok(bare?.query === '' && bare?.start === 1 && bare?.end === 1, '裸 @ 也能定位到当前引用')

  const oneChar = findAtQuery('@中', 2)
  ok(oneChar?.query === '中', '单字符前缀也能触发路径查询')

  const email = findAtQuery('联系 dev@example.com', '联系 dev@example.com'.length)
  ok(email === null, '邮箱地址不会误触发文件引用')

  const url = findAtQuery('打开 https://example.com/@docs', '打开 https://example.com/@docs'.length)
  ok(url === null, 'URL 中的 @ 不会误触发文件引用')

  const escaped = findAtQuery('字面量 \\@not-a-file', '字面量 \\@not-a-file'.length)
  ok(escaped === null, '反斜杠转义的 @ 不会触发文件引用')

  const chineseText = '请看 @我的 文件(1).md'
  const chinese = findAtQuery(chineseText, chineseText.length)
  ok(chinese?.query === '我的 文件(1).md', '路径补全支持中文、空格和括号')

  const quotedText = '请看 @"src/我的 文件(1).md"'
  const quoted = findAtQuery(quotedText, quotedText.length)
  ok(quoted?.query === 'src/我的 文件(1).md' && quoted.quoted, '带引号的路径会去除包裹引号')

  const singleQuotedText = "请看 @'src/我的 文件(1).md'"
  const singleQuoted = findAtQuery(singleQuotedText, singleQuotedText.length)
  ok(singleQuoted?.query === 'src/我的 文件(1).md' && singleQuoted.quote === "'", '单引号路径保留原始引号类型')

  const secondText = '@one.txt 和 @src/ma'
  const second = findAtQuery(secondText, secondText.length)
  ok(second?.query === 'src/ma', '多处引用时只补全光标所在的最后一处')

  const middle = findAtQuery('@one.txt 和 @src/ma 后面的文字', secondText.length)
  ok(middle?.query === 'src/ma', '光标不在文本末尾时仍按光标位置解析')

  if (second) {
    const replaced = replaceAtQuery('@one.txt 和 @src/ma 后面的文字', second, 'src/main/agent.ts')
    ok(
      replaced.value === '@one.txt 和 @src/main/agent.ts 后面的文字' &&
        replaced.cursor === '@one.txt 和 @src/main/agent.ts'.length,
      '替换保留前后正文并把光标放在候选路径末尾'
    )
  }

  const quotedReplacement = replaceAtQuery(
    quotedText,
    quoted,
    'src/new name.md'
  )
  ok(quotedReplacement.value === '请看 @"src/new name.md"', '带空格的候选路径保持引号')

  if (singleQuoted) {
    const singleReplacement = replaceAtQuery(singleQuotedText, singleQuoted, 'src/new name.md')
    ok(singleReplacement.value === "请看 @'src/new name.md'", '替换时沿用单引号路径')
  }
}
