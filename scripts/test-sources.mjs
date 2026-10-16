import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runSourcesTests(ok) {
  const {
    configureSources,
    sourcesDir,
    saveImage,
    registerFile,
    verifyFiles,
    listImagesForSession,
    listLinks,
    linkSources,
    removeImage,
    readImage,
    dropSession
  } = await import('../out/test/sources.mjs')

  const root = mkdtempSync(join(tmpdir(), 'yan-sources-'))
  configureSources({ dir: root })

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
  const pngB64 = pngBytes.toString('base64')
  const session = 'sess-abc'

  {
    const ref = saveImage({ sessionId: session, name: 'shot.png', mimeType: 'image/png', base64: pngB64 })
    ok(!!ref, '存一张图片返回了引用')
    ok(ref?.kind === 'image', 'kind 是 image', String(ref?.kind))
    ok(!!ref?.ref && existsSync(ref.ref), '文件真的在磁盘上（这就是"持久化"的全部意义）', String(ref?.ref))
    ok(/^[a-f0-9]{32}$/.test(ref?.fingerprint ?? ''), '指纹是 sha256 前 32 位（内容变了文件名就变）', String(ref?.fingerprint))
    ok((ref?.ref ?? '').startsWith(sourcesDir(session)), '落在**这个会话**的目录里（按会话隔离）')

    if (ref) {
      const onDisk = readFileSync(ref.ref)
      ok(Buffer.compare(onDisk, pngBytes) === 0, '磁盘上的字节与写入时逐字节一致')
    }

    const again = saveImage({ sessionId: session, name: 'shot.png', mimeType: 'image/png', base64: pngB64 })
    ok(again?.sourceId === ref?.sourceId, '同一份内容再存一次 → 同一个 sourceId（幂等）', String(again?.sourceId))
    ok(listImagesForSession(session).images.length === 1, '幂等：磁盘上只有一份（没堆第二份）', String(listImagesForSession(session).images.length))

    const listed = listImagesForSession(session)
    ok(listed.ok === true && listed.dir === sourcesDir(session), '列表回报的目录是会话目录', listed.dir)
    ok(listed.images[0]?.available === true, '列出来的每一份都标着 available')

    const back = readImage(session, ref.sourceId)
    ok(back.ok === true && back.mime === 'image/png', '读回来带对了 mime', String(back.mime))
    ok(Buffer.compare(Buffer.from(back.base64 ?? '', 'base64'), pngBytes) === 0, '读回来的字节与原来一致')

    const other = saveImage({ sessionId: session, name: 'shot2.png', mimeType: 'image/png', base64: Buffer.from([9, 9, 9]).toString('base64') })
    ok(other?.sourceId !== ref?.sourceId, '内容不同 → sourceId 不同')
    ok(listImagesForSession(session).images.length === 2, '现在有两份', String(listImagesForSession(session).images.length))

    const rm = removeImage(session, ref.sourceId)
    ok(rm.ok === true, '移除成功', String(rm.error))
    ok(!existsSync(ref.ref), '副本文件真的被删了')
    ok(listImagesForSession(session).images.length === 1, '列表里也少了一份', String(listImagesForSession(session).images.length))
    ok(removeImage(session, ref.sourceId).ok === false, '再删一次 → 如实报错（没有这份副本）')

    ok(saveImage({ sessionId: session, name: 'x.png', mimeType: 'image/png', base64: '' }) === null, '空内容 → 不存（不造空文件）')
  }

  {
    const a = saveImage({ sessionId: 'sess-a', name: 'a.png', mimeType: 'image/png', base64: pngB64 })
    const b = saveImage({ sessionId: 'sess-b', name: 'b.png', mimeType: 'image/png', base64: pngB64 })
    ok(listImagesForSession('sess-a').images.length === 1, '会话 a 只看到自己的', String(listImagesForSession('sess-a').images.length))
    ok((a?.ref ?? '').includes('sess-a') && (b?.ref ?? '').includes('sess-b'), '两份落在不同会话目录里')

    const evilDir = sourcesDir('../../etc')
    ok(!evilDir.split(/[\\/]/).includes('..'), '会话名里的 .. 被清洗（否则就是路径穿越）', evilDir)
    const evil = saveImage({ sessionId: '../../evil', name: 'e.png', mimeType: 'image/png', base64: pngB64 })
    ok((evil?.ref ?? '').startsWith(join(root, 'sources')), '穿越写的文件也被关在 sources 目录里', String(evil?.ref))

    ok(readImage(session, '../../secret').ok === false, '读的时候 id 形状不对 → 拒绝')
    ok(removeImage(session, '../x').ok === false, '删的时候 id 形状不对 → 拒绝')
    ok(removeImage(session, 'file:abc').ok === false, '文件引用的 id 拿来删 → 拒绝（我们从不删用户原文件）')
  }

  {
    const f = join(root, 'note.txt')
    writeFileSync(f, 'hello\n')
    const ref = registerFile({ sessionId: session, path: f })
    ok(!!ref, '登记一个真实存在的文件')
    ok(ref?.kind === 'file', 'kind 是 file', String(ref?.kind))
    ok(ref?.ref === f, '引用指向**用户的原文件**（我们不复制大文件）', String(ref?.ref))
    ok(/^\d+:\d+$/.test(ref?.fingerprint ?? ''), '指纹是 size:mtime（用来判断「还是原来那份吗」）', String(ref?.fingerprint))

    const verified = verifyFiles(session, [{ path: f, name: 'note.txt' }])
    ok(verified.length === 1 && verified[0].available === true, '复核：还在 → available', JSON.stringify(verified[0]?.available))

    const missing = verifyFiles(session, [{ path: join(root, 'gone.txt'), name: 'gone.txt' }])
    ok(missing.length === 1, '不存在的路径也返回一条（不是静默丢掉）', String(missing.length))
    ok(missing[0].available === false, '不存在 → available: false')
    ok(typeof missing[0].error === 'string' && missing[0].error.length > 0, '并保留原因（方案要求「获取失败可以重试并保留原因」）', String(missing[0].error))

    ok(registerFile({ sessionId: session, path: root }) === null, '目录不是文件 → 不登记')
    ok(registerFile({ sessionId: session, path: join(root, 'nope.txt') }) === null, '不存在的路径 → 不登记')
  }

  {
    const linked = linkSources({ sessionId: session, sourceIds: [`image:${'a'.repeat(32)}`], messageId: 'msg-1' })
    ok(linked.ok === true && linked.added === 1, '关联真的写进去了', JSON.stringify(linked))

    const file = join(sourcesDir(session), 'links.json')
    ok(existsSync(file), 'links.json 真的在会话目录里（不是只活在内存）', file)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    ok(Array.isArray(onDisk) && onDisk[0]?.messageId === 'msg-1', '磁盘上的内容就是刚才那条关联', JSON.stringify(onDisk))

    const again = linkSources({ sessionId: session, sourceIds: [`image:${'a'.repeat(32)}`], messageId: 'msg-1' })
    ok(again.added === 0, '同一对重复登记 → added: 0（幂等）', JSON.stringify(again))
    ok(listLinks(session).length === 1, '磁盘上仍然只有一条', String(listLinks(session).length))

    const batch = linkSources({
      sessionId: session,
      sourceIds: [`file:${'b'.repeat(24)}`, `web:web-1`, 'not-a-source', 'image:带空格 的'],
      messageId: 'msg-2'
    })
    ok(batch.ok === true && batch.added === 2, '合法的那两份进来了', JSON.stringify(batch))
    ok(batch.skipped === 2, '形状不对的进 skipped（不报错、也不静默算成功）', String(batch.skipped))

    const bad = linkSources({ sessionId: session, sourceIds: [`image:${'a'.repeat(32)}`], messageId: 'ms"g]' })
    ok(bad.ok === false && bad.added === 0, '消息 id 带不安全字符 → 拒绝（不是存进去再说）', JSON.stringify(bad))

    const listing = listImagesForSession(session)
    ok(Array.isArray(listing.links) && listing.links.length === 3, 'listImagesForSession 也带回了关联表', String(listing.links?.length))

    writeFileSync(file, '{ 这不是 JSON')
    ok(listLinks(session).length === 0, 'links.json 坏了 → 当空表（不让菜单整个报错）')

    const many = Array.from({ length: 520 }, (_, i) => ({ sourceId: `web:w-${i}`, messageId: `m-${i}`, at: i }))
    writeFileSync(file, JSON.stringify(many))
    linkSources({ sessionId: session, sourceIds: ['web:last'], messageId: 'm-last' })
    const capped = listLinks(session)
    ok(capped.length === 500, '超过上限 → 截到 500 条', String(capped.length))
    ok(capped[capped.length - 1]?.sourceId === 'web:last', '新记录在，丢的是最旧的')
  }

  {
    const dir = sourcesDir('sess-tmp')
    saveImage({ sessionId: 'sess-tmp', name: 't.png', mimeType: 'image/png', base64: pngB64 })
    ok(existsSync(dir), '会话目录建好了', dir)
    dropSession('sess-tmp')
    ok(!existsSync(dir), '会话被清理时它的图片副本也一起走了')
  }

  rmSync(root, { recursive: true, force: true })
}
