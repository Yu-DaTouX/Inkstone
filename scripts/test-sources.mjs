/**
 * 会话来源的持久化引用单测（方案 §8 的 S1）。
 *
 * ── 这一批测什么 ──
 * 核查结论是「现有附件链不持久化」（图片是内存 base64），所以这一层的存在意义
 * 就是**字节真的落到磁盘上**。所以断言不看返回值好看不好看，而是：
 *   · 文件真的在，字节与写入时一致（读回来 `Buffer.compare`）
 *   · 同一份内容幂等（重复粘贴不会在磁盘上堆第二份）
 *   · **移除只删我们自己的副本**，绝不碰用户的原文件
 *   · 路径穿越（`../../x`、`..\\x`）进不来
 *
 * 全部在临时数据目录里跑（`configureSources` 注入）—— 单测绝不碰用户真实数据。
 */
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
    removeImage,
    readImage,
    dropSession
  } = await import('../out/test/sources.mjs')

  const root = mkdtempSync(join(tmpdir(), 'yan-sources-'))
  configureSources({ dir: root })

  /* 一张 4×4 的假 PNG（只要字节是确定的，内容不重要） */
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
  const pngB64 = pngBytes.toString('base64')
  const session = 'sess-abc'

  /* ── 1. 图片：真的落盘 + 幂等 ─────────────────────────── */
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

    /* 换一份内容 → 新的 sourceId（指纹变了） */
    const other = saveImage({ sessionId: session, name: 'shot2.png', mimeType: 'image/png', base64: Buffer.from([9, 9, 9]).toString('base64') })
    ok(other?.sourceId !== ref?.sourceId, '内容不同 → sourceId 不同')
    ok(listImagesForSession(session).images.length === 2, '现在有两份', String(listImagesForSession(session).images.length))

    /* 移除：只删副本 */
    const rm = removeImage(session, ref.sourceId)
    ok(rm.ok === true, '移除成功', String(rm.error))
    ok(!existsSync(ref.ref), '副本文件真的被删了')
    ok(listImagesForSession(session).images.length === 1, '列表里也少了一份', String(listImagesForSession(session).images.length))
    ok(removeImage(session, ref.sourceId).ok === false, '再删一次 → 如实报错（没有这份副本）')

    /* 空 base64 不该造出一个空文件 */
    ok(saveImage({ sessionId: session, name: 'x.png', mimeType: 'image/png', base64: '' }) === null, '空内容 → 不存（不造空文件）')
  }

  /* ── 2. 会话隔离 + 路径穿越 ───────────────────────────── */
  {
    const a = saveImage({ sessionId: 'sess-a', name: 'a.png', mimeType: 'image/png', base64: pngB64 })
    const b = saveImage({ sessionId: 'sess-b', name: 'b.png', mimeType: 'image/png', base64: pngB64 })
    ok(listImagesForSession('sess-a').images.length === 1, '会话 a 只看到自己的', String(listImagesForSession('sess-a').images.length))
    ok((a?.ref ?? '').includes('sess-a') && (b?.ref ?? '').includes('sess-b'), '两份落在不同会话目录里')

    /* 穿越尝试：目录名要被清洗掉 */
    const evilDir = sourcesDir('../../etc')
    /*
     * 判据要落在**路径段**上，不是字符串包含 —— 清洗后的名字里仍然有 ".." 这两个
     * 字符（".._.._etc"），但它已经是一个普通目录名，不再是「上一级」。
     */
    ok(!evilDir.split(/[\\/]/).includes('..'), '会话名里的 .. 被清洗（否则就是路径穿越）', evilDir)
    const evil = saveImage({ sessionId: '../../evil', name: 'e.png', mimeType: 'image/png', base64: pngB64 })
    ok((evil?.ref ?? '').startsWith(join(root, 'sources')), '穿越写的文件也被关在 sources 目录里', String(evil?.ref))

    /* 读/删的 id 形状校验 */
    ok(readImage(session, '../../secret').ok === false, '读的时候 id 形状不对 → 拒绝')
    ok(removeImage(session, '../x').ok === false, '删的时候 id 形状不对 → 拒绝')
    ok(removeImage(session, 'file:abc').ok === false, '文件引用的 id 拿来删 → 拒绝（我们从不删用户原文件）')
  }

  /* ── 3. 文件引用：登记、指纹、丢了要如实报 ────────────── */
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

  /* ── 4. 会话数据清理 ─────────────────────────────────── */
  {
    const dir = sourcesDir('sess-tmp')
    saveImage({ sessionId: 'sess-tmp', name: 't.png', mimeType: 'image/png', base64: pngB64 })
    ok(existsSync(dir), '会话目录建好了', dir)
    dropSession('sess-tmp')
    ok(!existsSync(dir), '会话被清理时它的图片副本也一起走了')
  }

  rmSync(root, { recursive: true, force: true })
}
