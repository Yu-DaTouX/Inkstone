import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const filler = (ch, bytes) => ch.repeat(bytes)
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function loadImageActions() {
  const dir = mkdtempSync(join(tmpdir(), 'yan-image-actions-'))
  const abs = (rel) => join(ROOT, rel)
  const stubs = new Map([
    [abs('src/renderer/src/i18n/index.tsx'), 'export function useT(){ return (key) => key }'],
    [abs('src/renderer/src/state/store.ts'), 'export function useStore(selector){ return selector({ notify(){} }) }'],
    [abs('src/renderer/src/features/session/message-menu.ts'), 'export function openMessageMenu(){}'],
    [abs('src/renderer/src/features/composer/image-viewer.tsx'), 'export function ImageViewer(){ return null }']
  ])
  const result = await build({
    stdin: {
      contents: `export { imageFileSrc, imageMimeFromPath, imageDataMime, imageTransferDataUrl } from ${JSON.stringify(abs('src/renderer/src/features/session/Image.tsx'))}`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'stub-image-deps',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, (args) => {
          const target = resolve(args.resolveDir, args.path)
          const hit = [target, `${target}.tsx`, `${target}.ts`, `${target}/index.tsx`, `${target}/index.ts`]
            .find((candidate) => stubs.has(candidate))
          return hit ? { path: hit, namespace: 'stub' } : null
        })
        pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs.get(args.path),
          loader: 'tsx'
        }))
      }
    }]
  })
  const outfile = join(dir, 'image-actions.mjs')
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return { image: await import(pathToFileURL(outfile).href), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export async function runSessionImageTests(ok) {
  const { readSessionMessages } = await import('../out/test/session-reader.mjs')

  console.log('\n--- 历史重读：图片 base64 不被截断 ---')

  const dir = mkdtempSync(join(tmpdir(), 'yan-sessimg-test-'))
  const file = join(dir, 'sess.jsonl')

  const bigImage = filler('A', 200 * 1024)
  const smallImage = filler('C', 1024)
  const bigText = filler('B', 200 * 1024)

  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-img',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: 'C:/proj'
    }),
    JSON.stringify({
      type: 'message',
      id: 'e1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: bigText },
          { type: 'image', data: bigImage, mimeType: 'image/png' }
        ]
      }
    }),
    JSON.stringify({
      type: 'message',
      id: 'e2',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'image', data: smallImage, mimeType: 'image/png' }
        ]
      }
    })
  ]
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')

  try {
    const seen = []
    const res = await readSessionMessages(file, {
      localizeImage: (mimeType, data) => {
        seen.push({ mimeType, len: data.length })
        return `file:///C:/att/${seen.length}.png`
      }
    })

    ok(!!res, '会话文件能读出来')
    ok(seen.length === 2, `两张图都送到 localizeImage（实际 ${seen.length}）`)
    ok(
      seen[0]?.len === bigImage.length,
      `大图 base64 完整送达（原始 ${bigImage.length}，送达 ${seen[0]?.len}）`
    )
    ok(seen[1]?.len === smallImage.length, '小图 base64 完整送达')
    ok(seen[0]?.mimeType === 'image/png', 'mimeType 原样带过去')

    const user = res.messages.find((m) => m.role === 'user')
    ok(!!user?.images?.[0]?.url, '用户图拿到了 file:// 地址')
    ok(user?.images?.[0]?.data === '', '用户图的消息里不留 base64')

    ok(
      (user?.text?.length ?? 0) < bigText.length && (user?.text ?? '').includes('已截断'),
      '同一条消息里的超长文本仍然被截断并标记'
    )
    ok(res.truncated >= 1, `截断计数仍然算得出来（实际 ${res.truncated}）`)

    const huge = join(dir, 'huge.jsonl')
    writeFileSync(huge, filler('X', 49 * 1024 * 1024) + '\n', 'utf8')
    const hugeRes = await readSessionMessages(huge, { localizeImage: () => '' })
    ok(hugeRes?.total === 0, '超过单行上限的行仍然整行跳过')

    writeFileSync(file, lines[0] + '\n{坏掉的 json\n' + lines[1] + '\n', 'utf8')
    const badRes = await readSessionMessages(file, { localizeImage: () => 'file:///x.png' })
    ok(badRes?.total === 1, '坏行被跳过，其余消息照读')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('\n--- 图片右键复制/另存：本地文件与 data URL 取原始字节 ---')
  const { image, cleanup } = await loadImageActions()
  try {
    const fileSrc = 'file:///C:/shot/p%20x.PNG'
    ok(image.imageFileSrc(fileSrc) === 'C:/shot/p x.PNG', 'file:// 地址还原成本地路径')
    ok(image.imageFileSrc('data:image/png;base64,AA') === null, 'data URL 不当成本地路径')
    ok(image.imageFileSrc('https://example.com/a.png') === null, '远程地址不当成本地路径')
    ok(image.imageMimeFromPath('C:/shot/x.GIF') === 'image/gif', '按扩展名识别图片类型')
    ok(image.imageMimeFromPath('C:/shot/x.txt') === null, '非图片扩展名不给类型')
    ok(image.imageDataMime('data:image/webp;base64,AA') === 'image/webp', '可直接保存的 data URL 类型')

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    let rendered = 0
    let read = 0
    const fromFile = await image.imageTransferDataUrl(
      fileSrc,
      'C:/shot',
      'save',
      async (path, cwd) => {
        read += 1
        if (path !== 'C:/shot/p x.PNG' || cwd !== 'C:/shot') return { ok: false }
        return { ok: true, bytes }
      },
      async () => {
        rendered += 1
        return null
      }
    )
    ok(
      fromFile === `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      '本地图片直接读原始字节，不经 canvas 重编码'
    )
    ok(read === 1 && rendered === 0, '本地图片成功时不再走 canvas 回退')

    read = 0
    rendered = 0
    const passthrough = await image.imageTransferDataUrl(
      'data:image/gif;base64,R0lGOD',
      undefined,
      'save',
      async () => {
        read += 1
        return { ok: false }
      },
      async () => {
        rendered += 1
        return 'canvas'
      }
    )
    ok(passthrough === 'data:image/gif;base64,R0lGOD', 'data URL 原样透传（不重编码丢动图）')
    ok(read === 0 && rendered === 0, 'data URL 不读盘、不重编码')

    read = 0
    rendered = 0
    const copyGif = await image.imageTransferDataUrl(
      'data:image/gif;base64,R0lGOD',
      undefined,
      'copy',
      async () => {
        read += 1
        return { ok: false }
      },
      async () => {
        rendered += 1
        return 'data:image/png;base64,canvas'
      }
    )
    ok(copyGif === 'data:image/png;base64,canvas', '非 PNG 图片复制仍转成 PNG 再写剪贴板')
    ok(read === 0 && rendered === 1, '复制不读盘，统一由 canvas 出 PNG')

    read = 0
    rendered = 0
    const copyPng = await image.imageTransferDataUrl(
      'data:image/png;base64,QUJD',
      undefined,
      'copy',
      async () => {
        read += 1
        return { ok: false }
      },
      async () => {
        rendered += 1
        return 'canvas'
      }
    )
    ok(copyPng === 'data:image/png;base64,QUJD', 'PNG 复制保留原始字节')
    ok(read === 0 && rendered === 0, 'PNG 复制不经 canvas')

    read = 0
    rendered = 0
    let converted = 0
    const copyJpeg = await image.imageTransferDataUrl(
      'file:///C:/shot/photo.jpg',
      'C:/shot',
      'copy',
      async () => {
        read += 1
        return { ok: true, bytes: new Uint8Array([255, 216, 255]) }
      },
      async () => {
        rendered += 1
        return 'canvas'
      },
      async (input, mime) => {
        converted += 1
        return mime === 'image/jpeg' ? 'data:image/png;base64,converted' : null
      }
    )
    ok(copyJpeg === 'data:image/png;base64,converted', '本地 JPEG 复制用原始字节转 PNG')
    ok(read === 1 && converted === 1 && rendered === 0, '本地 JPEG 复制不依赖已渲染的 img 元素')

    read = 0
    rendered = 0
    const remote = await image.imageTransferDataUrl(
      'https://example.com/a.png',
      undefined,
      'save',
      async () => {
        read += 1
        return { ok: false }
      },
      async () => {
        rendered += 1
        return 'data:image/png;base64,fallback'
      }
    )
    ok(remote === 'data:image/png;base64,fallback', '远程图片仍走原有回退路径')
    ok(read === 0 && rendered === 1, '远程图片不触发本地读取')
  } finally {
    cleanup()
  }
}
