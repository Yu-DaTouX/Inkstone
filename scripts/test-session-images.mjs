import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const filler = (ch, bytes) => ch.repeat(bytes)

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
}
