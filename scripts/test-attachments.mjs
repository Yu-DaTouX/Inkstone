/**
 * 图片附件目录的占用统计与清理（main/attachments.ts）测试。
 *
 * 为什么钉住 prune：它会**真的删文件**。判断标准是「这个附件的内容 sha1 有没有
 * 出现在任何会话文件里」—— 判松了会删掉用户还翻得到的图，判紧了目录只涨不清，
 * 两个方向都要有断言。另外钉住「不按时间删」：那条正是我们拒绝 TTL 的理由。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sha1 = (s) => createHash('sha1').update(s).digest('hex')

export async function runAttachmentTests(ok) {
  const { attachmentStem, attachmentsUsage, listSessionFiles, pruneAttachments, referencedAttachmentNames } =
    await import('../out/test/attachments.mjs')

  console.log('\n--- 图片附件：占用与清理 ---')

  const root = mkdtempSync(join(tmpdir(), 'yan-attach-test-'))
  try {
    ok(attachmentStem('deadbeef.png') === 'deadbeef', '文件名去掉后缀就是内容 sha1')
    ok(attachmentStem('noext') === 'noext', '没有后缀也原样返回')

    /* 占用统计：目录不存在不报错，也不创建 */
    const dir = join(root, 'attachments')
    const empty = attachmentsUsage(dir)
    ok(empty.files === 0 && empty.bytes === 0, '目录不存在时占用为 0')
    ok(!existsSync(dir), '统计占用不创建目录')

    mkdirSync(dir, { recursive: true })
    const used = sha1('USED')
    const stale = sha1('STALE')
    writeFileSync(join(dir, `${used}.png`), Buffer.from('USED'))
    writeFileSync(join(dir, `${stale}.png`), Buffer.from('STALEDATA'))
    const usage = attachmentsUsage(dir)
    ok(usage.files === 2 && usage.bytes === 13, '占用统计数出文件数与字节数')

    /* 会话文件列举：只认 .jsonl，且要走进嵌套目录 */
    const sessions = join(root, 'sessions')
    mkdirSync(join(sessions, 'a', 'b'), { recursive: true })
    writeFileSync(join(sessions, 'a', 'b', 'one.jsonl'), '')
    writeFileSync(join(sessions, 'two.jsonl'), '')
    writeFileSync(join(sessions, 'skip.txt'), '')
    ok(listSessionFiles(sessions).length === 2, '只收 .jsonl（嵌套目录也要走到）')

    /* 引用扫描：用户消息与工具结果里的图都算，坏行跳过 */
    writeFileSync(
      join(sessions, 'a', 'b', 'one.jsonl'),
      [
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'image', data: 'USED', mimeType: 'image/png' }] }
        }),
        '{ 坏 JSON',
        JSON.stringify({
          type: 'message',
          message: { role: 'toolResult', content: [{ type: 'image', data: 'TOOL', mimeType: 'image/png' }] }
        })
      ].join('\n')
    )
    const referenced = await referencedAttachmentNames(listSessionFiles(sessions))
    ok(referenced.has(sha1('USED')), '用户消息里的图算引用')
    ok(referenced.has(sha1('TOOL')), '工具结果里的图也算引用')
    ok(!referenced.has(stale), '没有会话引用的附件不在集合里')

    /* dryRun 只统计 */
    const dry = pruneAttachments(dir, referenced, { dryRun: true })
    ok(dry.removed === 1 && dry.kept === 1, 'dryRun 报告会删几个、留几个')
    ok(existsSync(join(dir, `${stale}.png`)), 'dryRun 不真的删')

    /* 真删 */
    const res = pruneAttachments(dir, referenced)
    ok(res.removed === 1 && res.bytes === Buffer.from('STALEDATA').length, '删掉未被引用的附件并报告释放量')
    ok(!existsSync(join(dir, `${stale}.png`)), '未被引用的文件真的消失')
    ok(existsSync(join(dir, `${used}.png`)), '仍被会话引用的附件留着')
    ok(readdirSync(dir).length === 1, '清理后目录只剩被引用的那份')

    /*
     * 不按时间删（这是拒绝 TTL 的理由本身）：把被引用文件的时间戳改到很早，
     * 它仍然必须留下。判据只有「有没有会话引用」，没有第二个维度。
     */
    utimesSync(join(dir, `${used}.png`), new Date(2000, 0, 1), new Date(2000, 0, 1))
    const again = pruneAttachments(dir, referenced)
    ok(again.removed === 0 && existsSync(join(dir, `${used}.png`)), '很旧的附件只要还被引用就不删')

    /* 目录不存在时清理不报错 */
    const missing = pruneAttachments(join(root, 'nope'), referenced)
    ok(missing.removed === 0 && missing.kept === 0, '目录不存在时清理空转')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
