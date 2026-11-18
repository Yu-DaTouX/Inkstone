import './lib/test-isolate.mjs'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const DAY = 24 * 60 * 60 * 1000
const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const imageLine = (data) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] } })

await runSuite(import.meta.url, async (ok, compile) => {
  const { autoPruneAttachments } = await compile('src/main/attachment-auto-prune.ts')
  const now = Date.now() + 31 * DAY
  const root = await mkdtemp(join(tmpdir(), 'inkstone-attach-auto-'))
  try {
    const attachments = join(root, 'attachments')
    const sessions = join(root, 'sessions')
    const subSessions = join(root, 'subagents', 'sessions')
    const trashedSessions = join(root, 'trash', 'sessions')
    const queue = join(root, 'queue-recovery')
    await mkdir(attachments, { recursive: true })
    await mkdir(join(sessions, 'proj'), { recursive: true })
    await mkdir(join(subSessions, 'sub-00000001'), { recursive: true })
    await mkdir(trashedSessions, { recursive: true })
    await mkdir(queue, { recursive: true })
    const file = (data) => join(attachments, `${sha1(data)}.png`)
    const put = async (data, ageDays) => {
      await writeFile(file(data), Buffer.from(data))
      const at = new Date(now - ageDays * DAY)
      await utimes(file(data), at, at)
    }
    await put('OLD_REFERENCED', 90)
    await put('OLD_SUBAGENT', 90)
    await put('OLD_TRASHED_SESSION', 90)
    await put('OLD_QUEUED', 90)
    await put('OLD_RECLAIMED', 90)
    await put('OLD_STALE', 90)
    await put('OLD_STALE_2', 60)
    await put('FRESH_STALE', 5)
    await writeFile(join(sessions, 'proj', 'a.jsonl'), [JSON.stringify({ type: 'session' }), imageLine('OLD_REFERENCED')].join('\n') + '\n')
    await writeFile(join(subSessions, 'sub-00000001', 'b.jsonl'), imageLine('OLD_SUBAGENT') + '\n')
    await writeFile(join(trashedSessions, '100-token-0-c.jsonl'), imageLine('OLD_TRASHED_SESSION') + '\n')
    await writeFile(join(queue, 's1.json'), JSON.stringify({ version: 2, sessionId: 's1', items: { steering: [], followUp: [{ text: 'x', images: [{ data: 'OLD_QUEUED', mimeType: 'image/png' }] }] } }))
    await writeFile(join(queue, 's2.json.reclaimed'), JSON.stringify({ version: 2, sessionId: 's2', items: { steering: [{ text: 'y', images: [{ data: 'OLD_RECLAIMED', mimeType: 'image/png' }] }], followUp: [] } }))

    const trashed = []
    const logs = []
    const base = {
      attachmentsDir: attachments,
      sessionDirs: [sessions, subSessions, trashedSessions],
      queueDir: queue,
      now: () => now,
      log: (line) => logs.push(line)
    }
    const fakeTrash = async (path) => { trashed.push(path) }

    const busy = await autoPruneAttachments({ ...base, isBusy: () => true, trash: fakeTrash })
    ok(busy.status === 'busy' && trashed.length === 0, '有回合在跑时不扫描、不清理')

    let calls = 0
    const changed = await autoPruneAttachments({ ...base, isBusy: () => false, trash: fakeTrash })
    ok(changed.status === 'done', '正常扫描完成', JSON.stringify(changed))
    ok(trashed.length === 2 && trashed.includes(file('OLD_STALE')) && trashed.includes(file('OLD_STALE_2')), '只把没被引用且超过 30 天的附件交给回收站', trashed.join(','))
    ok([file('OLD_REFERENCED'), file('OLD_SUBAGENT'), file('OLD_QUEUED'), file('OLD_RECLAIMED'), file('FRESH_STALE')].every((path) => !trashed.includes(path)), '被主会话、子代理会话、排队中与待恢复队列引用的，以及新鲜的都不动')
    ok(!trashed.includes(file('OLD_TRASHED_SESSION')), '只被回收站会话引用的旧附件仍保留供撤销删除')
    ok(existsSync(file('OLD_STALE')) && existsSync(file('OLD_STALE_2')), '清理只经回收站接口，不会直接删除文件')
    ok(logs.some((line) => /moved 2 unreferenced attachments older than 30 days to the Recycle Bin/.test(line)), '清理后记一行日志', logs.join(' | '))
    trashed.length = 0
    logs.length = 0
    calls = 0

    const failing = await autoPruneAttachments({ ...base, isBusy: () => false, trash: async (path) => { calls++; if (path === file('OLD_STALE')) throw new Error('locked'); trashed.push(path) } })
    ok(failing.status === 'done' && failing.removed === 1 && failing.failed === 1 && calls === 2, '移到回收站失败的跳过并继续下一个', JSON.stringify(failing))
    ok(existsSync(file('OLD_STALE')) && logs.some((line) => /moving to the Recycle Bin failed, skipped/.test(line)), '失败的文件原样留着并记日志', logs.join(' | '))
    trashed.length = 0

    let checks = 0
    const midRun = await autoPruneAttachments({ ...base, isBusy: () => ++checks > 1, trash: fakeTrash })
    ok(midRun.status === 'busy' && trashed.length === 0, '扫描期间回合开始：放弃本次清理')

    let turnStarted = false
    const stopped = await autoPruneAttachments({ ...base, isBusy: () => turnStarted, trash: async (path) => { trashed.push(path); turnStarted = true } })
    ok(stopped.status === 'done' && stopped.stopped && trashed.length === 1, '清理途中回合开始：立刻停下，剩下的不动', JSON.stringify(stopped))
    trashed.length = 0

    let calls2 = 0
    const append = join(sessions, 'proj', 'a.jsonl')
    const raced = await autoPruneAttachments({
      ...base,
      isBusy: () => {
        calls2++
        if (calls2 === 2) appendFileSync(append, imageLine('OLD_STALE') + '\n')
        return false
      },
      trash: fakeTrash
    })
    ok(raced.status === 'changed' && trashed.length === 0, '扫描期间会话写入了新消息：本次不清理，等下次重扫', JSON.stringify(raced))
    const rescanned = await autoPruneAttachments({ ...base, isBusy: () => false, trash: fakeTrash })
    ok(rescanned.status === 'done' && !trashed.includes(file('OLD_STALE')) && trashed.includes(file('OLD_STALE_2')), '重扫后新引用的附件被保留', trashed.join(','))
    trashed.length = 0

    const { referencedAttachmentNames } = await compile('src/main/attachments.ts')
    const many = join(root, 'many')
    await mkdir(many, { recursive: true })
    const paths = []
    for (let i = 0; i < 20; i++) {
      const path = join(many, `s${i}.jsonl`)
      await writeFile(path, Array.from({ length: 2000 }, (_, n) => (n === 7 ? imageLine(`BIG${i}`) : JSON.stringify({ type: 'message', n, text: 'x'.repeat(200) }))).join('\n'))
      paths.push(path)
    }
    let ticks = 0
    let ticking = true
    const spin = () => { if (!ticking) return; ticks++; setImmediate(spin) }
    setImmediate(spin)
    const refs = await referencedAttachmentNames(paths)
    ticking = false
    ok(refs.size === 20 && refs.has(sha1('BIG3')), '流式逐行扫描仍能找出所有引用')
    ok(ticks >= 20, '大批会话文件扫描期间事件循环持续让出（不长时间阻塞主线程）', String(ticks))

    const corrupt = join(subSessions, 'sub-00000001', 'corrupt.jsonl')
    await writeFile(corrupt, '{"type":"message","text":"\u0000 broken\n' + '\n' + imageLine('OLD_STALE_2') + '\n')
    const tolerated = await autoPruneAttachments({ ...base, isBusy: () => false, trash: fakeTrash })
    ok(tolerated.status === 'done' && !trashed.includes(file('OLD_STALE_2')), '损坏但不含图片的行跳过，其余行里的引用照常保留', JSON.stringify(tolerated))
    trashed.length = 0
    await writeFile(corrupt, '{"type":"image","data":"OLD_STALE_2' + '\n')
    let refused = false
    await autoPruneAttachments({ ...base, isBusy: () => false, trash: fakeTrash }).catch(() => { refused = true })
    ok(refused && trashed.length === 0, '损坏且可能含图片的行：停止本次清理，一个都不动')
    await rm(corrupt, { force: true })

    const { corruptLineMayHoldImage } = await compile('src/main/attachments.ts')
    for (const [line, label] of [
      ['{"x":"see attachments/abc.png', 'attachments'],
      ['{"content":[{"data":"iVBOR', '"data"'],
      ['{"mime":"x;base64,', 'base64'],
      ['{"blob":"' + 'A'.repeat(300), '连续 256 个以上 base64 字符']
    ]) ok(corruptLineMayHoldImage(line), `损坏行含 ${label} 时按可能含图片处理`)
    ok(!corruptLineMayHoldImage('{"type":"message","text":"潭湵 garbled'), '纯乱码、无图片线索的损坏行才跳过')
    for (const hint of ['{"note":"attachments/x.png', '{"content":[{"data":"AAAA']) {
      await writeFile(corrupt, hint + '\n')
      let stopped = false
      await autoPruneAttachments({ ...base, isBusy: () => false, trash: fakeTrash }).catch(() => { stopped = true })
      ok(stopped && trashed.length === 0, `会话里损坏行带图片线索（${hint.slice(0, 18)}）：整次放弃`)
    }
    await rm(corrupt, { force: true })

    await writeFile(join(queue, 'broken.json'), '{"version":2,"items":')
    let queueRefused = false
    await autoPruneAttachments({ ...base, isBusy: () => false, trash: fakeTrash }).catch(() => { queueRefused = true })
    ok(queueRefused && trashed.length === 0, '排队记录解析失败：整次放弃，不当作没有引用')
    await rm(join(queue, 'broken.json'), { force: true })

    const empty = await autoPruneAttachments({ ...base, attachmentsDir: join(root, 'missing'), isBusy: () => false, trash: fakeTrash })
    ok(empty.status === 'empty', '附件目录不存在时空转')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
