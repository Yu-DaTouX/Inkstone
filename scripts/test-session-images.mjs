/**
 * 「历史重读不截断图片 base64」的测试（`main/session-reader.ts` 的 `truncateDeep`）。
 *
 * 为什么单独钉住：`truncateDeep` 会递归截断**所有**超过 `MAX_TEXT`(64KB) 的
 * 字符串，而图片块的 `data` 恰好就是一段超大 base64 —— 被截断后交给
 * `localizeImage` 落盘，写出的是一个坏 PNG，前端 `<img>` 加载失败。
 * 用户看到的就是「自动压缩后图片预览没了」：压缩 / 切会话 / 重启都走 hydrate
 * 这条读文件的路径，而实时事件流不走，所以问题只在压缩后才暴露。
 *
 * 实测本机数据：546 张图里 **474 张（87%）**超过 64KB，合计 143MB ——
 * 也就是说这条路径下曾经绝大多数图片都是坏的。
 *
 * 两个方向都要钉死：
 *   · 图片 base64 必须**完整**送达 `localizeImage`；
 *   · 普通长文本必须**仍然被截断**（别为了修图把体积保护整体关掉）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一段 n 字节的可辨识字符串 */
const filler = (ch, bytes) => ch.repeat(bytes)

export async function runSessionImageTests(ok) {
  const { readSessionMessages } = await import('../out/test/session-reader.mjs')

  console.log('\n--- 历史重读：图片 base64 不被截断 ---')

  const dir = mkdtempSync(join(tmpdir(), 'yan-sessimg-test-'))
  const file = join(dir, 'sess.jsonl')

  /* 都超过 MAX_TEXT(64KB)，好让截断逻辑一定被触发 */
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
    /* ① 用户贴的图：和数据同一条消息里还有一段超长文本 */
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
    /* ② 工具结果里的图（`yan browser` 截图同形） */
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

    /* 消息里只留落盘地址，不留 base64 */
    const user = res.messages.find((m) => m.role === 'user')
    ok(!!user?.images?.[0]?.url, '用户图拿到了 file:// 地址')
    ok(user?.images?.[0]?.data === '', '用户图的消息里不留 base64')

    /* 同一处的长文本仍然必须被截断 —— 别为了修图把体积保护关掉 */
    ok(
      (user?.text?.length ?? 0) < bigText.length && (user?.text ?? '').includes('已截断'),
      '同一条消息里的超长文本仍然被截断并标记'
    )
    ok(res.truncated >= 1, `截断计数仍然算得出来（实际 ${res.truncated}）`)

    /*
     * 该丢的还是要丢：整行超过 MAX_LINE_BYTES 时跳过。
     * 这两条路径的边界必须分得清 —— 图片是「别截」，超大行是「别读」。
     */
    const huge = join(dir, 'huge.jsonl')
    writeFileSync(huge, filler('X', 49 * 1024 * 1024) + '\n', 'utf8')
    const hugeRes = await readSessionMessages(huge, { localizeImage: () => '' })
    ok(hugeRes?.total === 0, '超过单行上限的行仍然整行跳过')

    /* 坏行不毁整个会话 */
    writeFileSync(file, lines[0] + '\n{坏掉的 json\n' + lines[1] + '\n', 'utf8')
    const badRes = await readSessionMessages(file, { localizeImage: () => 'file:///x.png' })
    ok(badRes?.total === 1, '坏行被跳过，其余消息照读')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
