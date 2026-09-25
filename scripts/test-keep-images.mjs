/**
 * 「历史重读时保住本地图片预览」（state/keep-images.ts）的纯逻辑测试。
 *
 * 为什么单独钉住：这是用户报的「自动压缩后图片之类的预览看不到了」的修复点。
 * 它靠「消息 id + role + 文本」三重匹配把本地那份 base64 粘回 hydrate 推来的
 * 列表 —— 匹配太松会把图挂到别的消息上（分叉/切会话时序号会指向别的内容），
 * 太紧又等于没修。两个方向都要有断言。
 */
export async function runKeepImagesTests(ok) {
  const { keepLocalImages } = await import('../out/test/keep-images.mjs')

  console.log('\n--- 历史重读时保住本地图片预览 ---')

  const img = [{ mimeType: 'image/png', data: 'AAA' }]
  const user = (id, text, images) => ({ id, role: 'user', text, ...(images ? { images } : {}) })

  /* 压缩结束（hydrate）推来的那份没有图 → 本地这份粘回去 */
  {
    const prev = [user('m0', '看这个', img), user('m1', '继续')]
    const next = [user('m0', '看这个'), user('m1', '继续')]
    const out = keepLocalImages(prev, next)
    ok(out[0].images?.[0]?.data === 'AAA', 'hydrate 后本地图片预览被粘回')
    ok(out[1].images === undefined, '原本没有图的消息不会被加图')
  }

  /* 文本对不上（分叉 / 切会话让序号指向别的消息）→ 不粘 */
  {
    const prev = [user('m0', '旧的', img)]
    const next = [user('m0', '完全不同的内容')]
    ok(keepLocalImages(prev, next)[0].images === undefined, '文本对不上时不粘图（避免挂到别人的消息上）')
  }

  /* role 对不上 → 不粘 */
  {
    const prev = [{ id: 'm0', role: 'assistant', text: 'x', images: img }]
    ok(keepLocalImages(prev, [user('m0', 'x')])[0].images === undefined, 'role 对不上时不粘图')
  }

  /* 新列表自带图片（刚发完、还没走过 hydrate）→ 以新列表为准 */
  {
    const fresh = [{ mimeType: 'image/png', data: 'NEW' }]
    ok(
      keepLocalImages([user('m0', 'x', img)], [user('m0', 'x', fresh)])[0].images[0].data === 'NEW',
      '新列表自带图片时以它为准（不做双向合并）'
    )
  }

  /* data 被体积保护清空（非空数组但没数据）也算「缺图」 */
  {
    const empty = [{ mimeType: 'image/png', data: '' }]
    ok(
      keepLocalImages([user('m0', 'x', img)], [user('m0', 'x', empty)])[0].images[0].data === 'AAA',
      'data 被清空时也补回本地图'
    )
  }

  /* 落盘地址（历史重读的形态）也算可用 → 不拿本地的 data 去覆盖 */
  {
    const withUrl = [{ mimeType: 'image/png', data: '', url: 'file:///C:/x/a.png' }]
    const out = keepLocalImages([user('m0', 'x', img)], [user('m0', 'x', withUrl)])
    ok(out[0].images[0].url === 'file:///C:/x/a.png' && out[0].images[0].data === '', '已经落盘的消息保留 file:// 地址')
  }

  /* 无从可补 → 原样返回同一个引用（别制造无谓的重渲染） */
  {
    const next = [user('m0', 'x')]
    ok(keepLocalImages([], next) === next, '没有旧列表时原样返回')
    ok(keepLocalImages([user('m0', 'x')], next) === next, '旧列表里没有图时原样返回')
  }
}
