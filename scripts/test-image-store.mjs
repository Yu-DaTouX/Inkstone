import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

export async function runImageStoreTests(ok) {
  console.log('\n--- 附件本地化：只落盘可渲染的图片类型 ---')
  const out = join('out', 'test', 'image-store.mjs')
  await build({
    entryPoints: ['src/main/image-store.ts'],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const { imageFile, localizeImage } = await import('../out/test/image-store.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'yan-image-store-'))
  try {
    const data = Buffer.from('image-bytes').toString('base64')
    for (const [mimeType, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']]) {
      ok((imageFile(dir, mimeType, data) ?? '').endsWith(`.${ext}`), `${mimeType} 使用 .${ext} 扩展名`)
      ok(localizeImage(dir, mimeType, data).startsWith('file:'), `${mimeType} 能本地化成 file 地址`)
    }
    for (const mimeType of ['image/svg+xml', 'image/bmp', 'image/avif', 'image/heic', 'image/tiff']) {
      ok(imageFile(dir, mimeType, data) === null, `${mimeType} 不生成无法渲染的 .bin 文件`)
      ok(localizeImage(dir, mimeType, data) === '', `${mimeType} 返回空 url，由调用方保留内联数据`)
    }
    const names = readdirSync(dir).sort()
    ok(names.length === 4, `只落盘 4 个可渲染文件（实际 ${names.length}）`)
    ok(names.every((name) => !name.endsWith('.bin')), '附件目录里没有 .bin 图片')
    const first = localizeImage(dir, 'image/png', data)
    ok(first === localizeImage(dir, 'image/png', data), '同一内容重复本地化复用同一文件')
    const other = Buffer.from('other-bytes').toString('base64')
    ok(localizeImage(dir, 'image/png', other) !== first, '不同内容使用不同文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
