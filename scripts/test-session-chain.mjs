/**
 * 会话「链」的契约与存储单测（实施-05 S5b）。
 *
 * 用户口径：**后台两份 JSONL，前端一条会话**。所以这份关系的正确性直接决定
 * 用户看到几条会话、历史拼得对不对：
 *   · `shared/session-chain.ts` —— 键归一化 / 追加幂等 / 代表段 / 拼接顺序 / 脏值清洗；
 *   · `main/session-chain-service.ts` —— 真文件、`link` 的四种情形、重启后关系还在。
 *
 * 其中**键归一化与 `main/work-mode-service.ts` 的同名函数交叉校验**：
 * 两边不一致的后果是「侧栏按 A 判断、历史按 B 查找」——同一个段看起来像两条会话。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runSessionChainTests(ok, workModeService) {
  const shared = await import('../out/test/session-chain.mjs')
  const service = await import('../out/test/session-chain-service.mjs')
  const { normalizeSessionFileKey } = workModeService

  console.log('\n--- 实施-05 S5b 会话链（前端一条会话） ---')

  /* --------------------------------------------------- 键归一化（含交叉校验） */

  const files = [
    'C:\\Users\\x\\sessions\\a.jsonl',
    'C:/Users/x/sessions/a.jsonl/',
    '  C:/Users/x/sessions/a.jsonl  ',
    '/home/x/a.jsonl',
    'D:\\tmp\\b.JSONL'
  ]
  for (const file of files) {
    ok(
      shared.normalizeChainKey(file) === normalizeSessionFileKey(file),
      `键归一化与 work-mode-service 一致：${JSON.stringify(file)}`
    )
  }
  ok(shared.normalizeChainKey('C:\\a\\b.jsonl') === 'C:/a/b.jsonl', '反斜杠统一成正斜杠')
  ok(shared.normalizeChainKey('C:/a/b.jsonl///') === 'C:/a/b.jsonl', '尾斜杠去掉')
  ok(shared.normalizeChainKey('') === null && shared.normalizeChainKey('   ') === null, '空键不可用')
  ok(shared.normalizeChainKey('a\u0000b') === null, '控制字符不可用')
  ok(shared.normalizeChainKey('x'.repeat(401)) === null, '超长不可用')
  ok(shared.normalizeChainKey(null) === null, '非字符串不可用')
  ok(shared.normalizeChainKey('C:/A/b.jsonl') !== shared.normalizeChainKey('C:/a/b.jsonl'), '不做大小写折叠（Linux 上大小写是两回事）')

  /* --------------------------------------------------- 建模与代表段 */

  const seg = (file, at = 1, handoffId = null) => ({ sessionFile: file, startedAt: at, handoffId })
  const A = 'C:/s/a.jsonl'
  const B = 'C:/s/b.jsonl'
  const C = 'C:/s/c.jsonl'

  const chainA = shared.createChain(seg(A))
  ok(!!chainA && chainA.chainId === A && chainA.segments.length === 1, '首段建链：chainId = 首段')
  ok(shared.createChain(seg('')) === null, '空文件建不出链')

  const withB = shared.appendSegment(chainA, seg(B, 2, 'h-1'))
  ok(withB.segments.length === 2 && withB.segments[1].handoffId === 'h-1', '向后追加一段')
  ok(shared.appendSegment(withB, seg(B, 3, 'h-x')) === withB, '同一段重复追加 → 原样返回（幂等）')
  ok(shared.chainRepresentative(withB)?.sessionFile === B, '代表段 = 最后一段')
  ok(shared.chainRepresentative(null) === null, '没有链 → 没有代表段')

  const withC = shared.appendSegment(withB, seg(C, 4, 'h-2'))
  ok(shared.planHistoryRead(withC).join(',') === `${A},${B},${C}`, '读历史按段从旧到新')
  ok(shared.planHistoryRead(null).length === 0, '没有链 → 不取文件')
  ok(shared.chainSummary(withC).includes('3 段'), `摘要写明几段（${shared.chainSummary(withC)}）`)
  ok(shared.chainSummary(chainA) === '单段', '单段链的摘要')

  const chains = [withC]
  ok(shared.chainForFile(chains, B) === withC, '按旧段也能找到链')
  ok(shared.isRepresentative(chains, C) === true, '代表段 → 侧栏显示')
  ok(shared.isRepresentative(chains, A) === false, '旧段 → 侧栏不显示（同一条会话）')
  ok(shared.isRepresentative(chains, 'C:/s/other.jsonl') === true, '不在任何链上的会话 → 自己就是一条（显示）')
  ok(shared.isRepresentative([], A) === true, '没有链记录时全部显示')

  /* --------------------------------------------------- 脏值清洗 */

  ok(shared.sanitizeSessionChain(null) === null, '非对象 → 丢掉')
  ok(shared.sanitizeSessionChain({ segments: [] }) === null, '没有段 → 丢掉')
  const dirty = shared.sanitizeSessionChain({
    chainId: 'C:/s/not-in-chain.jsonl',
    segments: [seg(''), seg(A), seg(A), { sessionFile: B, startedAt: 'x', handoffId: 7 }]
  })
  ok(dirty?.segments.length === 2, '空键与重复段被丢掉')
  ok(dirty?.chainId === A, 'chainId 不在链上 → 回落到首段')
  ok(dirty?.segments[1].startedAt === 0 && dirty?.segments[1].handoffId === null, '脏的时间戳 / handoffId 回落')

  const twoChains = shared.sanitizeSessionChains([
    { chainId: A, segments: [seg(A), seg(B)] },
    { chainId: C, segments: [seg(C), seg(B)] }
  ])
  ok(twoChains.length === 1, '两条链共享同一个段 → 后来的丢掉（不合并，合并是猜测）')
  ok(
    shared.sanitizeSessionChains({ chains: [{ chainId: A, segments: [seg(A)] }] }).length === 1,
    '也接受 { chains: [...] } 形状'
  )
  ok(shared.sanitizeSessionChains('nonsense').length === 0, '整体脏 → 空列表')

  /* --------------------------------------------------- 存储层 */

  const root = await mkdtemp(join(tmpdir(), 'yan-chain-'))
  try {
    const store = new service.SessionChainStore({ root, now: () => 7000 })
    await store.load()
    ok(store.chains().length === 0, '初始没有链')
    ok(store.isRepresentative(A) === true, '孤立会话默认显示')

    const first = await store.link(A, B, 'h-1')
    ok(!!first && first.segments.length === 2, '首段交接：新建链 [A, B]')
    ok(store.isRepresentative(B) === true && store.isRepresentative(A) === false, 'B 成为代表、A 不再显示')
    ok(store.representativeOf(A) === B, '从旧段问代表 → 新段（发送目标跟着走）')
    ok(store.representativeOf('C:/s/other.jsonl') === 'C:/s/other.jsonl', '孤立会话的代表是自己')

    const again = await store.link(A, B, 'h-1')
    ok(again?.segments.length === 2, '同一次交接再来一遍 → 不重复加段（幂等）')

    const third = await store.link(B, C, 'h-2')
    ok(!!third && third.segments.map((s) => s.sessionFile).join(',') === `${A},${B},${C}`, '第二次交接接在链尾')
    ok(store.isRepresentative(C) === true && store.isRepresentative(B) === false, '代表跟着走到最新段')

    /* to 已属于另一条链 → 拒绝 */
    const D = 'C:/s/d.jsonl'
    await store.link('C:/s/other.jsonl', D, 'h-x')
    const rejected = await store.link(A, D, 'h-y')
    ok(!!rejected && rejected.segments.some((s) => s.sessionFile === D), '目标段已在别的链上 → 返回那条链，不改本链')
    ok(store.chainOf(A)?.segments.length === 3, '被拒后本链没有被污染')

    ok((await store.link('', B, null)) === null, '空键 → 不落盘、返回 null')
    ok((await store.link(A, A, null)) === null, '自己接自己 → 拒绝')

    /* 落盘 + 重启后关系还在 */
    const file = join(root, service.SESSION_CHAIN_FILE_NAME)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    ok(Array.isArray(onDisk.chains) && onDisk.chains.length >= 2, '关系真的落盘了')
    const reopened = new service.SessionChainStore({ root })
    await reopened.load()
    ok(reopened.isRepresentative(C) === true && reopened.isRepresentative(A) === false, '重启后关系还在（A 依然不显示）')
    ok(reopened.chainOf(B)?.segments.length === 3, '重启后链上段数正确')

    /* 脏 JSON → 空；旧文件（没有 chains 字段）兼容 */
    await writeFile(file, '{ 坏 JSON', 'utf8')
    const bad = new service.SessionChainStore({ root })
    await bad.load()
    ok(bad.chains().length === 0 && bad.isRepresentative(A) === true, '坏 JSON → 空（每条会话各自一条，不丢会话）')

    await writeFile(file, JSON.stringify({ version: 1, entries: [] }), 'utf8')
    const old = new service.SessionChainStore({ root })
    await old.load()
    ok(old.chains().length === 0, '旧形状（没有 chains）→ 空，不抛')

    /* 落盘失败必须抛 */
    const rootBad = await mkdtemp(join(tmpdir(), 'yan-chain-bad-'))
    try {
      const badStore = new service.SessionChainStore({ root: rootBad })
      await badStore.load()
      await mkdir(service.sessionChainDocumentPath(rootBad), { recursive: true })
      let threw = false
      try {
        await badStore.link(A, B, 'h-1')
      } catch {
        threw = true
      }
      ok(threw, '落盘失败时抛错（不许「内存有链、磁盘没有」）')
      ok(badStore.chainOf(A) === null, '失败后内存态回退')
    } finally {
      await rm(rootBad, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
