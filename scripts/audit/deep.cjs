const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

const root = process.cwd()
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(root, p))
const walk = (dir, out = []) => {
  if (!fs.existsSync(path.join(root, dir))) return out
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

const report = {}

{
  const tracked = cp.execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean)
  report.missingTracked = tracked.filter((p) => !exists(p))
  let status = []
  try {
    status = cp.execFileSync('git', ['status', '--porcelain', '-z'], { maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean)
  } catch (error) {
    report.gitStatusError = String(error?.stderr ?? error?.message ?? error).trim()
  }
  report.deletedUnstaged = status.filter((s) => /^ ?D /.test(s)).map((s) => s.slice(3))
  report.renames = status.filter((s) => /^R/.test(s)).length
}

{
  const liveSrc = rd('scripts/test-live.mjs')
  const caseProbes = new Set([...liveSrc.matchAll(/probe:\s*'([^']+)'/g)].map((m) => m[1]))
  const probeFiles = [...walk('scripts/probe')].filter((p) => /\.(js|mjs)$/.test(p))
  const orphan = probeFiles.filter((p) => !caseProbes.has(p))
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
    unreferenced: orphan.filter((o) => referenced[o].length === 0),
    orphanReferencedElsewhere: Object.fromEntries(orphan.filter((o) => referenced[o].length).map((o) => [o, referenced[o]]))
  }
}

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

{
  const preload = rd('src/preload/index.ts')
  const main = rd('src/main/index.ts')
  const invoke = new Set([...preload.matchAll(/invoke<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1]))
  const invokePlain = new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]))
  const send = new Set([...preload.matchAll(/ipcRenderer\.send\(\s*'([^']+)'/g)].map((m) => m[1]))
  const handle = new Set([...main.matchAll(/(?:^|\s)handle\(\s*'([^']+)'/gm)].map((m) => m[1]))
  const on = new Set([...main.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1]))
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

{
  const srcFiles = walk('src')
  const allText = [...walk('src'), ...walk('scripts'), ...walk('docs').filter((p) => p.endsWith('.md'))]
    .map((p) => rd(p))
    .join('\n')
  const helper = /^(lib|icons)\//
  const unusedExports = srcFiles.filter((f) => {
    const base = path.basename(f).replace(/\.(ts|tsx)$/, '')
    if (!/\.(ts|tsx)$/.test(f) || f.endsWith('.d.ts')) return false
    const importName = base.replace(/\.(ts|tsx)$/, '')
    const patterns = [`from './${importName}'`, `from '../${importName}'`, `from './${importName}.ts'`, `/${importName}'`, `'./${importName}`, `/${importName}.`]
    return patterns.every((p) => !allText.includes(p))
  })
  report.unreferencedSourceFiles = unusedExports
}

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
        if (f.startsWith('docs/archive/reference/')) archivedRaw.push({ file: f, target, resolved })
        else broken.push({ file: f, target, resolved })
      }
    }
  }
  report.brokenDocLinks = broken
  report.archivedRawDocLinks = archivedRaw
}

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
