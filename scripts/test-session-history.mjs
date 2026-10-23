import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function runSessionHistoryTests(ok, history, chainService) {
  console.log('\n--- 实施-05 S5b-4 链感知历史（按段拼接） ---')

  const root = await mkdtemp(join(tmpdir(), 'yan-session-history-'))
  const sessions = join(root, 'sessions')
  await mkdir(sessions, { recursive: true })

  const writeSession = async (name, id, texts, cwd) => {
    const path = join(sessions, name)
    await mkdir(dirname(path), { recursive: true })
    const lines = [JSON.stringify({ type: 'session', id, ...(cwd ? { cwd } : {}) })]
    for (const text of texts) {
      lines.push(JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }))
    }
    await writeFile(path, lines.join('\n') + '\n', 'utf8')
    return path
  }

  try {
    const chains = new chainService.SessionChainStore({ root: join(root, 'data') })
    const single = await writeSession('single.jsonl', 's-single', ['只有这一段'], 'C:\\workspace\\single')

    const one = await history.readChainMessages(single, chains)
    ok(one?.messages.length === 1 && one.messages[0].text === '只有这一段', '不在链上 → 读单文件（行为与以前一致）')
    ok(one?.segments === 1 && one.missing === 0, `记为 1 段、无缺失（实际 ${one?.segments}/${one?.missing}）`)
    ok(one?.sourceCwd === 'C:\\workspace\\single', '单文件结果读出 session header cwd')
    ok(one?.messages[0]?.sourceCwd === one?.sourceCwd, '单文件消息保留自己的来源目录')

    const noStore = await history.readChainMessages(single, null)
    ok(noStore?.messages.length === 1, '没传链 store 时等价单文件（调用方不必都认识链）')

    const a = await writeSession('a.jsonl', 's-a', ['第一段的问题', '第一段的回答'], 'C:\\worktrees\\old')
    const b = await writeSession('b.jsonl', 's-b', ['续接后的第一句'], 'C:\\worktrees\\new')
    await chains.link(a, b, 'h-1')
    const joined = await history.readChainMessages(b, chains)
    ok(joined?.messages.length === 3, `两段拼起来 3 条（实际 ${joined?.messages.length}）`)
    ok(new Set(joined.messages.map(m => m.id)).size === joined.messages.length, '链式历史消息 ID 不跨段冲突')
    ok(joined.messages[0].id.startsWith('history:s-a:') && joined.messages.at(-1).id === 'm0', '旧段有来源前缀，活动段保留实时 m0 编号')
    const livePatched = joined.messages.map(m => m.id === 'm0' ? { ...m, text: '新的实时输出' } : m)
    ok(livePatched[0].text === '第一段的问题', '目的段实时更新不会覆盖源段用户消息')
    ok(joined.messages[0].text === '第一段的问题', '旧段在前（顺序不能倒）')
    ok(joined.messages.at(-1).text === '续接后的第一句', '新段在后')
    ok(
      joined.messages[0].sourceCwd === 'C:\\worktrees\\old' &&
        joined.messages[1].sourceCwd === 'C:\\worktrees\\old' &&
        joined.messages[2].sourceCwd === 'C:\\worktrees\\new',
      '链式消息逐段保留各自的工作树根目录'
    )
    ok(joined.segments === 2 && joined.missing === 0, `记为 2 段、无缺失（实际 ${joined.segments}/${joined.missing}）`)
    ok(joined.sessionId === 's-b', `sessionId 取最后一段（实际 ${joined.sessionId}）`)
    ok(joined.total === 3, 'total 是两段的合计')

    const hydrated = await history.readChainMessages(b, chains, async (_file, messages) =>
      messages.map((message) => ({ ...message, text: `${message.text}（hydrated）` }))
    )
    ok(
      hydrated?.messages[0]?.sourceCwd === 'C:\\worktrees\\old' &&
        hydrated.messages[2]?.sourceCwd === 'C:\\worktrees\\new',
      'artifact / message hydration 后来源目录仍逐段保留'
    )

    const legacy = await writeSession('legacy.jsonl', 's-legacy', ['旧格式缺 cwd'])
    const legacyRead = await history.readChainMessages(legacy, chains)
    ok(!legacyRead?.sourceCwd && !legacyRead?.messages[0]?.sourceCwd, '旧 session header 缺 cwd 时保留缺省来源')

    const fromOld = await history.readChainMessages(a, chains)
    ok(fromOld?.messages.length === 3 && fromOld.messages[0].text === '第一段的问题', '从旧段打开也拿到完整时间线')

    const c = await writeSession('c.jsonl', 's-c', ['第三段'])
    await chains.link(b, c, 'h-2')
    await rm(b)
    const partial = await history.readChainMessages(c, chains)
    ok(partial?.messages.length === 3, `缺一段仍返回可读的部分（实际 ${partial?.messages.length} 条）`)
    ok(partial.missing === 1, `如实计入缺失段数（实际 ${partial?.missing}）—— 不静默丢段`)
    ok(
      partial.messages.map((m) => m.text).join('|') === '第一段的问题|第一段的回答|第三段',
      '保留下来的段按顺序拼'
    )

    const g = join(sessions, 'g.jsonl')
    const h = join(sessions, 'h.jsonl')
    await chains.link(g, h, 'h-3')
    const nothing = await history.readChainMessages(h, chains)
    ok(nothing === null, '所有段都读不到 → null（调用方回退到 pi 的 get_messages）')

    const e = await writeSession('e.jsonl', 's-e', ['甲'])
    const f = await writeSession('f.jsonl', 's-f', ['乙'])
    await chains.link(e, f, 'h-4')
    ok(!!chains.chainOf(e), '夹具：链已建立')
    ok((await chains.forget(e)) === true, 'forget 删掉了包含该段的整条链')
    ok(chains.chainOf(e) === null && chains.chainOf(f) === null, '链上两段都不再归属于任何链')
    ok((await chains.forget(e)) === false, 'forget 幂等（再删一次返回 false、不落盘）')
    const reopened = new chainService.SessionChainStore({ root: join(root, 'data') })
    await reopened.load()
    ok(reopened.chains().every((chain) => !chain.segments.some((seg) => seg.sessionFile.endsWith('e.jsonl'))), 'forget 结果已落盘')

    console.log('\n--- 历史回看：跨段链式图片本地化（不把 base64 传进渲染进程） ---')

    const imagePayloads = Array.from({ length: 8 }, (_, i) => `IMG${i}-${'A'.repeat(512 * 1024)}`)
    const bigText = 'T'.repeat(96 * 1024)
    const writeImageSession = async (name, id, payloads) => {
      const path = join(sessions, name)
      const content = [
        { type: 'text', text: bigText },
        ...payloads.map((data) => ({ type: 'image', mimeType: 'image/png', data }))
      ]
      const lines = [
        JSON.stringify({ type: 'session', id, cwd: 'C:\\workspace\\images' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content } })
      ]
      await writeFile(path, lines.join('\n') + '\n', 'utf8')
      return path
    }

    const imgA = await writeImageSession('img-a.jsonl', 's-img-a', imagePayloads.slice(0, 4))
    const imgB = await writeImageSession('img-b.jsonl', 's-img-b', imagePayloads.slice(4))
    await chains.link(imgA, imgB, 'h-img')

    const seen = []
    const localizer = (mimeType, data) => {
      seen.push([mimeType, data.length])
      return `file:///history/attachments/img-${seen.length}.png`
    }

    const localized = await history.readChainMessages(imgB, chains, undefined, localizer)
    const localizedImages = localized?.messages.flatMap((m) => m.images ?? []) ?? []
    ok(localized?.messages.length === 2, `带图的两段仍拼成 2 条（实际 ${localized?.messages.length}）`)
    ok(localizedImages.length === 8, `跨段 8 张图片都还在（实际 ${localizedImages.length}）`)
    ok(localizedImages.every((img) => !!img.url && img.data === ''), '图片被本地化成 url，消息里不再带 base64')
    ok(
      seen.length === 8 && seen.every(([mime, length]) => mime === 'image/png' && length === imagePayloads[0].length),
      `localizer 拿到的 base64 与原始长度一致（实际 ${seen.length} 次，长度 ${seen[0]?.[1]}）`
    )
    ok(
      localized.messages[0].images.every((img) => img.url.startsWith('file://')) &&
        localized.messages[1].images.every((img) => img.url.startsWith('file://')),
      '两段各自都改成 file:// 本地路径'
    )
    const localizedJson = JSON.stringify(localized)
    ok(!localizedJson.includes(imagePayloads[0].slice(0, 128)), '返回的 JSON 不含图片 base64')
    ok(
      localizedJson.length < imagePayloads[0].length,
      `返回的 JSON 比单张图片还小（实际 ${localizedJson.length} 字节）`
    )
    ok(
      localized.messages[0].text.length < bigText.length && localized.messages[0].text.includes('已截断'),
      '文本仍按 64KiB 截断'
    )
    ok(
      (localized.messages[0].images ?? []).every((img) => img.data === '' && img.mimeType === 'image/png'),
      '图片元数据保留、图片本身不被截断（完整本地化）'
    )

    const rawInline = await history.readChainMessages(imgB, chains)
    const rawImages = rawInline?.messages.flatMap((m) => m.images ?? []) ?? []
    ok(rawImages.length === 8, `未传 localizer 时仍读到 8 张图片（实际 ${rawImages.length}）`)
    ok(
      rawImages.every((img) => img.data.length === imagePayloads[0].length && !img.url),
      '未传 localizer 时保持现状：仍内联 base64、无 url'
    )
    ok(
      JSON.stringify(rawInline).length > imagePayloads[0].length * 2,
      '未传 localizer 时返回值确实带大段 base64（对照）'
    )

    let hydrateCalls = 0
    const hydratedInline = await history.readChainMessages(imgB, chains, async (_file, messages) => {
      hydrateCalls += 1
      return messages.map((message) => ({ ...message, text: `${message.text}（hydrated）` }))
    }, localizer)
    ok(hydrateCalls === 2 && hydratedInline?.messages.length === 2, `传 localizer 后 hydrate 仍逐段拿到消息（实际 ${hydrateCalls} 次）`)
    ok(
      hydratedInline.messages[0].text.includes('（hydrated）') && !!hydratedInline.messages[0].images?.[0]?.url,
      'hydrate 之后图片本地化结果仍在（url 非空）'
    )

    const boom = () => { throw new Error('localize failed') }
    const failedChain = await history.readChainMessages(imgB, chains, undefined, boom)
    ok(!!failedChain && failedChain.messages.length === 2, 'localizer 抛错时历史仍然可读（不整段丢失）')
    const fallbackImages = failedChain?.messages.flatMap((m) => m.images ?? []) ?? []
    ok(fallbackImages.length === 8 && fallbackImages.every((img) => !img.url && !!img.data), '抛错时图片回退为内联 base64，不丢图')
    ok(!!failedChain?.messages[0]?.text.includes('已截断'), '抛错时同段文本仍然按上限截断并返回')
    const failedSingle = await history.readChainMessages(imgA, null, undefined, boom)
    ok(!!failedSingle && failedSingle.messages.length === 1, '无链的单文件读取在 localizer 抛错时同样保留历史')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
