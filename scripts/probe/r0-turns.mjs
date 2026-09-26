#!/usr/bin/env node
/**
 * 实施-26 · R0 可行性探测（只读，不改产品代码、不写产品数据）。
 *
 * 回答三个问题，结论决定 R2–R5 的形态：
 *   ① `UIMessage.id` ↔ fork 用的 `entryId` 能否对上（决定轮次卡能否直接分叉）
 *   ② 连续读 N 个会话的真实成本（决定「渐进披露 + 缓存」是否够用）
 *   ③ 压缩历史后轮次切分是否仍成立（决定压缩点会不会把轮次接错）
 *
 * 用法：
 *   node scripts/probe/r0-turns.mjs            # 全部三节
 *   node scripts/probe/r0-turns.mjs --json     # 只输出报告 JSON
 *
 * 原则：
 *   · 只读真实会话目录；需要 pi 打开会话时复制到临时 `PI_CODING_AGENT_DIR`，
 *     真实文件不被写。
 *   · 报告只含 entry id / role / 计数 / 耗时，不含消息正文与图片数据。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PI_CLI = join(ROOT, 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')
const READER_BUNDLE = join(ROOT, 'out', 'probe', 'session-reader.mjs')
const SESSIONS_ROOT =
  process.env.R0_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions')
const JSON_ONLY = process.argv.includes('--json')

const log = (...a) => {
  if (!JSON_ONLY) console.log(...a)
}

/* ── 公用：会话文件收集 ─────────────────────────────────────────── */

async function walkSessions(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkSessions(p)))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/** 轻量扫描：只拿 entry 的 type / id / parentId / message.role，不归一化。 */
function scanEntries(text) {
  const entries = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    entries.push({
      type: e.type,
      id: typeof e.id === 'string' ? e.id : undefined,
      parentId: typeof e.parentId === 'string' ? e.parentId : undefined,
      role: e.type === 'message' ? e.message?.role : undefined,
      firstKeptEntryId:
        typeof e.firstKeptEntryId === 'string' ? e.firstKeptEntryId : undefined
    })
  }
  return entries
}

/* ── 公用：真实 readSessionMessages（走 esbuild 构建的同一份源码） ── */

async function loadReader() {
  if (!existsSync(READER_BUNDLE)) {
    const require = createRequire(import.meta.url)
    require('esbuild').buildSync({
      entryPoints: [join(ROOT, 'src', 'main', 'session-reader.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: READER_BUNDLE,
      logLevel: 'warning'
    })
  }
  return import(`file://${READER_BUNDLE.replace(/\\/g, '/')}`)
}

/** 与产品一致的图片落盘替身：不写盘，但把 base64 从消息里去掉（避免虚高内存）。 */
const fakeLocalize = () => 'yan-media://r0-probe'

/* ── ① entryId 比对：起一个隔离的 pi 读 fork 点 ────────────────── */

class Rpc {
  constructor(child) {
    this.child = child
    this.buf = ''
    this.pending = new Map()
    this.seq = 0
    this.stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        this.onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      this.stderr += d
    })
  }
  onLine(line) {
    if (!line.trim()) return
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.type === 'response' && m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      p(m)
    }
  }
  send(type, extra = {}, timeoutMs = 30_000) {
    const id = `r${++this.seq}`
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`timeout: ${type}`))
      }, timeoutMs)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        res(m)
      })
      this.child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n')
    })
  }
}

