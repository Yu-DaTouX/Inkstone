/** Repository document check and private catalog. Never moves/deletes files or follows links. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args.some(a => !['--report'].includes(a))) throw new Error('Usage: node scripts/audit/workspace.mjs [--report]')
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 << 20 }).toString('utf8')
const split = s => s.split('\0').filter(Boolean)
const tracked = new Set(split(git('ls-files', '-z')))
const candidates = new Set([...tracked, ...split(git('ls-files', '--others', '--exclude-standard', '-z'))])
const errors = []
const publicDocs = [...candidates].filter(p => /\.md$/i.test(p))
const checkedLinks = []
for (const p of publicDocs) {
  const abs = path.join(root, p)
  if (!fs.existsSync(abs)) { errors.push(`${p}: missing document`); continue }
  const source = fs.readFileSync(abs, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')
  const urls = [
    ...[...source.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]),
    ...[...source.matchAll(/(?:src|href|srcset)=["']([^"']+)["']/g)].map(m => m[1]),
    ...[...source.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map(m => m[1]),
  ]
  for (let url of urls) {
    url = url.replace(/^<|>$/g, '')
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(url)) continue
    try { url = decodeURIComponent(url.split(/[?#]/)[0]) } catch { errors.push(`${p}: invalid URL ${url}`); continue }
    if (!url) continue
    const target = path.relative(root, path.resolve(path.dirname(abs), url)).replaceAll('\\', '/')
    checkedLinks.push({ from: p, target })
    if (target.startsWith('../') || path.isAbsolute(target)) errors.push(`${p}: link outside repository: ${url}`)
    else if (!fs.existsSync(path.join(root, target))) errors.push(`${p}: missing target: ${target}`)
    else if (![...candidates].some(q => q === target || q.startsWith(target.replace(/\/$/, '') + '/'))) errors.push(`${p}: target is local-only: ${target}`)
  }
}
for (const p of tracked) {
  if (/^(?:\.local-docs\/|docs\/(?:plan|design|archive)\/|docs\/dev\/(?!RELEASING\.md$)|docs\/WORKSPACE\.md$|docs\/ARCHITECTURE\.(?:html|mmd)$)/.test(p)) errors.push(`internal file tracked: ${p}`)
}
const summary = { publicDocuments: publicDocs.length, localLinks: checkedLinks.length, errors,
  limits: 'Checks local file targets and public visibility, not heading anchors, external URLs, prose accuracy or runtime behavior. Untracked non-ignored files are publication candidates, not committed files.' }

if (args.includes('--report')) {
  const boundaries = new Set(['.git', 'node_modules', '.pnpm-store', 'out', 'dist', 'release', 'resources/pi-runtime', '.pi', '.yan-tmp', '.backup', '.local-docs/workspace-audits'])
  const entries = [], excluded = [], scanErrors = []
  const category = p => {
    if (p.startsWith('.local-docs/')) return 'local-archive-metadata'
    if (/^docs\/(plan|design|archive)\//.test(p) || /^docs\/dev\/(?!RELEASING\.md$)/.test(p) || /^docs\/(WORKSPACE\.md|ARCHITECTURE\.(html|mmd))$/.test(p)) return 'local-reference'
    if (/^docs\/assets\//.test(p)) return 'public-media'
    if (/^(?:AGENTS|README(?:_EN)?)\.md$/.test(p) || /^docs\//.test(p)) return 'public-doc'
    if (/^src\//.test(p)) return 'source'
    if (/^scripts\//.test(p)) return 'maintenance'
    if (/^resources\//.test(p)) return 'shipped-source'
    if (/^build\//.test(p)) return tracked.has(p) ? 'retained-build-asset' : 'generated-build-asset'
    if (/^(?:\.tmp-|\.audit-|goal-plan\.json$|tmp-image-|nul$)|\.tsbuildinfo$/.test(p)) return 'local-loose'
    return 'root-config'
  }
  function walk(dir = '') {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = dir ? `${dir}/${ent.name}` : ent.name
      if (boundaries.has(p)) { excluded.push({ path: p, reason: 'opaque dependency, output, private data, backup or previous local report; not traversed' }); continue }
      if (ent.isSymbolicLink()) { excluded.push({ path: p, reason: 'symbolic link; not followed' }); continue }
      try {
        if (ent.isDirectory()) { walk(p); continue }
        const stat = fs.statSync(path.join(root, p))
        const row = { path: p, category: category(p), git: tracked.has(p) ? 'tracked' : candidates.has(p) ? 'untracked' : 'ignored', bytes: stat.size, modified: stat.mtime.toISOString() }
        // Windows device names and credentials are cataloged without reading contents.
        if (!p.startsWith('.local-docs/') && !/^(?:nul|con|prn|aux|com\d|lpt\d)(?:\.|$)/i.test(ent.name) && !/^(?:auth\.json|\.env(?:\..*)?|.*\.key)$/i.test(ent.name)) {
          if (/\.(?:md|txt|png|jpe?g|svg|gif|webp|ico|bmp|html|mmd)$/i.test(p)) {
            const data = fs.readFileSync(path.join(root, p))
            row.sha256 = createHash('sha256').update(data).digest('hex')
            if (p.endsWith('.md')) row.title = data.toString('utf8').match(/^#\s+(.+)$/m)?.[1] ?? ''
            if (p.endsWith('.png') && data.length >= 24 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) row.dimensions = `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`
          }
        }
        entries.push(row)
      } catch (e) { scanErrors.push({ path: p, code: e.code ?? e.message }) }
    }
  }
  walk()
  entries.sort((a,b) => a.path.localeCompare(b.path, 'en'))
  const groups = {}, hashes = new Map()
  for (const row of entries) {
    groups[row.category] ??= { files: 0, bytes: 0 }
    groups[row.category].files++; groups[row.category].bytes += row.bytes
    if (row.sha256) { const g = hashes.get(row.sha256) ?? []; g.push(row.path); hashes.set(row.sha256, g) }
  }
  const duplicates = [...hashes.values()].filter(g => g.length > 1)
  const base = path.join(root, '.local-docs', 'workspace-audits')
  fs.mkdirSync(base, { recursive: true })
  const dest = fs.mkdtempSync(path.join(base, new Date().toISOString().replace(/[:.]/g, '-') + '-'))
  const report = { created: new Date().toISOString(), ...summary, groups, excluded, scanErrors, duplicates, entries }
  fs.writeFileSync(path.join(dest, 'catalog.json'), JSON.stringify(report, null, 2) + '\n')
  const cell = x => String(x ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = ['# 工作区文件清单', '', `生成时间：${report.created}`, '', '这是本机机器清点，不是逐篇审阅、视觉验收或删除许可。既有本地报告、依赖、构建、备份与真实数据目录不展开，边界见 catalog.json。', '', '## 分类', '', '| 分类 | 文件数 | 字节 |', '| --- | ---: | ---: |', ...Object.entries(groups).map(([k,v]) => `| ${k} | ${v.files} | ${v.bytes} |`), '', '## 文档、图片与零散文件', '', '| 路径 | 分类 | Git | 标题或 PNG 尺寸 |', '| --- | --- | --- | --- |', ...entries.filter(r => r.sha256 || r.category === 'local-loose').map(r => `| ${cell(r.path)} | ${r.category} | ${r.git} | ${cell(r.title ?? r.dimensions)} |`), '', '## 内容相同的资产或文档', '', '相同哈希可能是必要的源文件与发布副本，不自动合并。', '', ...duplicates.map(g => '- ' + g.map(cell).join(' · ')), '', '## 扫描限制', '', ...excluded.map(e => `- ${e.path}：不展开`), ...scanErrors.map(e => `- 读取失败：${e.path} (${e.code})`), '']
  fs.writeFileSync(path.join(dest, 'INDEX.md'), lines.join('\n'))
  summary.report = path.relative(root, dest).replaceAll('\\', '/')
  summary.groups = groups
  summary.scanErrors = scanErrors
  if (scanErrors.length) process.exitCode = 1
}
console.log(JSON.stringify(summary, null, 2))
if (errors.length) process.exitCode = 1
