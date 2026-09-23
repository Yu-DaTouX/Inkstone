/** 短标题（U-3a/H-10a 复用）的纯函数测试。 */
export async function runShortTitleTests(ok) {
  const { shortTitle } = await import('../out/test/short-title.mjs')

  console.log('\n--- U-3a 短标题 ---')
  ok(shortTitle('会话标题').short === '会话标题' && !shortTitle('会话标题').truncated, '短文本原样返回')
  ok(shortTitle('').short === '', '空文本返回空串（调用方兜底）')
  ok(shortTitle(undefined).short === '' && shortTitle(null).short === '', 'null/undefined 返回空串')
  ok(shortTitle('a\n\nb   c').short === 'a b c', '换行与多余空白压成一行')
  ok(shortTitle('<b>粗体</b>标题').short === '粗体标题', '去掉标签')
  const long = shortTitle('一二三四五六七八九十一二三四五六七八九十', 10)
  ok(long.truncated && long.short.length === 11 && long.short.endsWith('…'), '超长按上限截断并加省略号')
  const emoji = shortTitle('🧑‍💻🧑‍💻🧑‍💻🧑‍💻', 2)
  ok(emoji.short === '🧑‍💻🧑‍💻…' && !emoji.short.includes('\uFFFD'), '按字素截断，不切坏 emoji（ZWJ 序列）')
  ok(shortTitle('🇨🇳🇨🇳🇨🇳', 2).short === '🇨🇳🇨🇳…', '不切坏区域指示符旗帜')
}