async function probeEntryIds(files) {
  const tmp = await mkdtemp(join(tmpdir(), 'r0pi-'))
  const tmpPi = join(tmp, 'pi')
  const tmpCwd = join(tmp, 'cwd')
  await mkdir(join(tmpPi, 'sessions'), { recursive: true })
  await mkdir(tmpCwd, { recursive: true })

  // 复制待比对会话到临时 pi 目录（真实文件只读）
  const copies = []
  for (const f of files) {
    const dst = join(tmpPi, 'sessions', basename(f))
    await copyFile(f, dst)
    copies.push({ src: f, dst })
  }

  const child = spawn(process.execPath, [PI_CLI, '--mode', 'rpc'], {
    cwd: tmpCwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: tmpPi },
    windowsHide: true
  })
  const rpc = new Rpc(child)

  const result = []
  try {
    // 等待 pi 起来（首次启动需要几秒；用 get_state 探活）
    for (let i = 0; i < 60; i++) {
      try {
        const st = await rpc.send('get_state', {}, 5_000)
        if (st.success) break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    for (const { src, dst } of copies) {
      const raw = await readFile(src, 'utf8')
      const entries = scanEntries(raw)
      const jsonlUsers = entries
        .filter((e) => e.type === 'message' && e.role === 'user' && e.id)
        .map((e) => e.id)

      const sw = await rpc.send('switch_session', { sessionPath: dst }, 60_000)
      if (!sw.success) {
        result.push({ file: basename(src), error: `switch_session: ${sw.error}` })
        continue
      }
      const fp = await rpc.send('get_fork_messages', {}, 30_000)
      const forkIds = fp.success ? (fp.data?.messages ?? []).map((m) => m.entryId) : []

      const jsonlSet = new Set(jsonlUsers)
      const forkSet = new Set(forkIds)
      const missingInJsonl = forkIds.filter((id) => !jsonlSet.has(id))
      const missingInFork = jsonlUsers.filter((id) => !forkSet.has(id))

      // 归一化后的 UIMessage.id（现状是合成的 m{seq}）
      const reader = await loadReader()
      const read = await reader.readSessionMessages(src, { localizeImage: fakeLocalize })
      const uiUsers = (read?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.id)

      result.push({
        file: basename(src),
        bytes: raw.length,
        jsonlUserEntries: jsonlUsers.length,
        forkPoints: forkIds.length,
        sameSet: missingInJsonl.length === 0 && missingInFork.length === 0,
        sameOrder: JSON.stringify(jsonlUsers) === JSON.stringify(forkIds),
        missingInJsonl: missingInJsonl.slice(0, 5),
        missingInFork: missingInFork.slice(0, 5),
        uiUserIds: uiUsers.slice(0, 6),
        uiUserIdIsEntryId: uiUsers.length > 0 && jsonlSet.has(uiUsers[0]),
        // 现状映射：第 k 个 user 消息（UIMessage 顺序）↔ forkPoints[k]
        orderAligned:
          uiUsers.length > 0 &&
          uiUsers.length === forkIds.length &&
          uiUsers.every((_, i) => forkIds[i] === jsonlUsers[i])
      })
    }
  } finally {
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, 300)
  }
  return result
}

/* ── ② 读取成本：连续读 N 个会话 ───────────────────────────────── */

async function probeReadCost(files) {
  const reader = await loadReader()
  const sized = []
  for (const f of files) sized.push({ f, size: (await stat(f)).size })
  sized.sort((a, b) => b.size - a.size)

  const batches = [1, 5, 10, 20]
  const rows = []
  for (const n of batches) {
    const picked = sized.slice(0, n)
    if (picked.length < n && n !== 1) continue
    global.gc?.()
    const before = process.memoryUsage().heapUsed
    let peak = before
    const t0 = performance.now()
    let bytes = 0
    let truncated = 0
    for (const { f } of picked) {
      const r = await reader.readSessionMessages(f, { localizeImage: fakeLocalize })
      bytes += r?.bytes ?? 0
      truncated += r?.truncated ?? 0
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }
    rows.push({
      files: picked.length,
      totalMB: +(bytes / 1048576).toFixed(1),
      ms: Math.round(performance.now() - t0),
      heapDeltaMB: +((peak - before) / 1048576).toFixed(1),
      truncated
    })
  }
  return { largest: sized.slice(0, 5).map((x) => +(x.size / 1048576).toFixed(2)), rows }
}

/* ── ③ 压缩历史：压缩点与轮次切分 ──────────────────────────────── */

