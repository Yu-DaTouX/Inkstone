/** N18 `/` 命令补全的光标范围与参数保留规则。 */
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

  ok(findSlashQuery('https://example.com/a/b', 23) === null, 'URL 中的斜杠不触发命令菜单')
  ok(findSlashQuery('普通文字 /model', '普通文字 /model'.length) === null, '普通正文中的斜杠不触发命令菜单')
}
