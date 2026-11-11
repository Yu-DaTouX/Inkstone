import { existsSync, readFileSync, readdirSync } from 'node:fs'

const MAX_LINES = 100
const TRACKED_ROOTS = /^(src|scripts|resources|debug|integrations|mobile|assets|build)\//
const GENERATED = /^resources\/pi-runtime\//
const MAP_HEADER = '| 功能域 |'
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs']

const rowCells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim())
const codeSpans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])

function codeMapProblems(lines, { pathExists, testFiles = [] }) {
  const start = lines.findIndex((line) => line.startsWith(MAP_HEADER))
  if (start < 0) return []
  const headers = rowCells(lines[start])
  const roots = headers.map((cell) => codeSpans(cell)[0] ?? '')
  const problems = []
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break
    const row = rowCells(line)
    row.forEach((cell, column) => {
      const title = headers[column] ?? ''
      if (column === 0 || title.startsWith('其他入口')) return
      for (const name of codeSpans(cell)) {
        if (title.startsWith('测试')) {
          if (!testFiles.some((file) => file.startsWith(`test-${name}`))) problems.push(`代码地图「${row[0]}」：没有 scripts/test-${name}*.mjs`)
        } else if (title.startsWith('场景')) {
          if (!pathExists(`debug/scenarios/${name}.mjs`)) problems.push(`代码地图「${row[0]}」：没有场景 ${name}`)
        } else {
          const target = roots[column] + name
          const found = name.endsWith('/') ? pathExists(target) : SOURCE_EXTENSIONS.some((extension) => pathExists(target + extension))
          if (!found) problems.push(`代码地图「${row[0]}」：${target} 不存在`)
        }
      }
    })
  }
  return problems
}

export function agentsDocProblems(text, { pathExists, scripts, testFiles }) {
  const problems = []
  const lines = text.split('\n')
  if (lines.length > MAX_LINES) problems.push(`超过 ${MAX_LINES} 行：${lines.length}`)
  if (/[A-Za-z]:[\\/]/.test(text)) problems.push('含本机盘符路径，本机约定放 .local-docs/README.md')
  for (const code of codeSpans(text)) {
    if (TRACKED_ROOTS.test(code) && !GENERATED.test(code) && !/[<*]/.test(code) && !pathExists(code)) problems.push(`路径不存在：${code}`)
    const script = /^npm run ([\w:.-]+)/.exec(code)?.[1]
    if (script && !scripts.has(script)) problems.push(`npm 脚本不存在：${script}`)
  }
  problems.push(...codeMapProblems(lines, { pathExists, testFiles }))
  return problems
}

export function runAgentsDocTests(ok) {
  const scripts = new Set(Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts))
  const testFiles = readdirSync('scripts').filter((name) => /^test-.*\.(mjs|cjs|js)$/.test(name))
  const real = { pathExists: existsSync, scripts, testFiles }
  const text = readFileSync('AGENTS.md', 'utf8')
  const problems = agentsDocProblems(text, real)
  ok(problems.length === 0, 'AGENTS.md 提到的路径、npm 脚本和代码地图条目都存在、没有本机路径、长度在上限内', problems.join('；'))
  ok(text.split('\n').some((line) => line.startsWith(MAP_HEADER)), 'AGENTS.md 里有代码地图')

  const fake = { pathExists: () => false, scripts: new Set(['build']) }
  ok(agentsDocProblems('`src/gone.ts`', fake).some((item) => item.includes('src/gone.ts')), '能发现不存在的路径')
  ok(agentsDocProblems('`npm run gone`', fake).some((item) => item.includes('gone')), '能发现不存在的 npm 脚本')
  ok(agentsDocProblems('`npm run build`', fake).length === 0, '存在的 npm 脚本不报')
  ok(agentsDocProblems('`release/<版本>/` `resources/pi-runtime/` `.local-docs/STATUS.md`', fake).length === 0, '占位路径、生成目录和被忽略的本地资料不报')
  ok(agentsDocProblems('E:/Inkstone/refs', fake).some((item) => item.includes('盘符')), '能发现本机盘符路径')
  ok(agentsDocProblems(Array(MAX_LINES + 1).fill('x').join('\n'), fake).some((item) => item.includes('超过')), '能发现超长')

  const known = ['src/main/', 'src/main/agent.ts', 'src/main/ipc/', 'debug/scenarios/demo.mjs', 'resources/yan-cli/yan.mjs']
  const mapped = { pathExists: (path) => known.includes(path), scripts: new Set(), testFiles: ['test-session-list.mjs'] }
  const map = (main, tests, scenarios) => [
    '| 功能域 | 主进程 `src/main/` | 其他入口 | 测试 | 场景 |',
    '| --- | --- | --- | --- | --- |',
    `| 示例 | ${main} | \`resources/yan-cli/yan.mjs\` | ${tests} | ${scenarios} |`,
    '',
    '表格之后的 `gone` 不算地图'
  ].join('\n')
  ok(agentsDocProblems(map('`agent`（说明） `ipc/`', '`session`', '`demo`'), mapped).length === 0, '代码地图里存在的入口、测试前缀和场景不报')
  ok(agentsDocProblems(map('`gone`', '`session`', '`demo`'), mapped).some((item) => item.includes('src/main/gone')), '能发现代码地图里不存在的入口文件')
  ok(agentsDocProblems(map('`gone/`', '`session`', '`demo`'), mapped).some((item) => item.includes('src/main/gone/')), '能发现代码地图里不存在的目录')
  ok(agentsDocProblems(map('`agent`', '`nothing`', '`demo`'), mapped).some((item) => item.includes('test-nothing')), '能发现没有对应测试脚本的前缀')
  ok(agentsDocProblems(map('`agent`', '`session`', '`gone`'), mapped).some((item) => item.includes('场景 gone')), '能发现不存在的场景')
  ok(agentsDocProblems(map('—', '—', '—'), mapped).length === 0, '空格子不报')
}
