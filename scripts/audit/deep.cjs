/**
 * 深度一致性审计（一次性工具，不属于产品代码）。
 *
 * 与 scripts/audit/project.cjs（全量文件清点 + 语法/JSON 扫描）互补，本脚本只看
 * 「文件之间的引用关系」是否闭合：孤儿探针、i18n 缺键、IPC 通道两端不对齐、
 * 未被引用的源码、未进口的 CSS、文档里的脚本名/相对链接。
 *
 * 输出 JSON 到 stdout；不写仓库内文件。
 */
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

const root = process.cwd()
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(root, p))
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

const report = {}

/* ---------- 1. git 跟踪但工作区已删除 ---------- */
{
  const tracked = cp.execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean)
  report.missingTracked = tracked.filter((p) => !exists(p))
  let status = []
  try {
    status = cp.execFileSync('git', ['status', '--porcelain', '-z'], { maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean)
  } catch (error) {
    /* Windows 的保留设备名可能让 Git 读 index 报 short read；审计其余引用关系仍应继续，
     * 但把这个事实写进报告，不能把“无法读取状态”伪装成干净。 */
    report.gitStatusError = String(error?.stderr ?? error?.message ?? error).trim()
  }
  report.deletedUnstaged = status.filter((s) => /^ ?D /.test(s)).map((s) => s.slice(3))
  report.renames = status.filter((s) => /^R/.test(s)).length
}

/* ---------- 2. 探针 ↔ test-live CASES 闭合 ---------- */
{
  const liveSrc = rd('scripts/test-live.mjs')
  const caseProbes = new Set([...liveSrc.matchAll(/probe:\s*'([^']+)'/g)].map((m) => m[1]))
  const probeFiles = [...walk('scripts/probe')].filter((p) => /\.(js|mjs)$/.test(p))
  const orphan = probeFiles.filter((p) => !caseProbes.has(p))
  // 孤儿探针是否被别处引用（脚本 / 文档 / package.json）
  const referenced = {}
  const haystack = [
    ...walk('scripts').filter((p) => !p.startsWith('scripts/probe/')),
    'package.json',
    ...walk('docs').filter((p) => p.endsWith('.md'))
  ].map((p) => ({ p, text: rd(p) }))
  for (const o of orphan) {
    const name = path.basename(o)
    referenced[o] = haystack.filter((h) => h.text.includes(name)).map((h) => h.p)
  }
  report.probes = {
    inCases: caseProbes.size,
    files: probeFiles.length,
    orphanCount: orphan.length,
    // 既不在 CASES、也没有任何引用 = 真正的孤儿
    unreferenced: orphan.filter((o) => referenced[o].length === 0),
    orphanReferencedElsewhere: Object.fromEntries(orphan.filter((o) => referenced[o].length).map((o) => [o, referenced[o]]))
  }
}

/* ---------- 3. i18n 键完整性 ---------- */
{
  const zh = JSON.parse(rd('src/renderer/src/i18n/zh-CN.json'))
  const en = JSON.parse(rd('src/renderer/src/i18n/en-US.json'))
  const kz = new Set(Object.keys(zh))
  const ke = new Set(Object.keys(en))
  report.i18n = {
    zhCount: kz.size,
    enCount: ke.size,
    missingInEn: [...kz].filter((k) => !ke.has(k)),
    missingInZh: [...ke].filter((k) => !kz.has(k))
  }
}

/* ---------- 4. IPC 通道两端对齐 ---------- */
{
  const preload = rd('src/preload/index.ts')
  const main = rd('src/main/index.ts')
  const invoke = new Set([...preload.matchAll(/invoke<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1]))
  const invokePlain = new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]))
  const send = new Set([...preload.matchAll(/ipcRenderer\.send\(\s*'([^']+)'/g)].map((m) => m[1]))
  const handle = new Set([...main.matchAll(/(?:^|\s)handle\(\s*'([^']+)'/gm)].map((m) => m[1]))
  const on = new Set([...main.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1]))
  // handle() 也用于非 yan: 前缀（win: 等），统一比较
  const allInvoke = new Set([...invoke, ...invokePlain])
  report.ipc = {
    preloadInvokeCount: allInvoke.size,
    mainHandleCount: handle.size,
    preloadSendCount: send.size,
    mainOnCount: on.size,
    preloadOnly: [...allInvoke].filter((c) => !handle.has(c)),
    mainOnly: [...handle].filter((c) => !allInvoke.has(c)),
    sendOnly: [...send].filter((c) => !on.has(c)),
    onOnly: [...on].filter((c) => !send.has(c))
  }
}

/* ---------- 5. MainPush 通道：生产 vs 消费 ---------- */
{
  const producers = new Set()
  for (const f of walk('src/main')) {
    if (!/\.ts$/.test(f)) continue
    const t = rd(f)
    for (const m of t.matchAll(/ch:\s*'([^']+)'/g)) producers.add(m[1])
  }
  const consumed = new Set()
  for (const f of [...walk('src/renderer/src'), ...walk('src/shared')]) {
    if (!/\.(ts|tsx)$/.test(f)) continue
    const t = rd(f)
    for (const m of t.matchAll(/case\s+'([^']+)':/g)) consumed.add(m[1])
  }
  report.pushChannels = {
    producers: [...producers].sort(),
    producedNotConsumed: [...producers].filter((c) => !consumed.has(c)).sort()
  }
}

/* ---------- 6. src 下的文件是否被引用 ---------- */
{
  const srcFiles = walk('src')
  const allText = [...walk('src'), ...walk('scripts'), ...walk('docs').filter((p) => p.endsWith('.md'))]
    .map((p) => rd(p))
    .join('\n')
  const helper = /^(lib|icons)\//
  const unusedExports = srcFiles.filter((f) => {
    const base = path.basename(f).replace(/\.(ts|tsx)$/, '')
    /* `.d.ts` 是类型声明，由 tsconfig 自动加载，永远不需要被 import —— 不进这项检查 */
    if (!/\.(ts|tsx)$/.test(f) || f.endsWith('.d.ts')) return false
    const importName = base.replace(/\.(ts|tsx)$/, '')
    const patterns = [`from './${importName}'`, `from '../${importName}'`, `from './${importName}.ts'`, `/${importName}'`, `'./${importName}`, `/${importName}.`]
    return patterns.every((p) => !allText.includes(p))
  })
  report.unreferencedSourceFiles = unusedExports
}

/* ---------- 7. CSS 是否被引入 ---------- */
{
  const css = walk('src/renderer/src/styles').filter((f) => f.endsWith('.css'))
  const mainTsx = rd('src/renderer/src/main.tsx')
  const appTsx = rd('src/renderer/src/App.tsx')
  const html = rd('src/renderer/index.html')
  const blob = mainTsx + appTsx + html
  report.css = {
    files: css.length,
    notImported: css.filter((f) => !blob.includes(path.basename(f)))
  }
}

/* ---------- 8. 文档里的 npm 脚本名是否存在 ---------- */
{
  const pkg = JSON.parse(rd('package.json'))
  const scripts = new Set(Object.keys(pkg.scripts))
  const used = new Map()
  for (const f of [...walk('docs').filter((p) => p.endsWith('.md')), 'README.md', 'AGENTS.md']) {
    const t = rd(f)
    for (const m of t.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], [])
      used.get(m[1]).push(f)
    }
  }
  report.docScripts = {
    unknown: [...used].filter(([k]) => !scripts.has(k)).map(([k, v]) => ({ script: k, files: [...new Set(v)] }))
  }
}

