#!/usr/bin/env node
/**
 * 真实实例「重启复核」取证工具（**只读**）。
 *
 * ── 为什么需要它 ──
 * 重启复核必须由人点退出/重启：助手自己就跑在要重启的那个实例里，进程一退就没了，
 * 没法在「重启后」继续观察。所以这里把「重启前」和「重启后」的关键落盘状态抽成
 * 一份可比对的快照 —— 重启前跑一次、重启后再跑一次，diff 两份 JSON 就能客观回答
 * 「退出时保存下来的东西，重启后还在不在、有没有被改写」。
 *
 * ── 它读什么（全部只读，绝不写用户数据）──
 *   PI_AGENT_DIR (~/.pi/agent)        pi 的会话 JSONL、凭证/设置是否存在
 *   YAN_DIR      (~/.pi/agent/yan)    桌面端派生状态：goals / 布局 / 回合计时 / …
 *   Electron userData (%APPDATA%/yan-desktop)
 *
 * ── 两类量要分开看（对比时很重要）──
 *   稳定项：界面布局与面板、目标集合与阶段、**历史**会话集合 —— 复核前后应当一致。
 *   增长项：会话消息数、ops 条数、回合计时条数 —— 复核期间的对话本身就会让它们变，
 *           只要求「不减少」，不要求相等。
 *
 * 用法：
 *   node scripts/probe/real-restart-snapshot.mjs                # 打印摘要
 *   node scripts/probe/real-restart-snapshot.mjs --out a.json    # 另存快照
 *   node scripts/probe/real-restart-snapshot.mjs --diff a.json b.json
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? true) : fallback
}

const PI_DIR = process.env.YAN_PI_DIR || join(homedir(), '.pi', 'agent')
const YAN_DIR = process.env.YAN_DATA_DIR || join(PI_DIR, 'yan')
const USER_DATA =
  process.env.YAN_USER_DATA ||
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'yan-desktop')

const hash = (v) =>
  createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16)

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
function listDir(p) {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}
function walk(dir, filter, out = []) {
  for (const name of listDir(dir)) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, filter, out)
    else if (filter(name, full)) out.push(full)
  }
  return out
}
function countLines(p) {
  try {
    const text = readFileSync(p, 'utf8')
    return text.length === 0 ? 0 : text.split('\n').filter((l) => l.trim()).length
  } catch {
    return -1
  }
}

/* ── 会话：只统计不读正文，避免把用户内容带进快照 ── */
const sessionFiles = walk(join(PI_DIR, 'sessions'), (n) => n.endsWith('.jsonl'))
const sessionDirs = new Set(sessionFiles.map((f) => join(f, '..')))
const sessions = sessionFiles
  .map((f) => {
    let st = { size: -1, mtimeMs: 0 }
    try {
      st = statSync(f)
    } catch {
      /* 读不到就留空 */
    }
    return { file: basename(f), dir: basename(join(f, '..')), size: st.size, mtimeMs: Math.round(st.mtimeMs), lines: countLines(f) }
  })
  .sort((a, b) => b.mtimeMs - a.mtimeMs)

/* ── 目标：只看结构与阶段，不搬全文 ── */
const goalsDoc = readJson(join(YAN_DIR, 'goals.json'))
/* 形状：`entries[sessionFile] = { goal: { phase, revision, steps } }`（按会话文件索引） */
const goalList = (() => {
  const e = goalsDoc?.entries
  if (!e) return []
  const rows = Array.isArray(e) ? e.map((g, i) => [String(i), g]) : Object.entries(e)
  return rows
    .map(([key, row]) => {
      const g = row?.goal ?? row
      const session = basename(String(key)).replace(/\.jsonl$/, '')
      return {
        session: session.slice(-32),
        phase: g?.phase ?? null,
        revision: g?.revision ?? g?.goalRevision ?? null,
        steps: Array.isArray(g?.steps) ? g.steps.length : null,
        done: Array.isArray(g?.steps) ? g.steps.filter((s) => s?.status === 'done').length : null,
        blocked: !!g?.blocked
      }
    })
    .sort((a, b) => a.session.localeCompare(b.session))
})()

