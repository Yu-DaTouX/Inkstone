/**
 * 项目信任（实施-07 S2b-2）：读 pi 的 `trust.json`，并允许用户**显式信任一个目录**。
 *
 * ── 为什么这块必须单独做 ──
 * pi 把「带 `.pi/settings.json`（或 `.agents/skills`）的目录」视为 **trust-requiring**：
 * 目录不在 `trust.json` 里被标成 `true` 时，pi **整份忽略**该目录的项目级配置。
 * RPC 模式**没有信任弹窗**（那只在 interactive 下问），所以用户不自己去终端跑一次 pi，
 * 项目级设置就永远不生效 —— 而这件事在「Fork 到工作树」时最容易被坑：
 * 工作树目录通常在仓库**旁边**（`…-worktrees/<branch>`），不在主仓库路径之下，
 * 于是「源目录被信任」**不等于**「工作树目录被信任」。
 *
 * ── 边界（2026-09-19 形态决策）──
 * · **不自动继承**：不因为「同一个 Git 仓库」「remote 相同」就把源目录的信任搬过来。
 *   这里只提供「读状态」与「用户点一下信任这个目录」两件事。
 * · 写入的是**绝对路径**（与 pi 自己的写法同一形态）；判定复用 `projectTrustedFrom`
 *   （它实现了 pi 的「从 cwd 向上找第一个条目」规则），保证界面显示的与 pi 实际认的一致。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { projectTrustedFrom } from './compaction'

/** `trust.json` 的路径（测试与文档都按它找） */
export const TRUST_FILE_NAME = 'trust.json'

export interface TrustStatus {
  /** 被问的那个目录（绝对路径） */
  cwd: string
  /** pi 会不会认这个目录的项目级配置 */
  trusted: boolean
  /** 让它是 `true` 的那条条目的键（向上查找命中的那一条；没有就是 null） */
  entry: string | null
}

async function readTable(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(join(PI_AGENT_DIR, TRUST_FILE_NAME), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    /* 文件不存在 / 坏了都当「没有任何条目」——与 pi 的行为一致（它也是当没配） */
    return {}
  }
}

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * 查这个目录的信任状态。
 *
 * 命中哪一条要单独取出来（`entry`）：用户看到的应该是「是**这条**让它是信任的」，
 * 而不是一句「已信任」—— 否则他没法判断该改哪一条（尤其是父目录被信任的情况）。
 */
export async function trustStatus(cwd: string): Promise<TrustStatus> {
  const abs = resolve(cwd)
  const table = await readTable()
  if (!projectTrustedFrom(table, abs)) {
    /*
     * 没通过也要区分「有条目但值为 false」与「根本没有」：
     * 前者是 pi 明确的不信任（它会中止向上查找），后者只是没配过。
     * 界面文案不同，所以 entry 只在**命中条目**时给。
     */
    let cur = norm(abs)
    for (;;) {
      const hit = Object.keys(table).find((k) => norm(k) === cur)
      if (hit) return { cwd: abs, trusted: false, entry: hit }
      const idx = cur.lastIndexOf('/')
      if (idx <= 0) break
      cur = cur.slice(0, idx)
    }
    return { cwd: abs, trusted: false, entry: null }
  }
  let cur = norm(abs)
  for (;;) {
    const hit = Object.keys(table).find((k) => norm(k) === cur)
    if (hit) return { cwd: abs, trusted: true, entry: hit }
    const idx = cur.lastIndexOf('/')
    if (idx <= 0) return { cwd: abs, trusted: true, entry: null }
    cur = cur.slice(0, idx)
  }
}

/**
 * 信任一个目录（**只应由用户显式动作触发**）。
 *
 * 已存在同名条目时**原地改成 true**（而不是新加一条），否则 pi 的「向上找第一个」规则
 * 可能先命中旧的那条 `false`。写入用 tmp + rename：中途断电不能留下半份 JSON ——
 * 那会让 pi 认为整张表都读不了（等于所有项目都失去信任）。
 */
export async function allowTrust(cwd: string): Promise<{ ok: boolean; entry: string; error?: string }> {
  const abs = resolve(cwd)
  if (!abs) return { ok: false, entry: '', error: '目录为空' }
  try {
    const table = await readTable()
    const existing = Object.keys(table).find((k) => norm(k) === norm(abs))
    /* 键用手上这条的**原样拼写**（pi 认的是它自己写的那个键），没有就新增绝对路径 */
    const key = existing ?? abs
    table[key] = true
    const file = join(PI_AGENT_DIR, TRUST_FILE_NAME)
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(table, null, 2), 'utf8')
    await rename(tmp, file)
    return { ok: true, entry: key }
  } catch (error) {
    return { ok: false, entry: '', error: error instanceof Error ? error.message : String(error) }
  }
}
