/**
 * 「会话 ↔ 工作树」来源关系的单测（实施-07 S2）。
 *
 * ── 这一批测什么 ──
 * 这张表的全部意义是「这个会话从哪来」—— 所以断言不看返回值，
 * 而是**真的去读那个文件**：
 *   · 文件真的在临时数据目录里，内容与登记的一致；
 *   · 同一个新会话重复登记是**就地更新**（不是堆第二条）；
 *   · 缺会话 id / 工作树目录的记录在清洗时被丢掉（不猜、不补默认值）；
 *   · 超过上限丢最旧；
 *   · 坏文件当空表（少一行追溯不该让应用起不来）。
 *
 * 全部在临时目录里跑（`root` 注入）—— 单测绝不碰用户真实数据目录。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runWorktreeLinkTests(ok) {
  const { WorktreeLinkStore, sanitizeWorktreeLinkDocument, worktreeLinkDocumentPath } = await import(
    '../out/test/worktree-links.mjs'
  )

  const root = mkdtempSync(join(tmpdir(), 'yan-worktree-links-'))
  const file = worktreeLinkDocumentPath(root)
  const store = new WorktreeLinkStore({ root, now: () => 1_700_000_000_000 })

  /* ── 1. 登记真的落盘 ─────────────────────────────────── */
  {
    const res = await store.link({
      sessionId: 'sess-new',
      sessionFile: 'C:/yan/sessions/new.jsonl',
      worktree: 'C:/repo-worktrees/feat-x',
      branch: 'feat/x',
      fromSessionId: 'sess-src',
      fromSessionFile: 'C:/yan/sessions/src.jsonl',
      fromCwd: 'C:/repo'
    })
    ok(res.ok === true, '登记返回成功', JSON.stringify(res))
    ok(existsSync(file), '文件真的在磁盘上（这就是「落盘」的全部意义）', file)

    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    ok(onDisk.version === 1, '文档带版本号', String(onDisk.version))
    ok(Array.isArray(onDisk.links) && onDisk.links.length === 1, '磁盘上只有一条', String(onDisk.links?.length))
    const item = onDisk.links[0]
    ok(item.sessionId === 'sess-new', '新会话 id 对得上', String(item.sessionId))
    ok(item.worktree === 'C:/repo-worktrees/feat-x', '工作树目录对得上', String(item.worktree))
    ok(item.branch === 'feat/x', '分支对得上')
    ok(item.fromSessionId === 'sess-src' && item.fromCwd === 'C:/repo', '源会话与源目录都记下来了')

    ok(store.forSession('sess-new')?.branch === 'feat/x', 'forSession 能按新会话取回', String(store.forSession('sess-new')?.branch))
    ok(store.forSession('sess-src') === null, '源会话**不是**「工作树会话」那一边（方向不能反）')
    ok(store.forSession('nope') === null, '没登记过的会话返回 null')
  }

  /* ── 2. 幂等：同一个新会话重复登记是就地更新 ────────── */
  {
    const again = await store.link({
      sessionId: 'sess-new',
      /* pi 写完文件之后才拿得到 sessionFile —— 那是信息补齐，不是第二条关系 */
      sessionFile: 'C:/yan/sessions/new-real.jsonl',
      worktree: 'C:/repo-worktrees/feat-x',
      branch: 'feat/x',
      fromSessionId: 'sess-src',
      fromCwd: 'C:/repo'
    })
    ok(again.ok === true, '再次登记成功')
    const list = store.links()
    ok(list.length === 1, '还是只有一条（不是堆第二条）', String(list.length))
    ok(list[0].sessionFile === 'C:/yan/sessions/new-real.jsonl', 'sessionFile 就地补上了', list[0].sessionFile)
  }

  /* ── 3. 必填缺失与上限 ───────────────────────────────── */
  {
    const bad = await store.link({ sessionId: '', worktree: 'C:/x' })
    ok(bad.ok === false && typeof bad.error === 'string', '缺会话 id → 明确报错（不写一条空记录）', JSON.stringify(bad))
    const bad2 = await store.link({ sessionId: 's', worktree: '' })
    ok(bad2.ok === false, '缺工作树目录 → 明确报错')

    const dirty = sanitizeWorktreeLinkDocument({
      links: [
        { sessionId: 'a', worktree: 'C:/a', branch: 'b', at: 1 },
        { sessionId: '', worktree: 'C:/b' },
        { sessionId: 'c', worktree: '' },
        'not-an-object',
        { sessionId: 'd', worktree: 'C:/d', at: 'nope' }
      ]
    })
    ok(dirty.links.length === 2, '清洗丢掉缺身份字段的记录（不猜、不补默认值）', String(dirty.links.length))
    ok(dirty.links[1].at === 0, '坏时间戳回落 0（不当成有效时间）', String(dirty.links[1].at))

    const many = sanitizeWorktreeLinkDocument({
      links: Array.from({ length: 2100 }, (_, i) => ({ sessionId: `s${i}`, worktree: 'C:/w', at: i }))
    })
    ok(many.links.length === 2000, '超过上限截到 2000 条', String(many.links.length))
    ok(many.links[0].sessionId === 's100', '丢的是最旧的', many.links[0].sessionId)
  }

  /* ── 4. 坏文件容错 + 重启读回 ───────────────────────── */
  {
    writeFileSync(file, '{ 这不是 JSON')
    const fresh = new WorktreeLinkStore({ root })
    await fresh.load()
    ok(fresh.links().length === 0, '文件坏了 → 当空表（少一行追溯不该让应用起不来）', String(fresh.links().length))

    /* 真实落盘的内容能被**另一个实例**读回（这才是「重启后还在」） */
    await fresh.link({ sessionId: 'persist', worktree: 'C:/w2', branch: 'main' })
    const reloaded = new WorktreeLinkStore({ root })
    await reloaded.load()
    ok(reloaded.forSession('persist')?.worktree === 'C:/w2', '换一个实例读回同一条关系（真的在磁盘上）')
  }

  rmSync(root, { recursive: true, force: true })
}