/* ── 回合计时：条数 + 终态分布 ── */
const timingFiles = walk(join(YAN_DIR, 'turn-timing'), (n) => n.endsWith('.jsonl'))
const timing = { files: timingFiles.length, entries: 0, byTerminal: {}, byFile: {} }
for (const f of timingFiles) {
  const rows = (() => {
    try {
      return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  })()
  timing.entries += rows.length
  timing.byFile[basename(f)] = rows.length
  for (const r of rows) {
    const k = r?.terminalReason ?? r?.terminal ?? 'unknown'
    timing.byTerminal[k] = (timing.byTerminal[k] ?? 0) + 1
  }
}

/* ── 界面/布局：稳定项 ── */
const desktop = readJson(join(YAN_DIR, 'desktop.json')) ?? {}
const layout = {
  theme: desktop.theme ?? null,
  cwd: desktop.cwd ?? null,
  rightPanelOpen: desktop.rightPanelOpen ?? null,
  alwaysOnTop: desktop.alwaysOnTop ?? null,
  uiScale: desktop.uiScale ?? null,
  railWidth: desktop.railWidth ?? null,
  panelWidth: desktop.panelWidth ?? null,
  browserHeight: desktop.browserHeight ?? null,
  recentCwds: Array.isArray(desktop.recentCwds) ? desktop.recentCwds.length : null,
  projects: Array.isArray(desktop.projects) ? desktop.projects.length : (desktop.projects ? Object.keys(desktop.projects).length : null),
  projectOrder: Array.isArray(desktop.projectOrder) ? desktop.projectOrder.length : null,
  hash: hash(desktop)
}
const sessionLayout = readJson(join(YAN_DIR, 'session-layout.json'))
const chains = readJson(join(YAN_DIR, 'session-chains.json'))
const titles = readJson(join(YAN_DIR, 'titles.json')) ?? {}
const manualTitles = readJson(join(YAN_DIR, 'manual-titles.json')) ?? {}

/* ── 上下文状态与任务侧状态 ── */
const ctxFiles = listDir(join(YAN_DIR, 'context-state'))
const ctxBySuffix = {}
for (const n of ctxFiles) {
  const suffix = n.endsWith('.recall.json') ? 'recall' : n.endsWith('.archive.json') ? 'archive' : 'base'
  ctxBySuffix[suffix] = (ctxBySuffix[suffix] ?? 0) + 1
}
const subagents = listDir(join(YAN_DIR, 'subagents'))
const knowledge = listDir(join(YAN_DIR, 'project-knowledge'))
const workModes = readJson(join(YAN_DIR, 'work-modes.json'))
const autoContinue = readJson(join(YAN_DIR, 'auto-continue.json'))
const handoffs = readJson(join(YAN_DIR, 'handoffs.json'))
const exitSnapshot = readJson(join(YAN_DIR, 'exit-snapshot.json'))
const opsDir = listDir(join(YAN_DIR, 'ops'))

const snapshot = {
  takenAt: new Date().toISOString(),
  dirs: { PI_DIR, YAN_DIR, USER_DATA },
  credentials: {
    auth: !!readJson(join(PI_DIR, 'auth.json')),
    models: !!readJson(join(PI_DIR, 'models.json')),
    settings: !!readJson(join(PI_DIR, 'settings.json'))
  },
  sessions: {
    count: sessions.length,
    projectDirs: sessionDirs.size,
    latest: sessions.slice(0, 8),
    totalLines: sessions.reduce((a, s) => a + Math.max(0, s.lines), 0)
  },
  goals: { count: goalList.length, list: goalList, hash: hash(goalList) },
  turnTiming: timing,
  layout,
  sessionLayout: { entries: Array.isArray(sessionLayout?.entries) ? sessionLayout.entries.length : (sessionLayout?.entries ? Object.keys(sessionLayout.entries).length : 0) },
  chains: Array.isArray(chains) ? chains.length : (chains?.entries ? Object.keys(chains.entries).length : 0),
  titles: Object.keys(titles).length,
  manualTitles: Object.keys(manualTitles).length,
  contextState: { total: ctxFiles.length, bySuffix: ctxBySuffix },
  misc: {
    subagents: subagents.length,
    knowledgeProjects: knowledge.length,
    ops: opsDir.length,
    workModes: Array.isArray(workModes) ? workModes.length : (workModes?.entries ? Object.keys(workModes.entries).length : 0),
    autoContinueEntries: Array.isArray(autoContinue?.entries) ? autoContinue.entries.length : (autoContinue?.entries ? Object.keys(autoContinue.entries).length : 0),
    handoffs: Array.isArray(handoffs) ? handoffs.length : (handoffs?.entries ? Object.keys(handoffs.entries).length : 0)
  },
  exitSnapshot: exitSnapshot
    ? { mode: exitSnapshot.mode ?? null, at: exitSnapshot.at ?? null, runners: (exitSnapshot.runners ?? []).length }
    : null
}

/* ── 稳定项指纹：单值，用来一眼看出「退出状态有没有变」 ── */
snapshot.stableFingerprint = hash([snapshot.layout, snapshot.goals.hash, snapshot.credentials])

/* ── diff 模式 ── */
if (flag('--diff')) {
  const [a, b] = args.slice(args.indexOf('--diff') + 1, args.indexOf('--diff') + 3)
  const A = readJson(a)
  const B = readJson(b)
  if (!A || !B) {
    console.error('diff 需要两个可读的快照 JSON')
    process.exit(1)
  }
  const flat = (o, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'takenAt' || k === 'latest' || k === 'byFile' || k === 'list') continue
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`, out)
      else out[`${prefix}${k}`] = v
    }
    return out
  }
  const fa = flat(A)
  const fb = flat(B)
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
  /*
   * 稳定项：复核前后应当**完全一致**。
   * 不含 `sessionLayout.entries` / `turnTiming.*` / `ops` / 会话行数 —— 那些按会话、
   * 回合或操作增长，复核期间的对话本身就会写它们，只要求「不减少」。
   */
  const stable = new Set([
    'layout.theme', 'layout.cwd', 'layout.rightPanelOpen', 'layout.alwaysOnTop', 'layout.uiScale',
    'layout.railWidth', 'layout.panelWidth', 'layout.browserHeight', 'layout.hash',
    'goals.count', 'goals.hash', 'credentials.auth', 'credentials.models', 'credentials.settings',
    'stableFingerprint', 'sessions.count', 'sessions.projectDirs', 'titles', 'manualTitles',
    'contextState.total'
  ])
  let changed = 0
  let shrank = 0
  console.log('=== 重启前后对比 ===')
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  for (const k of keys) {
    if (same(fa[k], fb[k])) continue
    changed += 1
    const isStable = stable.has(k)
    const nums = typeof fa[k] === 'number' && typeof fb[k] === 'number'
    const shrink = nums && fb[k] < fa[k]
    if (shrink) shrank += 1
    const tag = isStable ? '  ✗ 稳定项变了' : shrink ? '  ✗ 减少（不该）' : '  · 增长项（正常）'
    const show = (v) => JSON.stringify(v)?.slice(0, 120)
    console.log(`${tag} ${k}: ${show(fa[k])} → ${show(fb[k])}`)
  }
  console.log(`\n变化项 ${changed} 个；减少项 ${shrank} 个`)
  const stableKeys = [...stable].filter((k) => !same(fa[k], fb[k]))
  console.log(stableKeys.length === 0 && shrank === 0 ? '✓ 重启复核：稳定项一致、无回退' : `✗ 重启复核：${stableKeys.length} 个稳定项变化、${shrank} 个回退，需要人看`)
  process.exit(0)
}

const outFile = flag('--out')
if (outFile) {
  writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf8')
  console.log(`快照已写入 ${outFile}`)
}

console.log('=== 真实实例重启复核快照（只读） ===')
console.log(`时间        ${snapshot.takenAt}`)
console.log(`pi 目录     ${PI_DIR}`)
console.log(`桌面数据    ${YAN_DIR}`)
console.log(`Electron    ${USER_DATA}`)
console.log(`凭证/设置   auth=${snapshot.credentials.auth} models=${snapshot.credentials.models} settings=${snapshot.credentials.settings}`)
console.log(`\n--- 会话 ---`)
console.log(`共 ${snapshot.sessions.count} 个 JSONL（${snapshot.sessions.projectDirs} 个项目目录，累计 ${snapshot.sessions.totalLines} 行）`)
for (const s of snapshot.sessions.latest.slice(0, 5)) {
  console.log(`  ${String(s.lines).padStart(5)} 行  ${new Date(s.mtimeMs).toISOString()}  ${s.dir}/${s.file}`)
}
console.log(`\n--- 目标 ---`)
console.log(`共 ${snapshot.goals.count} 条`)
for (const g of snapshot.goals.list) {
  console.log(`  ${g.session}  phase=${g.phase}  rev=${g.revision}  ${g.done}/${g.steps}  blocked=${g.blocked}`)
}
console.log(`\n--- 回合计时 ---`)
console.log(`文件 ${snapshot.turnTiming.files}，条目 ${snapshot.turnTiming.entries}，终态 ${JSON.stringify(snapshot.turnTiming.byTerminal)}`)
console.log(`\n--- 界面状态 ---`)
console.log(`主题 ${snapshot.layout.theme}  cwd ${snapshot.layout.cwd}`)
console.log(`右面板开 ${snapshot.layout.rightPanelOpen}  左栏宽 ${snapshot.layout.railWidth}  面板宽 ${snapshot.layout.panelWidth}  缩放 ${snapshot.layout.uiScale}  置顶 ${snapshot.layout.alwaysOnTop}`)
console.log(`项目 ${snapshot.layout.projects}  最近 cwd ${snapshot.layout.recentCwds}  desktop hash ${snapshot.layout.hash}`)
console.log(`\n--- 其它 ---`)
console.log(`上下文状态 ${snapshot.contextState.total}（${JSON.stringify(snapshot.contextState.bySuffix)}）`)
console.log(`子代理 ${snapshot.misc.subagents}  项目知识 ${snapshot.misc.knowledgeProjects}  ops ${snapshot.misc.ops}  交接 ${snapshot.misc.handoffs}`)
console.log(`上次退出快照 ${snapshot.exitSnapshot ? `mode=${snapshot.exitSnapshot.mode} 实例 ${snapshot.exitSnapshot.runners} 个 @ ${new Date(snapshot.exitSnapshot.at).toISOString()}` : '（无）'}`)
console.log(`\n稳定项指纹 ${snapshot.stableFingerprint}`)
