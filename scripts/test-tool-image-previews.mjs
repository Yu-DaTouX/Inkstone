import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { collectToolImagePreviews } = await compile('src/renderer/src/features/session/tool-image-previews.ts')
  const image = (data) => ({ mimeType: 'image/png', data })
  const call = (id, images) => ({ id, name: 'read', args: { path: id + '.png' }, status: 'ok', images })
  const calls = [call('one', [image('a'), image('b')]), call('two', [image('c'), image('d')])]
  const previews = collectToolImagePreviews(calls)
  ok(previews.length === 3, '汇总工具条最多三张')
  ok(previews.map((preview) => preview.image.data).join() === 'a,b,c', '按读取顺序选择图片')
  ok(previews[2].call === calls[1] && previews[2].index === 0, '图片保留具体所属调用和序号')
  ok(collectToolImagePreviews(calls, Infinity).length === 4, '具体工具行不裁掉同次调用的其他图片')
  ok(collectToolImagePreviews([call('empty'), call('invalid', [{ mimeType: 'image/png', data: '' }])]).length === 0, '无图片工具和空记录不生成占位')
  ok(collectToolImagePreviews([call('duplicate', [image('a'), image('a')])]).length === 1, '同图重复回传只在汇总条预览一次')
  const linked = { mimeType: 'image/png', data: '', url: 'file:///E:/fixture/image.png' }
  ok(collectToolImagePreviews([call('file', [linked])])[0].image === linked, '兼容本地文件URL图片，不要求内嵌数据')
  ok(collectToolImagePreviews(calls, 0).length === 0, '零上限不返回图片')
})