/* ---------- 9. Markdown 相对链接是否有效 ---------- */
{
  const mdFiles = [...walk('docs').filter((p) => p.endsWith('.md')), 'README.md', 'AGENTS.md']
  const broken = []
  const archivedRaw = []
  for (const f of mdFiles) {
    const text = rd(f)
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1]
      if (/^[a-z]+:/i.test(target) || target.startsWith('//')) continue
      const resolved = path.normalize(path.join(path.dirname(f), decodeURI(target)))
      if (!exists(resolved)) {
        // 外部原文必须逐字保留；其中的旧仓库路径是历史内容，不把它伪装成当前断链。
        if (f.startsWith('docs/archive/reference/')) archivedRaw.push({ file: f, target, resolved })
        else broken.push({ file: f, target, resolved })
      }
    }
  }
  report.brokenDocLinks = broken
  report.archivedRawDocLinks = archivedRaw
}

/* ---------- 10. 文档提到的源码文件是否存在 ---------- */
{
  const mentioned = new Map()
  for (const f of [...walk('docs').filter((p) => p.endsWith('.md')), 'README.md', 'AGENTS.md']) {
    const t = rd(f)
    for (const m of t.matchAll(/`((?:src|scripts|resources|docs)\/[\w./\-\u4e00-\u9fa5]+\.\w+)`/g)) {
      if (!mentioned.has(m[1])) mentioned.set(m[1], new Set())
      mentioned.get(m[1]).add(f)
    }
  }
  report.docMentionsMissingFiles = [...mentioned].filter(([p]) => !exists(p)).map(([p, files]) => ({ path: p, files: [...files] }))
}

console.log(JSON.stringify(report, null, 2))