async function probeCompaction(files, limit = 12) {
  const reader = await loadReader()
  const withCompaction = []
  for (const f of files) {
    const text = await readFile(f, 'utf8')
    if (!text.includes('"type":"compaction"')) continue
    withCompaction.push({ f, text })
    if (withCompaction.length >= limit) break
  }

  const rows = []
  for (const { f, text } of withCompaction) {
    const entries = scanEntries(text)
    const ids = new Set(entries.map((e) => e.id).filter(Boolean))
    const compactions = entries.filter((e) => e.type === 'compaction')
    const idxOf = new Map(entries.map((e, i) => [e.id, i]))

    let firstKeptResolvable = 0
    let messagesBeforePoint = 0
    for (const c of compactions) {
      if (c.firstKeptEntryId && ids.has(c.firstKeptEntryId)) firstKeptResolvable++
      const at = idxOf.get(c.id) ?? -1
      const before = entries.slice(0, at).filter((e) => e.type === 'message' && e.role === 'user')
      messagesBeforePoint += before.length
    }

    const read = await reader.readSessionMessages(f, { localizeImage: fakeLocalize })
    const uiUsers = (read?.messages ?? []).filter((m) => m.role === 'user').length
    const jsonlUsers = entries.filter((e) => e.type === 'message' && e.role === 'user').length
    // compaction entry 不进 messages（readSessionMessages 只认 type:message），
    // 所以轮次层默认看不到压缩边界；这里量化「丢掉多少条压缩记录」。
    const hasAnyCompactionMarker = (read?.messages ?? []).some(
      (m) => typeof m.text === 'string' && m.text.includes('已压缩')
    )

    rows.push({
      file: basename(f),
      compactions: compactions.length,
      firstKeptResolvable: `${firstKeptResolvable}/${compactions.length}`,
      userMsgsBeforeFirstCompactionPoint: messagesBeforePoint,
      jsonlUsers,
      uiUsers,
      historyPreserved: jsonlUsers === uiUsers,
      compactionMarkerVisible: hasAnyCompactionMarker
    })
  }
  return rows
}

/* ── 主流程 ───────────────────────────────────────────────────── */

async function main() {
  const all = await walkSessions(SESSIONS_ROOT)
  const report = { generatedAt: new Date().toISOString(), sessionsRoot: SESSIONS_ROOT, files: all.length }

  // ① 选 3 个 user 消息足够多、体积中等的会话
  const candidates = []
  for (const f of all) {
    const { size } = await stat(f)
    if (size < 200_000 || size > 8 * 1048576) continue
    const text = await readFile(f, 'utf8')
    const users = scanEntries(text).filter((e) => e.type === 'message' && e.role === 'user').length
    if (users >= 4) candidates.push({ f, users, size })
  }
  candidates.sort((a, b) => b.users - a.users)
  const picked = candidates.slice(0, 3).map((c) => c.f)

  log('=== ① UIMessage.id ↔ fork entryId ===')
  report.entryIds = await probeEntryIds(picked)
  for (const r of report.entryIds) {
    log(`  文件 ${r.file}（${(r.bytes / 1048576).toFixed(1)}MB）`)
    log(`    JSONL user entry ${r.jsonlUserEntries} / fork 点 ${r.forkPoints}`)
    log(`    集合一致=${r.sameSet} 顺序一致=${r.sameOrder} 顺序可对齐=${r.orderAligned}`)
    log(`    UIMessage.id 是 entryId？${r.uiUserIdIsEntryId}（样例 ${JSON.stringify(r.uiUserIds)}）`)
  }

  log('=== ② 连续读取成本 ===')
  report.readCost = await probeReadCost(all)
  for (const r of report.readCost.rows) {
    log(`  ${r.files} 个会话（${r.totalMB}MB）: ${r.ms}ms, heap Δ${r.heapDeltaMB}MB, 截断 ${r.truncated}`)
  }

  log('=== ③ 压缩历史 ===')
  report.compaction = await probeCompaction(all)
  for (const r of report.compaction) {
    log(
      `  ${r.file}: 压缩点 ${r.compactions}（firstKept 可解析 ${r.firstKeptResolvable}）, ` +
        `JSONL user ${r.jsonlUsers} / 读出 ${r.uiUsers}, 历史完整=${r.historyPreserved}, 压缩标记可见=${r.compactionMarkerVisible}`
    )
  }

  const outFile = join(ROOT, 'out', 'probe', 'r0-report.json')
  await mkdir(join(ROOT, 'out', 'probe'), { recursive: true })
  await writeFile(outFile, JSON.stringify(report, null, 2))
  if (JSON_ONLY) console.log(JSON.stringify(report, null, 2))
  else log(`\n报告已写入 ${outFile}`)
}

main().catch((e) => {
  console.error('R0 探测失败:', e)
  process.exit(1)
})
