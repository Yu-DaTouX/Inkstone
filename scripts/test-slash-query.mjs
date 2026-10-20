export function runSlashQueryTests(ok, slashQuery) {
  const { findSlashQuery, replaceSlashQuery } = slashQuery

  const bare = findSlashQuery('/', 1)
  ok(bare?.query === '' && bare?.start === 1 && bare?.end === 1, '裸 / 显示命令候选')

  const partial = findSlashQuery('/mod', 4)
  ok(partial?.query === 'mod', '命令名按光标位置识别')

  const withArgs = '/mod old argument'
  const beforeArgs = findSlashQuery(withArgs, 4)
  ok(beforeArgs?.query === 'mod', '光标在命令名后、参数前仍可补全')
  const afterArgs = findSlashQuery(withArgs, withArgs.length)
  ok(afterArgs === null, '光标进入参数区后不误开命令菜单')

  const replaced = replaceSlashQuery(withArgs, beforeArgs, 'model')
  ok(
    replaced.value === '/model old argument' && replaced.cursor === '/model'.length,
    '补全只替换命令名并保留参数与光标位置'
  )

  const completed = replaceSlashQuery('/mod', partial, 'model')
  ok(completed.value === '/model ' && completed.cursor === completed.value.length, '无参数时补一个尾空格')

  const indented = '  /mod'
  ok(findSlashQuery(indented, indented.length)?.start === 3, '行首缩进后的 / 仍触发，范围不含缩进')

  const middle = 'hello /mod'
  const middleRange = findSlashQuery(middle, middle.length)
  ok(
    middleRange?.query === 'mod' && middleRange.start === 7,
    '行中空白后的 / 也触发（hello /mod）'
  )
  ok(findSlashQuery('hello 后面 /mod 继续', 'hello 后面 /mod'.length)?.query === 'mod', '中文正文后的 / 也按同一规则触发')
  ok(findSlashQuery('普通文字/model', '普通文字/model'.length) === null, '紧贴正文的 / 不触发')
  ok(findSlashQuery('https://example.com/a/b', 23) === null, 'URL 中的斜杠不触发命令菜单')
  ok(findSlashQuery('/ ', 2) === null, '/ 后跟空格不触发')
  ok(findSlashQuery('hello /', 'hello /'.length) === null, '行中裸 / 不触发（中段需以字母或数字开头）')
  ok(findSlashQuery(`/${'a'.repeat(51)}`, 52) === null, '命令名超过 50 字符不触发')
  ok(findSlashQuery(`/${'a'.repeat(50)}`, 51)?.query.length === 50, '命令名刚好 50 字符仍触发')
  ok(findSlashQuery('/mod', 4, { inCode: true }) === null, '代码块或行内码里不触发')
  ok(findSlashQuery('/mod', 4, {})?.query === 'mod', '默认参数下触发器行为不变')
  const multi = '/first\n/second'
  ok(findSlashQuery(multi, multi.length)?.start === 8, '多行时只看光标所在行')
  ok(findSlashQuery(multi, 6)?.query === 'first', '光标在上一行时仍按该行解析')
}
