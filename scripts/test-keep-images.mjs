export async function runKeepImagesTests(ok) {
  const { keepLocalImages } = await import('../out/test/keep-images.mjs')

  console.log('\n--- 历史重读时保住本地图片预览 ---')

  const img = [{ mimeType: 'image/png', data: 'AAA' }]
  const user = (id, text, images) => ({ id, role: 'user', text, ...(images ? { images } : {}) })

  {
    const prev = [user('m0', '看这个', img), user('m1', '继续')]
    const next = [user('m0', '看这个'), user('m1', '继续')]
    const out = keepLocalImages(prev, next)
    ok(out[0].images?.[0]?.data === 'AAA', 'hydrate 后本地图片预览被粘回')
    ok(out[1].images === undefined, '原本没有图的消息不会被加图')
  }

  {
    const prev = [user('m0', '旧的', img)]
    const next = [user('m0', '完全不同的内容')]
    ok(keepLocalImages(prev, next)[0].images === undefined, '文本对不上时不粘图（避免挂到别人的消息上）')
  }

  {
    const prev = [{ id: 'm0', role: 'assistant', text: 'x', images: img }]
    ok(keepLocalImages(prev, [user('m0', 'x')])[0].images === undefined, 'role 对不上时不粘图')
  }

  {
    const fresh = [{ mimeType: 'image/png', data: 'NEW' }]
    ok(
      keepLocalImages([user('m0', 'x', img)], [user('m0', 'x', fresh)])[0].images[0].data === 'NEW',
      '新列表自带图片时以它为准（不做双向合并）'
    )
  }

  {
    const empty = [{ mimeType: 'image/png', data: '' }]
    ok(
      keepLocalImages([user('m0', 'x', img)], [user('m0', 'x', empty)])[0].images[0].data === 'AAA',
      'data 被清空时也补回本地图'
    )
  }

  {
    const withUrl = [{ mimeType: 'image/png', data: '', url: 'file:///C:/x/a.png' }]
    const out = keepLocalImages([user('m0', 'x', img)], [user('m0', 'x', withUrl)])
    ok(out[0].images[0].url === 'file:///C:/x/a.png' && out[0].images[0].data === '', '已经落盘的消息保留 file:// 地址')
  }

  {
    const next = [user('m0', 'x')]
    ok(keepLocalImages([], next) === next, '没有旧列表时原样返回')
    ok(keepLocalImages([user('m0', 'x')], next) === next, '旧列表里没有图时原样返回')
  }
}
