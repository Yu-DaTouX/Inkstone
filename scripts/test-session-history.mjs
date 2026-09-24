/**
 * 链感知的会话历史读取（实施-05 S5b-4）。
 *
 * 用户口径是「后台两份 JSONL、前端一条会话」—— 所以历史必须在**读侧**拼成
 * 一条时间线。这一片的三个失败形态都是静默的，必须靠单测钉住：
 *   · 顺序错（新段在前）→ 用户看到「对话倒着走」；
 *   · 少读一段（链上的文件被删）→ 历史悄悄断掉，没人知道；
 *   · 没有链的普通会话被多读一遍 → 每次打开都慢一倍。
 *
 * 用法：npm run test:unit
 */
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

    /* --------------------------------------------------- 没有链 */
    const one = await history.readChainMessages(single, chains)
    ok(one?.messages.length === 1 && one.messages[0].text === '只有这一段', '不在链上 → 读单文件（行为与以前一致）')
    ok(one?.segments === 1 && one.missing === 0, `记为 1 段、无缺失（实际 ${one?.segments}/${one?.missing}）`)
    ok(one?.sourceCwd === 'C:\\workspace\\single', '单文件结果读出 session header cwd')
    ok(one?.messages[0]?.sourceCwd === one?.sourceCwd, '单文件消息保留自己的来源目录')

    const noStore = await history.readChainMessages(single, null)
    ok(noStore?.messages.length === 1, '没传链 store 时等价单文件（调用方不必都认识链）')

    /* --------------------------------------------------- 两段链 */
    const a = await writeSession('a.jsonl', 's-a', ['第一段的问题', '第一段的回答'], 'C:\\worktrees\\old')
    const b = await writeSession('b.jsonl', 's-b', ['续接后的第一句'], 'C:\\worktrees\\new')
    await chains.link(a, b, 'h-1')
    const joined = await history.readChainMessages(b, chains)
    ok(joined?.messages.length === 3, `两段拼起来 3 条（实际 ${joined?.messages.length}）`)
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

    /* 从旧段也能读到同样的完整历史（链上任一段都是同一条会话） */
    const fromOld = await history.readChainMessages(a, chains)
    ok(fromOld?.messages.length === 3 && fromOld.messages[0].text === '第一段的问题', '从旧段打开也拿到完整时间线')

    /* --------------------------------------------------- 有一段文件没了 */
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

    /* --------------------------------------------------- 全部读不到 */
    const g = join(sessions, 'g.jsonl')
    const h = join(sessions, 'h.jsonl')
    await chains.link(g, h, 'h-3')
    const nothing = await history.readChainMessages(h, chains)
    ok(nothing === null, '所有段都读不到 → null（调用方回退到 pi 的 get_messages）')

    /* --------------------------------------------------- 删除整链 */
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
